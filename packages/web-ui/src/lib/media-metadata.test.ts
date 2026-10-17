import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProjectAssetMetadata } from "./media-metadata";

afterEach(() => vi.unstubAllGlobals());

describe("probeProjectAssetMetadata", () => {
  it("resolves immediately with no hints where the browser cannot decode", async () => {
    const started = Date.now();
    const file = (type: string) => new File([new Uint8Array(8)], "f", { type });
    expect(await probeProjectAssetMetadata(file("image/png"), "image")).toEqual({});
    expect(await probeProjectAssetMetadata(file("video/mp4"), "video")).toEqual({});
    expect(await probeProjectAssetMetadata(file("audio/mpeg"), "audio")).toEqual({ hasAudio: true });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reads image dimensions from a decoded bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", async () => ({ width: 64, height: 32, close }));
    expect(
      await probeProjectAssetMetadata(new File([new Uint8Array(8)], "a.png", { type: "image/png" }), "image"),
    ).toEqual({ width: 64, height: 32 });
    expect(close).toHaveBeenCalled();
  });

  it("never rejects when decoding fails", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("bad image");
    });
    expect(
      await probeProjectAssetMetadata(new File([new Uint8Array(8)], "a.png", { type: "image/png" }), "image"),
    ).toEqual({});
  });
});
