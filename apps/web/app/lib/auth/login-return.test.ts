import { expect, it } from "vitest";
import { loginReturnPath } from "./login-return";
it("preserves the local PKCE continuation and rejects external destinations", () => {
  expect(loginReturnPath("/auth/cli?state=opaque&code_challenge=pkce")).toBe(
    "/auth/cli?state=opaque&code_challenge=pkce",
  );
  for (const unsafe of [
    null,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/login",
    "/login?returnTo=x",
    "javascript:alert(1)",
  ]) {
    expect(loginReturnPath(unsafe)).toBe("/");
  }
});
