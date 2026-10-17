import { describe, expect, it } from "vitest";

import { getEffectiveChromeAuth } from "./authChrome";

describe("auth chrome helpers", () => {
  it("keeps dashboard chrome visible when the shared session confirms auth", () => {
    expect(getEffectiveChromeAuth(false, true)).toBe(true);
    expect(getEffectiveChromeAuth(false, false)).toBe(false);
  });

  it("follows the shared session once it has signed out", () => {
    expect(getEffectiveChromeAuth(true, false)).toBe(false);
  });

  it("uses the loader answer while the shared session is unknown or absent", () => {
    expect(getEffectiveChromeAuth(true, null)).toBe(true);
    expect(getEffectiveChromeAuth(false, null)).toBe(false);
  });
});
