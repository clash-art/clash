import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  importCapabilityKey,
  signCapability,
  verifyCapability,
} from "./signed-capability";

// RFC 2104 HMAC-SHA256 from node:crypto is the independent reference.
const reference = (secret: string, message: string) =>
  createHmac("sha256", secret).update(message).digest("base64url");

describe("signed capabilities", () => {
  const secret = "capability-test-secret";
  const exp = 1_900_000_000;

  it("signs `<subject>:<exp>` without a domain", async () => {
    const key = await importCapabilityKey(secret);
    expect(await signCapability(key, "projects/p/a.mp4", exp)).toBe(
      reference(secret, `projects/p/a.mp4:${exp}`),
    );
  });

  it("prefixes the domain to the signed message", async () => {
    const key = await importCapabilityKey(secret);
    const signed = await signCapability(key, "p/a", exp, "domain-v1:");
    expect(signed).toBe(reference(secret, `domain-v1:p/a:${exp}`));
    expect(signed).not.toBe(await signCapability(key, "p/a", exp));
  });

  it("verifies only the exact subject, expiry, domain and signature", async () => {
    const key = await importCapabilityKey(secret);
    const signed = await signCapability(key, "p/a", exp, "d:");
    expect(await verifyCapability(key, "p/a", exp, signed, "d:")).toBe(true);
    expect(await verifyCapability(key, "p/b", exp, signed, "d:")).toBe(false);
    expect(await verifyCapability(key, "p/a", exp + 1, signed, "d:")).toBe(
      false,
    );
    expect(await verifyCapability(key, "p/a", exp, signed)).toBe(false);
    const flipped = `${signed[0] === "A" ? "B" : "A"}${signed.slice(1)}`;
    expect(await verifyCapability(key, "p/a", exp, flipped, "d:")).toBe(false);
    expect(
      await verifyCapability(key, "p/a", exp, signed.slice(0, -1), "d:"),
    ).toBe(false);
    const other = await importCapabilityKey("another-secret");
    expect(await verifyCapability(other, "p/a", exp, signed, "d:")).toBe(false);
  });

  it("refuses an empty secret", async () => {
    await expect(importCapabilityKey("")).rejects.toThrow(/secret/);
  });
});
