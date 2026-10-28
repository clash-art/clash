import { describe, expect, it } from "vitest";
import { oauthErrorMessage } from "./oauth-error-message";

describe("oauthErrorMessage", () => {
  it("maps state_mismatch to a retry-oriented Clash message", () => {
    const message = oauthErrorMessage("state_mismatch");
    expect(message).toMatch(/Google sign-in/i);
    expect(message).toMatch(/try Continue with Google again/i);
    expect(message).not.toBe("state_mismatch");
  });

  it("returns null for empty codes", () => {
    expect(oauthErrorMessage(null)).toBeNull();
    expect(oauthErrorMessage("")).toBeNull();
    expect(oauthErrorMessage("   ")).toBeNull();
  });

  it("falls back with the raw code for unknowns", () => {
    expect(oauthErrorMessage("weird_code")).toMatch(/weird_code/);
  });
});
