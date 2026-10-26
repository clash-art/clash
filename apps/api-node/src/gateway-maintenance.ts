/**
 * One periodic gateway maintenance tick (#365): budget period rollover plus
 * the rate-limit / lease sweep from #364. Every node may run it; correctness
 * comes from Postgres (SKIP LOCKED / idempotent deletes), not from a leader.
 * Nothing is kept in process memory between ticks.
 */

import type { GatewayBudgetDatabase } from "./gateway-budget.ts";
import {
  rolloverDueBudgets,
  type GatewayBudgetRolloverResult,
} from "./gateway-budget-rollover.ts";
import type { PgGatewayLimitPort } from "./gateway-limits.ts";
import { recordBudgetRollover } from "./metrics.ts";

export const GATEWAY_MAINTENANCE_INTERVAL_MS = 60_000;

export interface GatewayMaintenanceOptions {
  db: GatewayBudgetDatabase;
  limits?: Pick<PgGatewayLimitPort, "sweep">;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface GatewayMaintenanceResult {
  rollover: GatewayBudgetRolloverResult;
  sweep?: { leases: number; windows: number };
}

export async function runGatewayMaintenanceTick(
  options: Pick<GatewayMaintenanceOptions, "db" | "limits">,
): Promise<GatewayMaintenanceResult> {
  const rollover = await rolloverDueBudgets(options.db);
  recordBudgetRollover(rollover);
  const sweep = options.limits ? await options.limits.sweep() : undefined;
  return { rollover, sweep };
}

/** Start the tick on this node; returns a stop function. */
export function startGatewayMaintenance(
  options: GatewayMaintenanceOptions,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap on one node
    running = true;
    runGatewayMaintenanceTick(options)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? GATEWAY_MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
