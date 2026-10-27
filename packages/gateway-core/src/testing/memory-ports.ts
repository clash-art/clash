/**
 * In-memory GatewayPorts: the stub adapter the contract suite runs against and
 * a fake for adapter unit tests. Single-process only; it is not a store.
 *
 * Deliberate gaps (declared to the contract suite as known gaps/unavailable):
 * - limits: rate windows only; in-flight concurrency is not tracked.
 * - scheduler: no job runner, so the port answers GATEWAY_CAPABILITY_UNAVAILABLE.
 *
 * abuse: observations per minute, thresholds from `abuseThresholds`,
 * alerts and suspensions in memory; suspensions append to `audit`.
 *
 * Settlement runs inline: `dispatch` journals the intent and applies it
 * before it resolves, unless paused (pauseSettlement), when only `recover`
 * applies it. A failed apply stays journaled and pending, like a settle run
 * waiting for its retry.
 */
import type {
  ModelUpstreamRoute,
  ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import type {
  GatewayAbuseEvent,
  GatewayAbuseObservation,
  GatewayAbuseThresholds,
  GatewaySuspension,
  GatewaySuspendInput,
} from "../abuse.js";
import {
  budgetFlags,
  planCharge,
  planCheck,
  planDebit,
  planRefund,
  type BudgetFlag,
  type BudgetState,
} from "../budget.js";
import type { GatewayUpstreamHealth } from "../circuit.js";
import { GatewayError, toGatewayError } from "../errors.js";
import { fixedWindowDecision, fixedWindowStart } from "../limits.js";
import {
  unavailablePort,
  type BudgetRefundInput,
  type GatewayAuditEvent,
  type GatewayBlob,
  type GatewayIdentity,
  type GatewayLogFields,
  type GatewayPorts,
  type GatewayRetentionEntry,
  type GatewayUpstreamPort,
  type IdempotencyClaim,
  type UsageEvent,
} from "../ports.js";
import type { GatewayPrice } from "../pricing.js";
import type { GatewayCatalog, GatewayCredentialScope } from "../routing.js";
import {
  applyGatewaySettlement,
  gatewaySettlementRunKey,
  parseGatewaySettlementIntent,
  type GatewaySettlementIntent,
} from "../settlement.js";

export interface MemoryIdentity extends GatewayIdentity {
  /** Epoch ms after which the bearer token is expired. */
  expiresAt?: number;
}

export interface MemoryGatewayOptions {
  /** Bearer token -> identity. */
  identities: Record<string, MemoryIdentity>;
  catalog: GatewayCatalog;
  /** Earlier published versions, answered by name (route pins); `catalog` is the live one. */
  publishedCatalogs?: GatewayCatalog[];
  providers: Record<GatewayCredentialScope, ProviderAccountAvailability[]>;
  prices: GatewayPrice[];
  /**
   * Provider account id -> secret; the account's scope comes from `providers`.
   * A list is a rotation in progress, newest first: `[active, draining]`, the
   * active one with the highest version (`v<n>` … `v1`).
   */
  keys: Record<string, string | readonly string[]>;
  budgets: Array<BudgetState & { tenantId: string }>;
  /** Fixed-window request limits by key id (or user id for keyless callers); others are unlimited. */
  rateLimits?: Record<string, { windowMs: number; limit: number }>;
  startAt?: number;
  upstream?: GatewayUpstreamPort;
  /** Abuse thresholds (#356); mutable, so a test may configure them later. */
  abuseThresholds?: GatewayAbuseThresholds;
}

/** A request's money rows: its `settle` (debit or charge) per budget, then at most one refund. */
interface MoneyEntry {
  event: UsageEvent;
  budgetIds: string[];
  refund?: { status: BudgetRefundInput["status"]; errorCode?: string };
}

interface JournaledSettlement {
  intent: GatewaySettlementIntent;
  applied: boolean;
}

export interface MemoryGateway {
  ports: GatewayPorts;
  advance(ms: number): void;
  /**
   * Stop (true) or resume (false) running settle runs at dispatch: while
   * paused, an intent is journaled and reported `scheduled: false`, and only
   * `ports.settlement.recover()` applies it, as after a lost Workflow start.
   */
  pauseSettlement(paused: boolean): void;
  /** A journaled settle run's state, for tests; undefined when never journaled. */
  settlementState(requestId: string, kind: GatewaySettlementIntent["kind"]): "pending" | "applied" | undefined;
  /** Add a credential and its budgets after creation (fresh fixtures per test). */
  addIdentity(token: string, identity: MemoryIdentity, budgets: Array<BudgetState & { tenantId: string }>): void;
  logs: Array<{ level: "info" | "warn" | "error"; event: string; fields?: GatewayLogFields }>;
}

export function createMemoryGatewayPorts(options: MemoryGatewayOptions): MemoryGateway {
  let now = options.startAt ?? 0;
  let sequence = 0;
  const budgets = new Map(options.budgets.map((budget) => [budget.id, { ...budget }]));
  const money = new Map<string, MoneyEntry>();
  const claims = new Map<string, { requestId: string; expiresAt: number; ended: boolean }>();
  const claimOf = new Map<string, string>();
  const journal = new Map<string, JournaledSettlement>();
  let settlementPaused = false;
  const windows = new Map<string, number>();
  const budgetEvents = new Set<string>();
  const blobs = new Map<string, GatewayBlob>();
  const retention = new Map<string, GatewayRetentionEntry>();
  const audit: GatewayAuditEvent[] = [];
  const health = new Map<string, GatewayUpstreamHealth>();
  const logs: MemoryGateway["logs"] = [];
  const abuseThresholds = options.abuseThresholds ?? {};
  /** Observations per minute: kind, tenant, key, fingerprint, minute -> count. */
  const observations = new Map<string, { event: Required<Omit<GatewayAbuseEvent, "at">>; minute: number; count: number }>();
  const suspensions = new Map<string, GatewaySuspension>();
  const alerts = new Set<string>();
  const activeFor = (kind: GatewaySuspension["subjectKind"], subjectId: string) =>
    [...suspensions.values()].find((entry) => entry.liftedAt === null && entry.subjectKind === kind && entry.subjectId === subjectId);
  const suspendSubject = (input: GatewaySuspendInput, source: GatewaySuspension["source"], signal: GatewaySuspension["signal"]) => {
    const suspension: GatewaySuspension = {
      id: `susp-${(sequence += 1)}`,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      tenantId: input.tenantId,
      source,
      signal,
      reason: input.reason,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      createdAt: input.at,
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    };
    suspensions.set(suspension.id, suspension);
    audit.push({
      id: `audit-${suspension.id}`,
      actor: input.actor.id,
      tenantId: input.tenantId,
      action: "abuse.suspend",
      target: `${input.subjectKind}:${input.subjectId}`,
      after: { source, signal },
      reason: input.reason,
      at: input.at,
    });
    return structuredClone(suspension);
  };

  const scopeOf = (accountId: string | undefined): GatewayCredentialScope | undefined =>
    (["official", "tenant"] as const).find((scope) =>
      options.providers[scope].some((provider) => provider.id === accountId),
    );

  /** The caller's budgets, all present under the tenant; a missing budget is never unlimited. */
  const rowsOf = (tenantId: string, budgetIds: readonly string[]) =>
    [...new Set(budgetIds)].map((id) => {
      const budget = budgets.get(id);
      if (!budget || budget.tenantId !== tenantId)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "Budget not found for tenant; a missing budget is never unlimited.",
          details: { budgetId: id },
        });
      return budget;
    });

  const store = (tenantId: string, next: readonly BudgetState[]) => {
    for (const budget of next) budgets.set(budget.id, { ...budget, tenantId });
  };

  /** Recorded flags only: soft once per request and budget, an alert once per budget and dedupe key. */
  const record = (flags: readonly BudgetFlag[]) =>
    flags.filter((flag) => {
      const key = `${flag.budgetId}\u0000${flag.kind}\u0000${flag.dedupeKey}`;
      if (budgetEvents.has(key)) return false;
      budgetEvents.add(key);
      return true;
    });

  /** Throws when another request holds the key's claim; see IdempotencyClaim. */
  const assertClaimFree = (tenantId: string, requestId: string, claim: IdempotencyClaim | undefined) => {
    const prior = claim ? claims.get(`${tenantId}\u0000${claim.key}`) : undefined;
    if (prior && prior.requestId !== requestId)
      throw new GatewayError(
        !prior.ended && now < prior.expiresAt ? "GATEWAY_IDEMPOTENCY_IN_PROGRESS" : "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED",
        { details: { requestId: prior.requestId } },
      );
  };

  const takeClaim = (tenantId: string, requestId: string, claim: IdempotencyClaim | undefined) => {
    if (!claim) return;
    const id = `${tenantId}\u0000${claim.key}`;
    claims.set(id, { requestId, expiresAt: claim.expiresAt, ended: false });
    claimOf.set(requestId, id);
  };

  const budgetsRequired = (budgetIds: readonly string[]) => {
    if (budgetIds.length === 0)
      throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });
  };

  /** The ledger's one event per request: a refunded debit reads as its refund, at zero. */
  const ledgerEvent = (entry: MoneyEntry): UsageEvent => {
    const event = structuredClone(entry.event);
    if (!entry.refund) return event;
    const { errorCode: _errorCode, ...rest } = event;
    return {
      ...rest,
      status: entry.refund.status,
      costMicroCredits: 0,
      ...(entry.refund.errorCode ? { errorCode: entry.refund.errorCode } : {}),
    };
  };

  const journalKey = (intent: GatewaySettlementIntent) => {
    const { requestId, kind } = gatewaySettlementRunKey(intent);
    return `${requestId}\u0000${kind}`;
  };

  /** One settle run: apply the journaled intent; a failure stays pending for recovery. */
  const run = async (entry: JournaledSettlement): Promise<boolean> => {
    try {
      await applyGatewaySettlement(ports, parseGatewaySettlementIntent(entry.intent));
      entry.applied = true;
      return true;
    } catch (error) {
      logs.push({ level: "error", event: "gateway.settle_run_failed", fields: { cause: toGatewayError(error).code } });
      return false;
    }
  };

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
          throw new GatewayError("GATEWAY_TOKEN_EXPIRED", identity.keyId ? { details: { keyId: identity.keyId } } : {});
        const { expiresAt: _expiresAt, ...rest } = identity;
        return rest;
      },
    },
    routes: {
      async catalog(_identity, query) {
        if (!query?.version) return options.catalog;
        const found = [options.catalog, ...(options.publishedCatalogs ?? [])].find(
          (catalog) => catalog.version === query.version,
        );
        if (!found) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version: query.version } });
        return found;
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
      async resolve({
        route,
        scope,
        excludeKeyVersions = [],
      }: {
        route: ModelUpstreamRoute;
        scope: GatewayCredentialScope;
        excludeKeyVersions?: readonly string[];
      }) {
        const keys = route.accountId ? options.keys[route.accountId] : undefined;
        if (!keys?.length || scopeOf(route.accountId) !== scope)
          throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
            details: { upstreamId: route.upstreamId, scope },
          });
        const versions = (typeof keys === "string" ? [keys] : keys).map((apiKey, index, all) => ({
          apiKey,
          keyVersion: `v${all.length - index}`,
        }));
        const usable = versions.find((version) => !excludeKeyVersions.includes(version.keyVersion));
        if (!usable)
          throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
            details: { accountId: route.accountId, reason: "no_key_version" },
          });
        return { apiKey: usable.apiKey, keyId: route.accountId!, keyVersion: usable.keyVersion };
      },
    },
    upstreamHealth: {
      async read({ accountIds }) {
        return accountIds.flatMap((id) => {
          const entry = health.get(id);
          return entry ? [{ ...entry }] : [];
        });
      },
      async recordFailure({ accountId, code, at, threshold, openUntil }) {
        const before = health.get(accountId);
        const consecutiveFailures = (before?.consecutiveFailures ?? 0) + 1;
        const after: GatewayUpstreamHealth = {
          ...before,
          accountId,
          consecutiveFailures,
          lastFailureCode: code,
          lastFailureAt: at,
          ...(consecutiveFailures >= threshold ? { openUntil } : {}),
        };
        health.set(accountId, after);
        return { ...after };
      },
      async recordSuccess({ accountId, at }) {
        const before = health.get(accountId);
        if (!before) return;
        const { openUntil: _openUntil, ...rest } = before;
        health.set(accountId, { ...rest, consecutiveFailures: 0, lastSuccessAt: at });
      },
    },
    budgets: {
      async check(input) {
        budgetsRequired(input.budgetIds);
        assertClaimFree(input.tenantId, input.requestId, input.idempotency);
        const { flags } = planCheck(rowsOf(input.tenantId, input.budgetIds), input.floorMicroCredits, input.requestId);
        const recorded = record(flags);
        takeClaim(input.tenantId, input.requestId, input.idempotency);
        return recorded.length ? { flags: recorded } : {};
      },
      async debit({ budgetIds, idempotency, ...event }) {
        budgetsRequired(budgetIds);
        assertClaimFree(event.tenantId, event.requestId, idempotency);
        if (money.has(event.requestId))
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "Request id already debited.",
            details: { requestId: event.requestId },
          });
        const rows = rowsOf(event.tenantId, budgetIds);
        const planned = planDebit(rows, event.costMicroCredits, event.requestId);
        store(event.tenantId, planned.budgets);
        const recorded = record(planned.flags);
        money.set(event.requestId, { event: structuredClone(event), budgetIds: rows.map((budget) => budget.id) });
        takeClaim(event.tenantId, event.requestId, idempotency);
        return recorded.length ? { flags: recorded } : {};
      },
      async charge({ budgetIds, ...event }) {
        const existing = money.get(event.requestId);
        if (existing)
          return { requestId: event.requestId, kind: "charge", costMicroCredits: existing.event.costMicroCredits, duplicate: true };
        const rows = rowsOf(event.tenantId, budgetIds);
        record(rows.flatMap((budget) => budgetFlags(budget, event.costMicroCredits, event.requestId)));
        store(
          event.tenantId,
          rows.map((budget) => planCharge(budget, event.costMicroCredits)),
        );
        money.set(event.requestId, { event: structuredClone(event), budgetIds: rows.map((budget) => budget.id) });
        return { requestId: event.requestId, kind: "charge", costMicroCredits: event.costMicroCredits, duplicate: false };
      },
      async refund(input) {
        const entry = money.get(input.requestId);
        if (!entry || entry.event.tenantId !== input.tenantId)
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "Refund for a request that recorded no money.",
            details: { requestId: input.requestId },
          });
        const amount = entry.event.costMicroCredits;
        if (entry.refund) return { requestId: input.requestId, kind: "refund", costMicroCredits: amount, duplicate: true };
        store(
          input.tenantId,
          entry.budgetIds.map((id) => planRefund(budgets.get(id)!, amount)),
        );
        entry.refund = { status: input.status, ...(input.errorCode ? { errorCode: input.errorCode } : {}) };
        return { requestId: input.requestId, kind: "refund", costMicroCredits: amount, duplicate: false };
      },
      async endIdempotency({ requestId }) {
        const id = claimOf.get(requestId);
        const claim = id ? claims.get(id) : undefined;
        if (claim?.requestId === requestId) claim.ended = true;
      },
      async snapshot({ tenantId, budgetIds }) {
        return [...budgets.values()]
          .filter((budget) => budget.tenantId === tenantId)
          .filter((budget) => !budgetIds || budgetIds.includes(budget.id))
          .map(({ tenantId: _tenantId, ...budget }) => budget);
      },
    },
    settlement: {
      async dispatch(intent) {
        const parsed = parseGatewaySettlementIntent(intent);
        const key = journalKey(parsed);
        let entry = journal.get(key);
        if (entry && JSON.stringify(entry.intent) !== JSON.stringify(parsed))
          throw new GatewayError("GATEWAY_INTERNAL", {
            message: "A different settlement is already journaled for this request.",
            details: gatewaySettlementRunKey(parsed),
          });
        if (!entry) journal.set(key, (entry = { intent: structuredClone(parsed), applied: false }));
        const runKey = gatewaySettlementRunKey(parsed);
        if (settlementPaused) return { ...runKey, scheduled: false };
        if (!entry.applied) await run(entry);
        return { ...runKey, scheduled: true };
      },
      async recover() {
        const due = [...journal.values()].filter((entry) => !entry.applied);
        let scheduled = 0;
        for (const entry of due) if (await run(entry)) scheduled += 1;
        return { scanned: due.length, scheduled, failed: due.length - scheduled };
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
        const entry = money.get(requestId);
        return entry && entry.event.tenantId === tenantId ? ledgerEvent(entry) : null;
      },
      async query(filter) {
        return [...money.values()]
          .map(ledgerEvent)
          .filter((event) => event.tenantId === filter.tenantId)
          .filter((event) => !filter.userId || event.userId === filter.userId)
          .filter((event) => !filter.keyId || event.keyId === filter.keyId)
          .filter((event) => filter.from === undefined || event.occurredAt >= filter.from)
          .filter((event) => filter.to === undefined || event.occurredAt < filter.to)
          .sort((a, b) => b.occurredAt - a.occurredAt)
          .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
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
    retention: {
      async record(entry) {
        if (!retention.has(entry.requestId)) retention.set(entry.requestId, structuredClone(entry));
      },
      async get({ requestId }) {
        const entry = retention.get(requestId);
        return entry ? structuredClone(entry) : null;
      },
      async expired({ before, limit }) {
        return [...retention.values()]
          .filter((entry) => entry.status !== "purged" && entry.expiresAt <= before)
          .sort((a, b) => a.expiresAt - b.expiresAt)
          .slice(0, limit)
          .map((entry) => structuredClone(entry));
      },
      async markPurged({ requestId, at }) {
        const entry = retention.get(requestId);
        if (entry && entry.status !== "purged") retention.set(requestId, { ...entry, status: "purged", purgedAt: at });
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
    abuse: {
      async activeSuspension({ tenantId, keyIds }) {
        const found = activeFor("tenant", tenantId) ?? keyIds.map((keyId) => activeFor("key", keyId)).find(Boolean);
        return found ? structuredClone(found) : null;
      },
      async observe(event) {
        // A refused credential's tenant and key are known here only through the identity it maps to.
        const known = event.keyId
          ? Object.values(options.identities).find((identity) => (identity.abuseKeyId ?? identity.keyId) === event.keyId || identity.keyId === event.keyId)
          : undefined;
        const counted = {
          kind: event.kind,
          tenantId: event.tenantId ?? known?.tenantId ?? "",
          keyId: event.keyId ? (known?.abuseKeyId ?? event.keyId) : "",
          fingerprint: event.fingerprint,
        };
        const minute = fixedWindowStart(event.at, 60_000);
        const key = JSON.stringify([counted, minute]);
        const entry = observations.get(key);
        if (entry) entry.count += 1;
        else observations.set(key, { event: counted, minute, count: 1 });
      },
      async measure({ signal, since, atLeast, limit }) {
        const totals = new Map<string, GatewayAbuseObservation & { fingerprints: Set<string> }>();
        const add = (subject: Omit<GatewayAbuseObservation, "signal" | "value">, value: number, fingerprint?: string) => {
          const key = `${subject.subjectKind}\u0000${subject.subjectId}\u0000${subject.tenantId ?? ""}`;
          const total = totals.get(key) ?? { signal, ...subject, value: 0, fingerprints: new Set<string>() };
          if (fingerprint === undefined) total.value += value;
          else {
            total.fingerprints.add(fingerprint);
            total.value = total.fingerprints.size;
          }
          totals.set(key, total);
        };
        if (signal === "spend") {
          for (const event of [...money.values()].map(ledgerEvent))
            if (event.occurredAt >= since) add({ subjectKind: "tenant", subjectId: event.tenantId, tenantId: event.tenantId }, event.costMicroCredits);
        } else {
          const since0 = fixedWindowStart(since, 60_000);
          for (const { event, minute, count } of observations.values()) {
            if (minute < since0) continue;
            if (signal === "auth_failures" && event.kind === "auth_failure")
              add(
                event.tenantId
                  ? { subjectKind: "tenant", subjectId: event.tenantId, tenantId: event.tenantId }
                  : { subjectKind: "client", subjectId: event.fingerprint, tenantId: null },
                count,
              );
            if (signal !== "auth_failures" && event.kind === "request" && event.keyId) {
              const subject = { subjectKind: "key" as const, subjectId: event.keyId, tenantId: event.tenantId };
              if (signal === "velocity") add(subject, count);
              else add(subject, 0, event.fingerprint);
            }
          }
        }
        return [...totals.values()]
          .filter((total) => total.value >= atLeast)
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
          .map(({ fingerprints: _fingerprints, ...total }) => total);
      },
      async thresholds() {
        return structuredClone(abuseThresholds);
      },
      async setThreshold({ signal, threshold, actor, reason, at }) {
        const before = abuseThresholds[signal] ?? null;
        if (JSON.stringify(before) === JSON.stringify(threshold)) return { changed: false };
        if (threshold) abuseThresholds[signal] = structuredClone(threshold);
        else delete abuseThresholds[signal];
        audit.push({
          id: `audit-threshold-${(sequence += 1)}`,
          actor: actor.id,
          tenantId: "",
          action: "abuse.threshold",
          target: `signal:${signal}`,
          ...(before ? { before } : {}),
          ...(threshold ? { after: threshold } : {}),
          ...(reason ? { reason } : {}),
          at,
        });
        return { changed: true };
      },
      async raise({ decision, windowStart, at }) {
        const key = JSON.stringify([decision.signal, decision.subjectKind, decision.subjectId, windowStart, decision.action]);
        if (alerts.has(key)) return { raised: false, suspension: null };
        alerts.add(key);
        if (decision.action !== "suspend" || decision.subjectKind === "client") return { raised: true, suspension: null };
        if (activeFor(decision.subjectKind, decision.subjectId)) return { raised: true, suspension: null };
        const suspension = suspendSubject(
          {
            subjectKind: decision.subjectKind,
            subjectId: decision.subjectId,
            tenantId: decision.tenantId ?? "",
            reason: `${decision.signal} ${decision.value} >= ${decision.threshold} in ${decision.windowMinutes} min`,
            actor: { kind: "system", id: `threshold:${decision.signal}`, role: "abuse_threshold" },
            at,
          },
          "auto",
          decision.signal,
        );
        return { raised: true, suspension };
      },
      async suspend(input) {
        if (activeFor(input.subjectKind, input.subjectId))
          throw new GatewayError("GATEWAY_SUSPENSION_EXISTS", { details: { subjectKind: input.subjectKind } });
        return suspendSubject(input, "manual", null);
      },
      async lift({ suspensionId, reason, actor, at }) {
        const suspension = suspensions.get(suspensionId);
        if (!suspension || suspension.liftedAt !== null)
          throw new GatewayError("GATEWAY_SUSPENSION_NOT_FOUND", { details: { suspensionId } });
        Object.assign(suspension, { liftedAt: at, liftedBy: actor.id, liftReason: reason });
        audit.push({
          id: `audit-lift-${suspensionId}`,
          actor: actor.id,
          tenantId: suspension.tenantId,
          action: "abuse.lift",
          target: `${suspension.subjectKind}:${suspension.subjectId}`,
          reason,
          at,
        });
        return structuredClone(suspension);
      },
      async prune({ before }) {
        let pruned = 0;
        for (const [key, entry] of observations)
          if (entry.minute < before) {
            observations.delete(key);
            pruned += 1;
          }
        return pruned;
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
    pauseSettlement(paused) {
      settlementPaused = paused;
    },
    settlementState(requestId, kind) {
      const entry = journal.get(`${requestId}\u0000${kind}`);
      return entry ? (entry.applied ? "applied" : "pending") : undefined;
    },
    addIdentity(token, identity, added) {
      options.identities[token] = identity;
      for (const budget of added) budgets.set(budget.id, { ...budget });
    },
    logs,
  };
}
