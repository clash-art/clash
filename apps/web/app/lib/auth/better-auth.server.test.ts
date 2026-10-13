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

  it.each([{}, { ENVIRONMENT: "staging" }, { NODE_ENV: "production" }])(
    "refuses to sign without a secret outside development (%o)",
    (env) => {
      expect(() => resolveAuthSecret(bindings(env))).toThrow(/not configured/);
    },
  );

  it.each([{ ENVIRONMENT: "development" }, { NODE_ENV: "development" }])(
    "keeps zero-config local development working (%o)",
    (env) => {
      expect(resolveAuthSecret(bindings(env))).not.toBe("");
    },
  );
});
