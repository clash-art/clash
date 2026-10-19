import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import type { LocalProjectAssetReplica } from "./local-project-assets.js";
import {
  PROJECT_ASSET_DUPLICATE_CONTENT,
  PROJECT_ASSET_ID_COLLISION,
  PROJECT_ASSET_IMPORT_DIGEST_MISMATCH,
  PROJECT_ASSET_IMPORT_FAILED,
  PROJECT_ASSET_IMPORT_REPLAY_HEADER,
  PROJECT_ASSET_TRASHED,
} from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";

const nodeRequire = createRequire(import.meta.url);

const ORIGIN = "http://127.0.0.1:49152";
const temporaryDirectories: string[] = [];
const { createApp, close: closeApps } = managedLocalApiApps();

afterEach(async () => {
  await closeApps();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    projectAssetReplica?: LocalProjectAssetReplica;
    /** Skip Project creation when the replica itself is under test. */
    createProject?: boolean;
  } = {},
) {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-import-session-"));
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const inspections = { count: 0 };
  const app = createApp({
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => ORIGIN,
    ...(options.projectAssetReplica
      ? { projectAssetReplica: options.projectAssetReplica }
      : {}),
    inspectAssetResource: async ({ resource }) => {
      inspections.count += 1;
      return {
        width: 1,
        height: 1,
        rotationDegrees: 0,
        contentType: resource.contentType ?? "image/png",
      };
    },
    // Keep representation scheduling out of the replay assertions.
    assetRepresentations: {
      start: async () => undefined,
      schedule: () => undefined,
      ensure: async () => undefined,
      read: async () => undefined,
      openThumbnail: async () => undefined,
      openProxy: async () => undefined,
    } as never,
  });
  if (options.createProject === false) {
    return {
      app,
      clashRoot,
      dataDir,
      projectId: "project-without-a-replica",
      inspections,
      resetInspections: () => {
        inspections.count = 0;
      },
    };
  }
  const created = await app.request(`${ORIGIN}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Import sessions" }),
  });
  expect(created.status).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  return {
    app,
    clashRoot,
    dataDir,
    projectId,
    inspections,
    resetInspections: () => {
      inspections.count = 0;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

type Bytes = Uint8Array<ArrayBuffer>;

function importForm(input: {
  bytes: Bytes;
  name?: string;
  contentType?: string;
  duplicateContent?: "allow" | "reject";
}): FormData {
  const form = new FormData();
  form.set(
    "file",
    new File(
      [input.bytes],
      input.name ?? "frame.png",
      { type: input.contentType ?? "image/png" },
    ),
  );
  form.set("kind", "image");
  if (input.duplicateContent)
    form.set("duplicateContent", input.duplicateContent);
  return form;
}

async function importSingleShot(
  f: Fixture,
  input: {
    projectAssetId: string;
    bytes: Bytes;
    duplicateContent?: "allow" | "reject";
  },
): Promise<Response> {
  const form = importForm(input);
  form.set("projectAssetId", input.projectAssetId);
  return f.app.request(
    `${ORIGIN}/api/v1/projects/${f.projectId}/assets/import-file`,
    { method: "POST", body: form },
  );
}

let uploadSequence = 0;

function digestOf(bytes: Bytes): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createImportSession(
  f: Fixture,
  input: {
    projectAssetId: string;
    bytes: Bytes;
    sha256?: string;
    duplicateContent?: "allow" | "reject";
  },
): Promise<Response> {
  return f.app.request(
    `${ORIGIN}/api/v1/projects/${f.projectId}/assets/import-sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "image",
        projectAssetId: input.projectAssetId,
        fileName: "frame.png",
        byteLength: input.bytes.byteLength,
        contentType: "image/png",
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.duplicateContent
          ? { duplicateContent: input.duplicateContent }
          : {}),
      }),
    },
  );
}

async function uploadAndFinalize(
  f: Fixture,
  created: Response,
  bytes: Bytes,
): Promise<Response> {
  expect(created.status, await created.clone().text()).toBe(201);
  const session = (await created.json()) as {
    sessionId: string;
    upload: { url: string };
  };
  uploadSequence += 1;
  const uploadId = `import-test-upload-${String(uploadSequence).padStart(4, "0")}`;
  const upload = (query: string, body?: Bytes) =>
    f.app.request(`${session.upload.url}?upload=${query}&uploadId=${uploadId}`, {
      method: "PUT",
      ...(body ? { body } : {}),
    });
  expect((await upload("begin")).status).toBe(200);
  expect((await upload("part&partNumber=1", bytes)).status).toBe(204);
  expect((await upload("complete")).status).toBe(204);
  return f.app.request(
    `${ORIGIN}/api/v1/projects/${f.projectId}/assets/import-sessions/${encodeURIComponent(session.sessionId)}/finalize`,
    { method: "POST" },
  );
}

async function importChunked(
  f: Fixture,
  input: {
    projectAssetId: string;
    bytes: Bytes;
    sha256?: string;
    duplicateContent?: "allow" | "reject";
  },
): Promise<Response> {
  const created = await createImportSession(f, input);
  return uploadAndFinalize(f, created, input.bytes);
}

async function objectFiles(f: Fixture): Promise<string[]> {
  const entries = await readdir(
    join(f.dataDir, "asset-import-sessions", "objects"),
    { recursive: true, withFileTypes: true },
  ).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function localResourceCount(f: Fixture): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): { get(): { count?: unknown }; run(): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(f.dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM local_resources")
      .get();
    return Number(row?.count ?? 0);
  } catch {
    // A fresh Host has no Resource table until its first write.
    return 0;
  } finally {
    database.close();
  }
}

async function sealedOriginalCount(f: Fixture): Promise<number> {
  const entries = await readdir(join(f.clashRoot, "assets", "blobs"), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries.filter(
    (entry) => entry.isFile() && entry.name.startsWith("original."),
  ).length;
}

describe("chunked Project Asset imports", () => {
  it("answers duplicate content with the single-shot 409 code and leaves no session object", async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(randomBytes(300 * 1024 + 11));
    const first = await importSingleShot(f, {
      projectAssetId: "asset:first",
      bytes,
      duplicateContent: "reject",
    });
    expect(first.status, await first.clone().text()).toBe(201);

    const chunked = await importChunked(f, {
      projectAssetId: "asset:chunked-duplicate",
      bytes,
      duplicateContent: "reject",
    });
    expect(chunked.status, await chunked.clone().text()).toBe(409);
    const chunkedBody = (await chunked.json()) as {
      code?: string;
      existingProjectAssetIds?: string[];
    };
    expect(chunkedBody).toMatchObject({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      existingProjectAssetIds: ["asset:first"],
    });
    expect(await objectFiles(f)).toEqual([]);

    const single = await importSingleShot(f, {
      projectAssetId: "asset:single-duplicate",
      bytes,
      duplicateContent: "reject",
    });
    expect(single.status, await single.clone().text()).toBe(409);
    const singleBody = (await single.json()) as {
      code?: string;
      existingProjectAssetIds?: string[];
    };
    // The same failing condition returns the same code on both transports.
    expect(singleBody.code).toBe(chunkedBody.code);
    expect(singleBody.existingProjectAssetIds).toEqual(
      chunkedBody.existingProjectAssetIds,
    );
  });

  it("returns an explicit replay for identical bytes under the same id on both paths", async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(randomBytes(300 * 1024 + 11));
    const first = await importSingleShot(f, {
      projectAssetId: "asset:same",
      bytes,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const original = (await first.json()) as { id: string };
    f.resetInspections();

    const replaySingle = await importSingleShot(f, {
      projectAssetId: "asset:same",
      bytes,
    });
    expect(replaySingle.status, await replaySingle.clone().text()).toBe(200);
    expect(replaySingle.headers.get(PROJECT_ASSET_IMPORT_REPLAY_HEADER)).toBe(
      "true",
    );
    await expect(replaySingle.json()).resolves.toMatchObject({
      id: original.id,
    });
    expect(f.inspections.count).toBe(0);

    const replayChunked = await importChunked(f, {
      projectAssetId: "asset:same",
      bytes,
    });
    expect(replayChunked.status, await replayChunked.clone().text()).toBe(200);
    expect(replayChunked.headers.get(PROJECT_ASSET_IMPORT_REPLAY_HEADER)).toBe(
      "true",
    );
    await expect(replayChunked.json()).resolves.toMatchObject({
      id: original.id,
    });
    expect(f.inspections.count).toBe(0);
    expect(await objectFiles(f)).toEqual([]);
  });

  it("rejects different bytes under the same id with PROJECT_ASSET_ID_COLLISION and no staged bytes", async () => {
    const f = await fixture();
    const originalBytes = Uint8Array.from(randomBytes(300 * 1024 + 11));
    const differentBytes = Uint8Array.from(randomBytes(300 * 1024 + 12));
    const first = await importSingleShot(f, {
      projectAssetId: "asset:stable",
      bytes: originalBytes,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const resourcesBefore = localResourceCount(f);
    const sealedBefore = await sealedOriginalCount(f);

    const chunked = await importChunked(f, {
      projectAssetId: "asset:stable",
      bytes: differentBytes,
    });
    expect(chunked.status, await chunked.clone().text()).toBe(409);
    await expect(chunked.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    expect(await objectFiles(f)).toEqual([]);
    expect(localResourceCount(f)).toBe(resourcesBefore);
    expect(await sealedOriginalCount(f)).toBe(sealedBefore);
    const differentDigest = createHash("sha256")
      .update(differentBytes)
      .digest("hex");
    await expect(
      stat(join(f.clashRoot, "assets", "blobs", differentDigest, "staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const single = await importSingleShot(f, {
      projectAssetId: "asset:stable",
      bytes: differentBytes,
    });
    expect(single.status, await single.clone().text()).toBe(409);
    await expect(single.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    // The single-shot collision does not leave its staging copy behind either.
    await expect(
      stat(join(f.clashRoot, "assets", "blobs", differentDigest, "staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(localResourceCount(f)).toBe(resourcesBefore);
    expect(await sealedOriginalCount(f)).toBe(sealedBefore);
  });

  it("decides a digest replay/duplicate/collision/trashed before creating a session", async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(randomBytes(300 * 1024 + 11));
    const different = Uint8Array.from(randomBytes(300 * 1024 + 12));
    const sha = digestOf(bytes);
    const first = await importSingleShot(f, {
      projectAssetId: "asset:decided",
      bytes,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const original = (await first.json()) as { id: string };
    const resourcesBefore = localResourceCount(f);
    const sealedBefore = await sealedOriginalCount(f);

    const replay = await createImportSession(f, {
      projectAssetId: "asset:decided",
      bytes,
      sha256: sha,
    });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(replay.headers.get(PROJECT_ASSET_IMPORT_REPLAY_HEADER)).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({ id: original.id });

    const duplicate = await createImportSession(f, {
      projectAssetId: "asset:other",
      bytes,
      sha256: sha,
      duplicateContent: "reject",
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      existingProjectAssetIds: ["asset:decided"],
    });

    const collision = await createImportSession(f, {
      projectAssetId: "asset:decided",
      bytes: different,
      sha256: digestOf(different),
    });
    expect(collision.status, await collision.clone().text()).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });

    const trashed = await importSingleShot(f, {
      projectAssetId: "asset:trashed",
      bytes: different,
    });
    expect(trashed.status, await trashed.clone().text()).toBe(201);
    const deleted = await f.app.request(
      `${ORIGIN}/api/v1/projects/${f.projectId}/assets/${encodeURIComponent("asset:trashed")}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:digest-decision" }),
      },
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const trashedDecision = await createImportSession(f, {
      projectAssetId: "asset:trashed",
      bytes: different,
      sha256: digestOf(different),
    });
    expect(trashedDecision.status, await trashedDecision.clone().text()).toBe(
      409,
    );
    await expect(trashedDecision.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_TRASHED",
    });

    // No decision issued an upload URL or wrote resource bytes.
    expect(await objectFiles(f)).toEqual([]);
    expect(localResourceCount(f)).toBe(resourcesBefore + 1);
    expect(await sealedOriginalCount(f)).toBe(sealedBefore + 1);

    // An older client with no digest still gets the ordinary session path.
    const legacy = await createImportSession(f, {
      projectAssetId: "asset:legacy",
      bytes: different,
    });
    expect(legacy.status, await legacy.clone().text()).toBe(201);
    await expect(legacy.json()).resolves.toMatchObject({
      upload: { url: expect.stringContaining("import-sessions") },
    });
  });

  it("maps an inspect ENOENT through the coded error response instead of a false conflict", async () => {
    const failure = Object.assign(
      new Error(
        `ENOENT: no such file or directory, open '/tmp/${randomUUID()}.bin'`,
      ),
      { code: "ENOENT" },
    );
    const f = await fixture({
      createProject: false,
      projectAssetReplica: {
        inspect: async () => {
          throw failure;
        },
        mutate: async () => {
          throw failure;
        },
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createImportSession(f, {
        projectAssetId: "asset:enoent",
        bytes: Uint8Array.from(randomBytes(32)),
        sha256: "a".repeat(64),
      });
      // Not a fabricated 409: the route's coded 5xx mapping owns the failure.
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: failure.message,
        code: PROJECT_ASSET_IMPORT_FAILED,
      });
      const records = logged.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line)) as {
              event?: unknown;
              context?: unknown;
            };
          } catch {
            return undefined;
          }
        })
        .filter((record) => record !== undefined);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "project_asset_import.failed",
          context: expect.objectContaining({
            code: PROJECT_ASSET_IMPORT_FAILED,
            status: 500,
            message: failure.message,
          }),
        }),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("returns each create-time conflict body exactly as the finalize path does", async () => {
    const f = await fixture();
    const shared = Uint8Array.from(randomBytes(2048));
    const other = Uint8Array.from(randomBytes(2048));
    const imported = [
      ["asset:conflict-original", shared],
      ["asset:conflict-duplicate", shared],
      ["asset:conflict-stable", shared],
      ["asset:conflict-trashed", other],
    ] as const;
    for (const [projectAssetId, bytes] of imported) {
      const response = await importSingleShot(f, { projectAssetId, bytes });
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const deleted = await f.app.request(
      `${ORIGIN}/api/v1/projects/${f.projectId}/assets/${encodeURIComponent("asset:conflict-trashed")}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:conflict-parity" }),
      },
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const cases = [
      {
        code: PROJECT_ASSET_DUPLICATE_CONTENT,
        projectAssetId: "asset:requested-duplicate",
        bytes: shared,
        duplicateContent: "reject" as const,
      },
      {
        code: PROJECT_ASSET_ID_COLLISION,
        projectAssetId: "asset:conflict-stable",
        bytes: other,
      },
      {
        code: PROJECT_ASSET_TRASHED,
        projectAssetId: "asset:conflict-trashed",
        bytes: other,
      },
    ];
    for (const conflict of cases) {
      const decided = await createImportSession(f, {
        projectAssetId: conflict.projectAssetId,
        bytes: conflict.bytes,
        sha256: digestOf(conflict.bytes),
        ...(conflict.duplicateContent
          ? { duplicateContent: conflict.duplicateContent }
          : {}),
      });
      expect(decided.status, await decided.clone().text()).toBe(409);
      const decidedBody = await decided.json();
      expect(decidedBody).toMatchObject({ code: conflict.code });

      // The same failure at finalize is mapped by the route; both transports
      // must return one body shape for it.
      const finalized = await importChunked(f, {
        projectAssetId: conflict.projectAssetId,
        bytes: conflict.bytes,
        ...(conflict.duplicateContent
          ? { duplicateContent: conflict.duplicateContent }
          : {}),
      });
      expect(finalized.status, await finalized.clone().text()).toBe(409);
      await expect(finalized.json()).resolves.toEqual(decidedBody);
    }
  });

  it("rejects a finalize whose assembly does not match the declared digest and deletes staging", async () => {
    const f = await fixture();
    const bytes = Uint8Array.from(randomBytes(300 * 1024 + 11));
    const different = Uint8Array.from(bytes);
    different[different.length - 1] ^= 0xff;
    const resourcesBefore = localResourceCount(f);
    const created = await createImportSession(f, {
      projectAssetId: "asset:digest",
      bytes,
      sha256: digestOf(bytes),
    });
    const finalized = await uploadAndFinalize(f, created, different);
    expect(finalized.status, await finalized.clone().text()).toBe(409);
    await expect(finalized.json()).resolves.toMatchObject({
      code: PROJECT_ASSET_IMPORT_DIGEST_MISMATCH,
    });
    expect(await objectFiles(f)).toEqual([]);
    expect(localResourceCount(f)).toBe(resourcesBefore);
    await expect(
      stat(join(f.clashRoot, "assets", "blobs", digestOf(different), "staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
