import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../config";
import {
  computeSignature,
  getSigningKey,
  signAssetPath,
  verifySignature,
} from "./asset-signing";

const env = { ENVIRONMENT: "production", JWT_SECRET: "asset-test-secret" } as Env;
// The documented format, computed independently: HMAC-SHA256(`<key>:<exp>`), base64url.
const reference = (storageKey: string, exp: number) =>
  createHmac("sha256", "asset-test-secret")
    .update(`${storageKey}:${exp}`)
    .digest("base64url");

describe("asset signing", () => {
  afterEach(() => vi.useRealTimers());

  it("signs `<key>:<exp>` with JWT_SECRET and no domain prefix", async () => {
    const key = await getSigningKey(env);
    expect(await computeSignature(key, "projects/p/a.png", 1_900_000_000)).toBe(
      reference("projects/p/a.png", 1_900_000_000),
    );
  });

  it("keeps the /assets/<key>?exp=&sig= URL format with a one-hour expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const exp = 1_800_000_000 + 3600;
    expect(await signAssetPath(env, "projects/p/a.png")).toBe(
      `/assets/projects/p/a.png?exp=${exp}&sig=${reference("projects/p/a.png", exp)}`,
    );
  });

  it("verifies issued signatures and rejects tampered ones", async () => {
    const key = await getSigningKey(env);
    const sig = reference("projects/p/a.png", 1_900_000_000);
    expect(await verifySignature(key, "projects/p/a.png", 1_900_000_000, sig)).toBe(true);
    expect(await verifySignature(key, "projects/p/b.png", 1_900_000_000, sig)).toBe(false);
    expect(await verifySignature(key, "projects/p/a.png", 1_900_000_001, sig)).toBe(false);
    expect(
      await verifySignature(key, "projects/p/a.png", 1_900_000_000, `${sig}x`),
    ).toBe(false);
  });
});
