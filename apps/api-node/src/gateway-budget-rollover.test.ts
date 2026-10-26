/**
 * Budget period rollover (#365) on the real 0016 schema (PGlite).
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkGatewayInvariants,
  createPgGatewayBudgetStore,
  type GatewayBudgetDatabase,
  type GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  gatewayBudgetPeriodBounds,
  rolloverDueBudgets,
} from "./gateway-budget-rollover.ts";
import { runGatewayMaintenanceTick } from "./gateway-maintenance.ts";
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

const D = 86_400;
// 2026-10-26T12:00:00Z
const NOON = Date.UTC(2026, 9, 26, 12) / 1000;
const MIDNIGHT = Date.UTC(2026, 9, 26) / 1000;

async function makePeriodic(
  pglite: PGlite,
  id: string,
  period: "daily" | "monthly",
  resetAt: number | null,
): Promise<void> {
  await pglite.query(
    "UPDATE gateway_budget SET period = $2, reset_at = $3, period_start = $4 WHERE id = $1",
    [id, period, resetAt, resetAt === null ? null : resetAt - D],
  );
}

async function budget(pglite: PGlite, id: string) {
  const { rows } = await pglite.query<{
    spent_micro_credits: string | number;
    period_start: string | number | null;
    reset_at: string | number | null;
    version: string | number;
  }>(
    "SELECT spent_micro_credits, period_start, reset_at, version FROM gateway_budget WHERE id = $1",
    [id],
  );
  const row = rows[0];
  return {
    spent: Number(row.spent_micro_credits),
    periodStart: row.period_start === null ? null : Number(row.period_start),
    resetAt: row.reset_at === null ? null : Number(row.reset_at),
    version: Number(row.version),
  };
}

let t: TestDatabase;
beforeEach(async () => {
  t = await newDatabase();
});
afterEach(async () => {
  await t.pglite.close();
});

describe("gatewayBudgetPeriodBounds", () => {
  it("uses UTC day and calendar month boundaries", () => {
    expect(gatewayBudgetPeriodBounds("daily", NOON)).toEqual({
      startS: MIDNIGHT,
      resetAtS: MIDNIGHT + D,
    });
    expect(gatewayBudgetPeriodBounds("monthly", NOON)).toEqual({
      startS: Date.UTC(2026, 9, 1) / 1000,
      resetAtS: Date.UTC(2026, 10, 1) / 1000,
    });
    expect(
      gatewayBudgetPeriodBounds("monthly", Date.UTC(2026, 11, 31, 23) / 1000)
        .resetAtS,
    ).toBe(Date.UTC(2027, 0, 1) / 1000);
  });
});

describe("rolloverDueBudgets", () => {
  it("clears spend into a new period with one adjust ledger row and keeps invariants", async () => {
    await insertBudget(t.pglite, { id: "b1", limitMicroCredits: 1000 });
    const store = createPgGatewayBudgetStore(t.db);
    await store.debitMedia({
      requestId: "r1",
      tenantId: "tenant-a",
      userId: "u1",
      budgetIds: ["b1"],
      costMicroCredits: 400,
    });
    await makePeriodic(t.pglite, "b1", "daily", MIDNIGHT);

    const result = await rolloverDueBudgets(t.db, { nowS: NOON });
    expect(result).toEqual({ rolled: 1, backlog: 0, maxLagS: NOON - MIDNIGHT });
    expect(await budget(t.pglite, "b1")).toMatchObject({
      spent: 0,
      periodStart: MIDNIGHT,
      resetAt: MIDNIGHT + D,
    });
    const { rows } = await t.pglite.query<{ amount_micro_credits: string }>(
      "SELECT amount_micro_credits FROM gateway_usage_ledger WHERE kind = 'adjust' AND ref_kind = 'period_rollover'",
    );
    expect(rows.map((r) => Number(r.amount_micro_credits))).toEqual([400]);
    expect((await checkGatewayInvariants(t.db)).violations).toEqual([]);

    // A refund of the old-period debit after rollover takes back nothing more.
    const refund = await store.refundMedia({
      requestId: "r1",
      tenantId: "tenant-a",
    });
    expect(refund.refundedMicroCredits).toBe(400);
    expect((await budget(t.pglite, "b1")).spent).toBe(0);
    expect((await checkGatewayInvariants(t.db)).violations).toEqual([]);
  });

  it("is idempotent when four nodes race the same due rows", async () => {
    for (const id of ["a", "b", "c"]) {
      await insertBudget(t.pglite, {
        id,
        scopeId: id,
        limitMicroCredits: 100,
        spentMicroCredits: 0,
      });
      await makePeriodic(t.pglite, id, "daily", MIDNIGHT);
    }
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        rolloverDueBudgets(t.db, { nowS: NOON, limit: 2 }),
      ),
    );
    expect(results.reduce((n, r) => n + r.rolled, 0)).toBe(3);
    for (const id of ["a", "b", "c"]) {
      expect((await budget(t.pglite, id)).version).toBe(1);
    }
    expect((await rolloverDueBudgets(t.db, { nowS: NOON })).rolled).toBe(0);
  });

  it("claims rows with FOR UPDATE SKIP LOCKED", async () => {
    const seen: string[] = [];
    const spy: GatewayBudgetDatabase = {
      query: (sql, p) => t.db.query(sql, p),
      transaction: (work) =>
        t.db.transaction((tx) =>
          work({
            query: (sql, p) => {
              seen.push(sql);
              return tx.query(sql, p);
            },
          }),
        ),
    };
    await rolloverDueBudgets(spy, { nowS: NOON });
    expect(seen.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(
      true,
    );
  });

  it("first schedule keeps spend; none/one_time and future rows are untouched", async () => {
    await insertBudget(t.pglite, {
      id: "new",
      scopeId: "n",
      limitMicroCredits: 100,
      spentMicroCredits: 30,
    });
    await makePeriodic(t.pglite, "new", "monthly", null);
    await insertBudget(t.pglite, {
      id: "flat",
      scopeId: "f",
      limitMicroCredits: 100,
      spentMicroCredits: 30,
    });
    await insertBudget(t.pglite, {
      id: "later",
      scopeId: "l",
      limitMicroCredits: 100,
      spentMicroCredits: 30,
    });
    await makePeriodic(t.pglite, "later", "daily", NOON + 60);

    expect((await rolloverDueBudgets(t.db, { nowS: NOON })).rolled).toBe(1);
    expect(await budget(t.pglite, "new")).toMatchObject({
      spent: 30,
      resetAt: Date.UTC(2026, 10, 1) / 1000,
    });
    expect((await budget(t.pglite, "flat")).spent).toBe(30);
    expect((await budget(t.pglite, "later")).spent).toBe(30);
  });

  it("a late rollover fails closed and a missing budget is never unlimited", async () => {
    await insertBudget(t.pglite, {
      id: "b1",
      limitMicroCredits: 100,
      spentMicroCredits: 100,
    });
    await makePeriodic(t.pglite, "b1", "daily", MIDNIGHT);
    const store = createPgGatewayBudgetStore(t.db);
    await expect(
      store.debitMedia({
        requestId: "r2",
        tenantId: "tenant-a",
        userId: "u",
        budgetIds: ["b1"],
        costMicroCredits: 1,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED" });
    await expect(
      store.debitMedia({
        requestId: "r3",
        tenantId: "tenant-a",
        userId: "u",
        budgetIds: ["gone"],
        costMicroCredits: 1,
      }),
    ).rejects.toThrow();
    await expect(
      store.admitText({ tenantId: "tenant-a", budgetIds: ["gone"] }),
    ).rejects.toThrow();
  });

  it("maintenance tick runs rollover and the limits sweep", async () => {
    let swept = 0;
    const result = await runGatewayMaintenanceTick({
      db: t.db,
      limits: { sweep: async () => ((swept += 1), { leases: 0, windows: 0 }) },
    });
    expect(result.rollover.rolled).toBe(0);
    expect(swept).toBe(1);
  });
});
