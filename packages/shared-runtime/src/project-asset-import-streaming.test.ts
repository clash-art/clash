import { createHash, randomBytes } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPersonalGlobalAssetHostClient,
  createProjectAssetHostClient,
} from "./project-asset-client.js";

const readyAsset = {
  id: "asset:one",
  kind: "video" as const,
  name: "clip.mp4",
  metadata: { bytes: 4, contentType: "video/mp4" },
  provenance: { kind: "import" as const },
  lifecycle: { state: "active" as const },
  status: "ready" as const,
  url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone/media",
};

interface ReceivedImport {
  url: URL;
  headers: IncomingHttpHeaders;
  chunkCount: number;
  byteLength: number;
  sha256: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A loopback stand-in for the Host import-file route. It hashes the body as it
 * arrives and never holds it, so the test observes the client's real transport.
 */
async function recordingHost() {
  const received: ReceivedImport[] = [];
  const server = createServer((request, response) => {
    const digest = createHash("sha256");
    let chunkCount = 0;
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      chunkCount += 1;
      byteLength += chunk.byteLength;
      digest.update(chunk);
    });
    request.on("end", () => {
      received.push({
        url: new URL(request.url ?? "/", "http://host.test"),
        headers: request.headers,
        chunkCount,
        byteLength,
        sha256: digest.digest("hex"),
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(readyAsset));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, received };
}

/** A file large enough that no transport can deliver it as one chunk. */
async function multiChunkFile() {
  const directory = await mkdtemp(join(tmpdir(), "clash-import-stream-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "clip.mp4");
  const bytes = randomBytes(3 * 1024 * 1024 + 123);
  await writeFile(path, bytes);
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("Asset Host clients stream an imported file to the Host", () => {
  it("sends a file-backed Blob as the request body, chunk by chunk, with its declared length", async () => {
    const host = await recordingHost();
    const file = await multiChunkFile();
    const client = createProjectAssetHostClient({
      endpoint: host.endpoint,
      env: {},
    });

    await client.importFile({
      projectId: "project-a",
      file: await openAsBlob(file.path, { type: "video/mp4" }),
      fileName: "clip.mp4",
      kind: "video",
      projectAssetId: "asset:one",
      duplicateContent: "reject",
    });

    expect(host.received).toHaveLength(1);
    const upload = host.received[0]!;
    expect(upload.url.pathname).toBe(
      "/api/v1/projects/project-a/assets/import-file",
    );
    expect(Object.fromEntries(upload.url.searchParams)).toEqual({
      kind: "video",
      projectAssetId: "asset:one",
      duplicateContent: "reject",
      fileName: "clip.mp4",
      byteLength: String(file.byteLength),
    });
    // The body is the file itself: no multipart envelope, no re-encoding.
    expect(upload.headers["content-type"]).toBe("video/mp4");
    expect(upload.headers["content-length"]).toBe(String(file.byteLength));
    expect(upload.byteLength).toBe(file.byteLength);
    expect(upload.sha256).toBe(file.sha256);
    expect(upload.chunkCount).toBeGreaterThan(1);
  });

  it("reports cumulative progress while streaming when a listener is given", async () => {
    const host = await recordingHost();
    const file = await multiChunkFile();
    const client = createPersonalGlobalAssetHostClient({
      endpoint: host.endpoint,
      env: {},
    });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    await client.importFile({
      file: await openAsBlob(file.path, { type: "video/mp4" }),
      fileName: "clip.mp4",
      kind: "video",
      globalAssetId: "global:one",
      onProgress: (event) => progress.push(event),
    });

    const upload = host.received[0]!;
    expect(upload.url.pathname).toBe(
      "/api/v1/libraries/personal/assets/import-file",
    );
    expect(upload.url.searchParams.get("byteLength")).toBe(
      String(file.byteLength),
    );
    expect(upload.sha256).toBe(file.sha256);
    expect(progress.length).toBeGreaterThan(1);
    expect(
      progress.every((event) => event.totalBytes === file.byteLength),
    ).toBe(true);
    expect(progress.map((event) => event.loadedBytes)).toEqual(
      [...progress.map((event) => event.loadedBytes)].sort((a, b) => a - b),
    );
    expect(progress.at(-1)?.loadedBytes).toBe(file.byteLength);
  });
});
