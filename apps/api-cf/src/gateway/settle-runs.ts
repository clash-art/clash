/**
 * Gateway settle runs on Workers (#399, delivery N2): the shared
 * `gateway-settle` Durable Run of gateway-core settle-run.ts (a text
 * request's postpaid `charge`, a failed media request's `refund`), wired as
 * owner `api-cf:gateway-settle` on the cloud journal, Workflow and cron
 * recovery. The Node host wires the same run on its Postgres journal and
 * BullMQ (apps/api-node/src/gateway-settle.ts). Not nested into generation
 * runs (N1), no Queue, no reconcile job.
 *
 * - dispatch: journal first (`cloud_durable_run_journal`, one run per
 *   request id and kind, frozen intent as executor input), Workflow second.
 *   The intent is durable once dispatch resolves; a lost Workflow start
 *   leaves the row due, and the cron tick (generation/recovery.ts, every
 *   owner in cloud-runs/owners.ts) schedules it again. A crash before the
 *   journal write loses the follow-up: the accepted edge.
 * - the run: gatewaySettleRunExecutor over the D1 budgets port; the ledger's
 *   unique `(request_id, budget_id, kind)` makes a duplicate Workflow step or
 *   recovery move no money.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GatewayError,
  gatewaySettlementRunKey,
  gatewaySettleRunCommand,
  gatewaySettleRunExecutor,
  gatewaySettleRunIdentity,
  parseGatewaySettlementIntent,
  type GatewayClock,
  type GatewayLogger,
  type GatewaySettlementPort,
} from "@clash/gateway-core";
import {
  createCloudDurableRun,
  createCloudDurableRunCoordinator,
  type CloudDurableRunCoordinator,
  type CloudDurableRunJournal,
} from "@clash/shared-runtime/cloud-run-coordinator";

import {
  recoverCloudDurableRuns,
  scheduleCloudDurableWorkflow,
  type CloudDurableWorkflowBinding,
} from "../cloud-runs/cloud-durable-dispatcher";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { GATEWAY_SETTLE_OWNER } from "../cloud-runs/owners";
import { createD1GatewayBudgetPorts } from "./d1-budgets";
import { workersLogger } from "./workers-logger";

/** The coordinator of `api-cf:gateway-settle` runs (the Workflow's executor for this owner). */
export function createGatewaySettleCoordinator(input: {
  db: D1Database;
  journal?: CloudDurableRunJournal;
  clock?: GatewayClock;
  logger?: GatewayLogger;
}): CloudDurableRunCoordinator {
  const clock = input.clock ?? { now: () => Date.now() };
  const { budgets } = createD1GatewayBudgetPorts(input.db, { clock });
  return createCloudDurableRunCoordinator({
    ownerId: GATEWAY_SETTLE_OWNER,
    journal: input.journal ?? createD1CloudDurableRunJournal(input.db),
    clock,
    ...gatewaySettleRunExecutor({ budgets, logger: input.logger ?? workersLogger() }),
  });
}

/**
 * gateway-core's GatewaySettlementPort over the cloud journal and the
 * Durable Run Workflow binding. Without a binding, intents are journaled and
 * left to recovery.
 */
export function createD1GatewaySettlementPort(input: {
  db: D1Database;
  workflow?: CloudDurableWorkflowBinding;
  clock: GatewayClock;
  logger: GatewayLogger;
}): GatewaySettlementPort {
  const journal = createD1CloudDurableRunJournal(input.db);
  return {
    async dispatch(intent) {
      const parsed = parseGatewaySettlementIntent(intent);
      const runKey = gatewaySettlementRunKey(parsed);
      const identity = gatewaySettleRunIdentity(parsed);
      try {
        await createCloudDurableRun({
          ownerId: GATEWAY_SETTLE_OWNER,
          journal,
          clock: input.clock,
          command: gatewaySettleRunCommand(parsed),
        });
      } catch (cause) {
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The settlement could not be journaled, or a different one already is.",
          details: runKey,
          cause,
        });
      }
      if (!input.workflow) return { ...runKey, scheduled: false };
      try {
        // A duplicate start answers false: the run is already scheduled.
        await scheduleCloudDurableWorkflow({ workflow: input.workflow, identity });
        return { ...runKey, scheduled: true };
      } catch (error) {
        input.logger.warn("gateway.settle_schedule_failed", {
          ...runKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ...runKey, scheduled: false };
      }
    },
    async recover() {
      if (!input.workflow) {
        const due = await journal.listRecoverable(GATEWAY_SETTLE_OWNER, input.clock.now());
        return { scanned: due.length, scheduled: 0, failed: due.length };
      }
      return recoverCloudDurableRuns({
        ownerId: GATEWAY_SETTLE_OWNER,
        journal,
        workflow: input.workflow,
        now: input.clock.now(),
      });
    },
  };
}
