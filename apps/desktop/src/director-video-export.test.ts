import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  directorVideoLocalFileUrl,
  directorVideoSourceUrl,
  exportDirectorVideoToFile,
  safeDirectorVideoExportName,
} from "./director-video-export";
import type { TransferFetch } from "./file-transfer";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clash-director-export-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function bodyResponse(chunks: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}

function streamFetch(chunks: string[]): TransferFetch {
  return async (url) =>
    url.endsWith("/local-file")
      ? new Response("not a local asset", { status: 404 })
      : bodyResponse(chunks);
}

describe("desktop Director camera video export", () => {
  it("creates a safe WebM filename from the Stage and camera names", () => {
    expect(safeDirectorVideoExportName("  Lobby / Blocking  ", "Camera #2")).toBe(
      "Lobby-Blocking-Camera-2.webm",
    );
    expect(safeDirectorVideoExportName("***", "***")).toBe("director-camera.webm");
  });

  it("accepts only HTTP(S) media URLs", () => {
    expect(directorVideoSourceUrl("http://127.0.0.1:1234/media")).toBe(
      "http://127.0.0.1:1234/media",
    );
    expect(() => directorVideoSourceUrl("file:///tmp/a.webm")).toThrow(
      "must be an HTTP(S) URL",
    );
    expect(() => directorVideoSourceUrl("")).toThrow(
      "requires the published camera video URL",
    );
    try {
      directorVideoSourceUrl("file:///tmp/a.webm");
    } catch (error) {
      expect(error).toMatchObject({
        code: "DIRECTOR_VIDEO_EXPORT_SOURCE_INVALID",
      });
    }
  });

  it("maps a loopback media URL to the Host local-file projection", () => {
    expect(
      directorVideoLocalFileUrl(
        "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media?download=1",
      ),
    ).toBe("http://127.0.0.1:1234/api/v1/projects/p/assets/a/local-file");
    expect(
      directorVideoLocalFileUrl("https://clash.example/api/v1/assets/a/media"),
    ).toBeUndefined();
    expect(directorVideoLocalFileUrl("http://127.0.0.1:1234/elsewhere")).toBeUndefined();
    expect(
      directorVideoLocalFileUrl(
        "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media",
        "http://127.0.0.1:9999",
      ),
    ).toBeUndefined();
  });

  it("copies the already-published local Host file without downloading its bytes", async () => {
    const root = await tempRoot();
    const source = join(root, "published.webm");
    const target = join(root, "camera.webm");
    await writeFile(source, "local-webm-bytes");
    const calls: string[] = [];
    const fetchImpl: TransferFetch = async (url) => {
      calls.push(url);
      if (!url.endsWith("/local-file")) {
        return new Response("the media route must not be used", { status: 500 });
      }
      return Response.json({ path: source, byteLength: 16 });
    };

    const result = await exportDirectorVideoToFile(
      {
        targetPath: target,
        sourceUrl: "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media",
      },
      { fetchImpl, localFileOrigin: "http://127.0.0.1:1234" },
    );

    expect(result).toEqual({ outputPath: target, bytes: 16 });
    expect(await readFile(target, "utf8")).toBe("local-webm-bytes");
    expect(calls).toEqual([
      "http://127.0.0.1:1234/api/v1/projects/p/assets/a/local-file",
    ]);
    expect((await readdir(root)).sort()).toEqual(["camera.webm", "published.webm"]);
  });

  it("fails a local copy with a coded error and leaves no partial target", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");
    const fetchImpl: TransferFetch = async () =>
      Response.json({ path: join(root, "missing.webm"), byteLength: 10 });

    await expect(
      exportDirectorVideoToFile(
        {
          targetPath: target,
          sourceUrl: "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED" });

    expect(await readdir(root)).toEqual([]);
  });

  it("does not use local-file for a source outside the Host origin", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");
    const calls: string[] = [];
    const fetchImpl: TransferFetch = async (url) => {
      calls.push(url);
      return bodyResponse(["remote-webm"]);
    };

    const result = await exportDirectorVideoToFile(
      { targetPath: target, sourceUrl: "http://127.0.0.1:9/media" },
      {
        fetchImpl,
        localFileOrigin: "http://127.0.0.1:1234",
      },
    );

    expect(result.bytes).toBe(11);
    expect(calls).toEqual(["http://127.0.0.1:9/media"]);
  });

  it("streams the published Host video when no local file is exposed", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");

    const result = await exportDirectorVideoToFile(
      { targetPath: target, sourceUrl: "http://127.0.0.1:9/media" },
      {
        fetchImpl: streamFetch(["webm-head", "-webm-body"]),
      },
    );

    expect(result).toEqual({ outputPath: target, bytes: 19 });
    expect(await readFile(target, "utf8")).toBe("webm-head-webm-body");
    expect(await readdir(root)).toEqual(["camera.webm"]);
  });

  it("fails a non-2xx Host response with a coded error and no target", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");

    await expect(
      exportDirectorVideoToFile(
        { targetPath: target, sourceUrl: "http://127.0.0.1:9/media" },
        {
          fetchImpl: async (url) =>
            url.endsWith("/local-file")
              ? new Response("not local", { status: 404 })
              : new Response("missing", { status: 404 }),
        },
      ),
    ).rejects.toMatchObject({ code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED" });

    expect(await readdir(root)).toEqual([]);
  });

  it("fails a stalled Host transfer inside the timeout and leaves no partial file", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");
    const stalled: typeof fetch = (input, init) =>
      String(input).endsWith("/local-file")
        ? Promise.resolve(new Response("not local", { status: 404 }))
        : new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });

    await expect(
      exportDirectorVideoToFile(
        { targetPath: target, sourceUrl: "http://127.0.0.1:9/media" },
        { fetchImpl: stalled, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED" });

    expect(await readdir(root)).toEqual([]);
  });

  it("removes the temp file when the response body fails mid-transfer", async () => {
    const root = await tempRoot();
    const target = join(root, "camera.webm");
    const failingBody = () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("connection reset"));
        },
      }), { status: 200 });

    await expect(
      exportDirectorVideoToFile(
        { targetPath: target, sourceUrl: "http://127.0.0.1:9/media" },
        {
          fetchImpl: async (url) =>
            url.endsWith("/local-file")
              ? new Response("not local", { status: 404 })
              : failingBody(),
        },
      ),
    ).rejects.toMatchObject({ code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED" });

    expect(await readdir(root)).toEqual([]);
  });
});
