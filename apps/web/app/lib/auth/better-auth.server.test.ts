import { describe, expect, it } from "vitest";

import { resolveAuthSecret, type AuthBindings } from "./better-auth.server";
import { readFileSync } from "node:fs";
import { resolveAuthErrorURL, resolveTrustedOrigins } from "./auth-origins";

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

describe("better-auth hosted cutover wiring", () => {
  it("configures Clash /login errorURL and art+video trusted origins in source", () => {
    const source = readFileSync(new URL("./better-auth.server.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveTrustedOrigins");
    expect(source).toContain("onAPIError");
    expect(source).toContain("resolveAuthErrorURL");
    expect(resolveAuthErrorURL("https://clash.art")).toBe("https://clash.art/login");
    expect(resolveTrustedOrigins({ baseURL: "https://clash.art", includeLocalDev: false })).toEqual(
      expect.arrayContaining([
        "https://clash.art",
        "https://www.clash.art",
        "https://clash.video",
        "https://www.clash.video",
      ]),
    );
  });
});
