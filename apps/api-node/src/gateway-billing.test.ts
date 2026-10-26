/**
 * gateway-core's shared billing contract (#425) over the Postgres adapters on
 * PGlite with this package's migrations (0020 included). The D1 adapters run
 * the same suite in apps/api-cf (d1-billing.contract.test.ts); real Postgres
 * runs it in the lite harness (integration/gateway-billing.lite.test.ts).
 */
import { PGlite } from "@electric-sql/pglite";
import { describeGatewayBillingContract } from "@clash/gateway-core/contract";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  createPgGatewayBilling,
  createPgGatewayPriceBook,
} from "./gateway-billing.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  const client = (q: Pick<PGlite, "query">): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return {
    ...client(pglite),
    transaction: (work) => pglite.transaction((tx) => work(client(tx))),
  };
}

describeGatewayBillingContract("Postgres (PGlite)", async () => {
  const pglite = new PGlite();
  await migrateDatabase(pglite);
  const db = adapt(pglite);
  let t = Date.parse("2026-01-01T00:00:00Z");
  const now = () => t;
  let tenants = 0;
  return {
    billing: createPgGatewayBilling({ db, now }),
    priceBook: createPgGatewayPriceBook({ db, now }),
    async createTenant() {
      const id = `tnt_contract_${++tenants}`;
      await db.query(
        `INSERT INTO tenant (id, owner_user_id, name) VALUES ($1, $2, 'Contract')`,
        [id, `usr_${id}`],
      );
      return id;
    },
    now,
    setNow: (ms) => {
      t = ms;
    },
  };
});
