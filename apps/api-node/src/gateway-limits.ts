/**
 * Postgres gateway rate limits + in-flight concurrency for the Node self-host
 * gateway (#364). Implements gateway-core's `GatewayLimitPort` over the #362
 * schema (`gateway_rate_window`, `gateway_inflight`, `gateway_config`,
 * `gateway_model.rate_limit_json`).
 *
 * Multi-instance rules (decision 12): every counter lives in Postgres and every
 * clock reading comes from Postgres (`clock_timestamp()`), so N gateway nodes
 * with skewed clocks share one fixed window and one in-flight count. There is
 * no in-process Map: a node can restart at any time without losing or
 * duplicating a count.
 *
 * - Rate windows: fixed one-minute windows. `INSERT … ON CONFLICT DO UPDATE …
 *   RETURNING` increments the row atomically, so under any race the k-th
 *   request sees count k and exactly `limit` requests are admitted. A denied
 *   request still counts in its window (same as the D1 adapter).
 * - Concurrency: each bounded subject is serialised with a transaction-scoped
 *   advisory lock, then expired leases are dropped, the live leases counted and
 *   the new lease inserted only if under the bound. A lease that is never
 *   released expires after `leaseTtlMs`; `sweep()` is the repair sweeper that
 *   deletes expired leases and stale windows across all subjects.
 *
 * Limits are configuration (decision 5), read per request from
 * `gateway_config` (GatewayRateLimitSchema JSON):
 *   limits.default.tenant | limits.default.user | limits.default.key
 *   limits.tenant.<t>               (overrides the tenant default)
 *   limits.tenant.<t>.user.<u>      (overrides the user default)
 *   limits.tenant.<t>.key.<k>       (overrides the key default)
 * plus the enabled, published `gateway_model.rate_limit_json`, counted per
 * member and model. An absent config admits; a malformed one fails closed.
 */

import { randomUUID } from "node:crypto";
import {
  GatewayError,
  StoredGatewayRateLimitSchema,
  fixedWindowDecision,
  fixedWindowStart,
  toGatewayError,
  type GatewayLimitPort,
  type GatewayRateLimit,
  type LimitDecision,
  type LimitInput,
  type LimitScope,
} from "@clash/gateway-core";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";

const WINDOW_MS = 60_000;
/** Default life of an unreleased lease. */
export const GATEWAY_PG_LEASE_TTL_MS = 15 * 60 * 1000;
/** Advisory retry for a concurrency denial: there is no window to wait for. */
const CONCURRENCY_RETRY_AFTER_MS = 1_000;

type RateLimit = Partial<GatewayRateLimit>;

export const gatewayLimitConfigKeys = {
  defaultFor: (scope: LimitScope) => `limits.default.${scope}`,
  tenant: (t: string) => `limits.tenant.${t}`,
  user: (t: string, u: string) => `limits.tenant.${t}.user.${u}`,
  key: (t: string, k: string) => `limits.tenant.${t}.key.${k}`,
};

/** Counter subjects; each starts with its tenant (#354). */
export const gatewayPgLimitSubjects = {
  tenant: (t: string) => `tenant:${t}`,
  key: (t: string, k: string) => `tenant:${t}:key:${k}`,
  member: (t: string, u: string) => `tenant:${t}:user:${u}`,
  model: (t: string, m: string, u: string) =>
    `tenant:${t}:model:${m}:user:${u}`,
  media: (subject: string) => `${subject}:media`,
};

/** OpenAI-style `x-ratelimit-*` headers (plus `retry-after` on a denial). */
export type GatewayRateLimitHeaders = Record<string, string>;

export type PgLimitDecision = LimitDecision & {
  headers: GatewayRateLimitHeaders;
};

export interface PgGatewayLimitPort extends GatewayLimitPort {
  admit(input: LimitInput): Promise<PgLimitDecision>;
  /** Repair sweeper: delete expired leases and windows older than the previous one. */
  sweep(input?: {
    limit?: number;
  }): Promise<{ leases: number; windows: number }>;
}

export interface PgGatewayLimitOptions {
  leaseTtlMs?: number;
  /** Lease id generator (tests). */
  leaseId?: () => string;
}

interface Subject {
  scope: LimitScope;
  subject: string;
  limits: RateLimit;
}

function parseLimits(raw: unknown, source: string): RateLimit | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  const parsed = StoredGatewayRateLimitSchema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A configured rate limit is malformed.",
      details: { source },
    });
  return parsed.data;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return Symbol("invalid");
  }
}

function toInt(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : Number(value as number);
  if (!Number.isSafeInteger(n))
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A limit counter is not an integer.",
    });
  return n;
}

async function dbNowMs(tx: GatewayBudgetSqlClient): Promise<number> {
  const { rows } = await tx.query<{ now_ms: unknown }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  return toInt(rows[0]?.now_ms);
}

interface WindowState {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  resetMs: number;
}

/** Build OpenAI-style headers from the tightest observed window state. */
export function gatewayRateLimitHeaders(
  state: WindowState | undefined,
  retryAfterMs?: number,
): GatewayRateLimitHeaders {
  const headers: GatewayRateLimitHeaders = {};
  if (state) {
    const reset = `${Math.max(0, Math.ceil(state.resetMs / 1000))}s`;
    if (state.limitRequests !== undefined) {
      headers["x-ratelimit-limit-requests"] = String(state.limitRequests);
      headers["x-ratelimit-remaining-requests"] = String(
        state.remainingRequests ?? 0,
      );
      headers["x-ratelimit-reset-requests"] = reset;
    }
    if (state.limitTokens !== undefined) {
      headers["x-ratelimit-limit-tokens"] = String(state.limitTokens);
      headers["x-ratelimit-remaining-tokens"] = String(
        state.remainingTokens ?? 0,
      );
      headers["x-ratelimit-reset-tokens"] = reset;
    }
  }
  if (retryAfterMs !== undefined)
    headers["retry-after"] = String(
      Math.max(1, Math.ceil(retryAfterMs / 1000)),
    );
  return headers;
}

export function createPgGatewayLimitPort(
  db: GatewayBudgetDatabase,
  options: PgGatewayLimitOptions = {},
): PgGatewayLimitPort {
  const leaseTtlMs = options.leaseTtlMs ?? GATEWAY_PG_LEASE_TTL_MS;
  const nextLeaseId = options.leaseId ?? (() => `gwl_${randomUUID()}`);

  async function subjects(
    tx: GatewayBudgetSqlClient,
    input: LimitInput,
  ): Promise<Subject[]> {
    const t = input.tenantId;
    const keys = [
      gatewayLimitConfigKeys.defaultFor("tenant"),
      gatewayLimitConfigKeys.defaultFor("user"),
      gatewayLimitConfigKeys.defaultFor("key"),
      gatewayLimitConfigKeys.tenant(t),
      gatewayLimitConfigKeys.user(t, input.userId),
      ...(input.keyId ? [gatewayLimitConfigKeys.key(t, input.keyId)] : []),
    ];
    const { rows } = await tx.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM gateway_config WHERE key = ANY($1::text[])",
      [keys],
    );
    const config = new Map(rows.map((row) => [row.key, row.value]));
    const pick = (specific: string, scope: LimitScope) =>
      config.has(specific)
        ? parseLimits(config.get(specific), specific)
        : parseLimits(
            config.get(gatewayLimitConfigKeys.defaultFor(scope)),
            `default.${scope}`,
          );

    const model = await tx.query<{ rate_limit_json: unknown }>(
      `SELECT rate_limit_json FROM gateway_model
        WHERE model_code = $1 AND enabled = 1 AND published_at IS NOT NULL
        ORDER BY published_at DESC LIMIT 1`,
      [input.modelCode],
    );

    const list: Subject[] = [];
    if (input.keyId) {
      const key = pick(gatewayLimitConfigKeys.key(t, input.keyId), "key");
      if (key)
        list.push({
          scope: "key",
          subject: gatewayPgLimitSubjects.key(t, input.keyId),
          limits: key,
        });
    }
    const member = pick(gatewayLimitConfigKeys.user(t, input.userId), "user");
    if (member)
      list.push({
        scope: "user",
        subject: gatewayPgLimitSubjects.member(t, input.userId),
        limits: member,
      });
    const modelLimits = parseLimits(model.rows[0]?.rate_limit_json, "model");
    if (modelLimits)
      list.push({
        scope: "user",
        subject: gatewayPgLimitSubjects.model(t, input.modelCode, input.userId),
        limits: modelLimits,
      });
    const tenant = pick(gatewayLimitConfigKeys.tenant(t), "tenant");
    if (tenant)
      list.push({
        scope: "tenant",
        subject: gatewayPgLimitSubjects.tenant(t),
        limits: tenant,
      });
    // Stable lock order across nodes avoids deadlocks.
    return list.sort((a, b) =>
      a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
    );
  }

  async function countWindows(
    tx: GatewayBudgetSqlClient,
    list: Subject[],
    estimatedTokens: number,
    nowMs: number,
  ): Promise<{
    denial?: Extract<LimitDecision, { allowed: false }>;
    state?: WindowState;
  }> {
    const rated = list.filter(
      (e) => e.limits.requestsPerMinute || e.limits.tokensPerMinute,
    );
    if (rated.length === 0) return {};
    const windowStartMs = fixedWindowStart(nowMs, WINDOW_MS);
    const windowS = Math.floor(windowStartMs / 1000);
    const resetMs = windowStartMs + WINDOW_MS - nowMs;
    const tokens = Math.max(0, Math.ceil(estimatedTokens));
    let state: WindowState | undefined;
    let denial: Extract<LimitDecision, { allowed: false }> | undefined;
    for (const entry of rated) {
      const { rows } = await tx.query<{ requests: unknown; tokens: unknown }>(
        `INSERT INTO gateway_rate_window (subject, window_start, requests, tokens)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (subject, window_start)
         DO UPDATE SET requests = gateway_rate_window.requests + 1,
                       tokens = gateway_rate_window.tokens + excluded.tokens
         RETURNING requests, tokens`,
        [entry.subject, windowS, tokens],
      );
      const requests = toInt(rows[0]?.requests);
      const used = toInt(rows[0]?.tokens);
      const rpm = entry.limits.requestsPerMinute;
      const tpm = entry.limits.tokensPerMinute;
      // Headers report the tightest (least remaining) bound observed.
      if (rpm !== undefined) {
        const remaining = Math.max(0, rpm - requests);
        if (
          !state ||
          state.remainingRequests === undefined ||
          remaining < state.remainingRequests
        )
          state = {
            ...state,
            resetMs,
            limitRequests: rpm,
            remainingRequests: remaining,
          };
      }
      if (tpm !== undefined) {
        const remaining = Math.max(0, tpm - used);
        if (
          !state ||
          state.remainingTokens === undefined ||
          remaining < state.remainingTokens
        )
          state = {
            ...state,
            resetMs,
            limitTokens: tpm,
            remainingTokens: remaining,
          };
      }
      if (denial) continue;
      for (const [count, limit] of [
        [requests, rpm],
        [used, tpm],
      ] as const) {
        if (!limit) continue;
        const decision = fixedWindowDecision({
          nowMs,
          windowMs: WINDOW_MS,
          count,
          limit,
        });
        if (!decision.allowed) {
          denial = {
            allowed: false,
            code: "GATEWAY_RATE_LIMITED",
            scope: entry.scope,
            retryAfterMs: decision.retryAfterMs,
          };
          break;
        }
      }
    }
    return { ...(denial ? { denial } : {}), ...(state ? { state } : {}) };
  }

  async function lease(
    tx: GatewayBudgetSqlClient,
    list: Subject[],
    leaseId: string,
    nowMs: number,
    media: boolean,
  ): Promise<LimitDecision> {
    const bounded = list
      .flatMap((e) => [
        ...(e.limits.concurrency
          ? [
              {
                scope: e.scope,
                subject: e.subject,
                limit: e.limits.concurrency,
              },
            ]
          : []),
        ...(media && e.limits.mediaJobs
          ? [
              {
                scope: e.scope,
                subject: gatewayPgLimitSubjects.media(e.subject),
                limit: e.limits.mediaJobs,
              },
            ]
          : []),
      ])
      .sort((a, b) =>
        a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
      );
    if (bounded.length === 0) return { allowed: true, leaseId };
    const nowS = Math.floor(nowMs / 1000);
    const expiresS = Math.floor((nowMs + leaseTtlMs) / 1000);
    for (const entry of bounded) {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 364))",
        [`gateway_inflight:${entry.subject}`],
      );
      await tx.query(
        "DELETE FROM gateway_inflight WHERE subject = $1 AND expires_at <= $2",
        [entry.subject, nowS],
      );
      const { rows } = await tx.query<{ n: unknown }>(
        "SELECT count(*)::bigint AS n FROM gateway_inflight WHERE subject = $1",
        [entry.subject],
      );
      if (toInt(rows[0]?.n) >= entry.limit) {
        await tx.query("DELETE FROM gateway_inflight WHERE lease_id = $1", [
          leaseId,
        ]);
        return {
          allowed: false,
          code: "GATEWAY_CONCURRENCY_LIMITED",
          scope: entry.scope,
          retryAfterMs: CONCURRENCY_RETRY_AFTER_MS,
        };
      }
      await tx.query(
        `INSERT INTO gateway_inflight (lease_id, subject, expires_at, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [leaseId, entry.subject, expiresS, nowS],
      );
    }
    return { allowed: true, leaseId };
  }

  return {
    async admit(input) {
      try {
        return await db.transaction(async (tx) => {
          const nowMs = await dbNowMs(tx);
          const list = await subjects(tx, input);
          const leaseId = nextLeaseId();
          const windows = await countWindows(
            tx,
            list,
            input.estimatedTokens,
            nowMs,
          );
          const decision =
            windows.denial ??
            (await lease(tx, list, leaseId, nowMs, input.media === true));
          const headers = gatewayRateLimitHeaders(
            windows.state,
            decision.allowed ? undefined : decision.retryAfterMs,
          );
          return { ...decision, headers };
        });
      } catch (error) {
        throw toGatewayError(error);
      }
    },
    async release({ leaseId }) {
      await db.query("DELETE FROM gateway_inflight WHERE lease_id = $1", [
        leaseId,
      ]);
    },
    async sweep(input = {}) {
      const limit = input.limit ?? 10_000;
      try {
        return await db.transaction(async (tx) => {
          const nowMs = await dbNowMs(tx);
          const nowS = Math.floor(nowMs / 1000);
          const leases = await tx.query<{ n: unknown }>(
            `WITH gone AS (
               DELETE FROM gateway_inflight WHERE (lease_id, subject) IN (
                 SELECT lease_id, subject FROM gateway_inflight
                  WHERE expires_at <= $1 LIMIT $2)
               RETURNING 1)
             SELECT count(*)::bigint AS n FROM gone`,
            [nowS, limit],
          );
          const previousWindowS = Math.floor(
            (fixedWindowStart(nowMs, WINDOW_MS) - WINDOW_MS) / 1000,
          );
          const windows = await tx.query<{ n: unknown }>(
            `WITH gone AS (
               DELETE FROM gateway_rate_window WHERE (subject, window_start) IN (
                 SELECT subject, window_start FROM gateway_rate_window
                  WHERE window_start < $1 LIMIT $2)
               RETURNING 1)
             SELECT count(*)::bigint AS n FROM gone`,
            [previousWindowS, limit],
          );
          return {
            leases: toInt(leases.rows[0]?.n),
            windows: toInt(windows.rows[0]?.n),
          };
        });
      } catch (error) {
        throw toGatewayError(error);
      }
    },
  };
}
