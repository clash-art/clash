/**
 * Upstream circuit breaker (#350): an account that keeps failing before the
 * first byte is skipped for a cooldown, so failover goes straight to a healthy
 * route instead of paying the failing one's deadline on every request.
 *
 * The decisions live here; the `upstreamHealth` port only stores counters,
 * applying a failure atomically with the threshold and open-until the core
 * passes in. States:
 * - `closed`: fewer than `failureThreshold` consecutive failures; routed.
 * - `open`: the threshold was reached and `openUntil` is in the future; skipped.
 * - `half_open`: the cooldown has passed; routed again. One success closes it,
 *   one failure reopens it for another cooldown (the count is still at or
 *   above the threshold).
 *
 * Only failures that say something about the account count: no connection,
 * a deadline, 401/403 (its key was refused, after every usable key version),
 * 408/429/5xx, or a 2xx that is not a completion. A 4xx the caller caused
 * does not, and nothing after the first byte does.
 */
import type { GatewayErrorCode } from "./errors.js";
import type { UpstreamFailure } from "./routing.js";

export interface GatewayCircuitPolicy {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long an open circuit skips the account. */
  cooldownMs: number;
}

export const GATEWAY_CIRCUIT_DEFAULTS: Readonly<GatewayCircuitPolicy> = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

/** One account's breaker counters. Times are epoch ms. */
export interface GatewayUpstreamHealth {
  accountId: string;
  consecutiveFailures: number;
  /** Set once the threshold was reached; the circuit is open until then. */
  openUntil?: number;
  lastFailureCode?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export type GatewayCircuitState = "closed" | "open" | "half_open";

export function gatewayCircuitState(
  health: GatewayUpstreamHealth | undefined,
  now: number,
): GatewayCircuitState {
  if (!health || health.openUntil === undefined) return "closed";
  return now < health.openUntil ? "open" : "half_open";
}

/** Whether a failed attempt counts against its account's circuit. */
export function countsAgainstCircuit(failure: UpstreamFailure): boolean {
  switch (failure.state) {
    case "not-sent":
    case "unknown":
      return true;
    case "streaming":
      return false;
    case "answered":
      return (
        failure.status === 401 ||
        failure.status === 403 ||
        failure.status === 408 ||
        failure.status === 429 ||
        failure.status >= 500
      );
  }
}

/** The arguments of `upstreamHealth.recordFailure` for one failure at `now`. */
export function circuitFailureInput(
  accountId: string,
  code: GatewayErrorCode,
  now: number,
  policy: GatewayCircuitPolicy,
) {
  return {
    accountId,
    code,
    at: now,
    threshold: Math.max(1, Math.floor(policy.failureThreshold)),
    openUntil: now + Math.max(0, policy.cooldownMs),
  };
}
