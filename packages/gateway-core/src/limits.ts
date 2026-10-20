/**
 * Rate and concurrency admission decisions. Counters live in the adapter's
 * store (database time, shared across instances); the core defines the
 * decision shape and its coded error.
 */
import { GatewayError } from "./errors.js";

export type LimitScope = "tenant" | "user" | "key";

export type LimitDecision =
  | { allowed: true; leaseId: string }
  | {
      allowed: false;
      code: "GATEWAY_RATE_LIMITED" | "GATEWAY_CONCURRENCY_LIMITED";
      scope: LimitScope;
      retryAfterMs: number;
    };

/** Throw the coded error for a denial; return the lease to release afterwards. */
export function requireAdmission(decision: LimitDecision): string {
  if (decision.allowed) return decision.leaseId;
  throw new GatewayError(decision.code, {
    retryAfterMs: decision.retryAfterMs,
    details: { scope: decision.scope },
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
