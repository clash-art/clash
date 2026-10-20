/**
 * Integer money. All amounts are micro-credits (1 credit = 1_000_000) held as
 * safe integers; multiplication runs in bigint and rounds up once per line, so
 * no floating-point value ever reaches a hold, a settlement or a ledger row.
 * Prices carry no markup: the price book is the charged amount.
 */
import { GatewayError } from "./errors.js";
import type { GatewayMediaUnit, Usage } from "./usage.js";

export const MICRO_CREDITS_PER_CREDIT = 1_000_000;

export type MicroCredits = number;

export type GatewayPriceUnit =
  | "input_token"
  | "output_token"
  | "cached_input_token"
  | "cache_write_token"
  | GatewayMediaUnit;

export interface GatewayPriceRate {
  unit: GatewayPriceUnit;
  /** Price of `per` units, in micro-credits. */
  microCredits: MicroCredits;
  /** Quantity the price applies to, e.g. 1_000_000 tokens. */
  per: number;
}

export interface GatewayPrice {
  modelCode: string;
  /** Narrows the price to one upstream when routes differ in cost. */
  upstreamId?: string;
  /** Immutable price-book version recorded on every ledger row. */
  version: string;
  rates: GatewayPriceRate[];
  /** Ceiling for holds when a request omits `max_tokens`. */
  maxOutputTokens?: number;
}

export interface PricedLine {
  unit: GatewayPriceUnit;
  quantity: number;
  /** Unit whose rate was applied; differs only for cache fallbacks. */
  rateUnit: GatewayPriceUnit;
  microCredits: MicroCredits;
}

export interface PricedUsage {
  priceVersion: string;
  microCredits: MicroCredits;
  lines: PricedLine[];
}

export function assertMicroCredits(
  value: number,
  label = "amount",
): MicroCredits {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: `${label} must be a non-negative safe integer of micro-credits.`,
      details: { label },
    });
  return value;
}

export function assertQuantity(value: number, label = "quantity"): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: `${label} must be a non-negative safe integer.`,
      details: { label },
    });
  return value;
}

/** `ceil(quantity * microCredits / per)` computed exactly. */
export function lineCost(quantity: number, rate: GatewayPriceRate): MicroCredits {
  assertQuantity(quantity);
  assertMicroCredits(rate.microCredits, `rate ${rate.unit}`);
  if (!Number.isSafeInteger(rate.per) || rate.per <= 0)
    throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
      message: `rate ${rate.unit} has an invalid 'per' quantity.`,
      details: { unit: rate.unit },
    });
  const numerator = BigInt(quantity) * BigInt(rate.microCredits);
  const per = BigInt(rate.per);
  const cost = (numerator + per - 1n) / per;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "Line cost exceeds the safe integer range.",
      details: { unit: rate.unit },
    });
  return Number(cost);
}

export function sumMicroCredits(values: readonly MicroCredits[]): MicroCredits {
  let total = 0n;
  for (const value of values) total += BigInt(assertMicroCredits(value));
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "Total exceeds the safe integer range.",
    });
  return Number(total);
}

/**
 * Cache reads and writes fall back to the input-token rate when the price book
 * has no dedicated rate; no provider prices cached input above fresh input,
 * so the fallback can over-charge a cache write but never under-charges a read.
 */
const FALLBACK: Partial<Record<GatewayPriceUnit, GatewayPriceUnit>> = {
  cached_input_token: "input_token",
  cache_write_token: "input_token",
};

export function findRate(
  price: GatewayPrice,
  unit: GatewayPriceUnit,
): GatewayPriceRate | undefined {
  const exact = price.rates.find((rate) => rate.unit === unit);
  if (exact) return exact;
  const fallback = FALLBACK[unit];
  return fallback ? price.rates.find((rate) => rate.unit === fallback) : undefined;
}

function requireRate(price: GatewayPrice, unit: GatewayPriceUnit): GatewayPriceRate {
  const rate = findRate(price, unit);
  if (!rate)
    throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
      details: { modelCode: price.modelCode, unit, priceVersion: price.version },
    });
  return rate;
}

export function usageQuantities(
  usage: Usage,
): Array<[GatewayPriceUnit, number]> {
  return [
    ["input_token", usage.inputTokens] as [GatewayPriceUnit, number],
    ["output_token", usage.outputTokens] as [GatewayPriceUnit, number],
    ["cached_input_token", usage.cachedInputTokens] as [GatewayPriceUnit, number],
    ["cache_write_token", usage.cacheWriteTokens] as [GatewayPriceUnit, number],
    ...(Object.entries(usage.units) as Array<[GatewayPriceUnit, number]>),
  ].filter(([, quantity]) => quantity > 0);
}

/** Price usage against one price-book entry. A counted unit without a rate fails closed. */
export function priceUsage(usage: Usage, price: GatewayPrice): PricedUsage {
  const lines = usageQuantities(usage).map(([unit, quantity]): PricedLine => {
    const rate = requireRate(price, unit);
    return { unit, quantity, rateUnit: rate.unit, microCredits: lineCost(quantity, rate) };
  });
  return {
    priceVersion: price.version,
    microCredits: sumMicroCredits(lines.map((line) => line.microCredits)),
    lines,
  };
}

/** Units the admission estimate needs a rate for; checked before any upstream call. */
export function assertPriceCovers(
  price: GatewayPrice,
  units: readonly GatewayPriceUnit[],
): void {
  for (const unit of units) requireRate(price, unit);
}
