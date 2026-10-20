import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.js";
import { lineCost, priceUsage, sumMicroCredits, type GatewayPrice } from "./pricing.js";
import { emptyUsage } from "./usage.js";

const price: GatewayPrice = {
  modelCode: "m",
  version: "v1",
  rates: [
    { unit: "input_token", microCredits: 3_000_000, per: 1_000_000 },
    { unit: "output_token", microCredits: 15_000_000, per: 1_000_000 },
    { unit: "image", microCredits: 40_000, per: 1 },
  ],
};

/** Deterministic LCG so the property cases are reproducible. */
function* numbers(seed: number, count: number, max: number) {
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    yield state % max;
  }
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GatewayError ? error.code : "not-coded";
  }
  return "no-error";
};

describe("integer money", () => {
  it("rounds each line up to the least integer covering the exact cost", () => {
    const quantities = [...numbers(7, 200, 5_000_000)];
    const amounts = [...numbers(11, 200, 90_000_000)];
    const pers = [...numbers(13, 200, 2_000_000)].map((per) => per + 1);
    quantities.forEach((quantity, index) => {
      const rate = { unit: "input_token" as const, microCredits: amounts[index]!, per: pers[index]! };
      const cost = lineCost(quantity, rate);
      expect(Number.isSafeInteger(cost)).toBe(true);
      const exact = BigInt(quantity) * BigInt(rate.microCredits);
      expect(BigInt(cost) * BigInt(rate.per) >= exact).toBe(true);
      expect((BigInt(cost) - 1n) * BigInt(rate.per) < exact).toBe(true);
    });
  });

  it("stays exact where float arithmetic would drift", () => {
    const quantity = 2 ** 40 + 7;
    const rate = { unit: "output_token" as const, microCredits: 3, per: 1_000_000 };
    const exact = (BigInt(quantity) * 3n + 999_999n) / 1_000_000n;
    expect(lineCost(quantity, rate)).toBe(Number(exact));
  });

  it("rejects non-integer amounts and quantities with a coded error", () => {
    expect(code(() => lineCost(1.5, price.rates[0]!))).toBe("GATEWAY_INTERNAL");
    expect(code(() => lineCost(1, { unit: "input_token", microCredits: 0.25, per: 1 }))).toBe("GATEWAY_INTERNAL");
    expect(code(() => lineCost(1, { unit: "input_token", microCredits: 1, per: 0 }))).toBe("GATEWAY_PRICE_UNAVAILABLE");
    expect(code(() => sumMicroCredits([Number.MAX_SAFE_INTEGER, 1]))).toBe("GATEWAY_INTERNAL");
  });
});

describe("priceUsage", () => {
  it("charges the sum of its lines with no markup", () => {
    const usage = { ...emptyUsage(), inputTokens: 1234, outputTokens: 567, units: { image: 2 } };
    const priced = priceUsage(usage, price);
    expect(priced.priceVersion).toBe(price.version);
    expect(priced.microCredits).toBe(priced.lines.reduce((total, line) => total + line.microCredits, 0));
    for (const line of priced.lines) {
      const rate = price.rates.find((entry) => entry.unit === line.rateUnit)!;
      expect(line.microCredits).toBe(lineCost(line.quantity, rate));
    }
    expect(priced.lines.map((line) => line.unit).sort()).toEqual(["image", "input_token", "output_token"]);
  });

  it("prices cache reads at a dedicated rate when published, else at the input rate", () => {
    const usage = { ...emptyUsage(), cachedInputTokens: 1_000_000 };
    const fallback = priceUsage(usage, price);
    expect(fallback.lines[0]).toMatchObject({ unit: "cached_input_token", rateUnit: "input_token" });
    expect(fallback.microCredits).toBe(lineCost(1_000_000, price.rates[0]!));
    const cachedRate = { unit: "cached_input_token" as const, microCredits: 300_000, per: 1_000_000 };
    const dedicated = priceUsage(usage, { ...price, rates: [...price.rates, cachedRate] });
    expect(dedicated.lines[0]).toMatchObject({ rateUnit: "cached_input_token" });
    expect(dedicated.microCredits).toBe(lineCost(1_000_000, cachedRate));
  });

  it("fails closed for a counted unit without a rate", () => {
    const usage = { ...emptyUsage(), units: { video_second: 5 } };
    expect(code(() => priceUsage(usage, price))).toBe("GATEWAY_PRICE_UNAVAILABLE");
  });

  it("charges nothing for empty usage", () => {
    expect(priceUsage(emptyUsage(), { ...price, rates: [] }).microCredits).toBe(0);
  });
});
