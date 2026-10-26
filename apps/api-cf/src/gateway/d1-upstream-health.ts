/**
 * gateway-core `upstreamHealth` over `gateway_upstream_health` (0043, #350):
 * the circuit-breaker counters of each official upstream account. The core
 * (circuit.ts) decides thresholds and cooldowns; this port only stores them.
 * A failure is counted in one upsert, so concurrent failures never lose a
 * count. Times are epoch ms in `*_ms` columns (a cooldown is seconds long).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, type GatewayUpstreamHealth, type GatewayUpstreamHealthPort } from "@clash/gateway-core";

import { toSeconds } from "./d1-common";

export interface HealthRow {
  account_id: string;
  consecutive_failures: number;
  open_until_ms: number | null;
  last_failure_code: string | null;
  last_failure_at_ms: number | null;
  last_success_at_ms: number | null;
}

export const HEALTH_COLUMNS =
  "account_id, consecutive_failures, open_until_ms, last_failure_code, last_failure_at_ms, last_success_at_ms";

export function healthOf(row: HealthRow): GatewayUpstreamHealth {
  return {
    accountId: row.account_id,
    consecutiveFailures: row.consecutive_failures,
    ...(row.open_until_ms !== null ? { openUntil: row.open_until_ms } : {}),
    ...(row.last_failure_code !== null ? { lastFailureCode: row.last_failure_code } : {}),
    ...(row.last_failure_at_ms !== null ? { lastFailureAt: row.last_failure_at_ms } : {}),
    ...(row.last_success_at_ms !== null ? { lastSuccessAt: row.last_success_at_ms } : {}),
  };
}

export function createD1GatewayUpstreamHealthPort(db: D1Database): GatewayUpstreamHealthPort {
  return {
    async read({ accountIds }) {
      if (accountIds.length === 0) return [];
      const { results } = await db
        .prepare(
          `SELECT ${HEALTH_COLUMNS} FROM gateway_upstream_health
            WHERE account_id IN (${accountIds.map(() => "?").join(", ")})`,
        )
        .bind(...accountIds)
        .all<HealthRow>();
      return results.map(healthOf);
    },

    async recordFailure({ accountId, code, at, threshold, openUntil }) {
      const row = await db
        .prepare(
          `INSERT INTO gateway_upstream_health
             (account_id, consecutive_failures, open_until_ms, last_failure_code, last_failure_at_ms, updated_at)
           VALUES (?1, 1, CASE WHEN 1 >= ?3 THEN ?4 END, ?2, ?5, ?6)
           ON CONFLICT(account_id) DO UPDATE SET
             consecutive_failures = consecutive_failures + 1,
             open_until_ms = CASE WHEN consecutive_failures + 1 >= ?3 THEN ?4 ELSE open_until_ms END,
             last_failure_code = excluded.last_failure_code,
             last_failure_at_ms = excluded.last_failure_at_ms,
             updated_at = excluded.updated_at
           RETURNING ${HEALTH_COLUMNS}`,
        )
        .bind(accountId, code, threshold, openUntil, at, toSeconds(at))
        .first<HealthRow>();
      if (!row) throw new GatewayError("GATEWAY_INTERNAL", { details: { accountId, reason: "health_not_recorded" } });
      return healthOf(row);
    },

    async recordSuccess({ accountId, at }) {
      await db
        .prepare(
          `UPDATE gateway_upstream_health
              SET consecutive_failures = 0, open_until_ms = NULL, last_success_at_ms = ?2, updated_at = ?3
            WHERE account_id = ?1`,
        )
        .bind(accountId, at, toSeconds(at))
        .run();
    },
  };
}
