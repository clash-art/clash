/**
 * gateway-core's shared billing contract (#425) on real Postgres, the #379
 * lite harness (scripts/test-gateway-lite.ts): a disposable loopback database
 * with this package's migrations, a pg pool of 10, so the concurrent top-up of
 * one provider event id and the concurrent refund replay race real
 * transactions on the wallet row lock. Same suite as D1 and PGlite.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { describeGatewayBillingContract } from "@clash/gateway-core/contract";
import { checkGatewayInvariants } from "../gateway-budget.ts";
import {
  createPgGatewayBilling,
  createPgGatewayPriceBook,
} from "../gateway-billing.ts";
import { migrateDatabase } from "../migrations.ts";
import { openPostgres } from "../postgres.ts";

const ADMIN_URL = process.env.GATEWAY_LITE_DATABASE_URL;

let admin: Pool | undefined;
let database: ReturnType<typeof openPostgres> | undefined;
let dbName: string | undefined;

async function shared() {
  if (database) return database;
  const url = new URL(ADMIN_URL!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("gateway-lite requires a disposable loopback Postgres");
  admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `clash_gwbill_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  url.pathname = `/${dbName}`;
  database = openPostgres({ connectionString: url.href, max: 10 });
  await migrateDatabase(database.db);
  return database;
}

if (ADMIN_URL) {
  let tenants = 0;
  describeGatewayBillingContract("Postgres (lite, real server)", async () => {
    const { db } = await shared();
    let t = Date.parse("2026-01-01T00:00:00Z");
    const now = () => t;
    return {
      billing: createPgGatewayBilling({ db, now }),
      priceBook: createPgGatewayPriceBook({ db, now }),
      async createTenant() {
        const id = `tnt_lite_${++tenants}`;
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

  describe("gateway billing on real Postgres: ledger invariants", () => {
    it("keeps the gateway invariants after the contract", async () => {
      const { db } = await shared();
      const result = await checkGatewayInvariants(db);
      expect(result).toMatchObject({ ok: true });
    });
  });

  afterAll(async () => {
    await database?.close();
    if (admin && dbName)
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });
} else {
  describe.skip("gateway billing contract on real Postgres (GATEWAY_LITE_DATABASE_URL unset)", () => {
    it("skipped", () => undefined);
  });
}
