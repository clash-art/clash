import { describe, expect, it } from "vitest";

import {
  PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES,
  assetImportMetadataHintFields,
  assetImportRequest,
  sanitizeAssetImportMetadataHints,
  type AssetImportFile,
} from "./asset-import-request.js";

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

/** A source whose declared size is independent of what its stream yields. */
function source(size: number): AssetImportFile & { opened: number } {
  return {
    size,
    type: "video/mp4",
    opened: 0,
    stream() {
      this.opened += 1;
      return new Blob([bytes]).stream();
    },
  };
}

function request(
  file: AssetImportFile,
  onProgress?: Parameters<typeof assetImportRequest>[0]["onProgress"],
) {
  return assetImportRequest({
    url: "http://host.test/import-file",
    file,
    fileName: "clip.mp4",
    fields: { kind: "video" },
    headers: {},
    ...(onProgress ? { onProgress } : {}),
  });
}

describe("assetImportRequest", () => {
  it("sends a Blob as the body itself and declares its size", () => {
    const file = new Blob([bytes], { type: "video/mp4" });

    const { url, init } = request(file);

    expect(init.body).toBe(file);
    expect("duplex" in init).toBe(false);
    expect(new URL(url).searchParams.get("byteLength")).toBe(
      String(bytes.byteLength),
    );
  });

  it("streams a source that is not a Blob and declares the size the source states", async () => {
    // Past 2^32: the length a file-backed Blob would have wrapped.
    const file = source(2 ** 32 + bytes.byteLength);

    const { url, init } = request(file);

    expect(new URL(url).searchParams.get("byteLength")).toBe(String(file.size));
    expect(new Headers(init.headers).get("content-type")).toBe("video/mp4");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect((init as { duplex?: string }).duplex).toBe("half");
    expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(
      bytes,
    );
  });

  it("opens a fresh stream for each request built from one source", () => {
    const file = source(bytes.byteLength);

    request(file);
    request(file);

    expect(file.opened).toBe(2);
  });

  it("reports progress against the size the source states", async () => {
    const file = source(2 ** 32 + bytes.byteLength);
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    const { init } = request(file, (event) => progress.push(event));
    await new Response(init.body).arrayBuffer();

    expect(progress.at(-1)).toEqual({
      loadedBytes: bytes.byteLength,
      totalBytes: file.size,
    });
  });

  it("carries only bounded metadata hints in the query", () => {
    const { url } = assetImportRequest({
      url: "http://host.test/import-file",
      file: new Blob([bytes], { type: "video/mp4" }),
      fileName: "clip.mp4",
      fields: { kind: "video" },
      headers: {},
      metadataHints: {
        durationMs: 1_500,
        width: 1_920,
        height: 1_080,
        frameRate: 29.97,
        hasAudio: true,
      },
    });
    const query = new URL(url).searchParams;
    expect(query.get("durationMs")).toBe("1500");
    expect(query.get("width")).toBe("1920");
    expect(query.get("height")).toBe("1080");
    expect(query.get("frameRate")).toBe("29.97");
    expect(query.get("hasAudio")).toBe("true");
  });

  it("drops invalid hints and exposes the 64 MiB single-shot boundary", () => {
    expect(
      sanitizeAssetImportMetadataHints({
        durationMs: -1,
        width: Number.POSITIVE_INFINITY,
        height: 20_000,
        frameRate: 0,
        hasAudio: "true",
      }),
    ).toEqual({ hasAudio: true });
    expect(assetImportMetadataHintFields({ width: 10 })).toEqual({
      width: "10",
    });
    expect(PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});
