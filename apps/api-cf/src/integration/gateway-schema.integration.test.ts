import { env } from "cloudflare:test";
import { is, Table } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as gateway from "@clash/shared-cloud-schema/gateway";
import { tenantInvites, tenants } from "@clash/shared-cloud-schema/app";
import { describe, expect, it } from "vitest";

// Tables required by issue #345 (REPORT §5), applied from web/drizzle by the setup file.
const REQUIRED_TABLES = [
  "tenant_invite",
  "gateway_key",
  "gateway_token",
  "gateway_model",
  "gateway_price",
  "gateway_upstream_account",
  "gateway_budget",
  "gateway_usage_ledger",
  "gateway_admin_audit",
  "gateway_package",
  "gateway_topup_pack",
  "gateway_tenant_subscription",
];

const drizzleTables: SQLiteTable[] = [
  tenants,
  tenantInvites,
  ...Object.values(gateway as Record<string, unknown>).filter(
    (value): value is SQLiteTable => is(value, Table),
  ),
];

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM pragma_table_info(?)`,
  )
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

async function indexColumns(table: string): Promise<string[][]> {
  const { results: indexes } = await env.DB.prepare(
    `SELECT name FROM pragma_index_list(?)`,
  )
    .bind(table)
    .all<{ name: string }>();
  return Promise.all(
    indexes.map(async ({ name }) => {
      const { results } = await env.DB.prepare(
        `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
      )
        .bind(name)
        .all<{ name: string }>();
      return results.map((row) => row.name);
    }),
  );
}

describe("gateway D1 schema (web/drizzle migration)", () => {
  it("creates every gateway table with the Drizzle columns and no foreign keys", async () => {
    for (const table of REQUIRED_TABLES)
      expect(await columns(table), table).not.toEqual([]);
    for (const table of drizzleTables) {
      const config = getTableConfig(table);
      const migrated = await columns(config.name);
      expect(migrated, config.name).toEqual(
        expect.arrayContaining(config.columns.map((column) => column.name)),
      );
      const { results: fks } = await env.DB.prepare(
        `SELECT * FROM pragma_foreign_key_list(?)`,
      )
        .bind(config.name)
        .all();
      expect(fks, config.name).toEqual([]);
    }
  });

  it("keeps prompt and response bodies out of D1", async () => {
    for (const table of REQUIRED_TABLES)
      for (const column of await columns(table))
        expect(column, `${table}.${column}`).not.toMatch(
          /prompt|completion|message|body|content|response/,
        );
    // Retained bodies (0037) are R2 objects; their D1 row is keys, sizes and hashes only.
    const retention = await columns("gateway_request_retention");
    expect(retention).not.toEqual([]);
    for (const column of retention)
      expect(column, `gateway_request_retention.${column}`).not.toMatch(
        /prompt|completion|message|body|content/,
      );
  });

  it("indexes the ledger by tenant time, key time and budget status", async () => {
    const indexes = await indexColumns("gateway_usage_ledger");
    expect(indexes).toEqual(
      expect.arrayContaining([
        ["tenant_id", "occurred_at"],
        ["key_id", "occurred_at"],
        ["budget_id", "status"],
      ]),
    );
  });

  it("keeps official upstream accounts disjoint from tenant BYOK accounts", async () => {
    const official = await columns("gateway_upstream_account");
    expect(official).not.toContain("tenant_id");
    expect(official).not.toContain("user_id");
    expect(await columns("provider_account")).toContain("user_id");
    // A row must reference a secret; it can never hold none.
    await expect(
      env.DB.prepare(
        `INSERT INTO gateway_upstream_account (id, provider_id) VALUES (?, 'openai')`,
      )
        .bind("gw-345-upstream-without-secret")
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects ledger kinds outside the ledger vocabulary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO gateway_usage_ledger
           (id, request_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
         VALUES ('gw-345-bad-kind', 'gw-345-bad-kind', 'markup', 'posted', 't', 0, 0)`,
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });

  describe("hold -> settle round trip", () => {
    const tenantId = "gw-345-tenant";
    const budgetId = "gw-345-wallet";
    const limit = 10_000;
    const now = 1_790_000_000;

    // Conditional reserve: the hold row is appended only when the counter moved.
    function reserve(requestId: string, hold: number) {
      return env.DB.batch([
        env.DB.prepare(
          `UPDATE gateway_budget
              SET reserved_micro_credits = reserved_micro_credits + ?2,
                  version = version + 1, updated_at = ?4
            WHERE id = ?1 AND status = 'active'
              AND (limit_micro_credits IS NULL
                   OR spent_micro_credits + reserved_micro_credits + ?2 <= limit_micro_credits)
              AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger
                               WHERE request_id = ?3 AND budget_id = ?1 AND kind = 'hold')`,
        ).bind(budgetId, hold, requestId, now),
        env.DB.prepare(
          `INSERT INTO gateway_usage_ledger
             (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
              amount_micro_credits, model_code, expires_at, occurred_at)
           SELECT ?3 || ':hold', ?3, ?1, 'hold', 'open', ?5, 'gw-345-user', 'gw-345-key',
                  ?2, 'gw-345-model', ?4 + 660, ?4
            WHERE changes() = 1`,
        ).bind(budgetId, hold, requestId, now, tenantId),
      ]);
    }

    // Settle releases the stored hold (never a recomputed one) and charges the cost.
    function settle(requestId: string, cost: number) {
      const openHold = `SELECT amount_micro_credits FROM gateway_usage_ledger
                         WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'hold' AND status = 'open'`;
      return env.DB.batch([
        env.DB.prepare(
          `UPDATE gateway_budget
              SET spent_micro_credits = spent_micro_credits + ?3,
                  reserved_micro_credits = reserved_micro_credits - (${openHold}),
                  version = version + 1, updated_at = ?4
            WHERE id = ?1 AND EXISTS (${openHold})`,
        ).bind(budgetId, requestId, cost, now),
        env.DB.prepare(
          `UPDATE gateway_usage_ledger SET status = 'settled'
            WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'hold' AND status = 'open'`,
        ).bind(budgetId, requestId),
        env.DB.prepare(
          `INSERT INTO gateway_usage_ledger
             (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
              amount_micro_credits, model_code, input_tokens, output_tokens,
              price_version, catalog_version, occurred_at)
           SELECT ?2 || ':settle', ?2, ?1, 'settle', 'settled', ?5, 'gw-345-user', 'gw-345-key',
                  ?3, 'gw-345-model', 120, 80, 'p1', 'c1', ?4
            WHERE changes() = 1`,
        ).bind(budgetId, requestId, cost, now, tenantId),
      ]);
    }

    async function budget() {
      return env.DB.prepare(
        `SELECT spent_micro_credits AS spent, reserved_micro_credits AS reserved
           FROM gateway_budget WHERE id = ?`,
      )
        .bind(budgetId)
        .first<{ spent: number; reserved: number }>();
    }

    async function ledger(requestId: string) {
      const { results } = await env.DB.prepare(
        `SELECT kind, status, amount_micro_credits AS amount
           FROM gateway_usage_ledger WHERE request_id = ? ORDER BY kind`,
      )
        .bind(requestId)
        .all<{ kind: string; status: string; amount: number }>();
      return results;
    }

    it("holds, settles once, and keeps counters equal to the ledger", async () => {
      await env.DB.prepare(
        `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits)
         VALUES (?, ?, 'tenant', ?, ?)`,
      )
        .bind(budgetId, tenantId, tenantId, limit)
        .run();

      const requestId = "gw-345-request-1";
      const hold = 6_000;
      const cost = 3_200;
      await reserve(requestId, hold);
      expect(await budget()).toEqual({ spent: 0, reserved: hold });
      expect(await ledger(requestId)).toEqual([
        { kind: "hold", status: "open", amount: hold },
      ]);

      // A second hold larger than what remains is refused without a ledger row.
      const refused = "gw-345-request-refused";
      const [counter] = await reserve(refused, limit - hold + 1);
      expect(counter!.meta.changes).toBe(0);
      expect(await ledger(refused)).toEqual([]);
      // A replayed reserve does not hold twice.
      await reserve(requestId, hold);
      expect(await budget()).toEqual({ spent: 0, reserved: hold });

      await settle(requestId, cost);
      expect(await budget()).toEqual({ spent: cost, reserved: 0 });
      expect(await ledger(requestId)).toEqual([
        { kind: "hold", status: "settled", amount: hold },
        { kind: "settle", status: "settled", amount: cost },
      ]);

      // A duplicate settlement is a no-op on counters and ledger.
      await settle(requestId, cost);
      expect(await budget()).toEqual({ spent: cost, reserved: 0 });
      expect(await ledger(requestId)).toHaveLength(2);

      const sums = await env.DB.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'hold' AND status = 'open' THEN amount_micro_credits END), 0) AS open,
           COALESCE(SUM(CASE WHEN kind = 'settle' THEN amount_micro_credits END), 0) AS settled
         FROM gateway_usage_ledger WHERE budget_id = ?`,
      )
        .bind(budgetId)
        .first<{ open: number; settled: number }>();
      expect(sums).toEqual({ open: 0, settled: cost });
      expect(await budget()).toEqual({
        spent: sums!.settled,
        reserved: sums!.open,
      });
    });
  });
});
