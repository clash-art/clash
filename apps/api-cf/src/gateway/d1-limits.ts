/**
 * Rate and concurrency limits over D1 (`gateway_rate_window`,
 * `gateway_inflight`, 0034). Limits are configuration, read per request:
 *
 * - key: `gateway_key.rate_limit_json` of the virtual key behind the caller's
 *   token (or the key itself), counted per key;
 * - model: the published `gateway_model.rate_limit_json`, counted per user and model;
 * - tenant: the active `gateway_tenant_subscription.rate_limit_json`, counted per tenant.
 *
 * Each config is `{ requestsPerMinute?, tokensPerMinute?, concurrency? }`; an
 * absent config admits. A malformed one fails closed (GATEWAY_INTERNAL) rather
 * than silently admitting. Windows are fixed one-minute windows in database
 * rows shared by every isolate; decisions use gateway-core's window helpers.
 * A denied request still counts in its window, as in every adapter.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  fixedWindowDecision,
  fixedWindowStart,
  type GatewayClock,
  type GatewayIds,
  type GatewayLimitPort,
  type LimitDecision,
  type LimitScope,
} from "@clash/gateway-core";
import { z } from "zod";

import { parseJson, publishedCatalogVersionSql, toSeconds } from "./d1-common";

const WINDOW_MS = 60_000;
/** A lease a crashed request never released stops counting after this. */
export const GATEWAY_LEASE_TTL_MS = 15 * 60 * 1000;
/** Advisory retry for a concurrency denial: there is no window to wait for. */
const CONCURRENCY_RETRY_AFTER_MS = 1_000;

const RateLimitSchema = z.looseObject({
  requestsPerMinute: z.number().int().positive().optional(),
  tokensPerMinute: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
});
type RateLimit = z.infer<typeof RateLimitSchema>;

interface Subject {
  scope: LimitScope;
  subject: string;
  limits: RateLimit;
}

function parseLimits(raw: string | null, source: string): RateLimit | undefined {
  if (raw === null) return undefined;
  const parsed = RateLimitSchema.safeParse(parseJson(raw));
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A configured rate limit is malformed.",
      details: { source },
    });
  return parsed.data;
}

export function createD1GatewayLimitPort(
  db: D1Database,
  deps: { clock: GatewayClock; ids: GatewayIds },
): GatewayLimitPort {
  async function subjects(input: Parameters<GatewayLimitPort["admit"]>[0], nowS: number): Promise<Subject[]> {
    const row = await db
      .prepare(
        `SELECT
           k.id AS key_id, k.rate_limit_json AS key_limits,
           (SELECT m.rate_limit_json FROM gateway_model m
             WHERE m.model_code = ?2 AND m.enabled = 1
               AND m.catalog_version = ${publishedCatalogVersionSql("?4")}) AS model_limits,
           (SELECT s.rate_limit_json FROM gateway_tenant_subscription s
             WHERE s.tenant_id = ?3 AND s.status IN ('trialing', 'active')
             ORDER BY s.current_period_end DESC LIMIT 1) AS tenant_limits
         FROM (SELECT 1) AS one
         LEFT JOIN gateway_key k
           ON k.id = COALESCE((SELECT t.key_id FROM gateway_token t WHERE t.id = ?1), ?1)`,
      )
      .bind(input.keyId ?? null, input.modelCode, input.tenantId, nowS)
      .first<{
        key_id: string | null;
        key_limits: string | null;
        model_limits: string | null;
        tenant_limits: string | null;
      }>();
    const list: Subject[] = [];
    const key = row?.key_id ? parseLimits(row.key_limits, "key") : undefined;
    if (key && row?.key_id) list.push({ scope: "key", subject: `key:${row.key_id}`, limits: key });
    const model = parseLimits(row?.model_limits ?? null, "model");
    if (model)
      list.push({ scope: "user", subject: `model:${input.modelCode}:user:${input.userId}`, limits: model });
    const tenant = parseLimits(row?.tenant_limits ?? null, "tenant");
    if (tenant) list.push({ scope: "tenant", subject: `tenant:${input.tenantId}`, limits: tenant });
    return list;
  }

  async function countWindows(list: Subject[], input: { estimatedTokens: number }, nowMs: number) {
    const rated = list.filter((entry) => entry.limits.requestsPerMinute || entry.limits.tokensPerMinute);
    if (rated.length === 0) return undefined;
    const windowS = toSeconds(fixedWindowStart(nowMs, WINDOW_MS));
    const tokens = Math.max(0, Math.ceil(input.estimatedTokens));
    const statements = rated.flatMap((entry) => [
      db
        .prepare(`DELETE FROM gateway_rate_window WHERE subject = ? AND window_start < ?`)
        .bind(entry.subject, windowS),
      db
        .prepare(
          `INSERT INTO gateway_rate_window (subject, window_start, requests, tokens)
           VALUES (?1, ?2, 1, ?3)
           ON CONFLICT (subject, window_start)
           DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens
           RETURNING requests, tokens`,
        )
        .bind(entry.subject, windowS, tokens),
    ]);
    const results = await db.batch(statements);
    for (const [index, entry] of rated.entries()) {
      const counted = results[index * 2 + 1]?.results?.[0] as { requests: number; tokens: number } | undefined;
      if (!counted)
        throw new GatewayError("GATEWAY_INTERNAL", { message: "A rate window was not counted." });
      for (const [count, limit] of [
        [counted.requests, entry.limits.requestsPerMinute],
        [counted.tokens, entry.limits.tokensPerMinute],
      ] as const) {
        if (!limit) continue;
        const decision = fixedWindowDecision({ nowMs, windowMs: WINDOW_MS, count, limit });
        if (!decision.allowed)
          return {
            allowed: false,
            code: "GATEWAY_RATE_LIMITED",
            scope: entry.scope,
            retryAfterMs: decision.retryAfterMs,
          } satisfies LimitDecision;
      }
    }
    return undefined;
  }

  async function release({ leaseId }: { leaseId: string }) {
    await db.prepare(`DELETE FROM gateway_inflight WHERE lease_id = ?`).bind(leaseId).run();
  }

  async function lease(list: Subject[], leaseId: string, nowMs: number): Promise<LimitDecision> {
    const bounded = list.filter((entry) => entry.limits.concurrency);
    if (bounded.length === 0) return { allowed: true, leaseId };
    const nowS = toSeconds(nowMs);
    const expiresS = toSeconds(nowMs + GATEWAY_LEASE_TTL_MS);
    const statements: D1PreparedStatement[] = bounded.flatMap((entry) => [
      db
        .prepare(`DELETE FROM gateway_inflight WHERE subject = ? AND expires_at <= ?`)
        .bind(entry.subject, nowS),
      db
        .prepare(
          `INSERT INTO gateway_inflight (lease_id, subject, expires_at, created_at)
           SELECT ?1, ?2, ?3, ?4
            WHERE (SELECT COUNT(*) FROM gateway_inflight WHERE subject = ?2) < ?5`,
        )
        .bind(leaseId, entry.subject, expiresS, nowS, entry.limits.concurrency!),
    ]);
    const results = await db.batch(statements);
    const denied = bounded.find((_entry, index) => !(results[index * 2 + 1]?.meta.changes ?? 0));
    if (!denied) return { allowed: true, leaseId };
    await release({ leaseId });
    return {
      allowed: false,
      code: "GATEWAY_CONCURRENCY_LIMITED",
      scope: denied.scope,
      retryAfterMs: CONCURRENCY_RETRY_AFTER_MS,
    };
  }

  return {
    async admit(input) {
      const nowMs = deps.clock.now();
      const list = await subjects(input, toSeconds(nowMs));
      const leaseId = `gwl_${deps.ids.requestId()}`;
      return (await countWindows(list, input, nowMs)) ?? lease(list, leaseId, nowMs);
    },
    release,
  };
}
