/**
 * Test-only: the Postgres settlement port (gateway-settle.ts) with each
 * settle run driven inline right after its journal write, as the outbox
 * worker's BullMQ runtime would drive it, consuming its cloud_run_dispatch
 * row. With `paused`, runs stay journaled and undelivered until `drain()`.
 */
import { gatewaySettleRunIdentity, type GatewayClock, type GatewaySettlementPort } from "@clash/gateway-core";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import { createPostgresRunJournal } from "./durable-run-journal.ts";
import type { GatewayBudgetDatabase } from "./gateway-budget.ts";
import { createNodeGatewaySettleCoordinator, createPgGatewaySettlementPort } from "./gateway-settle.ts";

export interface InlinePgSettlement extends GatewaySettlementPort {
  paused: boolean;
  /** Drive every undelivered run; resolves with how many it drove. */
  drain(): Promise<number>;
}

export function inlinePgSettlement(input: { db: GatewayBudgetDatabase; clock?: GatewayClock }): InlinePgSettlement {
  const clock = input.clock ?? { now: () => Date.now() };
  const journal = createPostgresRunJournal(input.db);
  const port = createPgGatewaySettlementPort({ db: input.db, clock, journal });
  const coordinator = createNodeGatewaySettleCoordinator({
    db: input.db,
    journal,
    clock,
    logger: { info() {}, warn() {}, error() {} },
  });

  async function drive(identity: DurableRunIdentity): Promise<void> {
    await input.db.query("DELETE FROM cloud_run_dispatch WHERE action_run_id = $1 AND output_slot = $2", [
      identity.actionRunId,
      identity.outputSlot,
    ]);
    for (let step = 0; step < 20; step += 1) {
      const result = await coordinator.coordinate({ type: "advance", identity });
      // A retry waits for its backoff: the run stays due for recovery.
      if (result.kind === "terminal" || result.kind === "waiting") return;
      if (result.kind === "progressed" && (result.run.phase === "succeeded" || result.run.phase === "failed")) return;
    }
    throw Error(`settle run ${identity.actionRunId}/${identity.outputSlot} did not finish inline`);
  }

  const settlement: InlinePgSettlement = {
    paused: false,
    async dispatch(intent) {
      const dispatched = await port.dispatch(intent);
      if (!settlement.paused) await drive(gatewaySettleRunIdentity(intent));
      return dispatched;
    },
    recover: () => port.recover(),
    async drain() {
      const { rows } = await input.db.query<{ action_run_id: string; output_slot: string }>(
        "SELECT action_run_id, output_slot FROM cloud_run_dispatch ORDER BY action_run_id, output_slot",
      );
      for (const row of rows) await drive({ actionRunId: row.action_run_id, outputSlot: row.output_slot });
      return rows.length;
    },
  };
  return settlement;
}
