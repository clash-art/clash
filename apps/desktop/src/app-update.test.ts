import { describe, expect, it } from "vitest";

import {
  canInstallUpdate,
  compareAppVersions,
  electronUpdaterFeedOptions,
  feedForChannel,
  parseAppVersion,
  previewAppVersion,
  shouldAutoAcceptUpdate,
} from "./app-update.js";

describe("app-update", () => {
  it("orders stable releases above preview builds on the same x.y.z", () => {
    expect(compareAppVersions("0.2.0", "0.2.0-preview.5")).toBe(1);
    expect(compareAppVersions("0.2.0-preview.10", "0.2.0-preview.2")).toBe(8);
  });

  it("builds preview versions from the base package version", () => {
    expect(previewAppVersion("0.1.0", 910002)).toBe("0.1.0-preview.910002");
    expect(parseAppVersion("0.1.0-preview.910002")?.previewBuild).toBe(910002);
  });

  it("allows install only from a signed /Applications bundle", () => {
    expect(
      canInstallUpdate({
        platform: "darwin",
        packaged: true,
        signed: true,
        appBundlePath: "/Applications/Clash.app",
      }).ok,
    ).toBe(true);
    expect(
      canInstallUpdate({
        platform: "darwin",
        packaged: true,
        signed: true,
        appBundlePath: "/tmp/Clash.app",
      }),
    ).toEqual({ ok: false, reason: "location" });
  });

  it("points preview channel feeds at the rolling desktop-preview release", () => {
    const feed = feedForChannel("preview", {});
    expect(feed?.url).toContain("/releases/download/desktop-preview");
    expect(feed?.fileName).toBe("preview-mac.yml");
  });

  it("disables multipart range requests for GitHub generic feeds", () => {
    const feed = feedForChannel("stable", {});
    expect(feed).not.toBeNull();
    expect(electronUpdaterFeedOptions(feed!)).toEqual({
      provider: "generic",
      url: feed!.url,
      useMultipleRangeRequest: false,
    });
  });

  it("requires both e2e env vars before auto-accepting the update dialog", () => {
    expect(shouldAutoAcceptUpdate({ CLASH_UPDATE_E2E: "1" })).toBe(false);
    expect(
      shouldAutoAcceptUpdate({
        CLASH_UPDATE_E2E: "1",
        CLASH_UPDATE_ACCEPT: "1",
      }),
    ).toBe(true);
  });
});
