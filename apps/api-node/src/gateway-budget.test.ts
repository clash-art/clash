/**
 * Postgres gateway budget store — N2 settlement (#363).
 *
 * Every test runs against the real Node gateway schema (0016_gateway.sql) on
 * PGlite, so the money rules are proven against the same constraints the
 * self-host gateway runs with: `UNIQUE (request_id, budget_id, kind)` for
 * charge-once, `amount_micro_credits >= 0` and `spent_micro_credits >= 0`.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkGatewayInvariants,
  createPgGatewayBudgetStore,
  GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY,
  type GatewayBudgetAuditEvent,
  type GatewayBudgetDatabase,
  type GatewayBudgetSqlClient,
  type PgGatewayBudgetStore,
} from "./gateway-budget.ts";
import { migrateDatabase } from "./migrations.ts";

interface TestDatabase {
  pglite: PGlite;
  db: GatewayBudgetDatabase;
}

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  return {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      const result = await pglite.query<Row>(sql, parameters ?? []);
      return { rows: result.rows };
    },
    async transaction<T>(
      work: (tx: GatewayBudgetSqlClient) => Promise<T>,
    ): Promise<T> {
      return pglite.transaction(async (tx) =>
        work({
          async query<Row extends Record<string, unknown>>(
            sql: string,
            parameters?: unknown[],
          ) {
            const result = await tx.query<Row>(sql, parameters ?? []);
            return { rows: result.rows };
          },
        }),
      );
    },
  };
}

async function newDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  await migrateDatabase(pglite);
  return { pglite, db: adapt(pglite) };
}

interface BudgetSeed {
  id: string;
  tenantId?: string;
  scope?: "tenant" | "user" | "key";
  scopeId?: string;
  /** Null is an explicitly unlimited budget. */
  limitMicroCredits?: number | null;
  spentMicroCredits?: number;
  status?: string;
  enforcement?: string;
}

async function insertBudget(pglite: PGlite, seed: BudgetSeed): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tenantId = seed.tenantId ?? "tenant-a";
  await pglite.query(
    `INSERT INTO gateway_budget
       (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
        reserved_micro_credits, status, enforcement, version, period, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 0, 'none', $9, $9)`,
    [
      seed.id,
      tenantId,
      seed.scope ?? "tenant",
      seed.scopeId ?? tenantId,
      seed.limitMicroCredits === undefined ? null : seed.limitMicroCredits,
      seed.spentMicroCredits ?? 0,
      seed.status ?? "active",
      seed.enforcement ?? "hard",
      now,
    ],
  );
}

async function setFloor(pglite: PGlite, floorMicroCredits: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await pglite.query(
    `INSERT INTO gateway_config (key, value, version, updated_at)
     VALUES ($1, $2::jsonb, 1, $3)
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, version = gateway_config.version + 1,
            updated_at = EXCLUDED.updated_at`,
    [
      GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY,
      JSON.stringify({ floor_micro_credits: floorMicroCredits }),
      now,
    ],
  );
}

interface LedgerSummary {
  requestId: string;
  budgetId: string;
  kind: string;
  amountMicroCredits: number;
  billingBasis: Record<string, unknown>;
}

async function ledgerRows(
  pglite: PGlite,
  requestId?: string,
): Promise<LedgerSummary[]> {
  const { rows } = await pglite.query<{
    request_id: string;
    budget_id: string;
    kind: string;
    amount_micro_credits: number | string;
    billing_basis: Record<string, unknown>;
  }>(
    `SELECT request_id, budget_id, kind, amount_micro_credits, billing_basis
       FROM gateway_usage_ledger
      ${requestId === undefined ? "" : "WHERE request_id = $1"}
      ORDER BY request_id, budget_id, kind`,
    requestId === undefined ? [] : [requestId],
  );
  return rows.map((row) => ({
    requestId: row.request_id,
    budgetId: row.budget_id,
    kind: row.kind,
    amountMicroCredits: Number(row.amount_micro_credits),
    billingBasis: row.billing_basis ?? {},
  }));
}

async function spentOf(
  pglite: PGlite,
  budgetId: string,
): Promise<number> {
  const { rows } = await pglite.query<{ spent_micro_credits: number | string }>(
    "SELECT spent_micro_credits FROM gateway_budget WHERE id = $1",
    [budgetId],
  );
  return Number(rows[0]?.spent_micro_credits ?? 0);
}

describe("pg gateway budget store — N2 settlement", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await newDatabase();
  });

  afterEach(async () => {
    await database.pglite.close();
  });

  // ─── Media / AIGC: prepay ───────────────────────────────────────────────────

  it("debits the exact price on every scope of the request in one transaction", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      scope: "tenant",
      scopeId: "tenant-a",
      limitMicroCredits: 1_000_000,
    });
    await insertBudget(pglite, {
      id: "budget-member",
      scope: "user",
      scopeId: "user-a",
      limitMicroCredits: 500_000,
    });
    await insertBudget(pglite, {
      id: "budget-key",
      scope: "key",
      scopeId: "key-a",
      limitMicroCredits: 200_000,
    });
    const store = createPgGatewayBudgetStore(db, {
      now: () => 1_700_000_000_000,
    });

    const result = await store.debitMedia({
      requestId: "req-media-1",
      tenantId: "tenant-a",
      userId: "user-a",
      keyId: "key-a",
      budgetIds: ["budget-wallet", "budget-member", "budget-key"],
      costMicroCredits: 1_200,
      modelCode: "house-image",
      modelKind: "media",
    });

    expect(result).toMatchObject({
      requestId: "req-media-1",
      debitMicroCredits: 1_200,
      duplicate: false,
    });
    expect([...result.budgetIds].sort()).toEqual([
      "budget-key",
      "budget-member",
      "budget-wallet",
    ]);
    expect(await spentOf(pglite, "budget-wallet")).toBe(1_200);
    expect(await spentOf(pglite, "budget-member")).toBe(1_200);
    expect(await spentOf(pglite, "budget-key")).toBe(1_200);

    const rows = await ledgerRows(pglite, "req-media-1");
    expect(rows.map((row) => row.kind)).toEqual(["debit", "debit", "debit"]);
    expect(rows.every((row) => row.amountMicroCredits === 1_200)).toBe(true);
    expect(rows.every((row) => row.billingBasis.settlement === "prepay")).toBe(
      true,
    );

    const { rows: requests } = await pglite.query<{
      state: string;
      debit_micro_credits: number | string;
      charged_micro_credits: number | string | null;
    }>("SELECT state, debit_micro_credits, charged_micro_credits FROM gateway_request");
    expect(requests).toHaveLength(1);
    expect(requests[0].state).toBe("admitted");
    expect(Number(requests[0].debit_micro_credits)).toBe(1_200);
    expect(requests[0].charged_micro_credits).toBeNull();
  });

  it("charges the media debit once: a replay moves no more money", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 10_000 });
    const store = createPgGatewayBudgetStore(db);
    const input = {
      requestId: "req-media-replay",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 500,
    };

    const first = await store.debitMedia(input);
    const second = await store.debitMedia(input);

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      debitMicroCredits: 500,
      duplicate: true,
    });
    expect(await spentOf(pglite, "budget-wallet")).toBe(500);
    expect(await ledgerRows(pglite, "req-media-replay")).toHaveLength(1);
  });

  it("needs no second money write when the media generation succeeds", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 10_000 });
    const store = createPgGatewayBudgetStore(db);
    await store.debitMedia({
      requestId: "req-media-ok",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 750,
    });

    const completed = await store.completeMedia({
      requestId: "req-media-ok",
      tenantId: "tenant-a",
    });

    expect(completed.completed).toBe(true);
    expect(await spentOf(pglite, "budget-wallet")).toBe(750);
    const rows = await ledgerRows(pglite, "req-media-ok");
    expect(rows.map((row) => row.kind)).toEqual(["debit"]);
    const { rows: requests } = await pglite.query<{
      state: string;
      charged_micro_credits: number | string;
    }>("SELECT state, charged_micro_credits FROM gateway_request");
    expect(requests[0].state).toBe("completed");
    expect(Number(requests[0].charged_micro_credits)).toBe(750);
  });

  it("refunds a failed media generation in full and leaves no net charge", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 10_000 });
    await insertBudget(pglite, {
      id: "budget-member",
      scope: "user",
      scopeId: "user-a",
      limitMicroCredits: 10_000,
    });
    const store = createPgGatewayBudgetStore(db);
    await store.debitMedia({
      requestId: "req-media-fail",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet", "budget-member"],
      costMicroCredits: 900,
    });

    const refund = await store.refundMedia({
      requestId: "req-media-fail",
      tenantId: "tenant-a",
      reason: "upstream_failed",
      errorCode: "GATEWAY_UPSTREAM_ERROR",
    });

    expect(refund).toMatchObject({
      refundedMicroCredits: 900,
      duplicate: false,
    });
    expect(await spentOf(pglite, "budget-wallet")).toBe(0);
    expect(await spentOf(pglite, "budget-member")).toBe(0);

    const rows = await ledgerRows(pglite, "req-media-fail");
    expect(rows.map((row) => row.kind).sort()).toEqual(["debit", "debit", "refund", "refund"]);
    for (const budgetId of ["budget-wallet", "budget-member"]) {
      const net = rows
        .filter((row) => row.budgetId === budgetId)
        .reduce(
          (total, row) =>
            total + (row.kind === "refund" ? -row.amountMicroCredits : row.amountMicroCredits),
          0,
        );
      expect(net).toBe(0);
    }

    const report = await checkGatewayInvariants(db, { tenantId: "tenant-a" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("refunds a failed media generation only once", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 10_000 });
    const store = createPgGatewayBudgetStore(db);
    await store.debitMedia({
      requestId: "req-media-fail-once",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 400,
    });

    const first = await store.refundMedia({
      requestId: "req-media-fail-once",
      tenantId: "tenant-a",
    });
    const second = await store.refundMedia({
      requestId: "req-media-fail-once",
      tenantId: "tenant-a",
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await spentOf(pglite, "budget-wallet")).toBe(0);
    expect(await ledgerRows(pglite, "req-media-fail-once")).toHaveLength(2);
  });

  it("refuses a media prepay that does not fit and writes nothing", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 500 });
    const store = createPgGatewayBudgetStore(db);

    await expect(
      store.debitMedia({
        requestId: "req-media-too-big",
        tenantId: "tenant-a",
        userId: "user-a",
        budgetIds: ["budget-wallet"],
        costMicroCredits: 900,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED", status: 402 });

    expect(await spentOf(pglite, "budget-wallet")).toBe(0);
    expect(await ledgerRows(pglite)).toHaveLength(0);
    const { rows } = await pglite.query("SELECT id FROM gateway_request");
    expect(rows).toHaveLength(0);
  });

  // ─── Text / LLM: postpay ────────────────────────────────────────────────────

  it("checks the text admission against the floor without writing money", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      limitMicroCredits: 1_000,
      spentMicroCredits: 1_000,
    });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 500 });

    const admitted = await store.admitText({
      tenantId: "tenant-a",
      budgetIds: ["budget-wallet"],
    });

    expect(admitted.admitted).toBe(true);
    expect(admitted.floorMicroCredits).toBe(500);
    expect(admitted.budgets[0].balanceMicroCredits).toBe(0);
    expect(await ledgerRows(pglite)).toHaveLength(0);
    const { rows } = await pglite.query("SELECT id FROM gateway_request");
    expect(rows).toHaveLength(0);
  });

  it("refuses a text request whose balance is not above the floor", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      limitMicroCredits: 1_000,
      spentMicroCredits: 1_000,
    });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 0 });

    await expect(
      store.admitText({ tenantId: "tenant-a", budgetIds: ["budget-wallet"] }),
    ).rejects.toMatchObject({
      code: "GATEWAY_BUDGET_EXCEEDED",
      status: 402,
      details: { reason: "below_floor", balanceMicroCredits: 0 },
    });
    expect(await ledgerRows(pglite)).toHaveLength(0);
  });

  it("reads the credit floor from the configuration knob", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    await setFloor(pglite, 250_000);

    const configured = createPgGatewayBudgetStore(db);
    const admission = await configured.admitText({
      tenantId: "tenant-a",
      budgetIds: ["budget-wallet"],
    });
    expect(admission.floorMicroCredits).toBe(250_000);

    const overridden = createPgGatewayBudgetStore(db, {
      floorMicroCredits: 10,
    });
    const overrideAdmission = await overridden.admitText({
      tenantId: "tenant-a",
      budgetIds: ["budget-wallet"],
    });
    expect(overrideAdmission.floorMicroCredits).toBe(10);
  });

  it("charges the actual text cost once and may go negative down to the floor", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 100 });

    const charged = await store.chargeText({
      requestId: "req-text-1",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 800,
      modelCode: "house-chat",
      modelKind: "text",
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(charged).toMatchObject({
      chargedMicroCredits: 800,
      requestedMicroCredits: 800,
      unbilledMicroCredits: 0,
      duplicate: false,
    });
    expect(await spentOf(pglite, "budget-wallet")).toBe(800);

    const replay = await store.chargeText({
      requestId: "req-text-1",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 800,
    });
    expect(replay.duplicate).toBe(true);
    expect(await spentOf(pglite, "budget-wallet")).toBe(800);
    expect(await ledgerRows(pglite, "req-text-1")).toHaveLength(1);
  });

  it("never charges past the floor and records the unpaid remainder", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 100 });

    const charged = await store.chargeText({
      requestId: "req-text-over",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 1_200,
    });

    expect(charged).toMatchObject({
      chargedMicroCredits: 1_100,
      requestedMicroCredits: 1_200,
      unbilledMicroCredits: 100,
    });
    expect(await spentOf(pglite, "budget-wallet")).toBe(1_100);

    const rows = await ledgerRows(pglite, "req-text-over");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("charge");
    expect(rows[0].amountMicroCredits).toBe(1_100);
    expect(rows[0].billingBasis).toMatchObject({
      settlement: "postpay",
      requestedMicroCredits: 1_200,
      chargedMicroCredits: 1_100,
      unbilledMicroCredits: 100,
      floorMicroCredits: 100,
    });

    const report = await checkGatewayInvariants(db, {
      tenantId: "tenant-a",
      floorMicroCredits: 100,
    });
    expect(report.violations).toEqual([]);
  });

  it("charges every scope of a text request the same amount", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      scope: "tenant",
      scopeId: "tenant-a",
      limitMicroCredits: 1_000_000,
    });
    await insertBudget(pglite, {
      id: "budget-member",
      scope: "user",
      scopeId: "user-a",
      limitMicroCredits: 1_000_000,
    });
    await insertBudget(pglite, {
      id: "budget-key",
      scope: "key",
      scopeId: "key-a",
      limitMicroCredits: 1_000_000,
    });
    const store = createPgGatewayBudgetStore(db);

    await store.chargeText({
      requestId: "req-text-scopes",
      tenantId: "tenant-a",
      userId: "user-a",
      keyId: "key-a",
      budgetIds: ["budget-wallet", "budget-member", "budget-key"],
      costMicroCredits: 300,
    });

    expect(await spentOf(pglite, "budget-wallet")).toBe(300);
    expect(await spentOf(pglite, "budget-member")).toBe(300);
    expect(await spentOf(pglite, "budget-key")).toBe(300);
    expect(await ledgerRows(pglite, "req-text-scopes")).toHaveLength(3);
  });

  it("refuses a text request when one scope is below the floor", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      scope: "tenant",
      scopeId: "tenant-a",
      limitMicroCredits: 1_000_000,
    });
    await insertBudget(pglite, {
      id: "budget-member",
      scope: "user",
      scopeId: "user-a",
      limitMicroCredits: 100,
      spentMicroCredits: 100,
    });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 0 });

    await expect(
      store.admitText({
        tenantId: "tenant-a",
        budgetIds: ["budget-wallet", "budget-member"],
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED" });
    expect(await ledgerRows(pglite)).toHaveLength(0);
  });

  // ─── Concurrency ───────────────────────────────────────────────────────────

  it("admits exactly the requests the budget can pay for under 100-way concurrency", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        store.debitMedia({
          requestId: `req-race-${index}`,
          tenantId: "tenant-a",
          userId: "user-a",
          budgetIds: ["budget-wallet"],
          costMicroCredits: 100,
        }),
      ),
    );

    const admitted = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(admitted).toHaveLength(10);
    expect(refused).toHaveLength(90);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        code: "GATEWAY_BUDGET_EXCEEDED",
      });
    }
    expect(await spentOf(pglite, "budget-wallet")).toBe(1_000);
    expect(await ledgerRows(pglite)).toHaveLength(10);
    const report = await checkGatewayInvariants(db, { tenantId: "tenant-a" });
    expect(report.ok).toBe(true);
  });

  it("keeps the floor exposure of 100 concurrent text charges inside the floor", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 100 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        store.chargeText({
          requestId: `req-text-race-${index}`,
          tenantId: "tenant-a",
          userId: "user-a",
          budgetIds: ["budget-wallet"],
          costMicroCredits: 100,
        }),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(100);
    const spent = await spentOf(pglite, "budget-wallet");
    // The budget may go negative, but never past the floor.
    expect(spent).toBeLessThanOrEqual(1_100);
    expect(spent).toBe(1_100);
    const rows = await ledgerRows(pglite);
    const charged = rows.reduce(
      (total, row) => total + row.amountMicroCredits,
      0,
    );
    expect(charged).toBe(1_100);
    const unbilled = rows.reduce(
      (total, row) =>
        total + Number(row.billingBasis.unbilledMicroCredits ?? 0),
      0,
    );
    expect(unbilled).toBe(100 * 100 - 1_100);
    const report = await checkGatewayInvariants(db, {
      tenantId: "tenant-a",
      floorMicroCredits: 100,
    });
    expect(report.ok).toBe(true);
  });

  // ─── Invariants, isolation and audit ───────────────────────────────────────

  it("reports every drift the ledger and the budgets can disagree about", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 100 });
    await store.debitMedia({
      requestId: "req-drift",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 100,
    });

    const clean = await checkGatewayInvariants(db, { tenantId: "tenant-a" });
    expect(clean.ok).toBe(true);
    expect(clean.budgetsChecked).toBe(1);
    expect(clean.ledgerRowsChecked).toBe(1);

    await pglite.query(
      "UPDATE gateway_budget SET spent_micro_credits = 42, reserved_micro_credits = 7 WHERE id = $1",
      ["budget-wallet"],
    );
    const drifted = await checkGatewayInvariants(db, { tenantId: "tenant-a" });
    expect(drifted.ok).toBe(false);
    expect(drifted.violations.map((violation) => violation.rule).sort()).toEqual([
      "reserved-is-zero",
      "spent-matches-ledger",
    ]);
  });

  it("reports a refund that does not cancel its debit", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const now = Math.floor(Date.now() / 1000);
    await pglite.query(
      `INSERT INTO gateway_usage_ledger
         (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits,
          occurred_at, created_at)
       VALUES
         ('l-debit', 'req-partial', 'budget-wallet', 'debit', 'settled', 'tenant-a', 500, $1, $1),
         ('l-refund', 'req-partial', 'budget-wallet', 'refund', 'settled', 'tenant-a', 200, $1, $1)`,
      [now],
    );

    const report = await checkGatewayInvariants(db, { tenantId: "tenant-a" });
    expect(report.ok).toBe(false);
    const violation = report.violations.find(
      (entry) => entry.rule === "refund-matches-debit",
    );
    expect(violation).toMatchObject({
      requestId: "req-partial",
      budgetId: "budget-wallet",
      detail: { debitedMicroCredits: 500, refundedMicroCredits: 200 },
    });
  });

  it("reports a balance below the credit floor", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-wallet",
      limitMicroCredits: 1_000,
      spentMicroCredits: 1_500,
    });
    // Ledger matches spent so the only drift is the floor breach.
    const now = Math.floor(Date.now() / 1000);
    await pglite.query(
      `INSERT INTO gateway_usage_ledger
         (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits,
          occurred_at, created_at)
       VALUES
         ('l-below-floor', 'req-below-floor', 'budget-wallet', 'charge', 'settled',
          'tenant-a', 1500, $1, $1)`,
      [now],
    );
    const store = createPgGatewayBudgetStore(db, { floorMicroCredits: 100 });

    const report = await checkGatewayInvariants(db, {
      tenantId: "tenant-a",
      floorMicroCredits: 100,
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.rule)).toEqual([
      "floor-respected",
    ]);

    await expect(
      store.admitText({ tenantId: "tenant-a", budgetIds: ["budget-wallet"] }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED" });
  });

  it("never lets one tenant settle against another tenant's budget or request", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, {
      id: "budget-other",
      tenantId: "tenant-b",
      limitMicroCredits: 1_000_000,
    });
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db);

    await expect(
      store.debitMedia({
        requestId: "req-cross-tenant",
        tenantId: "tenant-a",
        userId: "user-a",
        budgetIds: ["budget-other"],
        costMicroCredits: 100,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_NOT_FOUND" });

    await pglite.query(
      `INSERT INTO gateway_request
         (id, tenant_id, user_id, team_id, key_id, state, debit_micro_credits,
          charged_micro_credits, attempt, expires_at, created_at, updated_at)
       VALUES ('req-owned', 'tenant-b', 'user-b', '', '', 'admitted', 0, NULL, 1, $1, $1, $1)`,
      [Math.floor(Date.now() / 1000)],
    );
    await expect(
      store.debitMedia({
        requestId: "req-owned",
        tenantId: "tenant-a",
        userId: "user-a",
        budgetIds: ["budget-wallet"],
        costMicroCredits: 100,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_FORBIDDEN", status: 403 });
    expect(await spentOf(pglite, "budget-wallet")).toBe(0);
  });

  it("audits a settlement inside the money transaction", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const events: GatewayBudgetAuditEvent[] = [];
    const store = createPgGatewayBudgetStore(db, {
      audit: (_tx, event) => {
        events.push(event);
      },
    });

    await store.debitMedia({
      requestId: "req-audited",
      tenantId: "tenant-a",
      userId: "user-a",
      budgetIds: ["budget-wallet"],
      costMicroCredits: 100,
    });
    await store.refundMedia({ requestId: "req-audited", tenantId: "tenant-a" });

    expect(events.map((event) => event.action)).toEqual([
      "budget.debit",
      "budget.refund",
    ]);
    expect(events[0]).toMatchObject({
      tenantId: "tenant-a",
      requestId: "req-audited",
      amountMicroCredits: 100,
    });
  });

  it("rolls the money write back when the audit sink refuses it", async () => {
    const { pglite, db } = database;
    await insertBudget(pglite, { id: "budget-wallet", limitMicroCredits: 1_000 });
    const store = createPgGatewayBudgetStore(db, {
      audit: () => {
        throw new Error("audit refused");
      },
    });

    await expect(
      store.debitMedia({
        requestId: "req-audit-refused",
        tenantId: "tenant-a",
        userId: "user-a",
        budgetIds: ["budget-wallet"],
        costMicroCredits: 100,
      }),
    ).rejects.toThrow(/audit refused/);
    expect(await spentOf(pglite, "budget-wallet")).toBe(0);
    expect(await ledgerRows(pglite)).toHaveLength(0);
  });

  it("rejects an invalid settlement input with a coded error", async () => {
    const { db } = database;
    const store: PgGatewayBudgetStore = createPgGatewayBudgetStore(db);

    await expect(
      store.debitMedia({
        requestId: "",
        tenantId: "tenant-a",
        userId: "user-a",
        budgetIds: ["budget-wallet"],
        costMicroCredits: -5,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_INVALID_REQUEST", status: 400 });
  });
});

describe("pg gateway budget store — same request settled concurrently on another node (#379)", () => {
  // Found by the real-Postgres lite harness (src/integration/gateway-lite.lite.test.ts):
  // two nodes settling one request both pass the charge-once read, then queue
  // on the budget row locks. PGlite serializes transactions, so here the other
  // node's committed settle is replayed inside the transaction right before
  // the budget lock is taken — what READ COMMITTED shows the waiting node.
  let pglite: PGlite;
  let db: GatewayBudgetDatabase;
  beforeEach(async () => {
    ({ pglite, db } = await newDatabase());
    await insertBudget(pglite, { id: "b-race", limitMicroCredits: 1_000_000 });
  });
  afterEach(async () => {
    await pglite.close();
  });

  function racing(kind: "charge" | "debit", amount: number): GatewayBudgetDatabase {
    let raced = false;
    return {
      query: db.query,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            async query(sql, parameters) {
              if (!raced && /FROM gateway_budget[\s\S]*FOR UPDATE/.test(sql)) {
                raced = true;
                await tx.query(
                  `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
                     amount_micro_credits, occurred_at, created_at)
                   VALUES ('other-node', 'req-race', 'b-race', $1, 'settled', 'tenant-a', 'u1', '', $2, 0, 0)`,
                  [kind, amount],
                );
                await tx.query(
                  "UPDATE gateway_budget SET spent_micro_credits = spent_micro_credits + $1 WHERE id = 'b-race'",
                  [amount],
                );
              }
              return tx.query(sql, parameters);
            },
          } as GatewayBudgetSqlClient),
        ),
    };
  }
  const spent = async () =>
    Number((await pglite.query<{ s: string }>("SELECT spent_micro_credits::text AS s FROM gateway_budget WHERE id = 'b-race'")).rows[0]!.s);

  it("a text charge that lost the race reports the recorded charge as a duplicate", async () => {
    const store = createPgGatewayBudgetStore(racing("charge", 700));
    const result = await store.chargeText({
      requestId: "req-race",
      tenantId: "tenant-a",
      userId: "u1",
      budgetIds: ["b-race"],
      costMicroCredits: 900,
    });
    expect(result).toMatchObject({ chargedMicroCredits: 700, duplicate: true });
    expect(await spent()).toBe(700);
    expect((await checkGatewayInvariants(db)).ok).toBe(true);
  });

  it("a media debit that lost the race does not spend twice", async () => {
    const store = createPgGatewayBudgetStore(racing("debit", 500));
    const result = await store.debitMedia({
      requestId: "req-race",
      tenantId: "tenant-a",
      userId: "u1",
      budgetIds: ["b-race"],
      costMicroCredits: 500,
    });
    expect(result).toMatchObject({ debitMicroCredits: 500, duplicate: true });
    expect(await spent()).toBe(500);
    expect((await checkGatewayInvariants(db)).ok).toBe(true);
  });
});
