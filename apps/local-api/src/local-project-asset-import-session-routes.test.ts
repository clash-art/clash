import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import { PROJECT_ASSET_IMPORT_REPLAY_HEADER } from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";

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

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-import-session-"));
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const inspections = { count: 0 };
  const app = createApp({
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => ORIGIN,
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

async function importChunked(
  f: Fixture,
  input: {
    projectAssetId: string;
    bytes: Bytes;
    duplicateContent?: "allow" | "reject";
  },
): Promise<Response> {
  const created = await f.app.request(
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
        ...(input.duplicateContent
          ? { duplicateContent: input.duplicateContent }
          : {}),
      }),
    },
  );
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
  expect((await upload("part&partNumber=1", input.bytes)).status).toBe(204);
  expect((await upload("complete")).status).toBe(204);
  return f.app.request(
    `${ORIGIN}/api/v1/projects/${f.projectId}/assets/import-sessions/${encodeURIComponent(session.sessionId)}/finalize`,
    { method: "POST" },
  );
}

async function objectFiles(f: Fixture): Promise<string[]> {
  const entries = await readdir(
    join(f.dataDir, "asset-import-sessions", "objects"),
    { recursive: true, withFileTypes: true },
  ).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
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

    const chunked = await importChunked(f, {
      projectAssetId: "asset:stable",
      bytes: differentBytes,
    });
    expect(chunked.status, await chunked.clone().text()).toBe(409);
    await expect(chunked.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    expect(await objectFiles(f)).toEqual([]);
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
  });
});
