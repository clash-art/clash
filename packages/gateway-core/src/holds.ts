/**
 * Stale-hold sweeper (#348). A reservation normally ends in its request's own
 * settlement. One whose request vanished (an isolate killed mid-stream, a
 * crash between reserve and settle) would otherwise keep its budget reserved
 * forever. Past its `expiresAt` the sweeper closes it at zero cost with ledger
 * status `expired` (settleRequest never charges an expiry).
 *
 * Holds outlive every request that can still settle them: the data plane sets
 * a stream's hold TTL beyond its maximum stream duration. `settle_failed`
 * holds are never swept; they wait for reconciliation, failing closed.
 *
 * Idempotent: an expired request has no open hold, so it is neither listed nor
 * expired again; the scheduled run and the admin action may overlap.
 */
import { toGatewayError } from "./errors.js";
import type { GatewayPorts } from "./ports.js";

export interface HoldSweepResult {
  /** Requests this call expired. */
  expired: number;
  /** Requests whose expiry failed; they stay open and are retried next run. */
  failed: number;
}

export async function sweepExpiredGatewayHolds(
  ports: Pick<GatewayPorts, "budgets" | "clock" | "logger">,
  options: { limit?: number } = {},
): Promise<HoldSweepResult> {
  const before = ports.clock.now();
  const holds = await ports.budgets.expiredHolds({ before, limit: options.limit ?? 200 });
  let expired = 0;
  let failed = 0;
  for (const hold of holds) {
    try {
      if (!(await ports.budgets.expire({ requestId: hold.requestId, tenantId: hold.tenantId, before }))
        .expired)
        continue;
      expired += 1;
      ports.logger.warn("gateway.hold_expired", {
        requestId: hold.requestId,
        tenantId: hold.tenantId,
        expiresAt: hold.expiresAt,
      });
    } catch (error) {
      failed += 1;
      ports.logger.error("gateway.hold_expire_failed", {
        requestId: hold.requestId,
        cause: toGatewayError(error).code,
      });
    }
  }
  if (expired || failed) ports.logger.info("gateway.holds_swept", { expired, failed });
  return { expired, failed };
}
