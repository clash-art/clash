/**
 * Official vs tenant (BYOK) credential resolution (#369) on PGlite with the
 * real schema, served by the #378 mock upstream (never a real provider).
 * Every upstream call is identified by the mock's key hash (`x-mock-key-id`,
 * `keyIdFor`): official keys never serve BYOK and vice versa, across
 * failover; the scope order is a per-tenant / per-member setting; BYOK with
 * no budget row is admitted while official with none is a 402 with no
 * upstream call.
 */
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readGatewaySettlementFloor,
  type GatewayBudgetDatabase,
  type GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import { createPgGatewayBudgetPort } from "./gateway-budget-port.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { createPgGatewayLimitPort } from "./gateway-limits.ts";
import { createGatewayNodeRoutes, createPgGatewayPorts, credentialPriorityOrder } from "./gateway-node.ts";
import { inlinePgSettlement } from "./gateway-settle-test-support.ts";
import { migrateDatabase } from "./migrations.ts";
import { createMockUpstreamApp, keyIdFor, MOCK_KEY_ID, type MockUpstreamApp } from "./mock-upstream/index.ts";

const MODEL = "gw-node-cred-chat";
const TENANT = "tenant-x";
const fake = (label: string) => `sk_test_${label}_${randomBytes(6).toString("hex")}`;
const KEYS = {
  officialA: fake("official_a"),
  officialB: fake("official_b"),
  byokA: fake("byok_a"),
  byokB: fake("byok_b"),
};
const OFFICIAL = new Set([keyIdFor(KEYS.officialA), keyIdFor(KEYS.officialB)]);
const BYOK = new Set([keyIdFor(KEYS.byokA), keyIdFor(KEYS.byokB)]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let pglite: PGlite;
let db: GatewayBudgetDatabase;
let mock: MockUpstreamApp;
let app: ReturnType<typeof createGatewayNodeRoutes>;
/** Key hashes the mock recorded, one per upstream call, in order. */
let calls: string[];
/** Keys whose upstream answers 500 (the mock's own error path). */
let failing: Set<string>;

function adapt(p: PGlite): GatewayBudgetDatabase {
  const wrap = (q: { query: PGlite["query"] }): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return { ...wrap(p), transaction: (work) => p.transaction(async (tx) => work(wrap(tx as never))) };
}

async function virtualKey(userId: string, scope: "official" | "tenant", tenantId = TENANT): Promise<string> {
  const id = randomBytes(12).toString("hex");
  const token = `sk_gw_${id}.${randomBytes(32).toString("hex")}`;
  await pglite.query(
    `INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix, credential_scope, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,0)`,
    [`gvk_${id}`, tenantId, userId, sha(token), token.slice(0, 12), scope],
  );
  return token;
}

async function budget(id: string, scopeId: string, limit: number, spent = 0, tenantId = TENANT) {
  await pglite.query(
    `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
       reserved_micro_credits, status, enforcement, version, period, created_at, updated_at)
     VALUES ($1,$2,'user',$3,$4,$5,0,'active','hard',0,'none',0,0)`,
    [id, tenantId, scopeId, limit, spent],
  );
}

async function priority(value: string, userId = "", tenantId = TENANT) {
  await pglite.query(
    `INSERT INTO gateway_credential_priority (tenant_id, user_id, priority, updated_at) VALUES ($1,$2,$3,0)`,
    [tenantId, userId, value],
  );
}

const chat = (token: string) =>
  app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 16 }),
  });

const charges = async () =>
  (await pglite.query<{ n: number }>(`SELECT count(*)::int AS n FROM gateway_usage_ledger WHERE kind = 'charge'`))
    .rows[0]!.n;

beforeEach(async () => {
  calls = [];
  failing = new Set();
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
  const ring = createGatewayKeyRing({ keys: { k1: randomBytes(32) }, current: "k1" });
  const credentials = createPgGatewayCredentialStore({ db, ring });
  const accounts = [
    { id: "official-a", scope: "official", providerId: "official", key: KEYS.officialA },
    { id: "official-b", scope: "official", providerId: "openai", key: KEYS.officialB },
    { id: "byok-a", scope: "tenant", providerId: "custom", key: KEYS.byokA },
    { id: "byok-b", scope: "tenant", providerId: "openai", key: KEYS.byokB },
  ] as const;
  for (const account of accounts)
    await credentials.put({
      id: account.id,
      scope: account.scope,
      ...(account.scope === "tenant" ? { tenantId: TENANT } : {}),
      providerId: account.providerId,
      upstreamId: "openai",
      credentials: { apiKey: account.key, baseUrl: "http://mock.test/openai/v1" },
    } as never);
  const [card] = buildEffectiveModelCards({
    baseModels: [],
    providers: accounts.map((account) => ({
      id: account.id,
      providerId: account.providerId,
      upstreamId: "openai",
      apiShape: "openai-compatible" as const,
      configuredCredentials: account.scope === "tenant" ? ["apiKey", "baseUrl"] : ["apiKey"],
    })),
    configs: [
      {
        modelId: MODEL,
        custom: true,
        name: "Credential resolution chat",
        kind: "text",
        providerBindings: accounts.map((account) => ({
          providerAccountId: account.id,
          upstreamModel: `mock-${account.id}`,
        })),
      },
    ],
  });
  const nowS = Math.floor(Date.now() / 1000) - 60;
  await pglite.query(
    `INSERT INTO gateway_model (id, catalog_version, model_code, kind, display_name, enabled, card_json, published_at, created_at)
     VALUES ('c1:${MODEL}', 'c1', $1, 'text', 'Credential resolution chat', 1, $2::jsonb, $3, $3)`,
    [MODEL, JSON.stringify(card), nowS],
  );
  for (const [unit, amount] of [["input_token", 1_000_000], ["output_token", 2_000_000]] as const)
    await pglite.query(
      `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per,
         currency, effective_from, source, published_at, created_at)
       VALUES ($1,'p1',$2,'',$3,$4,1000,'credit',$5,'test',$5,$5)`,
      [`p1:${unit}`, MODEL, unit, amount, nowS],
    );
  mock = createMockUpstreamApp();
  const upstream = {
    async fetch(request: Request): Promise<Response> {
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const fail = failing.has(key);
      if (fail) mock.state.setControl({ mode: "500" });
      try {
        const response = await mock.app.fetch(request);
        calls.push(response.headers.get(MOCK_KEY_ID) ?? "missing");
        return response;
      } finally {
        if (fail) mock.state.setControl({ mode: "ok" });
      }
    },
  };
  app = createGatewayNodeRoutes(
    createPgGatewayPorts({
      db,
      credentials,
      limits: createPgGatewayLimitPort(db),
      upstream,
      settlement: inlinePgSettlement({ db }),
    }),
    { app: { creditFloor: () => readGatewaySettlementFloor(db) } },
  );
});

afterEach(async () => {
  await pglite.close();
});

// Each scope has two accounts on distinct providers (one route each), in
// binding order: the A key is the primary and B the failover.
describe("gateway-node credential resolution (#369)", () => {
  it("records the key hash per call and keeps each scope's keys on its own requests", async () => {
    const official = await virtualKey("u-official", "official");
    const byok = await virtualKey("u-byok", "tenant");
    await budget("b-official", "u-official", 1_000_000_000);
    expect((await chat(official)).status).toBe(200);
    expect((await chat(byok)).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.officialA), keyIdFor(KEYS.byokA)]);
    const stats = mock.state.snapshot();
    expect(stats[keyIdFor(KEYS.officialA)]?.requests).toBe(1);
    expect(stats[keyIdFor(KEYS.byokA)]?.requests).toBe(1);
  });

  it("fails over within BYOK only: never an official key, even when every BYOK key fails", async () => {
    const byok = await virtualKey("u-byok", "tenant");
    failing.add(KEYS.byokA);
    expect((await chat(byok)).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.byokA), keyIdFor(KEYS.byokB)]);
    failing.add(KEYS.byokB);
    calls = [];
    const refused = await chat(byok);
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(calls).toEqual([keyIdFor(KEYS.byokA), keyIdFor(KEYS.byokB)]);
    expect(calls.some((id) => OFFICIAL.has(id))).toBe(false);
  });

  it("fails over within official only: never a BYOK key, even when every official key fails", async () => {
    const official = await virtualKey("u-official", "official");
    await budget("b-official", "u-official", 1_000_000_000);
    failing.add(KEYS.officialA);
    expect((await chat(official)).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.officialA), keyIdFor(KEYS.officialB)]);
    failing.add(KEYS.officialB);
    calls = [];
    expect((await chat(official)).status).toBeGreaterThanOrEqual(500);
    expect(calls).toEqual([keyIdFor(KEYS.officialA), keyIdFor(KEYS.officialB)]);
    expect(calls.some((id) => BYOK.has(id))).toBe(false);
  });

  it("admits BYOK with no budget row (tenant pays upstream) and charges no platform budget", async () => {
    const byok = await virtualKey("u-byok", "tenant");
    const response = await chat(byok);
    expect(response.status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.byokA)]);
    expect(await charges()).toBe(0);
  });

  it("holds BYOK with a budget row to that budget", async () => {
    const byok = await virtualKey("u-byok", "tenant");
    await budget("b-byok", "u-byok", 100, 100); // exhausted
    const response = await chat(byok);
    expect(response.status).toBe(402);
    expect(response.headers.get("x-clash-error-code")).toBe("GATEWAY_BUDGET_EXCEEDED");
    expect(calls).toEqual([]);
    await pglite.query(`UPDATE gateway_budget SET limit_micro_credits = 1000000000 WHERE id = 'b-byok'`);
    expect((await chat(byok)).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.byokA)]);
    expect(await charges()).toBe(1);
  });

  it("refuses official with no budget row: 402 and no upstream call", async () => {
    const official = await virtualKey("u-official", "official");
    const response = await chat(official);
    expect(response.status).toBe(402);
    expect(response.headers.get("x-clash-error-code")).toBe("GATEWAY_BUDGET_EXCEEDED");
    expect(calls).toEqual([]);
    expect(mock.state.snapshot()).toEqual({});
  });

  it("applies the tenant's priority: tenant_first serves an official-scope key from BYOK", async () => {
    const key = await virtualKey("u1", "official");
    await priority("tenant_first");
    expect((await chat(key)).status).toBe(200); // BYOK, unbudgeted: admitted
    expect(calls).toEqual([keyIdFor(KEYS.byokA)]);
  });

  it("falls back from BYOK to official only through the official budget check", async () => {
    // tenant-y has no BYOK account: tenant_first resolves to official at
    // planning, before the reserve, so the unbudgeted request is a 402.
    const key = await virtualKey("u1", "tenant", "tenant-y");
    await priority("tenant_first", "", "tenant-y");
    const refused = await chat(key);
    expect(refused.status).toBe(402);
    expect(calls).toEqual([]);
    await budget("b-y", "u1", 1_000_000_000, 0, "tenant-y");
    expect((await chat(key)).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.officialA)]);
    expect(await charges()).toBe(1);
  });

  it("lets a member's priority override the tenant's", async () => {
    await budget("b-u2", "u2", 1_000_000_000);
    await priority("tenant_only");
    await priority("official_first", "u2");
    expect((await chat(await virtualKey("u1", "official"))).status).toBe(200);
    expect((await chat(await virtualKey("u2", "tenant"))).status).toBe(200);
    expect(calls).toEqual([keyIdFor(KEYS.byokA), keyIdFor(KEYS.officialA)]);
  });

  it("defaults to the credential's own scope only", () => {
    expect(credentialPriorityOrder(null, "official")).toEqual(["official"]);
    expect(credentialPriorityOrder(undefined, "tenant")).toEqual(["tenant"]);
    expect(credentialPriorityOrder("bogus", "tenant")).toEqual(["tenant"]);
    expect(credentialPriorityOrder("tenant_first", "official")).toEqual(["tenant", "official"]);
    expect(credentialPriorityOrder("official_first", "tenant")).toEqual(["official", "tenant"]);
  });

  it("budget port: only tenant scope is exempt from the no-budget refusal", async () => {
    const port = createPgGatewayBudgetPort({ db });
    const base = { requestId: "gwr_x", tenantId: TENANT, budgetIds: [], floorMicroCredits: 0 };
    await expect(port.check({ ...base, credentialScope: "tenant" })).resolves.toEqual({});
    await expect(port.check({ ...base, credentialScope: "official" })).rejects.toMatchObject({
      code: "GATEWAY_BUDGET_EXCEEDED",
    });
  });
});
