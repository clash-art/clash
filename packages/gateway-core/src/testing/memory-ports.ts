/**
 * In-memory GatewayPorts: the stub adapter the contract suite runs against and
 * a fake for adapter unit tests. Single-process only; it is not a store.
 *
 * Deliberate gaps (declared to the contract suite as known gaps/unavailable):
 * - limits: rate windows only; in-flight concurrency is not tracked.
 * - scheduler: no job runner, so the port answers GATEWAY_CAPABILITY_UNAVAILABLE.
 */
import type {
  ModelUpstreamRoute,
  ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import { planReserve, planSettle, type BudgetHold, type BudgetState } from "../budget.js";
import { GatewayError } from "../errors.js";
import { fixedWindowDecision, fixedWindowStart } from "../limits.js";
import {
  unavailablePort,
  type GatewayAuditEvent,
  type GatewayBlob,
  type GatewayIdentity,
  type GatewayLogFields,
  type GatewayPorts,
  type GatewayUpstreamPort,
  type UsageEvent,
} from "../ports.js";
import type { GatewayPrice } from "../pricing.js";
import type { GatewayCatalog, GatewayCredentialScope } from "../routing.js";

export interface MemoryIdentity extends GatewayIdentity {
  /** Epoch ms after which the bearer token is expired. */
  expiresAt?: number;
}

export interface MemoryGatewayOptions {
  /** Bearer token -> identity. */
  identities: Record<string, MemoryIdentity>;
  catalog: GatewayCatalog;
  providers: Record<GatewayCredentialScope, ProviderAccountAvailability[]>;
  prices: GatewayPrice[];
  /** Provider account id -> secret; the account's scope comes from `providers`. */
  keys: Record<string, string>;
  budgets: Array<BudgetState & { tenantId: string }>;
  /** Fixed-window request limits by key id (or user id for keyless callers); others are unlimited. */
  rateLimits?: Record<string, { windowMs: number; limit: number }>;
  startAt?: number;
  upstream?: GatewayUpstreamPort;
}

interface OpenReservation {
  tenantId: string;
  holds: BudgetHold[];
  idempotencyKey?: string;
  state: "open" | "settle_failed" | "settled";
}

export interface MemoryGateway {
  ports: GatewayPorts;
  advance(ms: number): void;
  /** Reservation state of a request, for tests; undefined when never reserved. */
  reservationState(requestId: string): OpenReservation["state"] | undefined;
  logs: Array<{ level: "info" | "warn" | "error"; event: string; fields?: GatewayLogFields }>;
}

export function createMemoryGatewayPorts(options: MemoryGatewayOptions): MemoryGateway {
  let now = options.startAt ?? 0;
  let sequence = 0;
  const budgets = new Map(options.budgets.map((budget) => [budget.id, { ...budget }]));
  const reservations = new Map<string, OpenReservation>();
  const idempotency = new Map<string, string>();
  const ledger = new Map<string, UsageEvent>();
  const windows = new Map<string, number>();
  const blobs = new Map<string, GatewayBlob>();
  const audit: GatewayAuditEvent[] = [];
  const logs: MemoryGateway["logs"] = [];

  const scopeOf = (accountId: string | undefined): GatewayCredentialScope | undefined =>
    (["official", "tenant"] as const).find((scope) =>
      options.providers[scope].some((provider) => provider.id === accountId),
    );

  const ports: GatewayPorts = {
    clock: { now: () => now },
    ids: { requestId: () => `req-${(sequence += 1)}` },
    identity: {
      async authenticate(request) {
        const header = request.headers.get("authorization") ?? "";
        const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
        const identity = token ? options.identities[token] : undefined;
        if (!identity) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
        if (identity.expiresAt !== undefined && now >= identity.expiresAt)
          throw new GatewayError("GATEWAY_TOKEN_EXPIRED");
        const { expiresAt: _expiresAt, ...rest } = identity;
        return rest;
      },
    },
    routes: {
      async catalog() {
        return options.catalog;
      },
      async providers(_identity, scope) {
        return options.providers[scope].map((provider) => ({ ...provider }));
      },
      async price({ route }) {
        const price =
          options.prices.find(
            (entry) => entry.modelCode === route.modelCode && entry.upstreamId === route.upstreamId,
          ) ??
          options.prices.find(
            (entry) => entry.modelCode === route.modelCode && entry.upstreamId === undefined,
          );
        if (!price)
          throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
            details: { modelCode: route.modelCode, upstreamId: route.upstreamId },
          });
        return price;
      },
    },
    credentials: {
      async resolve({ route, scope }: { route: ModelUpstreamRoute; scope: GatewayCredentialScope }) {
        const apiKey = route.accountId ? options.keys[route.accountId] : undefined;
        if (!apiKey || scopeOf(route.accountId) !== scope)
          throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
            details: { upstreamId: route.upstreamId, scope },
          });
        return { apiKey, keyId: `${route.accountId}:v1`, keyVersion: "v1" };
      },
    },
    budgets: {
      async reserve(input) {
        const idempotencyId = input.idempotencyKey
          ? `${input.tenantId}\u0000${input.idempotencyKey}`
          : undefined;
        const prior = idempotencyId ? idempotency.get(idempotencyId) : undefined;
        if (prior !== undefined) {
          const settled = reservations.get(prior)?.state === "settled";
          throw new GatewayError(
            settled ? "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED" : "GATEWAY_IDEMPOTENCY_IN_PROGRESS",
            { details: { requestId: prior } },
          );
        }
        if (reservations.has(input.requestId))
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "Request id already reserved.",
            details: { requestId: input.requestId },
          });
        const rows = input.budgetIds.map((id) => {
          const budget = budgets.get(id);
          if (!budget || budget.tenantId !== input.tenantId)
            throw new GatewayError("GATEWAY_INTERNAL", {
              message: "Budget not found for tenant; a missing budget is never unlimited.",
              details: { budgetId: id },
            });
          return budget;
        });
        const planned = planReserve(rows, input.holdMicroCredits);
        for (const budget of planned.budgets)
          budgets.set(budget.id, { ...budget, tenantId: input.tenantId });
        reservations.set(input.requestId, {
          tenantId: input.tenantId,
          holds: planned.holds,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          state: "open",
        });
        if (idempotencyId) idempotency.set(idempotencyId, input.requestId);
        return { requestId: input.requestId, holds: planned.holds, expiresAt: input.expiresAt };
      },
      async settle(event) {
        const existing = ledger.get(event.requestId);
        if (existing)
          return {
            requestId: event.requestId,
            costMicroCredits: existing.costMicroCredits,
            duplicate: true,
          };
        const reservation = reservations.get(event.requestId);
        if (!reservation || reservation.tenantId !== event.tenantId)
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "Settlement for a request that was never reserved.",
            details: { requestId: event.requestId },
          });
        const next = reservation.holds.map((hold) => {
          const budget = budgets.get(hold.budgetId)!;
          return { ...planSettle(budget, hold, event.costMicroCredits).budget, tenantId: budget.tenantId };
        });
        for (const budget of next) budgets.set(budget.id, budget);
        reservation.state = "settled";
        ledger.set(event.requestId, structuredClone(event));
        return { requestId: event.requestId, costMicroCredits: event.costMicroCredits, duplicate: false };
      },
      async markSettleFailed({ requestId, tenantId }) {
        const reservation = reservations.get(requestId);
        if (!reservation || reservation.tenantId !== tenantId)
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "Settlement failure for a request that was never reserved.",
            details: { requestId },
          });
        if (reservation.state === "settled") return { status: "settled" };
        reservation.state = "settle_failed";
        return { status: "settle_failed" };
      },
      async snapshot({ tenantId, budgetIds }) {
        return [...budgets.values()]
          .filter((budget) => budget.tenantId === tenantId)
          .filter((budget) => !budgetIds || budgetIds.includes(budget.id))
          .map(({ tenantId: _tenantId, ...budget }) => budget);
      },
    },
    limits: {
      async admit(input) {
        const leaseId = `lease-${(sequence += 1)}`;
        const scope = input.keyId ? "key" : "user";
        const subject = input.keyId ?? input.userId;
        const rate = options.rateLimits?.[subject];
        if (!rate) return { allowed: true, leaseId };
        const key = `${input.tenantId}\u0000${scope}\u0000${subject}\u0000${fixedWindowStart(now, rate.windowMs)}`;
        const count = (windows.get(key) ?? 0) + 1;
        windows.set(key, count);
        const decision = fixedWindowDecision({
          nowMs: now,
          windowMs: rate.windowMs,
          count,
          limit: rate.limit,
        });
        return decision.allowed
          ? { allowed: true, leaseId }
          : { allowed: false, code: "GATEWAY_RATE_LIMITED", scope, retryAfterMs: decision.retryAfterMs };
      },
      async release() {
        // No in-flight tracking (known gap): nothing to release.
      },
    },
    ledger: {
      async get({ tenantId, requestId }) {
        const event = ledger.get(requestId);
        return event && event.tenantId === tenantId ? structuredClone(event) : null;
      },
      async query(filter) {
        return [...ledger.values()]
          .filter((event) => event.tenantId === filter.tenantId)
          .filter((event) => !filter.userId || event.userId === filter.userId)
          .filter((event) => !filter.keyId || event.keyId === filter.keyId)
          .filter((event) => filter.from === undefined || event.occurredAt >= filter.from)
          .filter((event) => filter.to === undefined || event.occurredAt < filter.to)
          .sort((a, b) => b.occurredAt - a.occurredAt)
          .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
          .map((event) => structuredClone(event));
      },
    },
    blobs: {
      async put(key, blob) {
        blobs.set(key, { ...blob, body: blob.body.slice() });
      },
      async get(key) {
        const blob = blobs.get(key);
        return blob ? { ...blob, body: blob.body.slice() } : null;
      },
      async delete(key) {
        blobs.delete(key);
      },
    },
    scheduler: unavailablePort("scheduler"),
    audit: {
      async append(event) {
        audit.push(structuredClone(event));
      },
      async query({ tenantId, limit }) {
        return audit
          .filter((event) => event.tenantId === tenantId)
          .slice(-(limit ?? audit.length))
          .reverse()
          .map((event) => structuredClone(event));
      },
    },
    logger: {
      info: (event, fields) => void logs.push({ level: "info", event, fields }),
      warn: (event, fields) => void logs.push({ level: "warn", event, fields }),
      error: (event, fields) => void logs.push({ level: "error", event, fields }),
    },
    upstream: options.upstream ?? unavailablePort("upstream"),
  };

  return {
    ports,
    advance(ms) {
      now += ms;
    },
    reservationState: (requestId) => reservations.get(requestId)?.state,
    logs,
  };
}
