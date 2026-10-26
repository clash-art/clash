/**
 * Gateway lite multi-process harness (#379) on REAL Postgres.
 *
 * Three or more `src/server.ts` gateway processes (the production entry, api
 * role) plus the #378 mock upstream process share one disposable Postgres
 * database. Worker processes drive the store-level races. No load balancer:
 * the harness spreads requests round-robin over the node ports itself.
 *
 * PGlite serializes every transaction, so the row-lock / SKIP LOCKED / unique
 * races below were untested before this harness. Run with
 * `pnpm --filter @clash/api-node test:gateway-lite` (see docs in
 * scripts/test-gateway-lite.ts); the JSON report goes to GATEWAY_LITE_REPORT.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkGatewayInvariants } from "../gateway-budget.ts";
import { createPgGatewayCredentialStore } from "../gateway-credentials.ts";
import { gatewayKeyRingFromEnv } from "../gateway-keyring.ts";
import { migrateDatabase } from "../migrations.ts";
import { openPostgres } from "../postgres.ts";

const ADMIN_URL = process.env.GATEWAY_LITE_DATABASE_URL;
const NODES = Math.max(3, Number(process.env.GATEWAY_LITE_NODES ?? 3));
const MODEL = "gw-lite-chat";
// Pricing below: 1000 µcr per input token, 2000 per output token.
const USAGE = { input: 10, output: 5, cached: 0 };
const COST = USAGE.input * 1000 + USAGE.output * 2000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// Test-only key material, generated per run and never written anywhere.
const RING_ENV = {
  GATEWAY_ENCRYPTION_KEYS: JSON.stringify({
    k1: randomBytes(32).toString("base64"),
    k2: randomBytes(32).toString("base64"),
  }),
  GATEWAY_ENCRYPTION_CURRENT: "k1",
};

type Scenario = {
  name: string;
  ok: boolean;
  ms: number;
  facts: Record<string, unknown>;
};
const report: {
  issue: number;
  startedAt: string;
  postgres: { serverVersion?: string };
  nodes: number;
  scenarios: Scenario[];
  invariants?: unknown;
  ok?: boolean;
} = {
  issue: 379,
  startedAt: new Date().toISOString(),
  postgres: {},
  nodes: NODES,
  scenarios: [],
};

async function scenario(
  name: string,
  body: (facts: Record<string, unknown>) => Promise<void>,
) {
  const facts: Record<string, unknown> = {};
  const started = Date.now();
  try {
    await body(facts);
    report.scenarios.push({ name, ok: true, ms: Date.now() - started, facts });
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error);
    report.scenarios.push({ name, ok: false, ms: Date.now() - started, facts });
    throw error;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw Error(`timed out: ${label}`);
}

/** A minimal env: no inherited secrets, only what the child needs. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    TSX_TSCONFIG_PATH: new URL("../../tsconfig.check.json", import.meta.url)
      .pathname,
    ...extra,
  };
}

interface Proc {
  child: ChildProcess;
  output: () => string;
}
const procs: Proc[] = [];
function spawnTs(file: string, env: Record<string, string>): Proc {
  const child = fork(new URL(file, import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const keep = (d: unknown) => {
    output = (output + String(d)).slice(-20_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const proc = { child, output: () => output };
  procs.push(proc);
  return proc;
}

async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  ms = 10_000,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  await exited;
  clearTimeout(timer);
}

let dbUrl = "";
let admin: Pool;
let dbName = "";
let database: ReturnType<typeof openPostgres>;
let mockPort = 0;
let mock: Proc;
interface Node extends Proc {
  port: number;
  label: string;
}
const nodes: Node[] = [];

async function startNode(label: string): Promise<Node> {
  const port = await freePort();
  const proc = spawnTs("../server.ts", {
    DATABASE_URL: dbUrl,
    CLOUD_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    HOST: "127.0.0.1",
    GATEWAY_ROLE: "api",
    ...RING_ENV,
    GATEWAY_DRAIN_DELAY_MS: "100",
    GATEWAY_DRAIN_GRACE_MS: "800",
    GATEWAY_DRAIN_SETTLE_MS: "5000",
  });
  await until(
    async () => {
      if (proc.child.exitCode !== null)
        throw Error(`${label} exited: ${proc.output()}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
      } catch {
        return false;
      }
    },
    `${label} ready`,
    60_000,
  );
  return { ...proc, port, label };
}

async function control(body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${mockPort}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function sql<Row extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) {
  return (await database.db.query<Row>(text, params)).rows;
}

async function virtualKey(tenantId: string, userId = "u1"): Promise<string> {
  const id = randomBytes(12).toString("hex");
  const token = `sk_gw_${id}.${randomBytes(32).toString("hex")}`;
  await sql(
    `INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix, credential_scope, created_at)
     VALUES ($1,$2,$3,$4,$5,'official',0)`,
    [`gvk_${id}`, tenantId, userId, sha(token), token.slice(0, 12)],
  );
  return token;
}

async function budget(
  id: string,
  tenantId: string,
  limit: number | null,
  extra: {
    period?: string;
    resetAt?: number;
    spent?: number;
    scope?: "tenant" | "user";
    scopeId?: string;
  } = {},
) {
  await sql(
    `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits,
       reserved_micro_credits, status, enforcement, version, period, reset_at, created_at, updated_at)
     VALUES ($1,$2,$7,$8,$3,$4,0,'active','hard',0,$5,$6,0,0)`,
    [
      id,
      tenantId,
      limit,
      extra.spent ?? 0,
      extra.period ?? "none",
      extra.resetAt ?? null,
      extra.scope ?? "tenant",
      extra.scopeId ?? tenantId,
    ],
  );
}

async function setConfig(key: string, value: unknown) {
  await sql(
    `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ($1, $2::jsonb, 1, 0)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = gateway_config.version + 1`,
    [key, JSON.stringify(value)],
  );
}

let rr = 0;
function post(
  token: string,
  body: Record<string, unknown>,
  opts: { node?: Node; signal?: AbortSignal } = {},
) {
  const node = opts.node ?? nodes[rr++ % nodes.length]!;
  return fetch(`http://127.0.0.1:${node.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      ...body,
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

const charges = (tenantId: string) =>
  sql<{
    request_id: string;
    budget_id: string;
    amount: string;
    status: string;
  }>(
    `SELECT request_id, budget_id, amount_micro_credits::text AS amount, status
       FROM gateway_usage_ledger WHERE kind = 'charge' AND tenant_id = $1`,
    [tenantId],
  );
const spentOf = async (id: string) =>
  Number(
    (
      await sql<{ s: string }>(
        `SELECT spent_micro_credits::text AS s FROM gateway_budget WHERE id = $1`,
        [id],
      )
    )[0]!.s,
  );

async function worker(
  role: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
) {
  const proc = spawnTs("./gateway-lite-worker.ts", {
    DATABASE_URL: dbUrl,
    LITE_ROLE: role,
    LITE_INPUT: JSON.stringify(input),
    ...extraEnv,
  });
  const [message] = (await Promise.race([
    once(proc.child, "message"),
    once(proc.child, "exit").then(() => {
      throw Error(`${role} worker exited without a result: ${proc.output()}`);
    }),
  ])) as [{ ok: boolean; result?: unknown; error?: string }];
  if (!message.ok) throw Error(`${role} worker failed: ${message.error}`);
  return message.result as Record<string, unknown>;
}

/** Reads an SSE response until `done` or the stream ends; returns the text. */
async function readSome(response: Response, stopAfterFirst = false) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let error: string | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (stopAfterFirst && text.includes("data:")) return { text, reader };
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { text, reader, error };
}

const describeLite = ADMIN_URL ? describe : describe.skip;
if (!ADMIN_URL)
  console.warn(
    "gateway-lite: GATEWAY_LITE_DATABASE_URL is not set; skipping the multi-process Postgres harness",
  );

describeLite(
  "gateway lite multi-process harness on real Postgres (#379)",
  () => {
    beforeAll(async () => {
      const url = new URL(ADMIN_URL!);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw Error("gateway-lite requires a disposable loopback Postgres");
      admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
      report.postgres.serverVersion = (
        await admin.query<{ v: string }>("SHOW server_version")
      ).rows[0]!.v;
      dbName = `clash_gwlite_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE ${dbName}`);
      url.pathname = `/${dbName}`;
      dbUrl = url.href;
      database = openPostgres({ connectionString: dbUrl, max: 10 });
      await migrateDatabase(database.db);

      mockPort = await freePort();
      mock = spawnTs("../mock-upstream/cli.ts", {
        MOCK_UPSTREAM_PORT: String(mockPort),
      });
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${mockPort}/healthz`)).ok;
        } catch {
          return false;
        }
      }, "mock upstream");

      // Catalog, prices and the sealed (k1) official credential.
      const ring = gatewayKeyRingFromEnv(RING_ENV);
      const store = createPgGatewayCredentialStore({ db: database.db, ring });
      await store.put({
        id: "official-mock",
        scope: "official",
        providerId: "official",
        upstreamId: "openai",
        credentials: {
          apiKey: `sk_test_lite_${randomBytes(6).toString("hex")}`,
          baseUrl: `http://127.0.0.1:${mockPort}/openai/v1`,
        },
      } as never);
      // Extra envelopes so the re-encryption race has rows to fight over.
      for (let i = 0; i < 40; i += 1)
        await store.put({
          id: `rotate-${String(i).padStart(2, "0")}`,
          scope: "tenant",
          tenantId: `t-rot-${i}`,
          providerId: "byok",
          upstreamId: "openai",
          credentials: {
            apiKey: `sk_test_rot_${i}`,
            baseUrl: `http://127.0.0.1:${mockPort}/openai/v1`,
          },
        } as never);
      const cards = buildEffectiveModelCards({
        baseModels: [],
        providers: [
          {
            id: "official-mock",
            providerId: "official",
            upstreamId: "openai",
            apiShape: "openai-compatible",
            configuredCredentials: ["apiKey"],
          },
        ],
        configs: [
          {
            modelId: MODEL,
            custom: true,
            name: "Lite chat",
            kind: "text",
            providerBindings: [
              {
                providerAccountId: "official-mock",
                upstreamModel: "mock-official-model",
              },
            ],
          },
        ],
      } as never);
      const nowS = Math.floor(Date.now() / 1000) - 60;
      for (const card of cards) {
        await sql(
          `INSERT INTO gateway_model (id, catalog_version, model_code, kind, display_name, enabled, card_json, published_at, created_at)
         VALUES ($1, 'c1', $2, 'text', $2, 1, $3::jsonb, $4, $4)`,
          [`c1:${card.id}`, card.id, JSON.stringify(card), nowS],
        );
        for (const [unit, amount] of [
          ["input_token", 1_000_000],
          ["output_token", 2_000_000],
        ] as const)
          await sql(
            `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per,
             currency, effective_from, source, published_at, created_at)
           VALUES ($1,'p1',$2,'',$3,$4,1000,'credit',$5,'test',$5,$5)`,
            [`p1:${card.id}:${unit}`, card.id, unit, amount, nowS],
          );
      }
      await control({
        mode: "ok",
        ttfb_ms: 0,
        chunk_ms: 0,
        chunks: 3,
        usage: USAGE,
      });
      for (let i = 0; i < NODES; i += 1)
        nodes.push(await startNode(`gw${i + 1}`));
    }, 180_000);

    afterAll(async () => {
      try {
        if (database)
          report.invariants = await checkGatewayInvariants(database.db);
      } catch (error) {
        report.invariants = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      report.ok =
        report.scenarios.length > 0 &&
        report.scenarios.every((s) => s.ok) &&
        (report.invariants as { ok?: boolean } | undefined)?.ok === true;
      const path = process.env.GATEWAY_LITE_REPORT;
      if (path) await writeFile(path, JSON.stringify(report, null, 2) + "\n");
      console.log(
        `gateway-lite report: ${JSON.stringify({ ok: report.ok, scenarios: report.scenarios.map((s) => [s.name, s.ok]) })}`,
      );
      await Promise.all(procs.map((p) => stop(p.child, "SIGTERM", 5000)));
      await database?.close();
      if (admin) {
        if (dbName)
          await admin
            .query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
            .catch(() => {});
        await admin.end();
      }
    }, 120_000);

    it("serves the same catalog from every node", async () => {
      await scenario("smoke", async (facts) => {
        const token = await virtualKey("t-smoke");
        await budget("b-smoke", "t-smoke", 1_000_000_000);
        const statuses = await Promise.all(
          nodes.map((node) =>
            post(token, {}, { node }).then(
              async (r) => (await r.text(), r.status),
            ),
          ),
        );
        facts.statuses = statuses;
        expect(statuses.every((s) => s === 200)).toBe(true);
        await until(
          async () => (await charges("t-smoke")).length === NODES,
          "smoke charges",
        );
        expect(await spentOf("b-smoke")).toBe(NODES * COST);
      });
    });

    it("budget overdraft race across nodes stops at the credit floor", async () => {
      await scenario("budget-overdraft-race", async (facts) => {
        const limit = 100_000;
        const floor = 50_000;
        await setConfig("settlement.floor_micro_credits", {
          floor_micro_credits: floor,
        });
        const token = await virtualKey("t-race");
        await budget("b-race", "t-race", limit);
        // Upstream latency keeps every request past admission before any settles.
        await control({ ttfb_ms: 300, usage: USAGE });
        const n = 60;
        const statuses = await Promise.all(
          Array.from({ length: n }, () =>
            post(token, {}).then(async (r) => (await r.text(), r.status)),
          ),
        );
        await control({ ttfb_ms: 0 });
        const ok = statuses.filter((s) => s === 200).length;
        await until(
          async () => (await charges("t-race")).length === ok,
          "race charges",
        );
        const rows = await charges("t-race");
        const spent = await spentOf("b-race");
        const charged = rows.reduce((sum, row) => sum + Number(row.amount), 0);
        const distinct = new Set(
          rows.map((r) => `${r.request_id}:${r.budget_id}`),
        ).size;
        const after = await post(token, {});
        Object.assign(facts, {
          requests: n,
          admitted: ok,
          refused: n - ok,
          chargeRows: rows.length,
          spent,
          charged,
          limit,
          floor,
          maxSpend: limit + floor,
          nextStatus: after.status,
        });
        await after.text();
        expect(distinct).toBe(rows.length);
        expect(spent).toBe(charged);
        expect(spent).toBeLessThanOrEqual(limit + floor);
        // Postpay: every admitted request was in flight, so the floor is reached exactly.
        expect(spent).toBe(limit + floor);
        expect(after.status).toBe(402);
        const inv = await checkGatewayInvariants(database.db, {
          tenantId: "t-race",
        });
        facts.invariants = { ok: inv.ok, violations: inv.violations.length };
        expect(inv.ok).toBe(true);
      });
    });

    it("concurrent settles of the same request ids from 3 processes charge once", async () => {
      await scenario("charge-once-race", async (facts) => {
        await budget("b-once", "t-once", 1_000_000_000);
        await budget("b-once-2", "t-once", 1_000_000_000, {
          scope: "user",
          scopeId: "u1",
        });
        const requestIds = Array.from(
          { length: 40 },
          (_, i) => `gwr_once_${i}`,
        );
        const startAt = Date.now() + 1500;
        const input = {
          tenantId: "t-once",
          userId: "u1",
          budgetIds: ["b-once", "b-once-2"],
          cost: 1000,
          requestIds,
          startAt,
        };
        const results = await Promise.all(
          [0, 1, 2].map(() => worker("charge", input)),
        );
        const flat = results.flatMap(
          (r) =>
            r.results as Array<{
              requestId: string;
              charged?: number;
              duplicate?: boolean;
              error?: string;
            }>,
        );
        const errors = flat.filter((r) => r.error);
        const winners = flat.filter((r) => r.duplicate === false);
        const reqRows = await sql<{ id: string; charged: string }>(
          `SELECT id, charged_micro_credits::text AS charged FROM gateway_request WHERE tenant_id = 't-once'`,
        );
        const wrongRequestRows = reqRows.filter(
          (r) => Number(r.charged) !== 1000,
        ).length;
        Object.assign(facts, {
          processes: 3,
          requestIds: requestIds.length,
          attempts: flat.length,
          errors: errors.length,
          nonDuplicateResults: winners.length,
          ledgerRows: (await charges("t-once")).length,
          spent: [await spentOf("b-once"), await spentOf("b-once-2")],
          gatewayRequestRowsWithWrongCharge: wrongRequestRows,
        });
        expect(errors).toEqual([]);
        expect((await charges("t-once")).length).toBe(requestIds.length * 2);
        expect(await spentOf("b-once")).toBe(requestIds.length * 1000);
        expect(await spentOf("b-once-2")).toBe(requestIds.length * 1000);
        // Exactly one caller per id is told it charged; the others see a duplicate.
        expect(winners.length).toBe(requestIds.length);
        expect(wrongRequestRows).toBe(0);
      });
    });

    it("concurrent media debits and refunds of the same request ids from 3 processes move money once", async () => {
      await scenario("media-debit-refund-race", async (facts) => {
        await budget("b-media", "t-media", 1_000_000_000);
        const requestIds = Array.from(
          { length: 30 },
          (_, i) => `gwr_media_${i}`,
        );
        const input = {
          tenantId: "t-media",
          userId: "u1",
          budgetIds: ["b-media"],
          cost: 5000,
          requestIds,
        };
        type R = { requestId: string; duplicate?: boolean; error?: string };
        const debits = (
          await Promise.all(
            [0, 1, 2].map(() =>
              worker("debit", { ...input, startAt: Date.now() + 1500 }),
            ),
          )
        ).flatMap((r) => r.results as R[]);
        const ledger = async (kind: string) =>
          Number(
            (
              await sql<{ n: string }>(
                `SELECT coalesce(sum(amount_micro_credits), 0)::text AS n FROM gateway_usage_ledger WHERE tenant_id = 't-media' AND kind = $1`,
                [kind],
              )
            )[0]!.n,
          );
        const spentAfterDebit = await spentOf("b-media");
        const debitLedger = await ledger("debit");
        const refunds = (
          await Promise.all(
            [0, 1, 2].map(() =>
              worker("refund", { ...input, startAt: Date.now() + 1500 }),
            ),
          )
        ).flatMap((r) => r.results as R[]);
        const spentAfterRefund = await spentOf("b-media");
        const inv = await checkGatewayInvariants(database.db, {
          tenantId: "t-media",
        });
        Object.assign(facts, {
          processes: 3,
          requestIds: requestIds.length,
          debitErrors: debits.filter((r) => r.error).length,
          debitWinners: debits.filter((r) => r.duplicate === false).length,
          spentAfterDebit,
          debitLedger,
          refundErrors: refunds.filter((r) => r.error).length,
          refundWinners: refunds.filter((r) => r.duplicate === false).length,
          refundLedger: await ledger("refund"),
          spentAfterRefund,
          invariants: {
            ok: inv.ok,
            violations: inv.violations.map((v) => v.rule),
          },
        });
        expect(debits.filter((r) => r.error)).toEqual([]);
        expect(spentAfterDebit).toBe(requestIds.length * 5000);
        expect(debitLedger).toBe(requestIds.length * 5000);
        expect(debits.filter((r) => r.duplicate === false).length).toBe(
          requestIds.length,
        );
        expect(refunds.filter((r) => r.error)).toEqual([]);
        expect(refunds.filter((r) => r.duplicate === false).length).toBe(
          requestIds.length,
        );
        expect(spentAfterRefund).toBe(0);
        expect(inv.ok).toBe(true);
      });
    });

    it("rate limit and concurrency races are exact across nodes", async () => {
      await scenario("rate-limit-race", async (facts) => {
        // Stay clear of a minute boundary (windows are Postgres-clock minutes).
        const sec = Number(
          (
            await sql<{ s: string }>(
              "SELECT extract(second FROM clock_timestamp())::text AS s",
            )
          )[0]!.s,
        );
        if (sec > 50) await delay((61 - sec) * 1000);
        const rpm = 10;
        await setConfig("limits.tenant.t-rpm", { requestsPerMinute: rpm });
        const token = await virtualKey("t-rpm");
        await budget("b-rpm", "t-rpm", 1_000_000_000);
        const statuses = await Promise.all(
          Array.from({ length: 40 }, () =>
            post(token, {}).then(async (r) => (await r.text(), r.status)),
          ),
        );
        const ok = statuses.filter((s) => s === 200).length;
        const limited = statuses.filter((s) => s === 429).length;
        Object.assign(facts, { rpm, requests: 40, ok, limited });
        expect(ok).toBe(rpm);
        expect(limited).toBe(40 - rpm);

        const conc = 3;
        await setConfig("limits.tenant.t-conc", { concurrency: conc });
        const token2 = await virtualKey("t-conc");
        await budget("b-conc", "t-conc", 1_000_000_000);
        await control({ ttfb_ms: 700 });
        const s2 = await Promise.all(
          Array.from({ length: 15 }, () =>
            post(token2, {}).then(async (r) => (await r.text(), r.status)),
          ),
        );
        await control({ ttfb_ms: 0 });
        const ok2 = s2.filter((s) => s === 200).length;
        const leases = Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM gateway_inflight WHERE subject LIKE 'tenant:t-conc%'`,
            )
          )[0]!.n,
        );
        Object.assign(facts, {
          concurrency: conc,
          concurrentRequests: 15,
          concurrentOk: ok2,
          concurrentLimited: s2.filter((s) => s === 429).length,
          leasesLeft: leases,
        });
        expect(ok2).toBe(conc);
        expect(leases).toBe(0);
      });
    });

    it("client abort mid-stream settles once and frees the node", async () => {
      await scenario("client-abort-mid-stream", async (facts) => {
        const token = await virtualKey("t-abort");
        await budget("b-abort", "t-abort", 1_000_000_000);
        await control({ chunks: 40, chunk_ms: 100 });
        const aborts: Array<Promise<void>> = [];
        for (const node of nodes) {
          const controller = new AbortController();
          const response = await post(
            token,
            { stream: true },
            { node, signal: controller.signal },
          );
          expect(response.status).toBe(200);
          aborts.push(
            (async () => {
              await readSome(response, true);
              controller.abort();
            })(),
          );
        }
        await Promise.all(aborts);
        await control({ chunks: 3, chunk_ms: 0 });
        await until(
          async () => (await charges("t-abort")).length === NODES,
          "abort charges",
          10_000,
        );
        await delay(500);
        const rows = await charges("t-abort");
        const metrics = await Promise.all(
          nodes.map(
            async (n) =>
              (
                await (await fetch(`http://127.0.0.1:${n.port}/metrics`)).text()
              ).match(/clash_gateway_open_streams (\d+)/)?.[1],
          ),
        );
        Object.assign(facts, {
          aborted: NODES,
          chargeRows: rows.length,
          statuses: [...new Set(rows.map((r) => r.status))],
          openStreamsAfter: metrics,
        });
        expect(rows.length).toBe(NODES);
        expect(metrics.every((m) => m === "0")).toBe(true);
      });
    });

    it("SIGTERM drains a node mid-stream: terminal event, one charge, peers keep serving", async () => {
      await scenario("sigterm-drain-mid-stream", async (facts) => {
        const token = await virtualKey("t-term");
        await budget("b-term", "t-term", 1_000_000_000);
        await control({ chunks: 60, chunk_ms: 100 });
        const victim = nodes[1]!;
        const response = await post(token, { stream: true }, { node: victim });
        expect(response.status).toBe(200);
        const reading = readSome(response);
        await delay(300);
        const exited = once(victim.child, "exit") as Promise<
          [number | null, string | null]
        >;
        victim.child.kill("SIGTERM");
        const peer = await post(token, {}, { node: nodes[0]! });
        const peerStatus = peer.status;
        await peer.text();
        const { text } = await reading;
        const [code, signal] = await exited;
        await control({ chunks: 3, chunk_ms: 0 });
        await until(
          async () => (await charges("t-term")).length === 2,
          "term charges",
          10_000,
        );
        Object.assign(facts, {
          drainedEvent: text.includes("GATEWAY_DRAINING"),
          exitCode: code,
          signal,
          peerStatus,
          chargeRows: (await charges("t-term")).length,
        });
        expect(text).toContain("GATEWAY_DRAINING");
        expect(code).toBe(0);
        expect(peerStatus).toBe(200);
        nodes[1] = await startNode("gw2b");
      });
    });

    it("SIGKILL mid-stream never leaves a partial charge (accepted loss before settle)", async () => {
      await scenario("sigkill-mid-stream", async (facts) => {
        const token = await virtualKey("t-kill");
        await budget("b-kill", "t-kill", 1_000_000_000);
        await setConfig("limits.tenant.t-kill", { concurrency: 50 });
        await control({ chunks: 60, chunk_ms: 100 });
        const victim = nodes[2]!;
        const streams = await Promise.all(
          [0, 1, 2].map(() => post(token, { stream: true }, { node: victim })),
        );
        const reads = streams.map((r) => readSome(r));
        await delay(400);
        const exited = once(victim.child, "exit");
        victim.child.kill("SIGKILL");
        await exited;
        const outcomes = await Promise.all(reads);
        await control({ chunks: 3, chunk_ms: 0 });
        await delay(1000);
        const rows = await charges("t-kill");
        const leases = Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM gateway_inflight WHERE subject LIKE 'tenant:t-kill%'`,
            )
          )[0]!.n,
        );
        const inv = await checkGatewayInvariants(database.db, {
          tenantId: "t-kill",
        });
        Object.assign(facts, {
          killedStreams: streams.length,
          clientErrors: outcomes.filter(
            (o) => o.error || !o.text.includes("[DONE]"),
          ).length,
          chargeRows: rows.length,
          spent: await spentOf("b-kill"),
          orphanLeases: leases,
          invariants: { ok: inv.ok, violations: inv.violations.length },
          note: "Charges of streams killed before settle are lost (accepted N2 edge wear); orphan concurrency leases expire after the lease TTL / sweep.",
        });
        expect(rows.length).toBe(0);
        expect(await spentOf("b-kill")).toBe(0);
        expect(inv.ok).toBe(true);
        nodes[2] = await startNode("gw3b");
        // The replacement serves the same tenant at once.
        const again = await post(token, {}, { node: nodes[2]! });
        await again.text();
        expect(again.status).toBe(200);
      });
    });

    it("key rotation with concurrent re-encryption workers while all nodes serve", async () => {
      await scenario("key-rotation-across-processes", async (facts) => {
        const token = await virtualKey("t-rot");
        await budget("b-rot", "t-rot", 1_000_000_000);
        const statuses: number[] = [];
        let running = true;
        const traffic = (async () => {
          while (running) {
            const batch = await Promise.all(
              nodes.map((node) =>
                post(token, {}, { node }).then(
                  async (r) => (await r.text(), r.status),
                ),
              ),
            );
            statuses.push(...batch);
          }
        })();
        await delay(300);
        // What POST /admin/gateway/encryption/rotate does, then two re-encrypt workers race.
        await setConfig("encryption.current", { kid: "k2" });
        const startAt = Date.now() + 1500;
        const results = await Promise.all(
          [0, 1, 2].map(() =>
            worker("reencrypt", { limit: 5, startAt }, RING_ENV),
          ),
        );
        await delay(300);
        running = false;
        await traffic;
        const kids = await sql<{ kid: string; n: string }>(
          `SELECT split_part(encrypted_credentials, '.', 2) AS kid, count(*)::text AS n FROM gateway_upstream_credential GROUP BY 1`,
        );
        const total = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM gateway_upstream_credential`,
        );
        const resealed = results.reduce((s, r) => s + Number(r.resealed), 0);
        const failed = results.reduce((s, r) => s + Number(r.failed), 0);
        const skipped = results.reduce((s, r) => s + Number(r.skipped ?? 0), 0);
        Object.assign(facts, {
          requests: statuses.length,
          non200: statuses.filter((s) => s !== 200).length,
          kids,
          credentials: Number(total[0]!.n),
          resealed,
          failed,
          skipped,
          workers: results.length,
        });
        expect(statuses.every((s) => s === 200)).toBe(true);
        expect(kids).toEqual([{ kid: "k2", n: total[0]!.n }]);
        // Nodes also re-seal lazily on read, so workers re-seal at most every row.
        expect(resealed).toBeGreaterThan(0);
        expect(resealed).toBeLessThanOrEqual(Number(total[0]!.n));
        // A lost compare-and-swap is another worker's success, not a failure.
        expect(failed).toBe(0);
      });
    });

    it("budget rollover with concurrent workers (FOR UPDATE SKIP LOCKED) rolls each row once", async () => {
      await scenario("rollover-skip-locked", async (facts) => {
        const n = 300;
        const nowS = Math.floor(Date.now() / 1000);
        for (let i = 0; i < n; i += 1)
          await budget(
            `b-roll-${String(i).padStart(3, "0")}`,
            `t-roll-${i}`,
            1_000_000,
            {
              period: "daily",
              resetAt: nowS - 3600,
              spent: 1000 + i,
            },
          );
        // Seed the matching ledger so the spend reconciles before the rollover.
        await sql(
          `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
           amount_micro_credits, occurred_at, created_at)
         SELECT 'seed:' || id, 'seed:' || id, id, 'charge', 'settled', tenant_id, 'u1', '', spent_micro_credits, 0, 0
           FROM gateway_budget WHERE id LIKE 'b-roll-%'`,
        );
        const startAt = Date.now() + 1500;
        const results = await Promise.all(
          [0, 1, 2, 3].map(() =>
            worker("rollover", { limit: 20, nowS, startAt }),
          ),
        );
        const rolled = results.map((r) => Number(r.rolled));
        const adjusts = await sql<{ budget_id: string; n: string }>(
          `SELECT budget_id, count(*)::text AS n FROM gateway_usage_ledger
          WHERE kind = 'adjust' AND ref_kind = 'period_rollover' AND budget_id LIKE 'b-roll-%' GROUP BY 1`,
        );
        const left = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM gateway_budget WHERE id LIKE 'b-roll-%' AND (spent_micro_credits <> 0 OR reset_at <= $1)`,
          [nowS],
        );
        const inv = await checkGatewayInvariants(database.db);
        Object.assign(facts, {
          budgets: n,
          workers: results.length,
          rolledPerWorker: rolled,
          totalRolled: rolled.reduce((a, b) => a + b, 0),
          adjustRows: adjusts.length,
          duplicateAdjusts: adjusts.filter((a) => a.n !== "1").length,
          notRolled: Number(left[0]!.n),
          invariants: { ok: inv.ok, violations: inv.violations.length },
        });
        expect(rolled.reduce((a, b) => a + b, 0)).toBe(n);
        expect(rolled.filter((r) => r > 0).length).toBeGreaterThan(1);
        expect(adjusts.length).toBe(n);
        expect(adjusts.every((a) => a.n === "1")).toBe(true);
        expect(Number(left[0]!.n)).toBe(0);
        expect(inv.ok).toBe(true);
      });
    });
  },
);
