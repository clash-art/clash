/**
 * Credit billing decisions shared by every adapter (#352): subscription
 * periods, the wallet balance and the unused-grant amount a period expiry
 * removes. Adapters own durability (ledger `grant`/`topup`/`expire` entries,
 * the tenant wallet budget); these functions own the arithmetic, in integer
 * micro-credits and epoch milliseconds.
 *
 * Wallet model: the tenant wallet is the `tenant`-scope budget. Purchased and
 * granted credits raise its limit, usage raises its spend, so the balance is
 * `limit - spent - reserved`. Credits granted for a subscription period are
 * consumed before any other wallet credits; at period end only the part of
 * that grant the period did not consume expires. Top-up credits do not expire.
 */
import { isBlockedDeepSeekModel } from "./catalog-policy.js";
import { GatewayError } from "./errors.js";
import { assertMicroCredits, isGatewayPriceUnit, type GatewayPriceUnit, type MicroCredits } from "./pricing.js";

export const GATEWAY_BILLING_PERIODS = ["month", "year"] as const;
export type GatewayBillingPeriod = (typeof GATEWAY_BILLING_PERIODS)[number];

const monthsPer = (period: GatewayBillingPeriod) => (period === "year" ? 12 : 1);

/**
 * Start of period `index` of a subscription anchored at `anchorMs` (UTC
 * calendar months). The anchor's day of month is kept and clamped to shorter
 * months, so periods never drift: Jan 31 -> Feb 28 -> Mar 31.
 */
export function billingPeriodStart(anchorMs: number, period: GatewayBillingPeriod, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new GatewayError("GATEWAY_INTERNAL", { message: "Billing period index must be a non-negative integer." });
  const anchor = new Date(anchorMs);
  const months = anchor.getUTCMonth() + index * monthsPer(period);
  const year = anchor.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(anchor.getUTCDate(), daysInMonth),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

/** Index of the period containing `atMs` (0 before or at the anchor). */
export function billingPeriodIndex(anchorMs: number, period: GatewayBillingPeriod, atMs: number): number {
  if (atMs <= anchorMs) return 0;
  const anchor = new Date(anchorMs);
  const at = new Date(atMs);
  const months = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth();
  let index = Math.max(0, Math.floor(months / monthsPer(period)) + 1);
  while (index > 0 && billingPeriodStart(anchorMs, period, index) > atMs) index -= 1;
  return index;
}

export interface BillingPeriodBounds {
  index: number;
  start: number;
  end: number;
}

export function billingPeriod(anchorMs: number, period: GatewayBillingPeriod, index: number): BillingPeriodBounds {
  return {
    index,
    start: billingPeriodStart(anchorMs, period, index),
    end: billingPeriodStart(anchorMs, period, index + 1),
  };
}

/** Spendable credits of a wallet; an unlimited (`null`) wallet has no balance to fund. */
export function walletAvailable(wallet: {
  limitMicroCredits: MicroCredits;
  spentMicroCredits: MicroCredits;
  reservedMicroCredits: MicroCredits;
}): MicroCredits {
  return Math.max(0, wallet.limitMicroCredits - wallet.spentMicroCredits - wallet.reservedMicroCredits);
}

/**
 * Credits a period expiry removes: the period's grant minus what the period
 * consumed (grant credits go first), never more than the wallet can give up
 * now, so open holds stay covered and the limit never drops below spend.
 */
export function expiringGrant(input: {
  grantedMicroCredits: MicroCredits;
  spentInPeriodMicroCredits: MicroCredits;
  availableMicroCredits: MicroCredits;
}): MicroCredits {
  const granted = assertMicroCredits(input.grantedMicroCredits, "granted");
  const spent = assertMicroCredits(input.spentInPeriodMicroCredits, "spentInPeriod");
  const available = assertMicroCredits(input.availableMicroCredits, "available");
  return Math.min(Math.max(0, granted - spent), available);
}

export interface PriceDraftRate {
  modelCode: string;
  /** '' prices every upstream of the model. */
  upstreamId: string;
  unit: GatewayPriceUnit;
  microCredits: MicroCredits;
  per: number;
}

/**
 * Product policy for a price-book draft: known units, integer micro-credits,
 * one rate per (model, upstream, unit), and DeepSeek Flash only.
 */
export function assertPriceDraftPolicy(rates: readonly PriceDraftRate[]): void {
  if (rates.length === 0)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { reason: "empty_price_version", param: "rates" } });
  const seen = new Set<string>();
  rates.forEach((rate, index) => {
    if (!isGatewayPriceUnit(rate.unit))
      throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { reason: "unit", param: `rates.${index}.unit` } });
    if (!Number.isSafeInteger(rate.microCredits) || rate.microCredits < 0)
      throw new GatewayError("GATEWAY_INVALID_REQUEST", {
        details: { reason: "amount", param: `rates.${index}.amountMicroCredits` },
      });
    if (!Number.isSafeInteger(rate.per) || rate.per <= 0)
      throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { reason: "per", param: `rates.${index}.per` } });
    if (isBlockedDeepSeekModel(rate.modelCode, rate.upstreamId))
      throw new GatewayError("GATEWAY_PRICE_MODEL_BLOCKED", {
        details: { modelCode: rate.modelCode, param: `rates.${index}.modelCode` },
      });
    const key = JSON.stringify([rate.modelCode, rate.upstreamId, rate.unit]);
    if (seen.has(key))
      throw new GatewayError("GATEWAY_INVALID_REQUEST", {
        details: { reason: "duplicate_rate", param: `rates.${index}` },
      });
    seen.add(key);
  });
}
