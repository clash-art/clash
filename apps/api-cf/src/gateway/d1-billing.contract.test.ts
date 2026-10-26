/**
 * gateway-core's shared billing contract (#425) over the D1 adapters on
 * node:sqlite with the web/drizzle migrations; the Postgres adapters run the
 * same suite in apps/api-node (gateway-billing.test.ts, lite harness).
 */
import { describeGatewayBillingContract } from "@clash/gateway-core/contract";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { createD1Billing } from "./d1-billing";
import { createD1PriceBook } from "./d1-price-book";

describeGatewayBillingContract("D1 (node:sqlite)", () => {
  const { d1, sqlite } = createSqliteD1();
  let t = Date.parse("2026-01-01T00:00:00Z");
  const clock = { now: () => t };
  let tenants = 0;
  return {
    billing: createD1Billing(d1, { clock }),
    priceBook: createD1PriceBook(d1, { clock }),
    async createTenant() {
      const id = `tnt_contract_${++tenants}`;
      sqlite
        .prepare(
          `INSERT INTO tenant (id, owner_user_id, name) VALUES (?, ?, 'Contract')`,
        )
        .run(id, `usr_${id}`);
      return id;
    },
    now: () => t,
    setNow: (ms) => {
      t = ms;
    },
  };
});
