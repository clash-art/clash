import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import {
  assertGatewaySeedFlashOnly,
  defaultGatewaySeedModels,
  GATEWAY_SEED_DEEPSEEK_FLASH,
  GatewaySeedError,
  seedGatewayDatabase,
} from "./gateway-seed.ts";
import { loadMigrations, migrateDatabase } from "./migrations.ts";

it("applies the postgres gateway migration on PGlite (0016)", async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.id)).toContain("0016_gateway.sql");
    await migrateDatabase(db);
    const tables = await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relkind = 'r' AND relname LIKE 'gateway_%'
        ORDER BY relname`,
    );
    expect(tables.rows.map((row) => row.relname)).toEqual([
      "gateway_admin_audit",
      "gateway_budget",
      "gateway_config",
      "gateway_idempotency_claim",
      "gateway_inflight",
      "gateway_model",
      "gateway_price",
      "gateway_rate_window",
      "gateway_request",
      "gateway_settle_intent",
      "gateway_upstream_credential",
      "gateway_usage_ledger",
    ]);
    const checksum = await db.query<{ id: string }>(
      "SELECT id FROM cloud_schema_migration WHERE id = $1",
      ["0016_gateway.sql"],
    );
    expect(checksum.rows).toEqual([{ id: "0016_gateway.sql" }]);
  } finally {
    await db.close();
  }
});

it("enforces ledger charge-once on (request_id, budget_id, kind) for N2 kinds", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const now = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO gateway_usage_ledger (
         id, request_id, budget_id, kind, status, tenant_id,
         amount_micro_credits, occurred_at, created_at
       ) VALUES
         ('l1', 'req-1', 'budget-a', 'debit', 'settled', 't1', 1000, $1, $1),
         ('l2', 'req-1', 'budget-a', 'refund', 'settled', 't1', 1000, $1, $1),
         ('l3', 'req-2', 'budget-a', 'charge', 'settled', 't1', 500, $1, $1)`,
      [now],
    );
    await expect(
      db.query(
        `INSERT INTO gateway_usage_ledger (
           id, request_id, budget_id, kind, status, tenant_id,
           amount_micro_credits, occurred_at, created_at
         ) VALUES ('l4', 'req-1', 'budget-a', 'debit', 'settled', 't1', 1000, $1, $1)`,
        [now],
      ),
    ).rejects.toThrow();
    // Same request + kind on a different budget is allowed (per-budget lines).
    await db.query(
      `INSERT INTO gateway_usage_ledger (
         id, request_id, budget_id, kind, status, tenant_id,
         amount_micro_credits, occurred_at, created_at
       ) VALUES ('l5', 'req-1', 'budget-b', 'debit', 'settled', 't1', 1000, $1, $1)`,
      [now],
    );
  } finally {
    await db.close();
  }
});

it("uses empty string not NULL for credential composite uniqueness", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const now = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO gateway_upstream_credential (
         id, tenant_key, scope, provider_id, upstream_id, account_id, region,
         encrypted_credentials, key_version, created_at, updated_at
       ) VALUES
         ('c1', '', 'official', 'deepseek', '', '', '', 'sealed', 'v1', $1, $1)`,
      [now],
    );
    await expect(
      db.query(
        `INSERT INTO gateway_upstream_credential (
           id, tenant_key, scope, provider_id, upstream_id, account_id, region,
           encrypted_credentials, key_version, created_at, updated_at
         ) VALUES
           ('c2', '', 'official', 'deepseek', '', '', '', 'sealed-2', 'v1', $1, $1)`,
        [now],
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});

it("seeds DeepSeek Flash only and refuses non-Flash DeepSeek", async () => {
  expect(() =>
    assertGatewaySeedFlashOnly([{ modelCode: "deepseek-v4-pro" }]),
  ).toThrow(GatewaySeedError);
  expect(() =>
    assertGatewaySeedFlashOnly([{ modelCode: "deepseek-reasoner" }]),
  ).toThrow(/Flash only/);
  expect(() =>
    assertGatewaySeedFlashOnly([
      { modelCode: "house-chat", upstreamId: "deepseek" },
    ]),
  ).toThrow(GatewaySeedError);
  expect(() =>
    assertGatewaySeedFlashOnly([
      { modelCode: GATEWAY_SEED_DEEPSEEK_FLASH, upstreamId: "deepseek" },
    ]),
  ).not.toThrow();

  const db = new PGlite();
  try {
    await migrateDatabase(db);
    await expect(
      seedGatewayDatabase(db, {
        models: [
          {
            modelCode: "deepseek-v4-pro",
            kind: "text",
            displayName: "blocked",
            inputAmountMicro: 1,
            outputAmountMicro: 1,
            card: { id: "deepseek-v4-pro" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_SEED_MODEL_BLOCKED" });

    const result = await seedGatewayDatabase(db, {
      models: defaultGatewaySeedModels(),
    });
    expect(result.models).toBe(1);
    expect(result.prices).toBe(2);
    const rows = await db.query<{ model_code: string }>(
      "SELECT model_code FROM gateway_model",
    );
    expect(rows.rows).toEqual([{ model_code: GATEWAY_SEED_DEEPSEEK_FLASH }]);
  } finally {
    await db.close();
  }
});

it("documents settle intent as non-authoritative short-lived bookkeeping", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const now = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO gateway_settle_intent (request_id, kind, payload, status, created_at, updated_at)
       VALUES ('req-1', 'charge', '{"cost":1}'::jsonb, 'pending', $1, $1)`,
      [now],
    );
    // Duplicate intent for same (request, kind) is refused — one follow-up.
    await expect(
      db.query(
        `INSERT INTO gateway_settle_intent (request_id, kind, payload, status, created_at, updated_at)
         VALUES ('req-1', 'charge', '{"cost":2}'::jsonb, 'pending', $1, $1)`,
        [now],
      ),
    ).rejects.toThrow();
    // Refund may coexist with charge for the same request.
    await db.query(
      `INSERT INTO gateway_settle_intent (request_id, kind, payload, status, created_at, updated_at)
       VALUES ('req-1', 'refund', '{"status":"upstream_failed"}'::jsonb, 'pending', $1, $1)`,
      [now],
    );
  } finally {
    await db.close();
  }
});
