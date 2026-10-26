/**
 * Gateway budget period rollover (#365).
 *
 * `daily` / `monthly` budgets start a fresh period at `reset_at` (unix
 * seconds, UTC calendar boundaries). Any number of stateless gateway nodes may
 * run `rolloverDueBudgets` at the same time: each claims due rows with
 * `FOR UPDATE SKIP LOCKED`, so two nodes never roll the same row, and a row a
 * racer already rolled is no longer due when the lock is released (its
 * `reset_at` moved forward). The cleared spend is journalled as one `adjust`
 * ledger row (`ref_kind = 'period_rollover'`) keyed by
 * `(request_id = rollover:<budget>:<new period_start>, budget_id, kind)`, so the
 * ledger unique index makes a replay of the same period a no-op as well.
 *
 * A budget whose rollover is late stays on its old period: it keeps its spend
 * and fails closed, it never becomes unlimited. This is not a hold-expiry
 * sweeper and not a reconcile job (N2 has neither).
 */

import { GatewayError } from "@clash/gateway-core";
import { z } from "zod";
import type { GatewayBudgetDatabase } from "./gateway-budget.ts";

export type GatewayBudgetPeriod = "daily" | "monthly";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC period containing `nowS`: `[startS, resetAtS)`. */
export function gatewayBudgetPeriodBounds(
  period: GatewayBudgetPeriod,
  nowS: number,
): { startS: number; resetAtS: number } {
  const now = new Date(nowS * 1000);
  if (period === "daily") {
    const start = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    return { startS: start / 1000, resetAtS: (start + DAY_MS) / 1000 };
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { startS: start / 1000, resetAtS: next / 1000 };
}

const rolloverInputSchema = z
  .object({
    limit: z.number().int().positive().max(10_000).optional(),
    nowS: z.number().int().nonnegative().optional(),
  })
  .strict();

export interface GatewayBudgetRolloverInput {
  /** Max rows one call claims; defaults to 500. */
  limit?: number;
  /** Test hook; production uses the database clock. */
  nowS?: number;
}

export interface GatewayBudgetRolloverResult {
  /** Rows this call moved into a new period. */
  rolled: number;
  /** Due rows left after this call (other nodes' locked rows included). */
  backlog: number;
  /** Seconds the oldest rolled row was past its `reset_at` (0 when none). */
  maxLagS: number;
}

interface DueRow {
  id: string;
  tenant_id: string;
  period: GatewayBudgetPeriod;
  reset_at: number | string | null;
  spent_micro_credits: number | string;
  [column: string]: unknown;
}

const DUE_WHERE = `status = 'active' AND period IN ('daily', 'monthly')
  AND (reset_at IS NULL OR reset_at <= $1)`;

export async function rolloverDueBudgets(
  db: GatewayBudgetDatabase,
  input: GatewayBudgetRolloverInput = {},
): Promise<GatewayBudgetRolloverResult> {
  const parsed = rolloverInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "Invalid budget rollover input.",
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const limit = parsed.data.limit ?? 500;

  const { rolled, maxLagS, nowS } = await db.transaction(async (tx) => {
    const nowS =
      parsed.data.nowS ??
      Number(
        (
          await tx.query<{ now_s: unknown }>(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now_s",
          )
        ).rows[0]?.now_s,
      );
    const { rows } = await tx.query<DueRow>(
      `SELECT id, tenant_id, period, reset_at, spent_micro_credits
         FROM gateway_budget
        WHERE ${DUE_WHERE}
        ORDER BY reset_at NULLS FIRST, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [nowS, limit],
    );
    let rolled = 0;
    let maxLagS = 0;
    for (const row of rows) {
      const { startS, resetAtS } = gatewayBudgetPeriodBounds(row.period, nowS);
      const spent = Number(row.spent_micro_credits);
      const oldResetAt = row.reset_at === null ? null : Number(row.reset_at);
      // First schedule of a budget (reset_at NULL) keeps its spend: starting
      // a period never forgives money already spent.
      const clear = oldResetAt !== null && spent > 0;
      if (clear) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO gateway_usage_ledger
             (id, request_id, budget_id, kind, status, tenant_id,
              amount_micro_credits, ref_kind, ref_id, reason, billing_basis,
              occurred_at, created_at)
           VALUES ($1, $1, $2, 'adjust', 'settled', $3, $4, 'period_rollover', $2,
                   'period rollover', $5::jsonb, $6, $6)
           ON CONFLICT (request_id, budget_id, kind) DO NOTHING
           RETURNING id`,
          [
            `rollover:${row.id}:${startS}`,
            row.id,
            row.tenant_id,
            spent,
            JSON.stringify({
              settlement: "period_rollover",
              period: row.period,
              periodStart: startS,
              clearedMicroCredits: spent,
            }),
            nowS,
          ],
        );
        // Already journalled for this period: someone rolled it; skip.
        if (inserted.rows.length === 0) continue;
      }
      const updated = await tx.query<{ id: string }>(
        `UPDATE gateway_budget
            SET spent_micro_credits = CASE WHEN $6::boolean THEN 0 ELSE spent_micro_credits END, period_start = $2, reset_at = $3,
                version = version + 1, updated_at = $4
          WHERE id = $1 AND reset_at IS NOT DISTINCT FROM $5::bigint
          RETURNING id`,
        [row.id, startS, resetAtS, nowS, oldResetAt, clear],
      );
      if (updated.rows.length !== 1) {
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: `Budget ${row.id} changed during its rollover.`,
          details: { budgetId: row.id },
        });
      }
      rolled += 1;
      if (oldResetAt !== null) maxLagS = Math.max(maxLagS, nowS - oldResetAt);
    }
    return { rolled, maxLagS, nowS };
  });

  const backlog = await db.query<{ n: unknown }>(
    `SELECT count(*)::bigint AS n FROM gateway_budget WHERE ${DUE_WHERE}`,
    [nowS],
  );
  return { rolled, backlog: Number(backlog.rows[0]?.n ?? 0), maxLagS };
}
