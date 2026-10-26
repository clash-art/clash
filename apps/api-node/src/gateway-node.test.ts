/**
 * Node gateway routes (#367) on PGlite with the real schema: gateway-core's
 * app over the Postgres ports, served by the #378 mock upstream (never a real
 * provider). Covers session / clsh_ / sk_gw_ auth, /v1/models, non-stream
 * chat, coded 401/402/429/502, tenant isolation and a query-count budget on
 * the admission path.
 */
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { createPgGatewayLimitPort, gatewayLimitConfigKeys } from "./gateway-limits.ts";
import {
  createGatewayNodeRoutes,
  createPgGatewayPorts,
  gatewayRole,
  personalTenantId,
} from "./gateway-node.ts";
import { migrateDatabase } from "./migrations.ts";
import { createMockUpstreamApp, keyIdFor, type MockUpstreamApp } from "./mock-upstream/index.ts";

const MODEL = "gw-node-chat";
const OFFICIAL_KEY = `sk_test_official_${randomBytes(6).toString("hex")}`;
const TENANT_B_KEY = `sk_test_tenant_b_${randomBytes(6).toString("hex")}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let pglite: PGlite;
let db: GatewayBudgetDatabase;
let queries: string[];
let mock: MockUpstreamApp;
let app: ReturnType<typeof createGatewayNodeRoutes>;
let sessionUser: string | null;

function adapt(p: PGlite): GatewayBudgetDatabase {
  const wrap = (q: { query: PGlite["query"] }): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      queries.push(sql);
      const result = await q.query<Row>(sql, parameters ?? []);
      return { rows: result.rows };
    },
  });
  return { ...wrap(p), transaction: (work) => p.transaction(async (tx) => work(wrap(tx as never))) };
}

async function virtualKey(input: {
  tenantId: string;
  userId: string;
  scope?: "official" | "tenant";
  allowlist?: string[];
  expiresAt?: number;
  revokedAt?: number;
}): Promise<{ token: string; id: string }> {
  const id = randomBytes(12).toString("hex");
  const token = `sk_gw_${id}.${randomBytes(32).toString("hex")}`;
  await pglite.query(
    `INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix,
       model_allowlist, credential_scope, expires_at, revoked_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,0)`,
    [
      `gvk_${id}`,
      input.tenantId,
      input.userId,
      sha(token),
      token.slice(0, 12),
      input.allowlist ? JSON.stringify(input.allowlist) : null,
      input.scope ?? "official",
      input.expiresAt ?? null,
      input.revokedAt ?? null,
    ],
  );
  return { token, id: `gvk_${id}` };
}

async function budget(id: string, tenantId: string, scope: string, scopeId: string, limit: number | null, spent = 0) {
  await pglite.query(
    `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
       reserved_micro_credits, status, enforcement, version, period, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,0,'active','hard',0,'none',0,0)`,
    [id, tenantId, scope, scopeId, limit, spent],
  );
}

const chat = (path: string, token: string | undefined, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...body }),
  });

beforeEach(async () => {
  queries = [];
  sessionUser = null;
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
  const ring = createGatewayKeyRing({ keys: { k1: randomBytes(32) }, current: "k1" });
  const credentials = createPgGatewayCredentialStore({ db, ring });
  await credentials.put({
    id: "official-mock",
    scope: "official",
    providerId: "official",
    upstreamId: "openai",
    credentials: { apiKey: OFFICIAL_KEY, baseUrl: "http://mock.test/openai/v1" },
  } as never);
  await credentials.put({
    id: "tenant-b-mock",
    scope: "tenant",
    tenantId: "tenant-b",
    providerId: "custom",
    upstreamId: "openai",
    credentials: { apiKey: TENANT_B_KEY, baseUrl: "http://mock.test/openai/v1" },
  } as never);
  const [card] = buildEffectiveModelCards({
    baseModels: [],
    providers: [
      { id: "official-mock", providerId: "official", upstreamId: "openai", apiShape: "openai-compatible", configuredCredentials: ["apiKey"] },
      { id: "tenant-b-mock", providerId: "custom", upstreamId: "openai", apiShape: "openai-compatible", configuredCredentials: ["apiKey", "baseUrl"] },
    ],
    configs: [
      {
        modelId: MODEL,
        custom: true,
        name: "Node gateway chat",
        kind: "text",
        providerBindings: [
          { providerAccountId: "official-mock", upstreamModel: "mock-official-model" },
          { providerAccountId: "tenant-b-mock", upstreamModel: "mock-tenant-model" },
        ],
      },
    ],
  });
  const nowS = Math.floor(Date.now() / 1000) - 60;
  await pglite.query(
    `INSERT INTO gateway_model (id, catalog_version, model_code, kind, display_name, enabled, card_json, published_at, created_at)
     VALUES ('c1:${MODEL}', 'c1', $1, 'text', 'Node gateway chat', 1, $2::jsonb, $3, $3)`,
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
  const ports = createPgGatewayPorts({
    db,
    credentials,
    limits: createPgGatewayLimitPort(db),
    session: async () => (sessionUser ? { userId: sessionUser } : null),
    upstream: { fetch: (request) => Promise.resolve(mock.app.fetch(request)) },
  });
  app = createGatewayNodeRoutes(ports);
  queries = [];
});

afterEach(async () => {
  await pglite.close();
});

const statsFor = (key: string) => mock.state.snapshot()[keyIdFor(key)];

describe("gateway-node routes", () => {
  it("serves an OpenAI-compatible non-stream completion on /v1 and /api/v1/gateway", async () => {
    const { token } = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    await budget("b-a", "tenant-a", "tenant", "tenant-a", 1_000_000_000);
    for (const path of ["/v1/chat/completions", "/api/v1/gateway/chat/completions"]) {
      const response = await chat(path, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(MODEL);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
      expect(response.headers.get("x-clash-request-id")).toMatch(/^gwr_/);
    }
    const { rows } = await pglite.query<{ n: number; spent: string }>(
      `SELECT (SELECT count(*)::int FROM gateway_usage_ledger WHERE kind='charge' AND tenant_id='tenant-a') AS n,
              (SELECT spent_micro_credits::text FROM gateway_budget WHERE id='b-a') AS spent`,
    );
    expect(rows[0]!.n).toBe(2);
    expect(Number(rows[0]!.spent)).toBeGreaterThan(0);
    expect(statsFor(OFFICIAL_KEY)?.requests).toBe(2);
  });

  it("authenticates clsh_ tokens and sessions as the personal tenant", async () => {
    const clsh = `clsh_${randomBytes(20).toString("hex")}`;
    await pglite.query(
      `INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES ('t1','u-clsh','n',$1,$2)`,
      [sha(clsh), clsh.slice(0, 13)],
    );
    const viaToken = await chat("/v1/chat/completions", clsh);
    expect(viaToken.status).toBe(200);
    sessionUser = "u-session";
    const viaSession = await chat("/v1/chat/completions", undefined, {}, { cookie: "better-auth.session_token=x" });
    expect(viaSession.status).toBe(200);
    const { rows } = await pglite.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM gateway_request ORDER BY tenant_id",
    );
    // No budgets: nothing charged, so no request row; identity is still personal.
    expect(rows.every((r) => r.tenant_id.startsWith("personal:"))).toBe(true);
    const models = await app.request("/v1/models", { headers: { authorization: `Bearer ${clsh}` } });
    expect(models.status).toBe(200);
    expect(personalTenantId("x")).toBe("personal:x");
  });

  it("lists /v1/models filtered by the key's allowlist", async () => {
    const all = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    const none = await virtualKey({ tenantId: "tenant-a", userId: "u1", allowlist: ["other-model"] });
    for (const path of ["/v1/models", "/api/v1/gateway/models"]) {
      const response = await app.request(path, { headers: { authorization: `Bearer ${all.token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        object: "list",
        data: [{ id: MODEL, object: "model", created: 0, owned_by: "clash" }],
      });
    }
    const filtered = await app.request("/v1/models", { headers: { authorization: `Bearer ${none.token}` } });
    expect(((await filtered.json()) as { data: unknown[] }).data).toEqual([]);
    const denied = await chat("/v1/chat/completions", none.token);
    expect(denied.status).toBe(403);
  });

  it("answers coded 401s and never trusts x-user-id", async () => {
    const expired = await virtualKey({ tenantId: "tenant-a", userId: "u1", expiresAt: 1 });
    const revoked = await virtualKey({ tenantId: "tenant-a", userId: "u1", revokedAt: 1 });
    const cases: [string | undefined, string][] = [
      [undefined, "GATEWAY_AUTH_REQUIRED"],
      [`sk_gw_${"0".repeat(24)}.${"0".repeat(64)}`, "GATEWAY_AUTH_REQUIRED"],
      ["clsh_unknown", "GATEWAY_AUTH_REQUIRED"],
      [expired.token, "GATEWAY_TOKEN_EXPIRED"],
      [revoked.token, "GATEWAY_TOKEN_REVOKED"],
    ];
    for (const [token, code] of cases) {
      const response = await chat("/v1/chat/completions", token, {}, { "x-user-id": "u1" });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-clash-error-code")).toBe(code);
      const models = await app.request("/v1/models", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      expect(models.status).toBe(401);
    }
    expect(statsFor(OFFICIAL_KEY)).toBeUndefined();
  });

  it("answers 402 when a budget is at the credit floor, without calling upstream", async () => {
    const { token } = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    await budget("b-empty", "tenant-a", "user", "u1", 100, 100);
    const response = await chat("/v1/chat/completions", token);
    expect(response.status).toBe(402);
    expect(response.headers.get("x-clash-error-code")).toBe("GATEWAY_BUDGET_EXCEEDED");
    expect(((await response.json()) as any).error.type).toBe("insufficient_quota");
    expect(statsFor(OFFICIAL_KEY)).toBeUndefined();
  });

  it("answers 429 past the key's rate limit with retry-after", async () => {
    const { token, id } = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    await pglite.query(
      `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ($1, $2::jsonb, 1, 0)`,
      [gatewayLimitConfigKeys.key("tenant-a", id), JSON.stringify({ requestsPerMinute: 1 })],
    );
    expect((await chat("/v1/chat/completions", token)).status).toBe(200);
    const limited = await chat("/v1/chat/completions", token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-clash-error-code")).toBe("GATEWAY_RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("answers 502 when the upstream fails, and charges nothing", async () => {
    const { token } = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    await budget("b-a", "tenant-a", "tenant", "tenant-a", 1_000_000_000);
    mock.state.setControl({ mode: "500" });
    const response = await chat("/v1/chat/completions", token);
    expect(response.status).toBe(502);
    expect(response.headers.get("x-clash-error-code")).toMatch(/^GATEWAY_(UPSTREAM_ERROR|ROUTES_EXHAUSTED)$/);
    const { rows } = await pglite.query<{ spent: string }>(
      "SELECT spent_micro_credits::text AS spent FROM gateway_budget WHERE id='b-a'",
    );
    expect(rows[0]!.spent).toBe("0");
  });

  it("isolates tenants: keys, credentials, budgets and limits never cross", async () => {
    const a = await virtualKey({ tenantId: "tenant-a", userId: "shared-user" });
    const b = await virtualKey({ tenantId: "tenant-b", userId: "shared-user", scope: "tenant" });
    const c = await virtualKey({ tenantId: "tenant-c", userId: "shared-user", scope: "tenant" });
    await budget("b-a", "tenant-a", "user", "shared-user", 1_000_000_000);
    await budget("b-b", "tenant-b", "user", "shared-user", 100, 100); // exhausted
    // tenant-b's budget is exhausted: 402 for b, a unaffected.
    expect((await chat("/v1/chat/completions", b.token)).status).toBe(402);
    expect((await chat("/v1/chat/completions", a.token)).status).toBe(200);
    // Lift b's budget: b is served by its own BYOK key only, a by the official key only.
    await pglite.query("UPDATE gateway_budget SET limit_micro_credits = 1000000000 WHERE id='b-b'");
    expect((await chat("/v1/chat/completions", b.token)).status).toBe(200);
    expect(statsFor(OFFICIAL_KEY)?.requests).toBe(1);
    expect(statsFor(TENANT_B_KEY)?.requests).toBe(1);
    // tenant-c has no tenant credential: never falls back to b's or the official key.
    const cResponse = await chat("/v1/chat/completions", c.token);
    expect(cResponse.status).toBeGreaterThanOrEqual(400);
    expect(statsFor(OFFICIAL_KEY)?.requests).toBe(1);
    expect(statsFor(TENANT_B_KEY)?.requests).toBe(1);
    // A rate limit on tenant-a's key does not throttle tenant-b.
    await pglite.query(
      `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ($1, $2::jsonb, 1, 0)`,
      [gatewayLimitConfigKeys.tenant("tenant-a"), JSON.stringify({ requestsPerMinute: 1 })],
    );
    expect((await chat("/v1/chat/completions", a.token)).status).toBe(200);
    expect((await chat("/v1/chat/completions", a.token)).status).toBe(429);
    expect((await chat("/v1/chat/completions", b.token)).status).toBe(200);
    // Ledger rows stay in their tenant.
    const { rows } = await pglite.query<{ tenant_id: string; budget_id: string }>(
      "SELECT tenant_id, budget_id FROM gateway_usage_ledger WHERE kind='charge'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.budget_id).toBe(row.tenant_id === "tenant-a" ? "b-a" : "b-b");
  });

  it("keeps the admission path within a fixed Postgres query budget", async () => {
    const { token } = await virtualKey({ tenantId: "tenant-a", userId: "u1" });
    await budget("b-a", "tenant-a", "tenant", "tenant-a", 1_000_000_000);
    mock.state.setControl({ mode: "500" }); // stop after admission + one failed attempt
    await chat("/v1/chat/completions", token); // warm-up
    mock.state.setControl({ mode: "ok" });
    queries = [];
    const response = await chat("/v1/chat/completions", token);
    expect(response.status).toBe(200);
    const upstreamAt = queries.length; // the whole request
    // Measured on this schema: 9 admission + 2 credential + 8 settlement + 1 lease = 20.
    expect(upstreamAt).toBeLessThanOrEqual(20);
    const admission = queries.slice(0, queries.findIndex((q) => q.includes("gateway_upstream_credential") && q.includes("encrypted_credentials")));
    // Admission: identity+budgets 1, catalog 1, providers 1, price 1, limits 3, floor check 2 (= 9, one spare).
    expect(admission.length).toBeGreaterThan(0);
    expect(admission.length).toBeLessThanOrEqual(10);
    expect(admission.filter((q) => /gateway_virtual_key/.test(q))).toHaveLength(1);
  });

  it("GATEWAY_ROLE defaults to api and rejects unknown roles", () => {
    expect(gatewayRole({})).toBe("api");
    expect(gatewayRole({ GATEWAY_ROLE: "worker" })).toBe("worker");
    expect(() => gatewayRole({ GATEWAY_ROLE: "nope" })).toThrow();
  });
});
