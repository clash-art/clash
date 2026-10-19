import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const nodeRequire = createRequire(import.meta.url);
const directories: string[] = [];
const { createApp, close: closeApps } = managedLocalApiApps();

afterEach(async () => {
  await closeApps();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function stagingRowCount(dataDir: string): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { get(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM local_resource_staging")
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

async function stagingFiles(clashRoot: string): Promise<string[]> {
  const entries = await readdir(join(clashRoot, "assets", "blobs"), {
    recursive: true,
  }).catch(() => []);
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === "staging");
}

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-path-route-"));
  directories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const app = createApp({
    dataDir,
    clashRoot,
    userId: "local-user",
    inspectAssetResource: async ({ resource }) => ({
      width: 1,
      height: 1,
      rotationDegrees: 0,
      contentType: resource.contentType ?? "image/png",
    }),
  });
  return { app, clashRoot, dataDir };
}

function pathImportBody(
  sourcePath: string,
  byteLength: number,
  mtimeMs: number,
) {
  return {
    sourcePath,
    byteLength,
    mtimeMs,
    kind: "image",
    projectAssetId: "asset:path-import",
    fileName: "frame.png",
    contentType: "image/png",
  };
}

describe("Project Asset import by loopback path", () => {
  it("opens the source itself and serves the imported bytes", async () => {
    const { app, clashRoot } = await fixture();
    const bytes = new Uint8Array(1024 * 1024).fill(3);
    const sourcePath = join(clashRoot, "frame.png");
    await writeFile(sourcePath, bytes);
    const source = await stat(sourcePath);

    const response = await app.request(
      "/api/v1/projects/project-path/assets/import-path",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          pathImportBody(sourcePath, bytes.byteLength, source.mtimeMs),
        ),
      },
      LOOPBACK,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    const asset = await response.json();
    expect(asset.id).toBe("asset:path-import");
    expect(asset.metadata.bytes).toBe(bytes.byteLength);

    const media = await app.request(
      `/api/v1/projects/project-path/assets/${encodeURIComponent(asset.id)}/media`,
    );
    expect(media.status).toBe(200);
    expect(await readFile(sourcePath)).toEqual(Buffer.from(bytes));
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);

    // A later write to the user's source cannot mutate the stored Asset.
    await writeFile(sourcePath, new Uint8Array(bytes.byteLength).fill(9));
    const after = await app.request(
      `/api/v1/projects/project-path/assets/${encodeURIComponent(asset.id)}/media`,
    );
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(bytes);
  });

  it("is denied to a non-loopback peer", async () => {
    const { app, clashRoot } = await fixture();
    const sourcePath = join(clashRoot, "frame.png");
    await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4]));
    const response = await app.request(
      "/api/v1/projects/project-path/assets/import-path",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pathImportBody(sourcePath, 4, Date.now())),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "ASSET_IMPORT_PATH_LOOPBACK_ONLY",
    });
  });

  it("fails a vanished source with a coded error and leaves no staged bytes", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const response = await app.request(
      "/api/v1/projects/project-path/assets/import-path",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          pathImportBody(join(clashRoot, "missing.png"), 4, Date.now()),
        ),
      },
      LOOPBACK,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "ASSET_IMPORT_SOURCE_UNREADABLE",
      errno: "ENOENT",
    });
    expect(await stagingFiles(clashRoot)).toEqual([]);
    expect(stagingRowCount(dataDir)).toBe(0);
  });
});
