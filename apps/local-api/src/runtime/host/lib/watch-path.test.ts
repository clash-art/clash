import { describe, expect, it, vi } from "vitest";
import { watchablePath } from "./watch-path.js";

const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\clash-smoke\\home-a";
const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\clash-smoke\\home-a";

describe("watchablePath", () => {
  it.each(["linux", "darwin"] as const)(
    "returns the input untouched on %s without resolving it",
    (platform) => {
      const realpathNative = vi.fn(() => "/resolved/elsewhere");
      expect(watchablePath("/tmp/link/home", { platform, realpathNative })).toBe(
        "/tmp/link/home",
      );
      expect(realpathNative).not.toHaveBeenCalled();
    },
  );

  it("canonicalises through realpath.native on win32", () => {
    const realpathNative = vi.fn(() => LONG);
    expect(watchablePath(SHORT, { platform: "win32", realpathNative })).toBe(LONG);
    expect(realpathNative).toHaveBeenCalledWith(SHORT);
  });

  it("falls back to the input on win32 when the path cannot be resolved", () => {
    const realpathNative = vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(watchablePath(SHORT, { platform: "win32", realpathNative })).toBe(SHORT);
  });
});
