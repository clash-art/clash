import { describe, expect, it } from "vitest";

import { resolveAuthSecret, type AuthBindings } from "./better-auth.server";

const bindings = (overrides: Partial<AuthBindings>): AuthBindings => ({
  DB: {} as D1Database,
  ...overrides,
});

describe("resolveAuthSecret", () => {
  it("uses the configured secret", () => {
    expect(resolveAuthSecret(bindings({ BETTER_AUTH_SECRET: "configured" }))).toBe(
      "configured",
    );
    expect(resolveAuthSecret(bindings({ AUTH_SECRET: "legacy" }))).toBe("legacy");
  });

  it.each([
    {},
    { ENVIRONMENT: "staging" },
    { ENVIRONMENT: "production" },
    // NODE_ENV is not an authority: it is commonly copied into uploaded vars.
    { NODE_ENV: "development" },
  ])(
    "refuses to sign without a secret outside development (%o)",
    (env) => {
      expect(() => resolveAuthSecret(bindings(env))).toThrow(/not configured/);
    },
  );

  it("permits the fallback only for the explicit local development marker", () => {
    expect(resolveAuthSecret(bindings({ ENVIRONMENT: "development" }))).not.toBe("");
  });
});
