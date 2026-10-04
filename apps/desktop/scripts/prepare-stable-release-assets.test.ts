import { describe, expect, it } from "vitest";

import {
  compareStableVersions,
  listStableVersions,
  macZipBlockmapName,
  previousStableVersion,
} from "./prepare-stable-release-assets.ts";

describe("prepare-stable-release-assets", () => {
  it("orders semver tags and finds the previous stable version", () => {
    const tags = ["v0.1.0", "v0.2.0", "v0.2.1", "desktop-preview", "v0.1.5"];
    expect(listStableVersions(tags)).toEqual(["0.1.0", "0.1.5", "0.2.0", "0.2.1"]);
    expect(previousStableVersion("0.2.1", tags)).toBe("0.2.0");
    expect(compareStableVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
  });

  it("names stable mac zip blockmaps with the packaged semver", () => {
    expect(macZipBlockmapName("0.2.0")).toBe(
      "Clash-Desktop-0.2.0-macOS-arm64.zip.blockmap",
    );
  });
});
