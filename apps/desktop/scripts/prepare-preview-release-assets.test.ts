import { describe, expect, it } from "vitest";

import { previousPreviewBlockmapAsset } from "./prepare-preview-release-assets.ts";

describe("prepare-preview-release-assets", () => {
  it("picks the newest preview blockmap older than the current version", () => {
    const assets = [
      "Clash-Desktop-0.1.0-preview.910001-macOS-arm64.zip.blockmap",
      "Clash-Desktop-0.1.0-preview.910002-macOS-arm64.zip.blockmap",
      "Clash-Desktop-0.1.0-preview.910005-macOS-arm64.zip.blockmap",
    ];
    expect(
      previousPreviewBlockmapAsset("0.1.0-preview.910003", assets),
    ).toBe("Clash-Desktop-0.1.0-preview.910002-macOS-arm64.zip.blockmap");
    expect(previousPreviewBlockmapAsset("0.1.0-preview.910002", assets)).toBe(
      "Clash-Desktop-0.1.0-preview.910001-macOS-arm64.zip.blockmap",
    );
  });
});
