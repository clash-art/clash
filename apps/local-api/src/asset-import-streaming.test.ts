import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROJECT_ASSET_IMPORT_MAX_BYTES } from "@clash/asset-sdk";
import sharp from "sharp";

import {
  assertAssetImportDeclaredWithinLimit,
  PROJECT_ASSET_IMPORT_MULTIPART_FRAMING_ALLOWANCE_BYTES,
} from "./app.js";
import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * The SQLite worker migrates `local.sqlite` on the Host's first request, so a
 * request rejected before touching storage can leave no table: none staged.
 */
function stagingRowCount(dataDir: string): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): { get(...params: unknown[]): unknown };
      close(): void;
    };
  };
  if (!existsSync(join(dataDir, "local.sqlite"))) return 0;
  const database = new DatabaseSync(join(dataDir, "local.sqlite"), {
    timeout: 5_000,
  });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM local_resource_staging")
      .get() as { count: number };
    return row.count;
  } catch (error) {
    if (/no such table: local_resource_staging/.test(String(error))) return 0;
    throw error;
  } finally {
    database.close();
  }
}

async function stagingFiles(clashRoot: string): Promise<string[]> {
  const entries = await readdir(join(clashRoot, "assets", "blobs"), {
    recursive: true,
  }).catch(() => []);
  return entries.filter(
    (entry) =>
      entry.split(/[\\/]/).at(-1) === "staging" ||
      entry.split(/[\\/]/).at(-1)?.endsWith(".tmp") === true,
  );
}

/** The representation table is created lazily, so absence means none yet. */
function representationRowCount(
  dataDir: string,
  sourceResourceId: string,
): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): { get(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM local_asset_representations WHERE source_resource_id = ?",
      )
      .get(sourceResourceId) as { count: number };
    return row.count;
  } catch {
    return 0;
  } finally {
    database.close();
  }
}

/**
 * Observes the one Resource store every import stages through: which entry
 * point received the bytes, and in how many pieces.
 */
const staging = vi.hoisted(() => ({
  wholeByteDigests: [] as string[],
  streamChunkCounts: [] as number[],
}));

vi.mock("./local-resource-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./local-resource-store.js")>();
  const { createHash: hash } = await import("node:crypto");
  return {
    ...actual,
    createLocalResourceStore: (
      options: Parameters<typeof actual.createLocalResourceStore>[0],
    ) => {
      const store = actual.createLocalResourceStore(options);
      return {
        ...store,
        stage: (input: Parameters<typeof store.stage>[0]) => {
          staging.wholeByteDigests.push(
            hash("sha256").update(input.bytes).digest("hex"),
          );
          return store.stage(input);
        },
        stageStream: (input: Parameters<typeof store.stageStream>[0]) => {
          const index = staging.streamChunkCounts.push(0) - 1;
          const source = input.source;
          return store.stageStream({
            ...input,
            source: (async function* () {
              for await (const chunk of source) {
                staging.streamChunkCounts[index]! += 1;
                yield chunk as Uint8Array;
              }
            })(),
          });
        },
      };
    },
  };
});

const temporaryDirectories: string[] = [];
const { createApp, close: closeApps } = managedLocalApiApps();

afterEach(async () => {
  await closeApps();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  staging.wholeByteDigests.length = 0;
  staging.streamChunkCounts.length = 0;
});

async function fixture(
  prepare?: (paths: { clashRoot: string; dataDir: string }) => Promise<void>,
) {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-import-streaming-"));
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  await prepare?.({ clashRoot, dataDir });
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

/** A request body that only ever exists as separate chunks. */
function chunkedBody(bytes: Uint8Array, chunkByteLength: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkByteLength));
      offset += chunkByteLength;
    },
  });
}

function streamedImport(input: {
  collection: string;
  query: Record<string, string>;
  bytes: Uint8Array;
  chunkByteLength: number;
}): [string, RequestInit] {
  return [
    `${input.collection}/import-file?${new URLSearchParams(input.query)}`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: chunkedBody(input.bytes, input.chunkByteLength),
      duplex: "half",
    } as RequestInit,
  ];
}

/** Every directory below the Host root whose name is this content address. */
async function contentAddressDirectories(
  root: string,
  digest: string,
): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === digest);
}

const scopes = [
  {
    name: "project",
    collection: "http://127.0.0.1:49152/api/v1/projects/project-a/assets",
    idField: "projectAssetId",
    errorCode: "INVALID_PROJECT_ASSET_IMPORT",
    lengthMismatchCode: "PROJECT_ASSET_IMPORT_LENGTH_MISMATCH",
  },
  {
    name: "global",
    collection: "http://127.0.0.1:49152/api/v1/libraries/personal/assets",
    idField: "globalAssetId",
    errorCode: "INVALID_GLOBAL_ASSET_IMPORT",
    lengthMismatchCode: "INVALID_GLOBAL_ASSET_IMPORT",
  },
] as const;

/** A Context-shaped declaration reader: only query/header are consulted. */
function declarationLimit(
  headers: Record<string, string>,
  query: Record<string, string> = {},
): () => void {
  return () =>
    assertAssetImportDeclaredWithinLimit({
      req: {
        query: (name: string) => query[name],
        header: (name: string) => headers[name.toLowerCase()],
      },
    });
}

describe("asset import declaration limit", () => {
  const multipart = "multipart/form-data; boundary=frame";
  const framingAllowance =
    PROJECT_ASSET_IMPORT_MAX_BYTES +
    PROJECT_ASSET_IMPORT_MULTIPART_FRAMING_ALLOWANCE_BYTES;

  it("accepts a multipart body exactly at the file cap despite form framing", () => {
    expect(
      declarationLimit({
        "content-type": multipart,
        "content-length": String(PROJECT_ASSET_IMPORT_MAX_BYTES),
      }),
    ).not.toThrow();
  });

  it("accepts multipart framing up to the named allowance", () => {
    expect(
      declarationLimit({
        "content-type": multipart,
        "content-length": String(framingAllowance),
      }),
    ).not.toThrow();
    expect(
      declarationLimit({
        "content-type": multipart,
        "content-length": String(framingAllowance + 1),
      }),
    ).toThrow(/maximum byte length/);
  });

  it("holds raw bodies and the streaming byteLength to the exact cap", () => {
    expect(
      declarationLimit({
        "content-type": "video/mp4",
        "content-length": String(PROJECT_ASSET_IMPORT_MAX_BYTES + 1),
      }),
    ).toThrow(/maximum byte length/);
    expect(
      declarationLimit(
        { "content-type": multipart },
        { byteLength: String(PROJECT_ASSET_IMPORT_MAX_BYTES + 1) },
      ),
    ).toThrow(/maximum byte length/);
  });
});

describe("import-file accepts the file as a streamed request body", () => {
  for (const scope of scopes) {
    it(`${scope.name}: a multi-chunk body lands on the same content address as the multipart upload`, async () => {
      const { app, clashRoot } = await fixture();
      // A decodable image lets the default thumbnail representation actually
      // seal, so this test can wait for that background Resource too.
      const bytes = new Uint8Array(
        await sharp(randomBytes(512 * 512 * 3), {
          raw: { width: 512, height: 512, channels: 3 },
        })
          .png({ compressionLevel: 0 })
          .toBuffer(),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");

      const form = new FormData();
      form.set("file", new File([bytes], "frame.png", { type: "image/png" }));
      form.set("kind", "image");
      form.set(scope.idField, "asset:multipart");
      const multipart = await app.request(`${scope.collection}/import-file`, {
        method: "POST",
        body: form,
      });
      expect(multipart.status, await multipart.clone().text()).toBe(201);

      const streamed = await app.request(
        ...streamedImport({
          collection: scope.collection,
          query: {
            kind: "image",
            [scope.idField]: "asset:streamed",
            fileName: "frame.png",
            byteLength: String(bytes.byteLength),
          },
          bytes,
          chunkByteLength: 16 * 1024,
        }),
      );
      expect(streamed.status, await streamed.clone().text()).toBe(201);

      const multipartAsset = await multipart.json();
      const streamedAsset = await streamed.json();
      expect(streamedAsset.id).toBe("asset:streamed");
      expect(streamedAsset.metadata).toEqual(multipartAsset.metadata);
      expect(streamedAsset.metadata.bytes).toBe(bytes.byteLength);
      for (const asset of [multipartAsset, streamedAsset]) {
        const media = await app.request(
          `${scope.collection}/${encodeURIComponent(asset.id)}/media`,
        );
        expect(media.status).toBe(200);
        expect(
          createHash("sha256")
            .update(new Uint8Array(await media.arrayBuffer()))
            .digest("hex"),
        ).toBe(digest);
      }
      // Both transports resolve to one immutable blob, addressed by SHA-256.
      expect(await contentAddressDirectories(clashRoot, digest)).toHaveLength(
        1,
      );
      // A successful Project import seals the bytes and releases the staging
      // name and row instead of retaining a second directory entry forever.
      // Background representations are sealed Resources too: once the derived
      // thumbnail exists, every digest must be free of staging rows/files.
      if (scope.name === "project") {
        await vi.waitFor(
          () => {
            expect(
              representationRowCount(
                join(clashRoot, "local-api"),
                `sha256:${digest}`,
              ),
            ).toBeGreaterThan(0);
          },
          { timeout: 15_000, interval: 50 },
        );
        expect(await stagingFiles(clashRoot)).toEqual([]);
        expect(stagingRowCount(join(clashRoot, "local-api"))).toBe(0);
      }

      // The file never reached the whole-bytes entry point, and the streamed
      // body was hashed and written as it arrived rather than reassembled.
      expect(staging.wholeByteDigests).not.toContain(digest);
      expect(staging.streamChunkCounts).toHaveLength(2);
      expect(staging.streamChunkCounts[1]).toBeGreaterThan(1);
    });

    it(`${scope.name}: a body that contradicts its declared byte length publishes nothing`, async () => {
      const { app, clashRoot } = await fixture();
      const bytes = new Uint8Array(randomBytes(64 * 1024));
      const query = {
        kind: "image",
        [scope.idField]: "asset:mismatch",
        fileName: "frame.png",
      };

      const longer = await app.request(
        ...streamedImport({
          collection: scope.collection,
          query: { ...query, byteLength: String(bytes.byteLength + 1) },
          bytes,
          chunkByteLength: 16 * 1024,
        }),
      );
      expect(longer.status).toBe(400);
      expect((await longer.json()).code).toBe(scope.lengthMismatchCode);

      const undeclared = await app.request(
        ...streamedImport({
          collection: scope.collection,
          query,
          bytes,
          chunkByteLength: 16 * 1024,
        }),
      );
      expect(undeclared.status).toBe(400);
      expect((await undeclared.json()).code).toBe(scope.errorCode);

      const listed = await (await app.request(scope.collection)).json();
      expect(listed.assets).toEqual([]);
      expect(await stagingFiles(clashRoot)).toEqual([]);
      expect(stagingRowCount(join(clashRoot, "local-api"))).toBe(0);
    });
  }

  for (const scope of scopes) {
    it(`${scope.name}: Content-Length declares the byte length when the query omits byteLength`, async () => {
      const { app, clashRoot } = await fixture();
      const bytes = new Uint8Array(randomBytes(64 * 1024));
      const importWith = (id: string, headers: Record<string, string>) =>
        app.request(
          `${scope.collection}/import-file?${new URLSearchParams({
            kind: "image",
            [scope.idField]: id,
            fileName: "frame.png",
          })}`,
          {
            method: "POST",
            headers: { "content-type": "image/png", ...headers },
            body: chunkedBody(bytes, 16 * 1024),
            duplex: "half",
          } as RequestInit,
        );

      const declared = await importWith("asset:content-length", {
        "content-length": String(bytes.byteLength),
      });
      expect(declared.status, await declared.clone().text()).toBe(201);
      expect((await declared.json()).metadata.bytes).toBe(bytes.byteLength);

      // The header is held to the same check as the query field.
      const contradicted = await importWith("asset:content-length-mismatch", {
        "content-length": String(bytes.byteLength + 1),
      });
      expect(contradicted.status).toBe(400);
      expect((await contradicted.json()).code).toBe(scope.lengthMismatchCode);

      // A chunked body carries no Content-Length, so nothing declares it.
      const undeclared = await importWith("asset:undeclared", {});
      expect(undeclared.status).toBe(400);
      expect((await undeclared.json()).code).toBe(scope.errorCode);

      const listed = await (await app.request(scope.collection)).json();
      expect(listed.assets.map((asset: { id: string }) => asset.id)).toEqual([
        "asset:content-length",
      ]);
      if (scope.name === "project") {
        expect(await stagingFiles(clashRoot)).toEqual([]);
        expect(stagingRowCount(join(clashRoot, "local-api"))).toBe(0);
      }
    });
  }

  for (const scope of scopes) {
    it(`${scope.name}: an oversized declared body is rejected before any byte is read`, async () => {
      const { app, clashRoot } = await fixture();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
      });
      const response = await app.request(
        `${scope.collection}/import-file?${new URLSearchParams({
          kind: "image",
          [scope.idField]: "asset:too-large",
          fileName: "huge.png",
          byteLength: String(PROJECT_ASSET_IMPORT_MAX_BYTES + 1),
        })}`,
        {
          method: "POST",
          headers: {
            "content-type": "image/png",
            "content-length": String(PROJECT_ASSET_IMPORT_MAX_BYTES + 1),
          },
          body,
          duplex: "half",
        } as RequestInit,
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        code: "CLOUD_CONTENT_TOO_LARGE",
        maxBytes: PROJECT_ASSET_IMPORT_MAX_BYTES,
      });
      expect(await stagingFiles(clashRoot)).toEqual([]);
      expect(stagingRowCount(join(clashRoot, "local-api"))).toBe(0);
    });
  }

  it("project: a multipart Content-Length over cap + framing allowance is rejected before formData buffers it", async () => {
    const { app, clashRoot } = await fixture();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not multipart"));
        controller.close();
      },
    });
    const response = await app.request(
      `${scopes[0].collection}/import-file?kind=image&projectAssetId=asset:multipart-too-large`,
      {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=oversized",
          "content-length": String(
            PROJECT_ASSET_IMPORT_MAX_BYTES +
              PROJECT_ASSET_IMPORT_MULTIPART_FRAMING_ALLOWANCE_BYTES +
              1,
          ),
        },
        body,
        duplex: "half",
      } as RequestInit,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "CLOUD_CONTENT_TOO_LARGE",
    });
    expect(await stagingFiles(clashRoot)).toEqual([]);
    expect(stagingRowCount(join(clashRoot, "local-api"))).toBe(0);
  });

  it("project: the streamed transport honours duplicateContent against a multipart import", async () => {
    const { app } = await fixture();
    const collection = scopes[0].collection;
    const bytes = new Uint8Array(randomBytes(48 * 1024));
    const form = new FormData();
    form.set("file", new File([bytes], "frame.png", { type: "image/png" }));
    form.set("kind", "image");
    form.set("projectAssetId", "asset:first");
    expect(
      (
        await app.request(`${collection}/import-file`, {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(201);

    const duplicate = await app.request(
      ...streamedImport({
        collection,
        query: {
          kind: "image",
          projectAssetId: "asset:second",
          fileName: "frame.png",
          byteLength: String(bytes.byteLength),
          duplicateContent: "reject",
        },
        bytes,
        chunkByteLength: 16 * 1024,
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      existingProjectAssetIds: ["asset:first"],
    });
  });
});

describe("Local Resource staging sweep on Host start", () => {
  it("removes pre-existing receipt and orphan-file shapes before serving", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const seeded: string[] = [];
    const { clashRoot, dataDir } = await fixture(
      async ({ clashRoot, dataDir }) => {
        await mkdir(join(clashRoot, "assets", "blobs"), { recursive: true });
        await mkdir(dataDir, { recursive: true });
        const { DatabaseSync } = nodeRequire("node:sqlite") as {
          DatabaseSync: new (path: string, options?: { timeout?: number }) => {
            exec(sql: string): void;
            prepare(sql: string): {
              run(...params: unknown[]): unknown;
            };
            close(): void;
          };
        };
        const database = new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
        try {
          database.exec(`
          CREATE TABLE IF NOT EXISTS local_resource_staging (
            resource_id TEXT PRIMARY KEY,
            digest_sha256 TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            storage_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
        `);
          const insert = database.prepare(
            "INSERT OR IGNORE INTO local_resource_staging (resource_id, digest_sha256, byte_length, storage_key, created_at) VALUES (?, ?, ?, ?, ?)",
          );
          const [withFile, missingFile, orphanFile] = Array.from(
            { length: 3 },
            () => randomBytes(32).toString("hex"),
          );
          seeded.push(withFile, missingFile, orphanFile);
          insert.run(
            `sha256:${withFile}`,
            withFile,
            1024,
            `local-blobs/${withFile}/staging`,
            old.getTime(),
          );
          const stagedPath = join(
            clashRoot,
            "assets",
            "blobs",
            withFile,
            "staging",
          );
          await mkdir(join(clashRoot, "assets", "blobs", withFile), {
            recursive: true,
          });
          await writeFile(stagedPath, randomBytes(1024));
          await utimes(stagedPath, old, old);
          insert.run(
            `sha256:${missingFile}`,
            missingFile,
            2048,
            `local-blobs/${missingFile}/staging`,
            old.getTime(),
          );
          const orphanPath = join(
            clashRoot,
            "assets",
            "blobs",
            orphanFile,
            "staging",
          );
          await mkdir(join(clashRoot, "assets", "blobs", orphanFile), {
            recursive: true,
          });
          await writeFile(orphanPath, randomBytes(1024));
          await utimes(orphanPath, old, old);
        } finally {
          database.close();
        }
      },
    );

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && stagingRowCount(dataDir) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stagingRowCount(dataDir)).toBe(0);
    expect(await stagingFiles(clashRoot)).toEqual([]);
    for (const digest of seeded) {
      const entries = await readdir(
        join(clashRoot, "assets", "blobs", digest),
      ).catch(() => []);
      expect(entries.filter((entry) => entry === "staging")).toEqual([]);
    }
  });
});
