import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";

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

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-import-streaming-"));
  temporaryDirectories.push(clashRoot);
  const app = createApp({
    dataDir: join(clashRoot, "local-api"),
    clashRoot,
    userId: "local-user",
    inspectAssetResource: async ({ resource }) => ({
      width: 1,
      height: 1,
      rotationDegrees: 0,
      contentType: resource.contentType ?? "image/png",
    }),
  });
  return { app, clashRoot };
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
  },
  {
    name: "global",
    collection: "http://127.0.0.1:49152/api/v1/libraries/personal/assets",
    idField: "globalAssetId",
    errorCode: "INVALID_GLOBAL_ASSET_IMPORT",
  },
] as const;

describe("import-file accepts the file as a streamed request body", () => {
  for (const scope of scopes) {
    it(`${scope.name}: a multi-chunk body lands on the same content address as the multipart upload`, async () => {
      const { app, clashRoot } = await fixture();
      const bytes = new Uint8Array(randomBytes(256 * 1024 + 17));
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

      // The file never reached the whole-bytes entry point, and the streamed
      // body was hashed and written as it arrived rather than reassembled.
      expect(staging.wholeByteDigests).not.toContain(digest);
      expect(staging.streamChunkCounts).toHaveLength(2);
      expect(staging.streamChunkCounts[1]).toBeGreaterThan(1);
    });

    it(`${scope.name}: a body that contradicts its declared byte length publishes nothing`, async () => {
      const { app } = await fixture();
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
      expect((await longer.json()).code).toBe(scope.errorCode);

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
    });
  }

  for (const scope of scopes) {
    it(`${scope.name}: Content-Length declares the byte length when the query omits byteLength`, async () => {
      const { app } = await fixture();
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
      expect((await contradicted.json()).code).toBe(scope.errorCode);

      // A chunked body carries no Content-Length, so nothing declares it.
      const undeclared = await importWith("asset:undeclared", {});
      expect(undeclared.status).toBe(400);
      expect((await undeclared.json()).code).toBe(scope.errorCode);

      const listed = await (await app.request(scope.collection)).json();
      expect(listed.assets.map((asset: { id: string }) => asset.id)).toEqual([
        "asset:content-length",
      ]);
    });
  }

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
