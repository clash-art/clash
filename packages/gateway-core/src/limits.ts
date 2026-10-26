/**
 * Rate and concurrency admission decisions. Counters live in the adapter's
 * store (database time, shared across instances); the core defines the
 * decision shape, its coded error, and the one schema every configured limit
 * (`rate_limit_json` on keys, members, tenants, models, upstreams, packages
 * and subscriptions) is validated with.
 */
import { z } from "zod";

import { GatewayError } from "./errors.js";

export type LimitScope = "tenant" | "user" | "key";

/**
 * The bounds a configured rate limit may set. Every one is configuration,
 * never a product constant:
 * - `requestsPerMinute`, `tokensPerMinute`: fixed one-minute windows;
 * - `concurrency`: requests in flight at once;
 * - `mediaJobs`: media/AIGC generations in flight at once.
 */
export const GATEWAY_RATE_LIMIT_FIELDS = ["requestsPerMinute", "tokensPerMinute", "concurrency", "mediaJobs"] as const;
export type GatewayRateLimitField = (typeof GATEWAY_RATE_LIMIT_FIELDS)[number];

const bound = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const RATE_LIMIT_SHAPE = {
  requestsPerMinute: bound(),
  tokensPerMinute: bound(),
  concurrency: bound(),
  mediaJobs: bound(),
};

/**
 * A rate limit as written by an API: positive integers, at least one bound,
 * and no unknown fields, so a typo never silently admits.
 */
export const GatewayRateLimitSchema = z
  .object(RATE_LIMIT_SHAPE)
  .strict()
  .refine((limits) => Object.keys(limits).length > 0, "empty rate limit");
export type GatewayRateLimit = z.infer<typeof GatewayRateLimitSchema>;

/**
 * A stored rate limit as an adapter reads it back: the same bounds, unknown
 * fields ignored. A malformed bound fails the parse, and the adapter must fail
 * closed rather than admit.
 */
export const StoredGatewayRateLimitSchema = z.looseObject(RATE_LIMIT_SHAPE);

/** The tightest of several limits that count in one subject: per field, the smallest bound set. */
export function tightestRateLimit(limits: ReadonlyArray<Partial<GatewayRateLimit> | undefined>): Partial<GatewayRateLimit> | undefined {
  const merged: Partial<GatewayRateLimit> = {};
  for (const limit of limits)
    for (const field of GATEWAY_RATE_LIMIT_FIELDS) {
      const value = limit?.[field];
      if (value !== undefined && (merged[field] === undefined || value < merged[field]!)) merged[field] = value;
    }
  return Object.keys(merged).length ? merged : undefined;
}

/** OpenAI-style `x-ratelimit-*` and `retry-after` answer headers. */
export type GatewayRateLimitHeaders = Record<string, string>;

export type LimitDecision =
  | { allowed: true; leaseId: string; headers?: GatewayRateLimitHeaders }
  | {
      allowed: false;
      code: "GATEWAY_RATE_LIMITED" | "GATEWAY_CONCURRENCY_LIMITED";
      scope: LimitScope;
      retryAfterMs: number;
      headers?: GatewayRateLimitHeaders;
    };

/** Throw the coded error for a denial; return the lease to release afterwards. */
export function requireAdmission(decision: LimitDecision): string {
  if (decision.allowed) return decision.leaseId;
  throw new GatewayError(decision.code, {
    retryAfterMs: decision.retryAfterMs,
    details: { scope: decision.scope },
    ...(decision.headers ? { headers: decision.headers } : {}),
  });
}

/** Start of the fixed window containing `nowMs`. */
export function fixedWindowStart(nowMs: number, windowMs: number): number {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "windowMs must be a positive integer.",
    });
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Fixed-window decision for one counter already incremented by this request. */
export function fixedWindowDecision(input: {
  nowMs: number;
  windowMs: number;
  /** Count including the request being admitted. */
  count: number;
  limit: number;
}): { allowed: true } | { allowed: false; retryAfterMs: number } {
  if (input.count <= input.limit) return { allowed: true };
  const windowEnd = fixedWindowStart(input.nowMs, input.windowMs) + input.windowMs;
  return { allowed: false, retryAfterMs: Math.max(0, windowEnd - input.nowMs) };
}
