/**
 * Gateway route plan: a thin facade over shared-types `listModelUpstreamRoutes`.
 * Ordering, account matching, credentials and parameter support stay in the
 * shared resolver; this module only scopes the accounts, attaches a retry
 * class to each attempt and decides failover after an upstream failure.
 */
import {
  listModelUpstreamRoutes,
  type ModelUpstreamRoute,
  type ModelUpstreamRouteQuery,
  type ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import { GatewayError, type GatewayErrorCode } from "./errors.js";
import type { GatewayModelKind } from "./request.js";

export type GatewayModelCard = NonNullable<
  ModelUpstreamRouteQuery["models"]
>[number];

/**
 * Official (platform-held keys) and tenant (BYOK) accounts are never mixed in
 * one plan: a request is served by exactly one scope, chosen before planning.
 */
export type GatewayCredentialScope = "official" | "tenant";

/**
 * - `idempotent`: an attempt whose outcome is unknown (sent, no answer) may be
 *   retried on the next route; a duplicate costs the platform, never the caller.
 * - `at-most-once`: an unknown outcome is terminal, because the upstream cannot
 *   deduplicate a repeated submit (billed media jobs, executor plugins).
 */
export type GatewayRetryClass = "idempotent" | "at-most-once";

export interface GatewayRouteAttempt {
  /** Zero-based position in the failover order. */
  index: number;
  route: ModelUpstreamRoute;
  scope: GatewayCredentialScope;
  retryClass: GatewayRetryClass;
  firstByteTimeoutMs?: number;
}

export interface GatewayRoutePlan {
  modelCode: string;
  kind?: GatewayModelKind;
  scope: GatewayCredentialScope;
  catalogVersion: string;
  attempts: GatewayRouteAttempt[];
}

export interface GatewayCatalog {
  /** Published catalog snapshot id; pins keep resolving against it. */
  version: string;
  models: readonly GatewayModelCard[];
}

export interface PlanGatewayRoutesInput {
  modelCode: string;
  kind?: GatewayModelKind;
  catalog: GatewayCatalog;
  scope: GatewayCredentialScope;
  /** Accounts of `scope` only. An empty list means no route, never "all routes". */
  providers: readonly ProviderAccountAvailability[];
  requestedParameterIds?: readonly string[];
  isRouteExecutable?: (route: ModelUpstreamRoute) => boolean;
  /** Whether an attempt with an unknown outcome may be retried on the next route. */
  mayRetryAmbiguousSubmit?: (route: ModelUpstreamRoute) => boolean;
  firstByteTimeoutMs?: (route: ModelUpstreamRoute) => number | undefined;
  /** Cap on attempts; the plan keeps the resolver's first `maxAttempts` routes. */
  maxAttempts?: number;
}

/**
 * Executor plugins own a provider's whole lifecycle and have no upstream
 * deduplication (mirrors api-cf `mayRetryAmbiguousSubmit`), and a media submit
 * creates a billed job; text completions may be retried before the first byte.
 */
export function defaultMayRetryAmbiguousSubmit(
  route: ModelUpstreamRoute,
): boolean {
  return !route.executorPluginId && route.kind === "text";
}

export function planGatewayRoutes(
  input: PlanGatewayRoutesInput,
): GatewayRoutePlan {
  const base = {
    modelCode: input.modelCode,
    kind: input.kind,
    models: input.catalog.models,
    requestedParameterIds: input.requestedParameterIds,
    // `local` routes run on the user's machine; a gateway never serves them.
    isRouteExecutable: (route) =>
      route.upstreamId !== "local" && (input.isRouteExecutable?.(route) ?? true),
  } satisfies ModelUpstreamRouteQuery;
  const declared = listModelUpstreamRoutes(base);
  if (declared.length === 0)
    throw new GatewayError("GATEWAY_MODEL_NOT_FOUND", {
      details: {
        model: input.modelCode,
        ...(input.kind ? { kind: input.kind } : {}),
        catalogVersion: input.catalog.version,
      },
    });
  const routes = listModelUpstreamRoutes({
    ...base,
    configuredProviders: [...input.providers],
  });
  const limit =
    input.maxAttempts !== undefined
      ? Math.max(1, Math.floor(input.maxAttempts))
      : routes.length;
  const mayRetry = input.mayRetryAmbiguousSubmit ?? defaultMayRetryAmbiguousSubmit;
  const attempts = routes.slice(0, limit).map((route, index) => {
    const firstByteTimeoutMs = input.firstByteTimeoutMs?.(route);
    return {
      index,
      route,
      scope: input.scope,
      retryClass: mayRetry(route) ? "idempotent" : "at-most-once",
      ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    } satisfies GatewayRouteAttempt;
  });
  if (attempts.length === 0)
    throw new GatewayError("GATEWAY_NO_ROUTE", {
      details: {
        model: input.modelCode,
        scope: input.scope,
        catalogVersion: input.catalog.version,
      },
    });
  return {
    modelCode: attempts[0]!.route.modelCode,
    ...(input.kind ? { kind: input.kind } : {}),
    scope: input.scope,
    catalogVersion: input.catalog.version,
    attempts,
  };
}

/**
 * What is known about a failed attempt.
 * - `not-sent`: the request never reached the upstream (DNS, connect refused).
 * - `answered`: the upstream answered with `status` before any body byte.
 * - `unknown`: sent, then timed out or the connection dropped before an answer.
 * - `streaming`: failed after the first byte was forwarded to the caller.
 */
export type UpstreamFailure =
  | { state: "not-sent"; reason?: string }
  | { state: "answered"; status: number; reason?: string }
  | { state: "unknown"; reason?: string }
  | { state: "streaming"; reason?: string };

export type FailoverDecision =
  | { action: "failover"; next: GatewayRouteAttempt; error: GatewayError }
  | { action: "fail"; error: GatewayError };

function failureError(failure: UpstreamFailure): {
  code: GatewayErrorCode;
  retryable: (retryClass: GatewayRetryClass) => boolean;
  upstreamStatus?: number;
} {
  switch (failure.state) {
    case "not-sent":
      return { code: "GATEWAY_UPSTREAM_ERROR", retryable: () => true };
    case "unknown":
      return {
        code: "GATEWAY_UPSTREAM_TIMEOUT",
        retryable: (retryClass) => retryClass === "idempotent",
      };
    case "streaming":
      // Bytes already reached the caller: a retry would duplicate output and billing.
      return { code: "GATEWAY_UPSTREAM_ERROR", retryable: () => false };
    case "answered": {
      const status = failure.status;
      if (status === 401 || status === 403)
        // The upstream refused this account's key; another account may serve it.
        return { code: "GATEWAY_KEY_UNAVAILABLE", retryable: () => true, upstreamStatus: status };
      if (status === 408 || status === 429 || status >= 500)
        return { code: "GATEWAY_UPSTREAM_ERROR", retryable: () => true, upstreamStatus: status };
      return { code: "GATEWAY_UPSTREAM_REJECTED", retryable: () => false, upstreamStatus: status };
    }
  }
}

/** The code a failed attempt is reported with (before any exhaustion wrapping). */
export function upstreamFailureCode(failure: UpstreamFailure): GatewayErrorCode {
  return failureError(failure).code;
}

/** Decide the next step after `attempt` failed. Exhaustion is GATEWAY_ROUTES_EXHAUSTED. */
export function nextGatewayAttempt(
  plan: GatewayRoutePlan,
  attempt: GatewayRouteAttempt,
  failure: UpstreamFailure,
): FailoverDecision {
  const classified = failureError(failure);
  const details = {
    model: plan.modelCode,
    attempt: attempt.index,
    upstreamId: attempt.route.upstreamId,
    ...(attempt.route.accountId ? { accountId: attempt.route.accountId } : {}),
    ...(classified.upstreamStatus !== undefined
      ? { upstreamStatus: classified.upstreamStatus }
      : {}),
    ...(failure.reason ? { reason: failure.reason } : {}),
  };
  const error = new GatewayError(classified.code, { details });
  if (!classified.retryable(attempt.retryClass)) return { action: "fail", error };
  const next = plan.attempts[attempt.index + 1];
  if (next) return { action: "failover", next, error };
  return {
    action: "fail",
    error: new GatewayError("GATEWAY_ROUTES_EXHAUSTED", {
      details: { ...details, attempts: plan.attempts.length, lastCode: classified.code },
      cause: error,
    }),
  };
}
