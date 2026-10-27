/**
 * `api-node:gateway-settle` runs (#399, N2) on PGlite with the real schema:
 * journal first (run + cloud_run_dispatch outbox row in one transaction),
 * the shared settle executor over the Postgres budgets port, storage retries
 * that still charge once, a coded refusal that fails at once, recovery that
 * re-arms only journaled runs, and the task runtime's owner routing.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  gatewaySettleRunIdentity,
  type GatewayLogFields,
  type GatewaySettlementIntent,
} from "@clash/gateway-core";
import type { CloudDurableRunCoordinator } from "@clash/shared-runtime/cloud-run-coordinator";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresRunJournal } from "./durable-run-journal.ts";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayBudgetPort } from "./gateway-budget-port.ts";
import {
  NODE_GATEWAY_SETTLE_OWNER,
  createNodeGatewaySettleCoordinator,
  createPgGatewaySettlementPort,
} from "./gateway-settle.ts";
import { migrateDatabase } from "./migrations.ts";
import { routeRunCoordinators } from "./task-runtime.ts";

let pglite: PGlite;
let db: GatewayBudgetDatabase;
let t: number;
const clock = { now: () => t };
let logs: Array<{ level: string; event: string; fields?: GatewayLogFields }>;
const logger = {
  info: (event: string, fields?: GatewayLogFields) => void logs.push({ level: "info", event, ...(fields ? { fields } : {}) }),
  warn: (event: string, fields?: GatewayLogFields) => void logs.push({ level: "warn", event, ...(fields ? { fields } : {}) }),
  error: (event: string, fields?: GatewayLogFields) => void logs.push({ level: "error", event, ...(fields ? { fields } : {}) }),
};

function adapt(p: PGlite): GatewayBudgetDatabase {
  const wrap = (q: { query: PGlite["query"] }): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return { ...wrap(p), transaction: (work) => p.transaction(async (tx) => work(wrap(tx as never))) };
}

beforeEach(async () => {
  t = Date.now();
  logs = [];
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
  await pglite.query(
    `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
       reserved_micro_credits, status, enforcement, version, period, created_at, updated_at)
     VALUES ('b-a','tenant-a','tenant','tenant-a',1000000000,0,0,'active','hard',0,'none',0,0)`,
  );
});

afterEach(async () => {
  await pglite.close();
});

const chargeIntent = (requestId: string, cost: number): GatewaySettlementIntent => ({
  kind: "charge",
  budgetIds: ["b-a"],
  event: {
    requestId,
    tenantId: "tenant-a",
    userId: "u1",
    modelCode: "gw-node-chat",
    kind: "text",
    upstreamId: "openai",
    credentialScope: "official",
    usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
    costMicroCredits: cost,
    priceVersion: "p1",
    catalogVersion: "c1",
    status: "settled",
    occurredAt: t,
  },
});

const ledger = async (requestId: string, kind: string) =>
  (
    await pglite.query<{ amount: string }>(
      "SELECT amount_micro_credits::text AS amount FROM gateway_usage_ledger WHERE request_id = $1 AND kind = $2",
      [requestId, kind],
    )
  ).rows.map((row) => Number(row.amount));
const spent = async () =>
  Number(
    (await pglite.query<{ s: string }>("SELECT spent_micro_credits::text AS s FROM gateway_budget WHERE id = 'b-a'")).rows[0]!
      .s,
  );
const phaseOf = async (identity: DurableRunIdentity) => (await createPostgresRunJournal(db).load(identity))?.phase;

/** Advance one run to a terminal phase, sleeping (moving the clock) through each backoff. */
async function drive(coordinator: CloudDurableRunCoordinator, identity: DurableRunIdentity) {
  for (let step = 0; step < 30; step += 1) {
    const result = await coordinator.coordinate({ type: "advance", identity });
    if (result.kind === "terminal") return result.run.phase;
    if (result.kind === "waiting") t = Math.max(t, result.wakeAt);
  }
  throw Error("run did not reach a terminal phase");
}

describe("api-node gateway-settle runs (#399)", () => {
  it("journals the run with its outbox row first, then charges once through storage failures and redelivery", async () => {
    const journal = createPostgresRunJournal(db);
    const settlement = createPgGatewaySettlementPort({ db, clock, journal });
    const intent = chargeIntent("gwr_retry", 4_000);
    const identity = gatewaySettleRunIdentity(intent);
    expect(await settlement.dispatch(intent)).toEqual({ requestId: "gwr_retry", kind: "charge", scheduled: true });
    // The same intent again is the same run; different content under its key is refused.
    await settlement.dispatch(structuredClone(intent));
    await expect(settlement.dispatch(chargeIntent("gwr_retry", 5_000))).rejects.toMatchObject({ code: "GATEWAY_INTERNAL" });
    const run = await journal.load(identity);
    expect(run).toMatchObject({ owner: { id: NODE_GATEWAY_SETTLE_OWNER }, phase: "queued" });
    expect((await pglite.query("SELECT 1 FROM cloud_run_dispatch WHERE action_run_id = 'gateway-settle:gwr_retry'")).rows).toHaveLength(1);
    expect(await ledger("gwr_retry", "charge")).toEqual([]);

    // Two raw storage failures: the run backs off and retries, never a second charge.
    const real = createPgGatewayBudgetPort({ db });
    let failures = 2;
    const coordinator = createNodeGatewaySettleCoordinator({
      db,
      journal,
      clock,
      logger,
      budgets: {
        charge: async (input) => {
          if (failures-- > 0) throw new Error("connection terminated unexpectedly");
          return real.charge(input);
        },
        refund: (input) => real.refund(input),
      },
    });
    expect(await drive(coordinator, identity)).toBe("succeeded");
    expect(failures).toBe(-1);
    expect(await ledger("gwr_retry", "charge")).toEqual([4_000]);
    expect(await spent()).toBe(4_000);
    // A redelivered job on a finished run moves nothing.
    expect(await drive(coordinator, identity)).toBe("succeeded");
    expect(await ledger("gwr_retry", "charge")).toEqual([4_000]);
    expect(await spent()).toBe(4_000);
  });

  it("refunds a failed media debit once; a refund of nothing is a coded refusal that fails the run at once", async () => {
    const journal = createPostgresRunJournal(db);
    const settlement = createPgGatewaySettlementPort({ db, clock, journal });
    const coordinator = createNodeGatewaySettleCoordinator({ db, journal, clock, logger });
    await createPgGatewayBudgetPort({ db }).debit({
      requestId: "gwr_media",
      tenantId: "tenant-a",
      userId: "u1",
      budgetIds: ["b-a"],
      modelCode: "gw-node-image",
      kind: "image",
      upstreamId: "openai",
      credentialScope: "official",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
      costMicroCredits: 7_000,
      priceVersion: "p1",
      catalogVersion: "c1",
      status: "settled",
      occurredAt: t,
    });
    expect(await spent()).toBe(7_000);
    const refund: GatewaySettlementIntent = {
      kind: "refund",
      requestId: "gwr_media",
      tenantId: "tenant-a",
      status: "upstream_failed",
      errorCode: "GATEWAY_UPSTREAM_ERROR",
      occurredAt: t,
    };
    await settlement.dispatch(refund);
    expect(await drive(coordinator, gatewaySettleRunIdentity(refund))).toBe("succeeded");
    expect(await ledger("gwr_media", "refund")).toEqual([7_000]);
    expect(await spent()).toBe(0);

    const nothing: GatewaySettlementIntent = { ...refund, requestId: "gwr_never_debited" };
    await settlement.dispatch(nothing);
    expect(await drive(coordinator, gatewaySettleRunIdentity(nothing))).toBe("failed");
    expect(logs.find((entry) => entry.event === "gateway.settle_run_failed")).toMatchObject({
      level: "error",
      fields: { actionRunId: "gateway-settle:gwr_never_debited", kind: "refund", retryable: false },
    });
    // A failed run is not due again: recovery never retries a refusal.
    const due = await journal.listRecoverable(NODE_GATEWAY_SETTLE_OWNER, t + 60_000);
    expect(due.some((entry) => entry.actionRunId === "gateway-settle:gwr_never_debited")).toBe(false);
  });

  it("recovery re-arms the outbox of a journaled run whose delivery was lost, and only of journaled runs", async () => {
    const journal = createPostgresRunJournal(db);
    const settlement = createPgGatewaySettlementPort({ db, clock, journal });
    await settlement.dispatch(chargeIntent("gwr_lost", 1_000));
    // The outbox row was consumed (a BullMQ flow added) but the worker died with it.
    await pglite.query("DELETE FROM cloud_run_dispatch");
    expect(await settlement.recover()).toEqual({ scanned: 1, scheduled: 1, failed: 0 });
    expect(await settlement.recover()).toEqual({ scanned: 1, scheduled: 0, failed: 0 });
    const coordinator = createNodeGatewaySettleCoordinator({ db, journal, clock, logger });
    expect(await drive(coordinator, gatewaySettleRunIdentity(chargeIntent("gwr_lost", 1_000)))).toBe("succeeded");
    expect(await settlement.recover()).toMatchObject({ scanned: 0, scheduled: 0 });
    expect(await ledger("gwr_lost", "charge")).toEqual([1_000]);
  });

  it("routes a run to its journaled owner's coordinator and lists every owner's due runs", async () => {
    const journal = createPostgresRunJournal(db);
    const settlement = createPgGatewaySettlementPort({ db, clock, journal });
    const intent = chargeIntent("gwr_routed", 2_000);
    await settlement.dispatch(intent);
    const identity = gatewaySettleRunIdentity(intent);
    const other: CloudDurableRunCoordinator = {
      async coordinate(command) {
        if (command.type === "recoverable") return { kind: "recoverable", identities: [] };
        throw Error("routed to the wrong owner");
      },
    };
    const router = routeRunCoordinators(journal, {
      "api-node:generation": other,
      [NODE_GATEWAY_SETTLE_OWNER]: createNodeGatewaySettleCoordinator({ db, journal, clock, logger }),
    });
    expect(await router.coordinate({ type: "recoverable", now: t })).toEqual({ kind: "recoverable", identities: [identity] });
    expect(await drive(router, identity)).toBe("succeeded");
    expect(await phaseOf(identity)).toBe("succeeded");
    expect(await ledger("gwr_routed", "charge")).toEqual([2_000]);
    await expect(
      routeRunCoordinators(journal, { "api-node:generation": other }).coordinate({ type: "advance", identity }),
    ).rejects.toThrow(/No run owner serves/);
    await expect(
      router.coordinate({ type: "advance", identity: { actionRunId: "gateway-settle:missing", outputSlot: "charge" } }),
    ).rejects.toThrow(/No run owner serves/);
  });
});
