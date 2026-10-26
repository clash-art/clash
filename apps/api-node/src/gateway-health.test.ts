/**
 * Node gateway health/readiness/metrics and SIGTERM drain (#375) on PGlite with
 * the real schema and the #378 mock upstream (never a real provider).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import type { GatewayPorts } from "@clash/gateway-core";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";
import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { createPgGatewayLimitPort } from "./gateway-limits.ts";
import {
  createGatewayBackgroundWork,
  createGatewayNodeRoutes,
  createPgGatewayPorts,
  type GatewayBackgroundWork,
  type GatewayNodeRoutesOptions,
} from "./gateway-node.ts";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_DRAINING_CODE,
  createGatewayDrainController,
  createGatewayHealthRoutes,
  runGatewayDrain,
  type GatewayDrainController,
} from "./gateway-health.ts";
import { migrateDatabase } from "./migrations.ts";
import { createMockUpstreamApp, type MockUpstreamApp } from "./mock-upstream/index.ts";

const MODEL = "gw-node-chat";
const CLAUDE = "gw-node-claude";
const OFFICIAL_KEY = `sk_test_official_${randomBytes(6).toString("hex")}`;
const ANTHROPIC_KEY = `sk_test_anthropic_${randomBytes(6).toString("hex")}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let pglite: PGlite;
let db: GatewayBudgetDatabase;
let mock: MockUpstreamApp;
let ports: GatewayPorts;
let work: GatewayBackgroundWork;
let app: Hono;
let drain: GatewayDrainController;
let ring: ReturnType<typeof createGatewayKeyRing>;
let failNextTransactions = 0;
let credentials: ReturnType<typeof createPgGatewayCredentialStore>;

function adapt(p: PGlite): GatewayBudgetDatabase {
  const wrap = (q: { query: PGlite["query"] }): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return {
    ...wrap(p),
    transaction: async (fn) => {
      if (failNextTransactions > 0) {
        failNextTransactions -= 1;
        throw new Error("connection terminated unexpectedly");
      }
      return p.transaction(async (tx) => fn(wrap(tx as never)));
    },
  };
}

async function virtualKey(tenantId: string, userId: string): Promise<string> {
  const id = randomBytes(12).toString("hex");
  const token = `sk_gw_${id}.${randomBytes(32).toString("hex")}`;
  await pglite.query(
    `INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix, credential_scope, created_at)
     VALUES ($1,$2,$3,$4,$5,'official',0)`,
    [`gvk_${id}`, tenantId, userId, sha(token), token.slice(0, 12)],
  );
  return token;
}

async function budget(id: string, tenantId: string, limit: number | null, spent = 0) {
  await pglite.query(
    `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
       reserved_micro_credits, status, enforcement, version, period, created_at, updated_at)
     VALUES ($1,$2,'tenant',$2,$3,$4,0,'active','hard',0,'none',0,0)`,
    [id, tenantId, limit, spent],
  );
}

function mount(options: GatewayNodeRoutesOptions = {}) {
  work = createGatewayBackgroundWork();
  drain = createGatewayDrainController();
  app = new Hono();
  app.route("/", createGatewayHealthRoutes({ db, drain, work, ring }));
  app.route("/", createGatewayNodeRoutes(ports, { work, drain, ...options }));
}

beforeEach(async () => {
  failNextTransactions = 0;
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
  ring = createGatewayKeyRing({ keys: { k1: randomBytes(32) }, current: "k1" });
  credentials = createPgGatewayCredentialStore({ db, ring });
  await credentials.put({
    id: "official-mock",
    scope: "official",
    providerId: "official",
    upstreamId: "openai",
    credentials: { apiKey: OFFICIAL_KEY, baseUrl: "http://mock.test/openai/v1" },
  } as never);
  await credentials.put({
    id: "official-anthropic-mock",
    scope: "official",
    providerId: "official",
    upstreamId: "anthropic",
    credentials: { apiKey: ANTHROPIC_KEY, baseUrl: "http://mock.test/anthropic/v1" },
  } as never);
  const cards = buildEffectiveModelCards({
    baseModels: [],
    providers: [
      { id: "official-mock", providerId: "official", upstreamId: "openai", apiShape: "openai-compatible", configuredCredentials: ["apiKey"] },
      { id: "official-anthropic-mock", providerId: "official", upstreamId: "anthropic", apiShape: "anthropic-compatible", configuredCredentials: ["apiKey"] },
    ],
    configs: [
      { modelId: MODEL, custom: true, name: "Node chat", kind: "text", providerBindings: [{ providerAccountId: "official-mock", upstreamModel: "mock-official-model" }] },
      { modelId: CLAUDE, custom: true, name: "Node claude", kind: "text", providerBindings: [{ providerAccountId: "official-anthropic-mock", upstreamModel: "mock-claude" }] },
    ],
  });
  const nowS = Math.floor(Date.now() / 1000) - 60;
  for (const card of cards) {
    await pglite.query(
      `INSERT INTO gateway_model (id, catalog_version, model_code, kind, display_name, enabled, card_json, published_at, created_at)
       VALUES ($1, 'c1', $2, 'text', $2, 1, $3::jsonb, $4, $4)`,
      [`c1:${card.id}`, card.id, JSON.stringify(card), nowS],
    );
    for (const [unit, amount] of [["input_token", 1_000_000], ["output_token", 2_000_000]] as const)
      await pglite.query(
        `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per,
           currency, effective_from, source, published_at, created_at)
         VALUES ($1,'p1',$2,'',$3,$4,1000,'credit',$5,'test',$5,$5)`,
        [`p1:${card.id}:${unit}`, card.id, unit, amount, nowS],
      );
  }
  mock = createMockUpstreamApp();
  ports = createPgGatewayPorts({
    db,
    credentials,
    limits: createPgGatewayLimitPort(db),
    upstream: { fetch: (request) => Promise.resolve(mock.app.fetch(request)) },
    settleRetryDelaysMs: [1, 1, 1],
  });
  mount();
});

afterEach(async () => {
  await work.drain(5000);
  await pglite.close();
});

const openaiBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...extra });

const post = (path: string, token: string, body: string, signal?: AbortSignal) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-api-key": token },
    body,
    ...(signal ? { signal } : {}),
  });

async function charges(tenantId: string) {
  const { rows } = await pglite.query<{ request_id: string; status: string; amount: string; output_tokens: string; usage_source: string }>(
    `SELECT request_id, status, amount_micro_credits::text AS amount, output_tokens::text, usage_source
       FROM gateway_usage_ledger WHERE kind='charge' AND tenant_id=$1 ORDER BY occurred_at`,
    [tenantId],
  );
  return rows;
}
const spent = async (id: string) =>
  Number((await pglite.query<{ s: string }>(`SELECT spent_micro_credits::text AS s FROM gateway_budget WHERE id=$1`, [id])).rows[0]!.s);

async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
}

describe("gateway-node health (#375)", () => {
  it("serves healthz and a readyz that checks db, schema, encryption key and draining", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ok",
      checks: { db: "ok", schema: "ok", encryption: "ok", draining: "ok" },
    });
    drain.beginDraining();
    const draining = await app.request("/readyz");
    expect(draining.status).toBe(503);
    expect((await draining.json()).checks.draining).toBe("failed");
  });

  it("fails readyz on a pending migration, a missing current key or an unwritable blob dir", async () => {
    await pglite.query("DELETE FROM cloud_schema_migration WHERE id = '0019_gateway_credential_priority.sql'");
    const noKey = createGatewayKeyRing({ keys: { k2: randomBytes(32) }, current: "k2" });
    await pglite.query(
      `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ('encryption.current', '{"kid":"k9"}'::jsonb, 1, 0)`,
    );
    const dir = await mkdtemp(join(tmpdir(), "gw-ready-"));
    await rm(dir, { recursive: true });
    const health = createGatewayHealthRoutes({ db, drain, work, ring: noKey, blobDirectories: [dir] });
    const response = await health.request("/readyz");
    expect(response.status).toBe(503);
    expect((await response.json()).checks).toEqual({
      db: "ok",
      schema: "failed",
      encryption: "failed",
      blob: "failed",
      draining: "ok",
    });
  });

  it("exposes low-cardinality metrics with no tenant, user or key labels", async () => {
    const token = await virtualKey("tenant-m", "user-m");
    await budget("b-m", "tenant-m", 1_000_000_000);
    expect((await (await post("/v1/chat/completions", token, openaiBody())).text())).toContain("[DONE]");
    const response = await app.request("/metrics");
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("clash_gateway_open_streams 0");
    expect(text).toContain("clash_gateway_draining 0");
    expect(text).toContain("clash_gateway_pending_settlements");
    expect(text).not.toMatch(/\{|tenant|user|key_id|request_id/);
  });

  it("refuses new gateway requests once the node stopped accepting", async () => {
    const token = await virtualKey("tenant-a", "u1");
    drain.stopAccepting();
    const response = await post("/v1/chat/completions", token, openaiBody());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-clash-error-code")).toBe(GATEWAY_DRAINING_CODE);
    expect(mock.state.snapshot()).toEqual({});
  });
});

describe("gateway-node SIGTERM drain (#375)", () => {
  it("drains 100 open streams: each gets GATEWAY_DRAINING and is charged exactly once", async () => {
    const STREAMS = 100;
    const token = await virtualKey("tenant-d", "u1");
    await budget("b-d", "tenant-d", 1_000_000_000_000);
    // Long streams: they would run ~60 s without the drain.
    mock.state.setControl({ chunks: 1200, chunk_ms: 50 });
    const server: Server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const responses = await Promise.all(
      Array.from({ length: STREAMS }, () =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: openaiBody({ max_tokens: 4000 }),
        }),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const bodies = responses.map(readAll);
    await until(async () => drain.openStreams === STREAMS);
    const steps: string[] = [];
    let chargesAtPoolClose = -1;
    let readyDuringDelay = 0;
    const drained = runGatewayDrain({
      drain,
      work,
      server,
      timings: { delayMs: 150, graceMs: 200, settleMs: 20_000 },
      closeDatabase: async () => {
        chargesAtPoolClose = (await charges("tenant-d")).length;
      },
      onStep: (step) => steps.push(step),
    });
    readyDuringDelay = (await app.request("/readyz")).status;
    // Nothing is cut during the delay or the grace: no charge before the terminal event.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await charges("tenant-d")).toHaveLength(0);
    const { terminated } = await drained;
    expect(readyDuringDelay).toBe(503);
    expect(terminated).toBe(STREAMS);
    expect(steps).toEqual(["draining", "stopped_accepting", "grace_ended", "settled", "closed"]);
    const texts = await Promise.all(bodies);
    for (const text of texts) {
      expect(text).toContain("data: ");
      expect(text.trimEnd().endsWith("}")).toBe(true);
      expect(text).toContain(`"code":"${GATEWAY_DRAINING_CODE}"`);
      expect(text).not.toContain("[DONE]");
    }
    const ids = texts.map((text) => /"request_id":"([^"]+)"/.exec(text.slice(text.lastIndexOf("event: gateway_error")))?.[1]);
    // Every stream settled before the pool closed, once per request.
    expect(chargesAtPoolClose).toBe(STREAMS);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rows = await charges("tenant-d");
    expect(rows).toHaveLength(STREAMS);
    expect(new Set(rows.map((row) => row.request_id))).toEqual(new Set(ids));
    for (const row of rows) expect(Number(row.amount)).toBeGreaterThan(0);
    expect(drain.openStreams).toBe(0);
    expect(work.pending).toBe(0);
  }, 60_000);

  it("lets a stream that ends within the grace finish normally", async () => {
    const token = await virtualKey("tenant-g", "u1");
    await budget("b-g", "tenant-g", 1_000_000_000);
    mock.state.setControl({ chunks: 4, chunk_ms: 60 });
    const server: Server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: openaiBody(),
    });
    const body = readAll(response);
    const { terminated } = await runGatewayDrain({
      drain,
      work,
      server,
      timings: { delayMs: 10, graceMs: 5_000, settleMs: 5_000 },
      closeDatabase: async () => {},
    });
    expect(terminated).toBe(0);
    const text = await body;
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain(GATEWAY_DRAINING_CODE);
    expect(await charges("tenant-g")).toHaveLength(1);
  });
});
