import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProjectAsset } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalApiApp } from "./app.js";
import {
  LOCAL_BLOB_SWEEP_FAILED,
  LOCAL_BLOB_SWEEP_GRACE_MS,
  sweepLocalBlobs,
} from "./local-blob-sweep.js";
import {
  createLocalResourceStore,
  type LocalResourceProjection,
  type LocalResourceStore,
} from "./local-resource-store.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";

const unlinkHook = vi.hoisted(() => ({
  value: undefined as ((path: string) => Promise<void> | void) | undefined,
}));

// A real unlink failure depends on the uid and platform running the suite.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const unlink = (async (path: Parameters<typeof actual.unlink>[0]) => {
    await unlinkHook.value?.(String(path));
    await actual.unlink(path);
  }) as typeof actual.unlink;
  return { ...actual, unlink, default: { ...actual, unlink } };
});

const nodeRequire = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(async () => {
  unlinkHook.value = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function withSqlite<T>(
  dataDir: string,
  task: (database: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
  }) => T,
): T {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): Record<string, unknown> | undefined;
      };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"), {
    timeout: 5_000,
  });
  try {
    return task(database);
  } finally {
    database.close();
  }
}

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-blob-sweep-"));
  roots.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  await mkdir(dataDir, { recursive: true });
  const store = createLocalResourceStore({ dataDir, clashRoot });
  const replicas = new FileReplicaStore(join(dataDir, "projects"));
  const longAgo = Date.now() - 2 * LOCAL_BLOB_SWEEP_GRACE_MS;

  const age = async (sealed: LocalResourceProjection) => {
    withSqlite(dataDir, (database) =>
      database
        .prepare(
          "UPDATE local_resources SET created_at = ? WHERE digest_sha256 = ?",
        )
        .run(longAgo, sealed.resource.digest.value),
    );
    const when = new Date(longAgo);
    await utimes(sealed.path, when, when);
  };

  return {
    clashRoot,
    dataDir,
    store,
    replicas,
    age,
    /** A sealed blob past the grace period, whose import has finished. */
    async sealedOld(text: string): Promise<LocalResourceProjection> {
      const sealed = await sealFresh(store, text);
      await age(sealed);
      return sealed;
    },
    async project(
      projectId: string,
      assets: Array<{
        id: string;
        resourceId: string;
        state?: "active" | "trashed";
      }>,
    ): Promise<void> {
      const doc = new LoroDoc();
      for (const asset of assets) {
        const created = createProjectAsset(doc, {
          id: asset.id,
          kind: "image",
          source: { kind: "owned", resourceId: asset.resourceId },
          lifecycle:
            asset.state === "trashed"
              ? {
                  state: "trashed",
                  deleteOperationId: "delete-1",
                  deletedAt: "2026-10-01T00:00:00.000Z",
                  purgeAfter: "2026-10-08T00:00:00.000Z",
                }
              : { state: "active" },
          metadata: {},
        });
        expect(created.ok).toBe(true);
      }
      await replicas.saveSnapshotAtomic(
        projectId,
        doc.export({ mode: "snapshot" }),
      );
      doc.free();
    },
    sweep: () => sweepLocalBlobs({ dataDir, clashRoot }),
    rowCount(table: string, where = "1 = 1", ...params: unknown[]): number {
      return withSqlite(
        dataDir,
        (database) =>
          database
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
            .get(...params)?.count as number,
      );
    },
  };
}

async function sealFresh(
  store: LocalResourceStore,
  text: string,
): Promise<LocalResourceProjection> {
  const staged = await store.stage({ bytes: new TextEncoder().encode(text) });
  const sealed = await store.seal({
    receipt: staged.receipt,
    kind: "image",
    contentType: "image/png",
  });
  await store.releaseStaged(staged.resourceId);
  return sealed;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("local blob sweep", () => {
  it("reclaims an unreferenced blob and its derived rows only after the grace period", async () => {
    const f = await fixture();
    const old = await f.sealedOld("failed import bytes");
    const young = await sealFresh(f.store, "import still publishing");
    withSqlite(f.dataDir, (database) => {
      database
        .prepare(
          "INSERT INTO local_asset_inspections (source_resource_id, recipe, facts_json, inspected_at) VALUES (?, 'v1', '{}', 1)",
        )
        .run(old.resource.id);
      database
        .prepare(
          "INSERT INTO local_asset_representations (source_resource_id, recipe, role, result_json, created_at) VALUES (?, 'w', 'waveform', '{}', 1)",
        )
        .run(old.resource.id);
    });

    const result = await f.sweep();

    expect(result).toMatchObject({
      scanned: 2,
      deleted: 1,
      bytes: "failed import bytes".length,
      failed: [],
    });
    expect(await exists(old.path)).toBe(false);
    expect(await exists(join(old.path, ".."))).toBe(false);
    await expect(f.store.readFacts(old.resource.id)).resolves.toBeUndefined();
    expect(f.rowCount("local_asset_inspections")).toBe(0);
    expect(f.rowCount("local_asset_representations")).toBe(0);
    expect(await exists(young.path)).toBe(true);
    await expect(f.store.resolve(young.resource.id)).resolves.toBeDefined();
  });

  it("removes a blob only one purged Project referenced and keeps one shared with another Project", async () => {
    const f = await fixture();
    const only = await f.sealedOld("only in the purged Project");
    const shared = await f.sealedOld("shared between Projects");
    await f.project("purged", [
      { id: "a", resourceId: only.resource.id },
      { id: "b", resourceId: shared.resource.id },
    ]);
    await f.project("kept", [{ id: "c", resourceId: shared.resource.id }]);

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(await exists(only.path)).toBe(true);

    await f.replicas.deleteReplica("purged");
    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });

    expect(await exists(only.path)).toBe(false);
    expect((await f.store.resolve(shared.resource.id))?.path).toBe(shared.path);
  });

  it("keeps a blob while the global library holds it, until that entry is purged", async () => {
    const f = await fixture();
    const held = await f.sealedOld("library bytes");
    const insert = (state: string) =>
      withSqlite(f.dataDir, (database) =>
        database
          .prepare(
            "INSERT OR REPLACE INTO global_asset_entry (library_id, id, kind, resource_id, lifecycle_state, metadata_json, created_at, updated_at) VALUES ('me', 'entry', 'image', ?, ?, '{}', 1, 1)",
          )
          .run(held.resource.id, state),
      );

    insert("trashed");
    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(await exists(held.path)).toBe(true);

    insert("purged");
    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
    expect(await exists(held.path)).toBe(false);
  });

  it("treats a trashed Project Asset as a reference and a purged one as none", async () => {
    const f = await fixture();
    const trashed = await f.sealedOld("recoverable bytes");
    await f.project("p", [
      { id: "a", resourceId: trashed.resource.id, state: "trashed" },
    ]);
    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });

    const { purgeProjectAsset } = await import("@clash/shared-types");
    const doc = await f.replicas.recover("p");
    expect(
      purgeProjectAsset(doc, {
        id: "a",
        deleteOperationId: "delete-1",
        purgedAt: "2026-10-09T00:00:00.000Z",
      }).ok,
    ).toBe(true);
    await f.replicas.saveSnapshotAtomic("p", doc.export({ mode: "snapshot" }));
    doc.free();

    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
    expect(await exists(trashed.path)).toBe(false);
  });

  it("pins by digest: a replicated Resource id keeps the file and every row that shares it", async () => {
    const f = await fixture();
    const verified = await f.sealedOld("replicated bytes");
    const replicated = await f.store.installReplica({
      resource: { ...verified.resource, id: "res_replicated" },
      verifiedResourceId: verified.resource.id,
    });
    await f.age(replicated);
    await f.project("p", [{ id: "a", resourceId: "res_replicated" }]);

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(f.rowCount("local_resources")).toBe(2);
    expect(await readFile(verified.path, "utf8")).toBe("replicated bytes");

    await f.replicas.deleteReplica("p");
    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
    expect(f.rowCount("local_resources")).toBe(0);
    expect(await exists(verified.path)).toBe(false);
  });

  it("keeps a representation of a live source and reclaims it with a dead one", async () => {
    const f = await fixture();
    const source = await f.sealedOld("video bytes");
    const thumbnail = await f.sealedOld("thumbnail bytes");
    withSqlite(f.dataDir, (database) =>
      database
        .prepare(
          "INSERT INTO local_asset_representations (source_resource_id, recipe, role, result_json, created_at) VALUES (?, 't', 'thumbnail', ?, 1)",
        )
        .run(
          source.resource.id,
          JSON.stringify({
            role: "thumbnail",
            recipe: "t",
            resourceId: thumbnail.resource.id,
          }),
        ),
    );
    await f.project("p", [{ id: "a", resourceId: source.resource.id }]);

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(await exists(thumbnail.path)).toBe(true);

    await f.replicas.deleteReplica("p");
    expect(await f.sweep()).toMatchObject({ deleted: 2, failed: [] });
    expect(await exists(source.path)).toBe(false);
    expect(await exists(thumbnail.path)).toBe(false);
  });

  it("keeps a durable output while its Project exists and drops the receipt once it is purged", async () => {
    const f = await fixture();
    const output = await f.sealedOld("durable output bytes");
    await f.project("p", []);
    withSqlite(f.dataDir, (database) =>
      database
        .prepare(
          "INSERT INTO local_durable_output_staging (project_id, action_run_id, output_slot, project_asset_id, resource_id, kind, content_type, byte_length, metadata_json, created_at) VALUES ('p', 'run', 'slot', 'asset', ?, 'image', 'image/png', 1, '{}', 1)",
        )
        .run(output.resource.id),
    );

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(await exists(output.path)).toBe(true);

    await f.replicas.deleteReplica("p");
    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
    expect(f.rowCount("local_durable_output_staging")).toBe(0);
    expect(await exists(output.path)).toBe(false);
  });

  it("keeps a legacy Asset's blob while an owner exists", async () => {
    const f = await fixture();
    const legacy = await f.sealedOld("legacy bytes");
    await f.project("p", []);
    withSqlite(f.dataDir, (database) =>
      database
        .prepare(
          "INSERT INTO assets (id, user_id, kind, src_r2_key, metadata, created_at, updated_at, project_id) VALUES ('legacy', 'me', 'image', 'x', ?, 1, 1, 'p')",
        )
        .run(
          JSON.stringify({
            localBlobKey: `blobs/${legacy.resource.digest.value}/original.png`,
          }),
        ),
    );

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    expect(await exists(legacy.path)).toBe(true);

    await f.replicas.deleteReplica("p");
    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
  });

  it("does not touch an old blob that a fresh import of the same bytes is using", async () => {
    const f = await fixture();
    const old = await f.sealedOld("re-imported bytes");
    await f.store.stage({ bytes: new TextEncoder().encode("re-imported bytes") });

    expect(await f.sweep()).toMatchObject({ deleted: 0, failed: [] });
    await expect(f.store.resolve(old.resource.id)).resolves.toBeDefined();
  });

  it("removes an old sealed file with no row, left by a crash before indexing", async () => {
    const f = await fixture();
    const sealed = await f.sealedOld("crashed before indexing");
    withSqlite(f.dataDir, (database) =>
      database.prepare("DELETE FROM local_resources").run(),
    );

    expect(await f.sweep()).toMatchObject({ deleted: 1, failed: [] });
    expect(await exists(sealed.path)).toBe(false);
  });

  it("deletes nothing when a replica cannot be read", async () => {
    const f = await fixture();
    const old = await f.sealedOld("maybe referenced by the corrupt replica");
    const loroDir = join(f.dataDir, "projects", "corrupt", "loro");
    await mkdir(loroDir, { recursive: true });
    await writeFile(join(loroDir, "snapshot.bin"), "not a Loro snapshot");

    const result = await f.sweep();

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([
      expect.objectContaining({
        code: LOCAL_BLOB_SWEEP_FAILED,
        path: join(f.dataDir, "projects", "corrupt"),
      }),
    ]);
    await expect(f.store.resolve(old.resource.id)).resolves.toBeDefined();
  });

  it("refuses a row stored outside its content address", async () => {
    const f = await fixture();
    const old = await f.sealedOld("foreign row bytes");
    withSqlite(f.dataDir, (database) =>
      database
        .prepare("UPDATE local_resources SET storage_key = 'projects/x.png'")
        .run(),
    );

    const result = await f.sweep();

    expect(result.deleted).toBe(0);
    expect(result.failed[0]).toMatchObject({
      code: LOCAL_BLOB_SWEEP_FAILED,
      path: join(old.path, ".."),
    });
    expect(f.rowCount("local_resources")).toBe(1);
    expect(await exists(old.path)).toBe(true);
  });

  it("reports a failed delete with its code, path and errno, then retries it", async () => {
    const f = await fixture();
    const stuck = await f.sealedOld("undeletable for now");
    const referenced = await f.sealedOld("referenced bytes");
    await f.project("p", [{ id: "a", resourceId: referenced.resource.id }]);
    unlinkHook.value = (path) => {
      if (path === stuck.path) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
    };

    const first = await f.sweep();

    expect(first.deleted).toBe(0);
    expect(first.failed).toEqual([
      expect.objectContaining({
        code: LOCAL_BLOB_SWEEP_FAILED,
        path: stuck.path,
        errno: "EACCES",
      }),
    ]);
    expect(await exists(stuck.path)).toBe(true);
    expect(await exists(referenced.path)).toBe(true);

    unlinkHook.value = undefined;
    expect(await f.sweep()).toMatchObject({
      deleted: 1,
      bytes: "undeletable for now".length,
      failed: [],
    });
    expect(await exists(stuck.path)).toBe(false);
    await expect(f.store.resolve(referenced.resource.id)).resolves.toBeDefined();
  });

  it("makes a seal of the same digest wait, so its published bytes survive the sweep", async () => {
    const f = await fixture();
    const bytes = new TextEncoder().encode("sealed during the sweep");
    const old = await f.sealedOld("sealed during the sweep");
    let seal: Promise<LocalResourceProjection> | undefined;
    unlinkHook.value = async (path) => {
      if (path !== old.path || seal) return;
      const staged = await f.store.stage({ bytes });
      seal = f.store.seal({
        receipt: staged.receipt,
        kind: "image",
        contentType: "image/png",
      });
      // Unlocked, the seal would publish here and the unlink would then remove
      // its bytes. Locked, it can only finish after the sweep lets go.
      await Promise.race([
        seal,
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
    };

    await f.sweep();
    unlinkHook.value = undefined;
    const sealed = await seal!;

    expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
    await expect(f.store.resolve(old.resource.id)).resolves.toBeDefined();
  });
});

describe("Project purge", () => {
  async function createdDeletedAged(
    f: Awaited<ReturnType<typeof fixture>>,
    app: ReturnType<typeof createLocalApiApp>,
    name: string,
    resourceIds: string[],
  ): Promise<{ id: string; readToken: string }> {
    const created = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await f.project(
      id,
      resourceIds.map((resourceId, index) => ({
        id: `asset-${index}`,
        resourceId,
      })),
    );
    const deleted = await app.request(`/api/v1/projects/${id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    withSqlite(f.dataDir, (database) =>
      database
        .prepare("UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(
          new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
          new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
          id,
        ),
    );
    const read = await app.request(`/api/v1/projects/${id}?includeDeleted=true`);
    expect(read.status).toBe(200);
    const { readToken } = (await read.json()) as { readToken: string };
    return { id, readToken };
  }

  const purge = (
    app: ReturnType<typeof createLocalApiApp>,
    project: { id: string; readToken: string },
  ) =>
    app.request(`/api/v1/projects/${project.id}/purge`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-clash-client-type": "agent",
        "x-clash-if-match": project.readToken,
      },
      body: JSON.stringify({ confirm: "purge" }),
    });

  it("removes every blob only that Project referenced and keeps blobs held elsewhere", async () => {
    const f = await fixture();
    const app = createLocalApiApp({
      dataDir: f.dataDir,
      clashRoot: f.clashRoot,
      userId: "local-user",
    });
    const only = await f.sealedOld("only this Project");
    const sharedProject = await f.sealedOld("also in another Project");
    const sharedLibrary = await f.sealedOld("also in the library");
    withSqlite(f.dataDir, (database) =>
      database
        .prepare(
          "INSERT INTO global_asset_entry (library_id, id, kind, resource_id, lifecycle_state, metadata_json, created_at, updated_at) VALUES ('me', 'entry', 'image', ?, 'active', '{}', 1, 1)",
        )
        .run(sharedLibrary.resource.id),
    );
    const purged = await createdDeletedAged(f, app, "Purged", [
      only.resource.id,
      sharedProject.resource.id,
      sharedLibrary.resource.id,
    ]);
    await createdDeletedAged(f, app, "Still recoverable", [
      sharedProject.resource.id,
    ]);

    const response = await purge(app, purged);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purged: true,
      replicaDeleted: true,
      blobs: { deleted: 1, bytes: "only this Project".length, failed: 0 },
    });
    expect(await exists(only.path)).toBe(false);
    await expect(f.store.readFacts(only.resource.id)).resolves.toBeUndefined();
    await expect(
      f.store.resolve(sharedProject.resource.id),
    ).resolves.toBeDefined();
    await expect(
      f.store.resolve(sharedLibrary.resource.id),
    ).resolves.toBeDefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a replica it could not delete with a code, keeps its blobs and retries",
    async () => {
      const f = await fixture();
      const app = createLocalApiApp({
        dataDir: f.dataDir,
        clashRoot: f.clashRoot,
        userId: "local-user",
      });
      const blob = await f.sealedOld("pinned by the undeleted replica");
      const stuck = await createdDeletedAged(f, app, "Stuck", [
        blob.resource.id,
      ]);
      const other = await createdDeletedAged(f, app, "Other", []);
      const projectsRoot = join(f.dataDir, "projects");

      await chmod(projectsRoot, 0o500);
      let failed: Response;
      try {
        failed = await purge(app, stuck);
      } finally {
        await chmod(projectsRoot, 0o700);
      }

      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        purged: true,
        replicaDeleted: false,
        code: "PROJECT_PURGE_REPLICA_DELETE_FAILED",
      });
      expect(await exists(blob.path)).toBe(true);

      // The next sweep, here from another purge, retries the delete first.
      const next = await purge(app, other);
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({ blobs: { deleted: 1 } });
      expect(await exists(join(projectsRoot, stuck.id))).toBe(false);
      expect(await exists(blob.path)).toBe(false);
    },
  );
});
