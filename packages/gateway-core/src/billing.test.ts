import { describe, expect, it } from "vitest";

import {
  assertPriceDraftPolicy,
  billingPeriod,
  billingPeriodIndex,
  billingPeriodStart,
  expiringGrant,
  walletAvailable,
  type PriceDraftRate,
} from "./billing.js";
import { isBlockedDeepSeekModel } from "./catalog-policy.js";
import { GatewayError } from "./errors.js";

const utc = (iso: string) => Date.parse(iso);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof GatewayError ? error.code : "not-coded";
  }
  return undefined;
}

describe("billing periods", () => {
  it("keeps the anchor's day of month, clamped to shorter months (Gregorian calendar)", () => {
    const anchor = utc("2027-01-31T10:00:00.000Z");
    expect(new Date(billingPeriodStart(anchor, "month", 1)).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(new Date(billingPeriodStart(anchor, "month", 2)).toISOString()).toBe("2027-03-31T10:00:00.000Z");
    // 2028 is a leap year.
    expect(new Date(billingPeriodStart(anchor, "month", 13)).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(new Date(billingPeriodStart(utc("2028-02-29T00:00:00.000Z"), "year", 1)).toISOString()).toBe(
      "2029-02-28T00:00:00.000Z",
    );
  });

  it("finds the period containing an instant, with contiguous bounds", () => {
    const anchor = utc("2027-01-31T10:00:00.000Z");
    for (const index of [0, 1, 2, 11, 12, 13, 40]) {
      const period = billingPeriod(anchor, "month", index);
      expect(billingPeriodIndex(anchor, "month", period.start)).toBe(index);
      expect(billingPeriodIndex(anchor, "month", period.end - 1)).toBe(index);
      expect(billingPeriodIndex(anchor, "month", period.end)).toBe(index + 1);
      expect(billingPeriod(anchor, "month", index + 1).start).toBe(period.end);
    }
    expect(billingPeriodIndex(anchor, "year", anchor - 1)).toBe(0);
    expect(() => billingPeriodStart(anchor, "month", -1)).toThrow(GatewayError);
  });
});

describe("wallet credits", () => {
  it("never reports a negative balance", () => {
    expect(walletAvailable({ limitMicroCredits: 10, spentMicroCredits: 4, reservedMicroCredits: 3 })).toBe(3);
    expect(walletAvailable({ limitMicroCredits: 10, spentMicroCredits: 9, reservedMicroCredits: 3 })).toBe(0);
  });

  it("expires only the part of a grant its period did not consume", () => {
    // Grant credits go first: spend up to the grant comes out of it.
    expect(expiringGrant({ grantedMicroCredits: 100, spentInPeriodMicroCredits: 30, availableMicroCredits: 500 })).toBe(70);
    expect(expiringGrant({ grantedMicroCredits: 100, spentInPeriodMicroCredits: 130, availableMicroCredits: 500 })).toBe(0);
    // Never more than the wallet can give up now (nothing from a balance at or below zero).
    expect(expiringGrant({ grantedMicroCredits: 100, spentInPeriodMicroCredits: 0, availableMicroCredits: 40 })).toBe(40);
    expect(codeOf(() => expiringGrant({ grantedMicroCredits: 1.5, spentInPeriodMicroCredits: 0, availableMicroCredits: 0 }))).toBe(
      "GATEWAY_INTERNAL",
    );
  });
});

describe("price draft policy", () => {
  const rate = (overrides: Partial<PriceDraftRate> = {}): PriceDraftRate => ({
    modelCode: "model-a",
    upstreamId: "",
    unit: "input_token",
    microCredits: 1,
    per: 1,
    ...overrides,
  });

  it("accepts distinct integer rates", () => {
    expect(() => assertPriceDraftPolicy([rate(), rate({ unit: "output_token" }), rate({ upstreamId: "openai" })])).not.toThrow();
  });

  it("rejects empty, duplicate, fractional and unknown-unit drafts with coded errors", () => {
    expect(codeOf(() => assertPriceDraftPolicy([]))).toBe("GATEWAY_INVALID_REQUEST");
    expect(codeOf(() => assertPriceDraftPolicy([rate(), rate()]))).toBe("GATEWAY_INVALID_REQUEST");
    expect(codeOf(() => assertPriceDraftPolicy([rate({ microCredits: 0.5 })]))).toBe("GATEWAY_INVALID_REQUEST");
    expect(codeOf(() => assertPriceDraftPolicy([rate({ per: 0 })]))).toBe("GATEWAY_INVALID_REQUEST");
    expect(codeOf(() => assertPriceDraftPolicy([rate({ unit: "token" as never })]))).toBe("GATEWAY_INVALID_REQUEST");
  });

  it("allows DeepSeek only as a Flash model", () => {
    expect(isBlockedDeepSeekModel("deepseek-v4-flash")).toBe(false);
    expect(isBlockedDeepSeekModel("deepseek-v4-pro")).toBe(true);
    expect(isBlockedDeepSeekModel("deepseek-reasoner")).toBe(true);
    expect(isBlockedDeepSeekModel("house-chat", "deepseek")).toBe(true);
    expect(isBlockedDeepSeekModel("gpt-5.4")).toBe(false);
    expect(codeOf(() => assertPriceDraftPolicy([rate({ modelCode: "deepseek-v4-pro" })]))).toBe(
      "GATEWAY_PRICE_MODEL_BLOCKED",
    );
    expect(() => assertPriceDraftPolicy([rate({ modelCode: "deepseek-v4-flash", upstreamId: "deepseek" })])).not.toThrow();
  });
});
