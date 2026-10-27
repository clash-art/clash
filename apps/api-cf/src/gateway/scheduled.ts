/**
 * The gateway usage jobs of the every-minute `scheduled` handler (#355):
 * metadata/ledger retention at its minute of each hour, and the nightly
 * upstream reconciliation at its minute of each UTC day (gateway-core
 * isRetentionEnforcementDue / isNightlyReconcileDue). Each job is idempotent;
 * one failing never stops the other, and failures are logged with their code.
 */
import { isNightlyReconcileDue, isRetentionEnforcementDue, toGatewayError, type GatewayLogger } from "@clash/gateway-core";

import type { Env } from "../config";
import { reconcileGatewayUsageNightly } from "./d1-reconciliation";
import { enforceGatewayDataRetention } from "./d1-retention";
import { workersLogger } from "./workers-logger";

export async function runScheduledGatewayUsageJobs(
  env: Pick<Env, "DB">,
  scheduledTime: number,
  logger: GatewayLogger = workersLogger(),
): Promise<{ retention: boolean; reconciliation: boolean }> {
  const ran = { retention: false, reconciliation: false };
  const jobs: Promise<void>[] = [];
  if (isRetentionEnforcementDue(scheduledTime)) {
    ran.retention = true;
    jobs.push(
      enforceGatewayDataRetention(env.DB).then(
        (result) => logger.info("gateway.retention_enforced", { ...result }),
        (error: unknown) => logger.error("gateway.retention_failed", { cause: toGatewayError(error).code }),
      ),
    );
  }
  if (isNightlyReconcileDue(scheduledTime)) {
    ran.reconciliation = true;
    jobs.push(
      reconcileGatewayUsageNightly(env, { logger }).then(
        (result) => logger.info("gateway.reconcile_nightly", { days: result.runs.length, failed: result.failed }),
        (error: unknown) => logger.error("gateway.reconcile_nightly_failed", { cause: toGatewayError(error).code }),
      ),
    );
  }
  await Promise.all(jobs);
  return ran;
}
