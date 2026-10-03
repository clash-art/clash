import { describe, expect, it } from "vitest";

import {
  localizeFeedYaml,
  zipNameFromFeedYaml,
} from "./macos-update-e2e.ts";

describe("macos-update-e2e helpers", () => {
  it("reads the zip name from preview-mac.yml", () => {
    const yaml = [
      "version: 0.1.0-preview.2",
      "files:",
      "  - url: Clash-Desktop-macOS-arm64.zip",
      "    sha512: abc",
      "    size: 1",
      "path: Clash-Desktop-macOS-arm64.zip",
    ].join("\n");
    expect(zipNameFromFeedYaml(yaml)).toBe("Clash-Desktop-macOS-arm64.zip");
  });

  it("rewrites feed urls to a locally served zip", () => {
    const yaml = [
      "url: https://github.com/clash-art/clash/releases/download/desktop-preview/Clash-Desktop-macOS-arm64.zip",
      "path: Clash-Desktop-macOS-arm64.zip",
    ].join("\n");
    expect(localizeFeedYaml(yaml, "local.zip")).toContain("url: local.zip");
    expect(localizeFeedYaml(yaml, "local.zip")).toContain("path: local.zip");
  });
});
