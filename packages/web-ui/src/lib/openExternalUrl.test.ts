// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canOpenExternalUrl, openExternalUrl } from "./openExternalUrl";

afterEach(() => {
  delete (globalThis as { __CLASH_DESKTOP__?: unknown }).__CLASH_DESKTOP__;
  vi.unstubAllGlobals();
});

describe("openExternalUrl", () => {
  it("uses __CLASH_DESKTOP__.openExternal when present", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis as { __CLASH_DESKTOP__: unknown }).__CLASH_DESKTOP__ = {
      openExternal,
    };
    await openExternalUrl("https://clash.art/billing");
    expect(openExternal).toHaveBeenCalledWith("https://clash.art/billing");
    expect(canOpenExternalUrl()).toBe(true);
  });

  it("falls back to window.open on web", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await openExternalUrl("https://polar.sh/checkout/x");
    expect(open).toHaveBeenCalledWith(
      "https://polar.sh/checkout/x",
      "_blank",
      "noopener,noreferrer",
    );
    expect(canOpenExternalUrl()).toBe(false);
  });
});
