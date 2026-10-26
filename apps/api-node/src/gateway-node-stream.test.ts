/**
 * Node gateway streaming (#368) on PGlite with the real schema, served by the
 * #378 mock upstream (never a real provider): OpenAI + Anthropic SSE
 * pass-through, injected include_usage, keep-alives, and N2 settlement of
 * every stream ending — completed, upstream error mid-stream, caller
 * disconnect, duration timeout — exactly once.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { GatewayError, type GatewayPorts, type UsageEvent } from "@clash/gateway-core";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";
import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { createPgGatewayLimitPort } from "./gateway-limits.ts";
import {
  GATEWAY_NODE_TTFT_OVERHEAD_BUDGET_MS,
  SSE_KEEPALIVE_COMMENT,
  createGatewayBackgroundWork,
  createGatewayNodeRoutes,
  createPgGatewayPorts,
  settleDurably,
  withSseKeepAlive,
  type GatewayBackgroundWork,
  type GatewayNodeRoutesOptions,
} from "./gateway-node.ts";
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
let app: ReturnType<typeof createGatewayNodeRoutes>;
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
  app = createGatewayNodeRoutes(ports, { work, ...options });
}

beforeEach(async () => {
  failNextTransactions = 0;
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
  const ring = createGatewayKeyRing({ keys: { k1: randomBytes(32) }, current: "k1" });
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

describe("gateway-node streaming (#368)", () => {
  it("passes an OpenAI stream through chunk by chunk and charges reported usage once", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ chunks: 4, chunk_ms: 80, usage: { input: 11, output: 7, cached: 0 } });
    const started = performance.now();
    const response = await post("/v1/chat/completions", token, openaiBody());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // Pass-through: the first event arrives before the upstream finished (4 × 80 ms).
    expect(performance.now() - started).toBeLessThan(200);
    expect(first).toContain("data:");
    let text = first;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    expect(text).toContain("data: [DONE]");
    expect(text).toContain(`"model":"${MODEL}"`);
    expect(text).not.toContain("mock-official-model");
    // The caller did not ask for usage: the injected usage chunk is dropped.
    expect(text).not.toContain('"usage"');
    const rows = await charges("tenant-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usage_source: "reported", output_tokens: "7" });
    // 11 in × 1000 + 7 out × 2000 micro-credits.
    expect(Number(rows[0]!.amount)).toBe(11 * 1000 + 7 * 2000);
    expect(await spent("b-a")).toBe(11 * 1000 + 7 * 2000);
  });

  it("keeps the usage chunk for a caller that asked for include_usage", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    const response = await post("/v1/chat/completions", token, openaiBody({ stream_options: { include_usage: true } }));
    expect(await response.text()).toContain('"usage"');
    expect(await charges("tenant-a")).toHaveLength(1);
  });

  it("passes an Anthropic messages stream through and charges message_delta usage once", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ usage: { input: 5, output: 3, cached: 0 } });
    const response = await post(
      "/api/v1/gateway/anthropic/v1/messages",
      token,
      JSON.stringify({ model: CLAUDE, stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("mock-claude");
    const rows = await charges("tenant-a");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount)).toBe(5 * 1000 + 3 * 2000);
  });

  it("charges observed usage once when the upstream fails mid-stream", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ chunks: 5, fail_after_chunks: 2 });
    const response = await post("/v1/chat/completions", token, openaiBody());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("GATEWAY_UPSTREAM_ERROR");
    const rows = await charges("tenant-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usage_source).toBe("estimated");
    expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
    expect(await spent("b-a")).toBe(Number(rows[0]!.amount));
  });

  it("charges observed usage once after the caller disconnects (real HTTP socket)", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ chunks: 50, chunk_ms: 40 });
    const server: Server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: openaiBody({ max_tokens: 400 }),
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.read();
      abort.abort();
      await until(async () => (await charges("tenant-a")).length === 1);
      await work.drain(2000);
      const rows = await charges("tenant-a");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
      // The upstream was aborted, not drained to the end.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await charges("tenant-a")).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("settles a stream whose caller stopped reading when it hits the duration limit", async () => {
    mount({ app: { streamMaxDurationMs: 150 } });
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ chunks: 50, chunk_ms: 50 });
    const response = await post("/v1/chat/completions", token, openaiBody());
    expect(response.status).toBe(200);
    // Never read the body: settlement must not depend on the caller pulling.
    await until(async () => (await charges("tenant-a")).length === 1);
    expect(Number((await charges("tenant-a"))[0]!.amount)).toBeGreaterThan(0);
    await response.body!.cancel();
  });

  it("refuses an unfunded stream with 402 before any upstream call", async () => {
    const token = await virtualKey("tenant-x", "u1");
    const response = await post("/v1/chat/completions", token, openaiBody());
    expect(response.status).toBe(402);
    expect(mock.state.snapshot()).toEqual({});
  });

  it("retries a transiently failed charge and still charges exactly once", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    // Fail the first two charge transactions (after admission, once the upstream is called).
    const upstreamFetch = ports.upstream.fetch;
    ports.upstream.fetch = (request) => {
      failNextTransactions = 2;
      return upstreamFetch(request);
    };
    mount();
    const response = await post("/v1/chat/completions", token, openaiBody());
    const text = await response.text();
    expect(text).not.toContain("x-gateway-settlement");
    expect(failNextTransactions).toBe(0); // both injected failures were hit and retried
    expect(await charges("tenant-a")).toHaveLength(1);
  });

  it("does not retry a coded refusal", async () => {
    let calls = 0;
    await expect(
      settleDurably(async () => {
        calls += 1;
        throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND");
      }, [1, 1, 1]),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toBe(1);
  });

  it("makes a duplicate settle delivery a no-op on the (request_id, kind) ledger key", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    await (await post("/v1/chat/completions", token, openaiBody())).text();
    const [row] = await charges("tenant-a");
    const before = await spent("b-a");
    const event: UsageEvent = {
      requestId: row!.request_id,
      tenantId: "tenant-a",
      userId: "u1",
      modelCode: MODEL,
      kind: "text",
      upstreamId: "openai",
      credentialScope: "official",
      usage: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
      costMicroCredits: 9_999_999,
      priceVersion: "p1",
      catalogVersion: "c1",
      status: "settled",
      occurredAt: Date.now(),
    };
    const results = await Promise.all([ports.budgets.settle(event), ports.budgets.settle(event)]);
    expect(results.every((result) => result.duplicate)).toBe(true);
    expect(await charges("tenant-a")).toHaveLength(1);
    expect(await spent("b-a")).toBe(before);
  });

  it("records the TTFT overhead within budget", async () => {
    const token = await virtualKey("tenant-a", "u1");
    await budget("b-a", "tenant-a", 1_000_000_000);
    mock.state.setControl({ ttfb_ms: 20, chunks: 2 });
    const firstByte = async (fetcher: () => Response | Promise<Response>) => {
      const started = performance.now();
      const response = await fetcher();
      const reader = response.body!.getReader();
      await reader.read();
      const ms = performance.now() - started;
      while (!(await reader.read()).done);
      return ms;
    };
    const direct = () =>
      mock.app.fetch(
        new Request("http://mock.test/openai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${OFFICIAL_KEY}` },
          body: openaiBody({ model: "mock-official-model" }),
        }),
      );
    await firstByte(() => post("/v1/chat/completions", token, openaiBody())); // warm-up
    const overheads: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const upstream = await firstByte(direct);
      const gateway = await firstByte(() => post("/v1/chat/completions", token, openaiBody()));
      overheads.push(gateway - upstream);
    }
    overheads.sort((a, b) => a - b);
    const median = overheads[Math.floor(overheads.length / 2)]!;
    process.stderr.write(`[gateway-node] TTFT overhead median=${median.toFixed(1)}ms samples=${overheads.map((o) => o.toFixed(1)).join(",")} budget=${GATEWAY_NODE_TTFT_OVERHEAD_BUDGET_MS}ms\n`);
    expect(median).toBeLessThan(GATEWAY_NODE_TTFT_OVERHEAD_BUDGET_MS);
  });
});

describe("withSseKeepAlive", () => {
  it("sends keep-alive comments only at event boundaries and passes bytes unchanged", async () => {
    const encoder = new TextEncoder();
    let push!: (text: string | null) => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => (text === null ? controller.close() : controller.enqueue(encoder.encode(text)));
      },
    });
    const wrapped = withSseKeepAlive(new Response(source, { headers: { "content-type": "text/event-stream" } }), {
      keepAliveMs: 30,
    });
    const reader = wrapped.body!.getReader();
    const chunks: string[] = [];
    const pump = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        chunks.push(new TextDecoder().decode(next.value));
      }
    })();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await sleep(80); // idle at a boundary: keep-alive
    push('data: {"a":');
    await sleep(80); // idle inside an event: no keep-alive
    push("1}\n\n");
    await sleep(80);
    push(null);
    await pump;
    const joined = chunks.join("");
    expect(joined.replaceAll(SSE_KEEPALIVE_COMMENT, "")).toBe('data: {"a":1}\n\n');
    const split = joined.indexOf('data: {"a":');
    expect(joined.slice(0, split)).toContain(SSE_KEEPALIVE_COMMENT);
    expect(joined.slice(split, joined.indexOf("1}\n\n"))).toBe('data: {"a":');
    expect(joined.slice(joined.indexOf("1}\n\n"))).toContain(SSE_KEEPALIVE_COMMENT);
  });

  it("leaves non-stream responses untouched", () => {
    const response = Response.json({ ok: true });
    expect(withSseKeepAlive(response, { keepAliveMs: 10 })).toBe(response);
  });
});
