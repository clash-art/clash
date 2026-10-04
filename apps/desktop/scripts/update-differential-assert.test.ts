import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertDifferentialUpdate,
  differentialFailureReasons,
  parseDifferentialDownloadBytes,
  parseHumanDataSize,
} from "./update-differential-assert.ts";

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const hop2Fixture = readFileSync(
  resolve(fixtureDir, "stable-hop2-full-download-updater.fixture"),
  "utf8",
);

describe("update-differential-assert", () => {
  it("parses electron-updater KB formatting with thousands separators", () => {
    expect(parseHumanDataSize("12,615.63 KB")).toBe(Math.round(12615.63 * 1024));
  });

  it("reads differential plan bytes from DifferentialDownloader log line", () => {
    const fullPackageBytes = 181_133_316;
    const log = [
      '[desktop:updater] Download block maps (old: "...0.0.1....blockmap", new: ...)',
      "[desktop:updater] Full: 176,888.98 KB, To download: 12,615.63 KB (7%)",
    ].join("\n");
    const bytes = parseDifferentialDownloadBytes(log, fullPackageBytes);
    expect(bytes).toBe(Math.round(fullPackageBytes * 0.07));
  });

  it("detects differential failure phrases from the hop2 fixture", () => {
    const reasons = differentialFailureReasons(hop2Fixture);
    expect(reasons).toContain("Cannot download differentially");
    expect(reasons).toContain("fallback to full download");
  });

  it("fails assertDifferentialUpdate on real full-download fixture", () => {
    const fullPackageBytes = 181_133_316;
    const result = assertDifferentialUpdate(hop2Fixture, fullPackageBytes);
    expect(
      result.errors.some((error) =>
        error.includes("Cannot download differentially"),
      ),
    ).toBe(true);
    expect(
      result.errors.some((error) =>
        error.includes("fallback to full download"),
      ),
    ).toBe(true);
    expect(
      result.errors.some((error) =>
        error.includes("could not determine differential download bytes"),
      ),
    ).toBe(true);
  });

  it("passes assertDifferentialUpdate when plan shows a small differential", () => {
    const fullPackageBytes = 181_133_316;
    const log = [
      "[desktop:updater] Differential download: https://github.com/clash-art/clash/releases/latest/download/Clash-Desktop-0.2.0-macOS-arm64.zip",
      "[desktop:updater] Full: 176,888.98 KB, To download: 12,615.63 KB (7%)",
    ].join("\n");
    const result = assertDifferentialUpdate(log, fullPackageBytes);
    expect(result.errors).toEqual([]);
    expect(result.analysis.downloadedBytes).toBeLessThan(fullPackageBytes * 0.9);
  });
});
