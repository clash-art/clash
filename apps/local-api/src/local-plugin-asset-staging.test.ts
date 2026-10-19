import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalPluginAssetStagingStore,
  pluginOutputProjectAssetId,
} from "./local-plugin-asset-staging";
import { createLocalResourceStore } from "./local-resource-store.js";
import { closeLocalSqliteClient } from "./local-sqlite-connection.js";

const cleanups: string[] = [];
const nodeRequire = createRequire(import.meta.url);

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function store() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-plugin-staging-"));
  cleanups.push(dataDir);
  return {
    dataDir,
    store: createLocalPluginAssetStagingStore({ dataDir }),
  };
}

async function legacySealedReceipt(input?: {
  kind?: "image" | "audio";
  mediaType?: string | null;
  byteLength?: number | null;
}) {
  const fixture = await store();
  const bytes = new Uint8Array([10, 20, 30, 40]);
  const resources = createLocalResourceStore({ dataDir: fixture.dataDir });
  const sealed = await resources.install({
    kind: "image",
    contentType: "image/png",
    bytes,
  });
  const identity = {
    projectId: "project-legacy",
    taskId: "run-legacy",
    slot: "media",
  };
  const projectAssetId = pluginOutputProjectAssetId(identity);
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => TestDatabase;
  };
  // A pre-cutover data dir: close the Host SQLite worker so the next store
  // call reopens and migrates the legacy table, as a Host restart does.
  await closeLocalSqliteClient();
  const database = new DatabaseSync(join(fixture.dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    database.exec(`
      DROP TABLE local_plugin_asset_staging;
      CREATE TABLE local_plugin_asset_staging (
        project_id TEXT NOT NULL,
        project_asset_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        media_type TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, project_asset_id)
      );
    `);
    database
      .prepare("DELETE FROM local_resource_staging WHERE resource_id = ?")
      .run(sealed.resource.id);
    database
      .prepare(
        `INSERT INTO local_plugin_asset_staging (
           project_id, project_asset_id, resource_id, kind, task_id, slot,
           plugin_id, plugin_version, invocation_id, media_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.projectId,
        projectAssetId,
        sealed.resource.id,
        input?.kind ?? "image",
        identity.taskId,
        identity.slot,
        "clash.legacy",
        "1.0.0",
        "invoke-legacy",
        input?.mediaType === undefined ? "image/png" : input.mediaType,
        Date.now(),
      );
  } finally {
    database.close();
  }

  if (input?.byteLength !== undefined) {
    const database = new DatabaseSync(join(fixture.dataDir, "local.sqlite"), { timeout: 5_000 });
    try {
      database.exec(
        "ALTER TABLE local_plugin_asset_staging ADD COLUMN byte_length INTEGER",
      );
      database
        .prepare(
          "UPDATE local_plugin_asset_staging SET byte_length = ? WHERE project_id = ? AND project_asset_id = ?",
        )
        .run(input.byteLength, identity.projectId, projectAssetId);
    } finally {
      database.close();
    }
  }
  return {
    ...fixture,
    bytes,
    identity,
    projectAssetId,
    resourceId: sealed.resource.id,
    resources,
  };
}

describe("local plugin Asset staging", () => {
  it("chooses a stable Project-scoped output identity without exposing the Resource digest", () => {
    const first = pluginOutputProjectAssetId({
      projectId: "project-a",
      taskId: "run-1",
      slot: "media",
    });
    expect(first).toBe(
      pluginOutputProjectAssetId({
        projectId: "project-a",
        taskId: "run-1",
        slot: "media",
      }),
    );
    expect(first).not.toBe(
      pluginOutputProjectAssetId({
        projectId: "project-b",
        taskId: "run-1",
        slot: "media",
      }),
    );
    expect(first).toMatch(/^plugin-output:[a-f0-9]{64}$/);
    expect(first).not.toContain("sha256:");
  });

  it("persists restart-safe bytes without declaring a canonical Resource", async () => {
    const fixture = await store();
    const staged = await fixture.store.stage({
      projectId: "project-a",
      taskId: "run-1",
      slot: "media",
      pluginId: "clash.minimax",
      pluginVersion: "1.0.0",
      invocationId: "invoke-1",
      kind: "audio",
      mediaType: "audio/mpeg",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(staged).toMatchObject({
      projectId: "project-a",
      taskId: "run-1",
      slot: "media",
      kind: "audio",
      mediaType: "audio/mpeg",
      byteLength: 3,
      projection: {
        byteLength: 3,
      },
    });
    expect(staged.projection).not.toHaveProperty("resource");
    const resources = createLocalResourceStore({ dataDir: fixture.dataDir });
    await expect(resources.resolve(staged.resourceId)).resolves.toBeUndefined();
    await expect(
      resources.resolveStaged(staged.resourceId),
    ).resolves.toMatchObject({
      resourceId: staged.resourceId,
      byteLength: 3,
    });
    await expect(readFile(staged.projection.path)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );

    const reopened = createLocalPluginAssetStagingStore({
      dataDir: fixture.dataDir,
    });
    await expect(
      reopened.resolve({
        projectId: "project-a",
        projectAssetId: staged.projectAssetId,
      }),
    ).resolves.toMatchObject({
      resourceId: staged.resourceId,
      projectAssetId: staged.projectAssetId,
    });
    await expect(
      reopened.resolve({
        projectId: "project-b",
        projectAssetId: staged.projectAssetId,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the first durable receipt when an ambiguous Provider retry returns different bytes", async () => {
    const fixture = await store();
    const first = await fixture.store.stage({
      projectId: "project-a",
      taskId: "run-1",
      slot: "media",
      pluginId: "clash.google",
      pluginVersion: "1.0.0",
      invocationId: "invoke-1",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
    });
    const retried = await fixture.store.stage({
      projectId: "project-a",
      taskId: "run-1",
      slot: "media",
      pluginId: "clash.google",
      pluginVersion: "1.0.0",
      invocationId: "invoke-2",
      kind: "image",
      mediaType: "image/png",
      bytes: new Uint8Array([2]),
    });

    expect(retried.projectAssetId).toBe(first.projectAssetId);
    expect(retried.resourceId).toBe(first.resourceId);
    await expect(readFile(retried.projection.path)).resolves.toEqual(
      Buffer.from([1]),
    );
    await expect(
      createLocalResourceStore({ dataDir: fixture.dataDir }).resolve(
        first.resourceId,
      ),
    ).resolves.toBeUndefined();
  });

  it("recovers a complete pre-cutover sealed receipt as unsealed staging after restart", async () => {
    const fixture = await legacySealedReceipt();
    await expect(
      fixture.resources.resolveStaged(fixture.resourceId),
    ).resolves.toBeUndefined();

    const recovered = await createLocalPluginAssetStagingStore({
      dataDir: fixture.dataDir,
    }).resolve({
      projectId: fixture.identity.projectId,
      projectAssetId: fixture.projectAssetId,
    });

    expect(recovered).toMatchObject({
      resourceId: fixture.resourceId,
      kind: "image",
      mediaType: "image/png",
      byteLength: 4,
      projection: {
        resourceId: fixture.resourceId,
        byteLength: 4,
      },
    });
    expect(recovered!.projection).not.toHaveProperty("resource");
    await expect(readFile(recovered!.projection.path)).resolves.toEqual(
      Buffer.from(fixture.bytes),
    );
  });

  it.each([
    {
      label: "kind",
      receipt: { kind: "audio" as const },
    },
    {
      label: "media type",
      receipt: { mediaType: "audio/mpeg" },
    },
    {
      label: "missing media type",
      receipt: { mediaType: null },
    },
    {
      label: "persisted byte length",
      receipt: { byteLength: 99 },
    },
  ])(
    "fails closed without restaging when a pre-cutover plugin receipt has conflicting $label",
    async ({ receipt }) => {
      const fixture = await legacySealedReceipt(receipt);

      await expect(
        createLocalPluginAssetStagingStore({
          dataDir: fixture.dataDir,
        }).resolve({
          projectId: fixture.identity.projectId,
          projectAssetId: fixture.projectAssetId,
        }),
      ).rejects.toThrow();
      await expect(
        fixture.resources.resolveStaged(fixture.resourceId),
      ).resolves.toBeUndefined();
    },
  );
});
