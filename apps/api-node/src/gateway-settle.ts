/**
 * Gateway settle runs on the Node host (#399, delivery N2): the shared
 * `gateway-settle` Durable Run of gateway-core settle-run.ts (a text
 * request's postpaid `charge`, a failed media request's `refund`), wired as
 * owner `api-node:gateway-settle` on the Postgres run journal and BullMQ.
 * The Workers host wires the same run on D1 and its Workflow
 * (apps/api-cf/src/gateway/settle-runs.ts). Not nested into generation runs
 * (N1), no queue of its own, no reconcile job.
 *
 * - dispatch (api role): journal first. `createPostgresRunJournal.create`
 *   commits the run (one per request id and kind, frozen intent as executor
 *   input) and its `cloud_run_dispatch` outbox row in one transaction, so the
 *   intent is durable and its delivery is armed once dispatch resolves. A
 *   crash before that commit loses the follow-up: the accepted edge.
 * - delivery (outbox worker): the task runtime (task-runtime.ts) turns the
 *   outbox row into a BullMQ Flow and advances the run with this owner's
 *   coordinator; its recovery sweep revives any due run whose jobs ended
 *   (a worker killed mid-run, an expired attempt).
 * - the run: gatewaySettleRunExecutor over the Postgres budgets port; the
 *   ledger's unique `(request_id, budget_id, kind)` makes a repeated step or
 *   a recovery move no money.
 */
import {
  GatewayError,
  gatewaySettlementRunKey,
  gatewaySettleRunCommand,
  gatewaySettleRunExecutor,
  parseGatewaySettlementIntent,
  type GatewayBudgetPort,
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
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { createPostgresRunJournal } from "./durable-run-journal.ts";
import type { GatewayBudgetDatabase } from "./gateway-budget.ts";
import { createPgGatewayBudgetPort } from "./gateway-budget-port.ts";
import { apiNodeLog } from "./log.ts";

export const NODE_GATEWAY_SETTLE_OWNER = "api-node:gateway-settle";

type SettleDatabase = GatewayBudgetDatabase & PostgresTransactionPort;

function settleLogger(): GatewayLogger {
  const log = apiNodeLog.child("gateway-settle");
  const safe =
    (level: "info" | "warn" | "error") =>
    (event: string, fields?: Record<string, unknown>) => {
      try {
        log[level](event, fields as never);
      } catch {
        // A logger never throws into a settle run.
      }
    };
  return { info: safe("info"), warn: safe("warn"), error: safe("error") };
}

/** The coordinator of `api-node:gateway-settle` runs (the task runtime's executor for this owner). */
export function createNodeGatewaySettleCoordinator(input: {
  db: SettleDatabase;
  journal?: CloudDurableRunJournal;
  budgets?: Pick<GatewayBudgetPort, "charge" | "refund">;
  clock?: GatewayClock;
  logger?: GatewayLogger;
}): CloudDurableRunCoordinator {
  const clock = input.clock ?? { now: () => Date.now() };
  const budgets = input.budgets ?? createPgGatewayBudgetPort({ db: input.db });
  return createCloudDurableRunCoordinator({
    ownerId: NODE_GATEWAY_SETTLE_OWNER,
    journal: input.journal ?? createPostgresRunJournal(input.db),
    clock,
    ...gatewaySettleRunExecutor({ budgets, logger: input.logger ?? settleLogger() }),
  });
}

/**
 * gateway-core's GatewaySettlementPort over the Postgres run journal. The
 * journal write is also the scheduling (its outbox row), so a resolved
 * dispatch is always `scheduled: true`.
 */
export function createPgGatewaySettlementPort(input: {
  db: SettleDatabase;
  clock: GatewayClock;
  journal?: CloudDurableRunJournal;
}): GatewaySettlementPort {
  const journal = input.journal ?? createPostgresRunJournal(input.db);
  return {
    async dispatch(intent) {
      const parsed = parseGatewaySettlementIntent(intent);
      const runKey = gatewaySettlementRunKey(parsed);
      try {
        await createCloudDurableRun({
          ownerId: NODE_GATEWAY_SETTLE_OWNER,
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
      return { ...runKey, scheduled: true };
    },
    /**
     * Re-arm the outbox of every due run. The task runtime's recovery sweep
     * (task-runtime.ts `recoverRuns`) is the steady-state path; this lets an
     * operator tick schedule the same runs without a worker's sweep.
     */
    async recover() {
      const due = await journal.listRecoverable(NODE_GATEWAY_SETTLE_OWNER, input.clock.now());
      let scheduled = 0;
      for (const run of due) {
        const { rows } = await input.db.query(
          `INSERT INTO cloud_run_dispatch (action_run_id, output_slot) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING action_run_id`,
          [run.actionRunId, run.outputSlot],
        );
        scheduled += rows.length;
      }
      return { scanned: due.length, scheduled, failed: 0 };
    },
  };
}
