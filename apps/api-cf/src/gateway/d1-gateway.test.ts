/**
 * Gateway data plane (#347) over the real D1 ports on node:sqlite with the
 * web/drizzle migrations: the shared gateway-core contract, the Worker mount
 * at /gateway/v1/*, and the official credential custody rules. The upstream
 * is always a fetch stub; no provider is called.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeGatewayContract } from "@clash/gateway-core/contract";
import { listDeclaredModelUpstreamRoutes } from "@clash/shared-types";

import { createApp } from "../app";
import type { Env } from "../config";
import { runCloudDurableWorkflow } from "../cloud-runs/cloud-durable-workflow";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { GATEWAY_SETTLE_OWNER } from "../cloud-runs/owners";
import { recoverCloudDurableRuns } from "../generation/recovery";
import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import {
  createD1GatewayCredentialPort,
  gatewayEncryptionKey,
  readSecretBinding,
  sealGatewayUpstreamCredentials,
} from "./d1-credentials";
import { createD1GatewaySettlementPort, createGatewaySettleCoordinator } from "./settle-runs";
import {
  GATEWAY_CIRCUIT_DEFAULTS,
  gatewayRetentionKeys,
  gatewaySettleRunIdentity,
  type GatewayLogFields,
  type GatewaySettlementIntent,
} from "@clash/gateway-core";
import { encryptProviderCredentials } from "@clash/shared-runtime/provider-credentials";
import { workerSecrets } from "./index";
import {
  createMemoryBucket,
  d1ContractHarness,
  gatewayRequest,
  officialChatCard,
  officialMessagesCard,
  seedGateway,
  type SeededGateway,
} from "./test-support";

const { d1, sqlite } = createSqliteD1();
const bucket = createMemoryBucket();
const seeded: Promise<SeededGateway> = seedGateway(d1, { bucket });

describeGatewayContract("Workers/D1 ports on node:sqlite", async () => d1ContractHarness(await seeded));

const ORIGIN = "http://localhost:8789";
const app = createApp();

const completion = (model: string) => ({
  id: "chatcmpl-unit",
  object: "chat.completion",
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

describe("/gateway/v1 through the Worker app", () => {
  let gateway: SeededGateway;
  let upstream: Request[];
  beforeAll(async () => {
    gateway = await seeded;
  });
  afterEach(() => vi.restoreAllMocks());

  function stubUpstream(answer: (body: Record<string, unknown>) => Response) {
    upstream = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      upstream.push(request);
      return answer((await request.clone().json()) as Record<string, unknown>);
    });
  }

  /** The Worker env: settle runs go through the real journal on the inline Durable Run Workflow. */
  const workerEnv = (overrides: Record<string, unknown> = {}) =>
    ({
      DB: d1,
      ENVIRONMENT: "test",
      GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
      GENERATION_WORKFLOW: gateway.workflow,
      ...overrides,
    }) as never;

  const send = (token: string | undefined, body: Record<string, unknown>, headers: Record<string, string> = {}, env = workerEnv()) =>
    app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );

  const chat =(model = gateway.textModel, extra: Record<string, unknown> = {}) => ({
    model,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    ...extra,
  });
  const code = (res: Response) => res.headers.get("x-clash-error-code");

  it("serves the catalog's official route and ignores a spoofed x-user-id", async () => {
    const alice = await gateway.tenantToken();
    const bob = await gateway.tenantToken();
    stubUpstream((body) => Response.json(completion(String(body.model))));
    const res = await send(alice.token, chat(), { "x-user-id": bob.userId });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe(gateway.textModel);

    const route = listDeclaredModelUpstreamRoutes([officialChatCard()]).find(
      (candidate) => candidate.apiShape === "openai-compatible" && candidate.providerId === "official",
    )!;
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${gateway.upstreamApiKey}`);
    expect(upstream[0]!.headers.get("x-user-id")).toBeNull();
    expect(((await upstream[0]!.json()) as { model: string }).model).toBe(route.upstreamModel);

    const requestId = res.headers.get("x-clash-request-id");
    const rows = sqlite
      .prepare(`SELECT user_id, tenant_id, status, account_id FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`)
      .all(requestId) as Array<{ user_id: string; tenant_id: string; status: string; account_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row).toEqual({
        user_id: alice.userId,
        tenant_id: alice.tenantId,
        status: "settled",
        account_id: gateway.upstreamAccountId,
      });
  });

  it("streams through the Worker mount byte for byte, settles it, and retains the delivered bytes", async () => {
    const caller = await gateway.tenantToken();
    const events = (model: string) =>
      [
        { choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }], model },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], model },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, model },
        "[DONE]",
      ]
        .map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
        .join("");
    // The upstream names its own model; the caller must only ever see the public code.
    const vendorModel = "vendor-internal-model-name";
    stubUpstream(() => new Response(events(vendorModel), { headers: { "content-type": "text/event-stream" } }));
    const res = await app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
        body: JSON.stringify(chat(gateway.textModel, { stream: true, stream_options: { include_usage: true } })),
      },
      workerEnv({ GATEWAY_STAFF_PROMPT_ACCESS: "enabled", R2_BUCKET: bucket }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const delivered = await res.text();
    expect(delivered).toBe(events(gateway.textModel));
    expect(delivered).not.toContain(vendorModel);
    expect(((await upstream[0]!.json()) as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
    const requestId = res.headers.get("x-clash-request-id")!;
    const settled = sqlite
      .prepare(`SELECT status, input_tokens, output_tokens, usage_source FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`)
      .all(requestId);
    expect(settled.length).toBeGreaterThan(0);
    for (const row of settled) expect(row).toEqual({ status: "settled", input_tokens: 4, output_tokens: 2, usage_source: "reported" });
    const stored = bucket.objects.get(gatewayRetentionKeys(requestId).response);
    expect(stored && new TextDecoder().decode(stored.body)).toBe(delivered);
    expect(sqlite.prepare(`SELECT status, response_truncated FROM gateway_request_retention WHERE request_id = ?`).get(requestId)).toEqual({
      status: "stored",
      response_truncated: 0,
    });
  });

  it("answers coded 401/403/404/402/502 without calling or leaking the upstream", async () => {
    const allowed = await gateway.tenantToken({ modelAllowlist: ["some-other-model"] });
    const readOnly = await gateway.tenantToken({ scopes: ["usage:read"] });
    const unbudgeted = await gateway.tenantToken({ budgets: false });
    const caller = await gateway.tenantToken();
    stubUpstream(() => Response.json({}));

    const anonymous = await send(undefined, chat(), { "x-user-id": caller.userId });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
    const notAllowed = await send(allowed.token, chat());
    expect([notAllowed.status, code(notAllowed)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
    const noScope = await send(readOnly.token, chat());
    expect([noScope.status, code(noScope)]).toEqual([403, "GATEWAY_FORBIDDEN"]);
    const unknown = await send(caller.token, chat("no-such-gateway-model"));
    expect([unknown.status, code(unknown)]).toEqual([404, "GATEWAY_MODEL_NOT_FOUND"]);
    const noBudget = await send(unbudgeted.token, chat(gateway.textModel, { stream: true }));
    expect([noBudget.status, code(noBudget)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
    // No budget row at all: the 402 names no budget and no reset.
    expect(((await noBudget.json()) as { error: Record<string, unknown> }).error).toMatchObject({ budget_id: null, reset_at: null });
    expect(upstream).toHaveLength(0);

    stubUpstream(() => Response.json({ error: { message: `bad key ${gateway.upstreamApiKey}` } }, { status: 500 }));
    const failed = await send(caller.token, chat());
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(text).not.toContain(gateway.upstreamApiKey);
    expect(text).not.toContain(caller.token);
    // A failed text request owed nothing: no money row and no settle run.
    const failedId = failed.headers.get("x-clash-request-id")!;
    expect(ledgerRows(failedId)).toEqual([]);
    expect(settleRuns(failedId)).toEqual([]);
  });

  it("retries a refused rotated key with the draining version before the first byte (#350)", async () => {
    const caller = await gateway.tenantToken();
    const rotatedKey = `sk-rotated-${crypto.randomUUID()}`;
    const original = sqlite
      .prepare(`SELECT encrypted_credentials, key_version FROM gateway_upstream_account WHERE id = ?`)
      .get(gateway.upstreamAccountId) as { encrypted_credentials: string; key_version: string };
    // A rotation in progress: v2 active, the seeded key draining as v1.
    sqlite
      .prepare(
        `UPDATE gateway_upstream_account
            SET draining_key_version = key_version, draining_encrypted_credentials = encrypted_credentials,
                key_version = 'v2', encrypted_credentials = ?
          WHERE id = ?`,
      )
      .run(await sealGatewayUpstreamCredentials({ apiKey: rotatedKey }, gateway.encryptionKey), gateway.upstreamAccountId);
    try {
      stubUpstream((body) =>
        upstream.at(-1)!.headers.get("authorization") === `Bearer ${rotatedKey}`
          ? Response.json({ error: { message: "invalid key" } }, { status: 401 })
          : Response.json(completion(String(body.model))),
      );
      const res = await send(caller.token, chat());
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(upstream.map((request) => request.headers.get("authorization"))).toEqual([
        `Bearer ${rotatedKey}`,
        `Bearer ${gateway.upstreamApiKey}`,
      ]);
      const rows = sqlite
        .prepare(`SELECT * FROM gateway_usage_ledger WHERE request_id = ?`)
        .all(res.headers.get("x-clash-request-id")) as Array<{ kind: string; status: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.kind === "settle").map((row) => row.status)).toContain("settled");
      for (const surface of [text, JSON.stringify(rows)])
        for (const key of [rotatedKey, gateway.upstreamApiKey]) expect(surface).not.toContain(key);
    } finally {
      sqlite
        .prepare(
          `UPDATE gateway_upstream_account
              SET key_version = ?, encrypted_credentials = ?, draining_key_version = NULL, draining_encrypted_credentials = NULL
            WHERE id = ?`,
        )
        .run(original.key_version, original.encrypted_credentials, gateway.upstreamAccountId);
    }
  });

  it("opens the account's circuit in D1 after consecutive 5xx and answers GATEWAY_NO_ROUTE without contact (#350)", async () => {
    const caller = await gateway.tenantToken();
    const health = () =>
      sqlite
        .prepare(`SELECT consecutive_failures, open_until_ms FROM gateway_upstream_health WHERE account_id = ?`)
        .get(gateway.upstreamAccountId) as { consecutive_failures: number; open_until_ms: number | null } | undefined;
    try {
      stubUpstream(() => Response.json({ error: { message: "overloaded" } }, { status: 503 }));
      for (let i = 0; i < GATEWAY_CIRCUIT_DEFAULTS.failureThreshold; i += 1)
        expect((await send(caller.token, chat())).status).toBeGreaterThanOrEqual(500);
      expect(upstream).toHaveLength(GATEWAY_CIRCUIT_DEFAULTS.failureThreshold);
      expect(health()).toMatchObject({ consecutive_failures: GATEWAY_CIRCUIT_DEFAULTS.failureThreshold });
      expect(health()?.open_until_ms).toBeGreaterThan(Date.now());

      stubUpstream(() => Response.json(completion("unused")));
      const open = await send(caller.token, chat());
      expect([open.status, code(open)]).toEqual([503, "GATEWAY_NO_ROUTE"]);
      expect(Number(open.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(upstream).toHaveLength(0);
    } finally {
      sqlite.prepare(`DELETE FROM gateway_upstream_health WHERE account_id = ?`).run(gateway.upstreamAccountId);
    }
  });

  const ledgerRows = (requestId: string) =>
    sqlite
      .prepare(`SELECT budget_id, kind, status, amount_micro_credits AS amount FROM gateway_usage_ledger WHERE request_id = ? ORDER BY budget_id, kind`)
      .all(requestId) as Array<{ budget_id: string; kind: string; status: string; amount: number }>;
  const settleRuns = (requestId: string) =>
    sqlite
      .prepare(`SELECT owner_id, output_slot, phase, recover_at FROM cloud_durable_run_journal WHERE action_run_id = ?`)
      .all(`gateway-settle:${requestId}`) as Array<{ owner_id: string; output_slot: string; phase: string; recover_at: number | null }>;
  const spent = (tenantId: string) =>
    sqlite
      .prepare(`SELECT id, spent_micro_credits AS spent, reserved_micro_credits AS reserved FROM gateway_budget WHERE tenant_id = ? ORDER BY id`)
      .all(tenantId) as Array<{ id: string; spent: number; reserved: number }>;

  it("admits text without a money write and charges it through one gateway-settle run", async () => {
    const caller = await gateway.tenantToken();
    const before = spent(caller.tenantId);
    stubUpstream((body) => Response.json(completion(String(body.model))));
    const res = await send(caller.token, chat());
    expect(res.status, await res.clone().text()).toBe(200);
    const requestId = res.headers.get("x-clash-request-id")!;
    expect(res.headers.get("x-gateway-settlement")).toBeNull();
    expect(settleRuns(requestId)).toEqual([{ owner_id: GATEWAY_SETTLE_OWNER, output_slot: "charge", phase: "succeeded", recover_at: null }]);
    const rows = ledgerRows(requestId);
    expect(rows.map((row) => row.kind)).toEqual(before.map(() => "settle"));
    expect(new Set(rows.map((row) => row.amount)).size).toBe(1);
    for (const [index, budget] of spent(caller.tenantId).entries())
      expect(budget).toEqual({ ...before[index]!, spent: before[index]!.spent + rows[0]!.amount });
  });

  it("answers a charge that cannot be journaled with the coded settlement header and writes nothing: the accepted edge", async () => {
    const caller = await gateway.tenantToken();
    const before = spent(caller.tenantId);
    stubUpstream((body) => Response.json(completion(String(body.model))));
    // The node:sqlite shim exposes each statement's SQL; fail only the journal write.
    const failingJournal = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "prepare")
          return (sql: string) =>
            sql.includes("INTO cloud_durable_run_journal")
              ? { bind: () => ({ run: () => Promise.reject(new Error("D1_ERROR: forced journal failure")) }) }
              : target.prepare(sql);
        return Reflect.get(target, property, receiver);
      },
    });
    const res = await send(caller.token, chat(), {}, workerEnv({ DB: failingJournal }));
    expect(res.status, await res.clone().text()).toBe(200);
    const requestId = res.headers.get("x-clash-request-id")!;
    expect(res.headers.get("x-gateway-settlement")).toBe(`failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=${requestId}`);
    expect(settleRuns(requestId)).toEqual([]);
    expect(ledgerRows(requestId)).toEqual([]);
    expect(spent(caller.tenantId)).toEqual(before);
  });

  it("charges once, through the scheduled cron, a journaled charge whose Workflow start was lost", async () => {
    const caller = await gateway.tenantToken();
    const before = spent(caller.tenantId);
    stubUpstream((body) => Response.json(completion(String(body.model))));
    gateway.workflow.pause(true);
    let requestId: string;
    try {
      const res = await send(caller.token, chat());
      expect(res.status, await res.clone().text()).toBe(200);
      // Journaled, so the answer is a normal one.
      expect(res.headers.get("x-gateway-settlement")).toBeNull();
      requestId = res.headers.get("x-clash-request-id")!;
      expect(settleRuns(requestId)).toEqual([
        { owner_id: GATEWAY_SETTLE_OWNER, output_slot: "charge", phase: "queued", recover_at: expect.any(Number) },
      ]);
      expect(ledgerRows(requestId)).toEqual([]);
      expect(spent(caller.tenantId)).toEqual(before);
    } finally {
      gateway.workflow.pause(false);
    }
    const env = { DB: d1, GENERATION_WORKFLOW: gateway.workflow } as unknown as Env;
    await recoverCloudDurableRuns(env, gateway.clock.now() + 60_000);
    expect(settleRuns(requestId)).toMatchObject([{ phase: "succeeded", recover_at: null }]);
    const charged = spent(caller.tenantId);
    const amount = ledgerRows(requestId)[0]!.amount;
    expect(charged.map((budget) => budget.spent)).toEqual(before.map((budget) => budget.spent + amount));
    // Another tick finds nothing due for it.
    await recoverCloudDurableRuns(env, gateway.clock.now() + 120_000);
    expect(spent(caller.tenantId)).toEqual(charged);
  });

  describe("body retention (GATEWAY_STAFF_PROMPT_ACCESS)", () => {
    const retainingEnv = (overrides: Record<string, unknown> = {}) =>
      workerEnv({ GATEWAY_STAFF_PROMPT_ACCESS: "enabled", R2_BUCKET: bucket, ...overrides });
    const post = (token: string, body: Record<string, unknown>, env: never, headers: Record<string, string> = {}) =>
      app.request(
        "/gateway/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}`, ...headers },
          body: JSON.stringify(body),
        },
        env,
      );
    const row = (requestId: string) =>
      sqlite.prepare(`SELECT * FROM gateway_request_retention WHERE request_id = ?`).get(requestId) as
        | Record<string, unknown>
        | undefined;
    const object = (key: string) => {
      const stored = bucket.objects.get(key);
      return stored ? new TextDecoder().decode(stored.body) : undefined;
    };

    it("stores the normalized request and the exact answer in R2 with a 30-day metadata row, never a credential", async () => {
      const caller = await gateway.tenantToken();
      stubUpstream((body) => Response.json(completion(String(body.model))));
      const res = await post(caller.token, chat(), retainingEnv(), { "x-api-key": caller.token });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-gateway-retention")).toBeNull();
      const answered = await res.text();
      const requestId = res.headers.get("x-clash-request-id")!;
      const keys = gatewayRetentionKeys(requestId);
      expect(object(keys.response)).toBe(answered);
      expect(JSON.parse(object(keys.request)!)).toEqual(chat());
      const meta = row(requestId)!;
      expect(meta).toMatchObject({ tenant_id: caller.tenantId, user_id: caller.userId, status: "stored", response_status: 200 });
      expect(Number(meta.expires_at) - Number(meta.stored_at)).toBe(30 * 24 * 60 * 60);
      for (const text of [object(keys.request)!, object(keys.response)!, JSON.stringify(meta)]) {
        expect(text).not.toContain(caller.token);
        expect(text).not.toContain(gateway.upstreamApiKey);
      }

      // An upstream error stores the coded answer the caller got, not the upstream body.
      stubUpstream(() => Response.json({ error: { message: `bad key ${gateway.upstreamApiKey}` } }, { status: 500 }));
      const failed = await post(caller.token, chat(), retainingEnv());
      expect(failed.status).toBe(502);
      const failedId = failed.headers.get("x-clash-request-id")!;
      expect(object(gatewayRetentionKeys(failedId).response)).toBe(await failed.text());
      expect(object(gatewayRetentionKeys(failedId).response)).not.toContain(gateway.upstreamApiKey);
      expect(row(failedId)).toMatchObject({ status: "stored", response_status: 502 });
    });

    it("stores nothing when the flag is off (the self-host default)", async () => {
      const caller = await gateway.tenantToken();
      stubUpstream((body) => Response.json(completion(String(body.model))));
      const res = await post(caller.token, chat(), retainingEnv({ GATEWAY_STAFF_PROMPT_ACCESS: undefined }));
      expect(res.status).toBe(200);
      const requestId = res.headers.get("x-clash-request-id")!;
      expect(row(requestId)).toBeUndefined();
      expect(object(gatewayRetentionKeys(requestId).response)).toBeUndefined();
    });

    it("codes an R2 failure on the answer, records it, and bills exactly as a stored request", async () => {
      const stored = await gateway.tenantToken();
      const failing = await gateway.tenantToken();
      stubUpstream((body) => Response.json(completion(String(body.model))));
      const brokenBucket = { ...bucket, put: () => Promise.reject(new Error("R2 down")) };
      const ok = await post(stored.token, chat(), retainingEnv());
      const res = await post(failing.token, chat(), retainingEnv({ R2_BUCKET: brokenBucket }));
      expect(res.status).toBe(200);
      const requestId = res.headers.get("x-clash-request-id")!;
      expect(res.headers.get("x-gateway-retention")).toBe(`failed; code=GATEWAY_RETENTION_FAILED; request_id=${requestId}`);
      expect(res.headers.get("x-gateway-settlement")).toBeNull();
      expect(row(requestId)).toMatchObject({ status: "failed", error_code: "GATEWAY_INTERNAL" });
      const settled = (id: string) =>
        sqlite
          .prepare(`SELECT status, amount_micro_credits AS amount FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle' ORDER BY budget_id`)
          .all(id) as Array<{ status: string; amount: number }>;
      expect(settled(requestId).length).toBeGreaterThan(0);
      expect(settled(requestId)).toEqual(settled(ok.headers.get("x-clash-request-id")!));
    });
  });

  it("migration 0042 closes the retired path's open and settle_failed holds at zero and keeps their keys claimed", async () => {
    const caller = await gateway.tenantToken();
    const ports = gateway.ports();
    const identity = await ports.identity.authenticate(gatewayRequest(caller.token));
    const before = spent(identity.tenantId);
    const nowS = Math.floor(gateway.clock.now() / 1000);
    const open = `gwr_hold_${crypto.randomUUID()}`;
    const failed = `gwr_hold_${crypto.randomUUID()}`;
    const key = `idem-${crypto.randomUUID()}`;
    // What the retired reserve path left behind: hold rows and their reserved credits.
    for (const [requestId, status] of [[open, "open"], [failed, "settle_failed"]] as const)
      for (const budgetId of identity.budgetIds) {
        sqlite
          .prepare(
            `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, ref_kind, ref_id, expires_at, occurred_at)
             VALUES (?, ?, ?, 'hold', ?, ?, 7, ?, ?, ?, ?)`,
          )
          .run(`${requestId}:hold:${budgetId}`, requestId, budgetId, status, identity.tenantId, requestId === open ? "idempotency" : null, requestId === open ? key : null, nowS + 600, nowS);
        sqlite.prepare(`UPDATE gateway_budget SET reserved_micro_credits = reserved_micro_credits + 7 WHERE id = ?`).run(budgetId);
      }
    const migration = readFileSync(fileURLToPath(new URL("../../../web/drizzle/0042_gateway_settlement.sql", import.meta.url).href), "utf8");
    sqlite.exec(migration);

    expect(spent(identity.tenantId)).toEqual(before);
    for (const requestId of [open, failed])
      expect(ledgerRows(requestId)).toEqual(
        [...identity.budgetIds].sort().flatMap((budgetId) => [
          { budget_id: budgetId, kind: "hold", status: "expired", amount: 7 },
          { budget_id: budgetId, kind: "settle", status: "expired", amount: 0 },
        ]),
      );
    // The key its hold claimed never runs again.
    await expect(
      ports.budgets.check({ requestId: ports.ids.requestId(), tenantId: identity.tenantId, budgetIds: identity.budgetIds, credentialScope: "official", floorMicroCredits: 1_000_000, idempotency: { key, expiresAt: gateway.clock.now() + 60_000 } }),
    ).rejects.toMatchObject({ code: "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED" });
    // Re-applied, it changes nothing.
    sqlite.exec(migration);
    expect(spent(identity.tenantId)).toEqual(before);
  });

  it("exempts only unbudgeted tenant-scope (BYOK) requests from the no-budget refusal (#369)", async () => {
    const caller = await gateway.tenantToken();
    const ports = gateway.ports();
    const identity = await ports.identity.authenticate(gatewayRequest(caller.token));
    const input = (requestId: string, credentialScope: "official" | "tenant", budgetIds: readonly string[] = []) => ({
      requestId,
      tenantId: identity.tenantId,
      budgetIds,
      credentialScope,
      floorMicroCredits: 0,
    });
    const event = (requestId: string, credentialScope: "official" | "tenant") => ({
      requestId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      modelCode: "m",
      kind: "text" as const,
      upstreamId: "u",
      credentialScope,
      usage: { source: "reported" as const, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, units: {} },
      costMicroCredits: 5,
      priceVersion: "p",
      catalogVersion: "c",
      status: "settled" as const,
      occurredAt: gateway.clock.now(),
    });
    // An unbudgeted BYOK request is admitted with no money write (and owes no settle run).
    await expect(ports.budgets.check(input(`gwr_byok_${crypto.randomUUID()}`, "tenant"))).resolves.toEqual({});
    await expect(ports.budgets.check(input(`gwr_off_${crypto.randomUUID()}`, "official"))).rejects.toMatchObject({
      code: "GATEWAY_BUDGET_EXCEEDED",
    });
    // A charge never invents a free budget.
    await expect(
      ports.budgets.charge({ ...event(`gwr_off_${crypto.randomUUID()}`, "official"), budgetIds: [] }),
    ).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED" });
    // A BYOK request with budget rows is still checked against, and charged on, them.
    const byok = `gwr_byokb_${crypto.randomUUID()}`;
    await ports.budgets.check(input(byok, "tenant", identity.budgetIds));
    await ports.budgets.charge({ ...event(byok, "tenant"), budgetIds: identity.budgetIds });
    expect(identity.budgetIds.length).toBeGreaterThan(0);
    expect(ledgerRows(byok).filter((row) => row.kind === "settle")).toHaveLength(identity.budgetIds.length);
  });

  it("serves /gateway/anthropic/v1 messages and count_tokens through the Worker mount on the official Anthropic account", async () => {
    const caller = await gateway.tenantToken();
    const route = listDeclaredModelUpstreamRoutes([officialMessagesCard()]).find(
      (candidate) => candidate.apiShape === "anthropic-compatible" && candidate.providerId === "official",
    )!;
    stubUpstream((body) =>
      new URL(upstream.at(-1)!.url).pathname.endsWith("/count_tokens")
        ? Response.json({ input_tokens: 11 })
        : Response.json({
            id: "msg_unit",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
    );
    // Claude Code's own request shape: the agent's model id, `?beta=true`, and the token as Bearer.
    const send = (path: string, body: Record<string, unknown>) =>
      app.request(
        `/gateway/anthropic/v1/${path}?beta=true`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            authorization: `Bearer ${caller.token}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        workerEnv(),
      );
    const turn ={ model: route.upstreamModel, messages: [{ role: "user", content: "hello" }] };

    const res = await send("messages", { ...turn, max_tokens: 16 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe(gateway.messagesModel);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBeNull();
    expect(upstream[0]!.headers.get("x-api-key")).toMatch(/\S/);
    expect(upstream[0]!.headers.get("x-api-key")).not.toBe(caller.token);
    const rows = sqlite
      .prepare(`SELECT user_id, model_code, status, account_id FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`)
      .all(res.headers.get("x-clash-request-id")) as Array<Record<string, string>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row).toEqual({
        user_id: caller.userId,
        model_code: gateway.messagesModel,
        status: "settled",
        account_id: gateway.messagesAccountId,
      });

    const counted = await send("messages/count_tokens", turn);
    expect(counted.status, await counted.clone().text()).toBe(200);
    expect(await counted.json()).toEqual({ input_tokens: 11 });
    expect(new URL(upstream[1]!.url).pathname.endsWith("/messages/count_tokens")).toBe(true);
  });

  it("keeps /gateway/me working beside the data plane", async () => {
    const caller = await gateway.tenantToken();
    const res = await app.request(
      "/gateway/me",
      { headers: { authorization: `Bearer ${caller.token}` } },
      { DB: d1, ENVIRONMENT: "test" } as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: caller.userId, tenantId: caller.tenantId });
  });
});

describe("gateway-settle runs on the Durable Run journal (#399, N2)", () => {
  let gateway: SeededGateway;
  beforeAll(async () => {
    gateway = await seeded;
  });

  function harness() {
    let t = gateway.clock.now();
    const clock = { now: () => t };
    const logs: Array<{ event: string; fields?: GatewayLogFields }> = [];
    const logger = {
      info: (event: string, fields?: GatewayLogFields) => logs.push({ event, fields }),
      warn: (event: string, fields?: GatewayLogFields) => logs.push({ event, fields }),
      error: (event: string, fields?: GatewayLogFields) => logs.push({ event, fields }),
    };
    // Journal only: these tests drive the run themselves.
    const settlement = createD1GatewaySettlementPort({ db: d1, clock, logger });
    const drive = (db: typeof d1, intent: GatewaySettlementIntent) =>
      runCloudDurableWorkflow({
        coordinator: createGatewaySettleCoordinator({ db, clock, logger }),
        identity: gatewaySettleRunIdentity(intent),
        // Sleeps move the clock to the wake time, so a retry is due at once.
        step: { do: (_name, _config, callback) => callback(), sleepUntil: async (_name, at) => void (t = Math.max(t, at)) },
        now: clock.now,
        maxSteps: 64,
      });
    return { clock, logs, settlement, drive };
  }

  async function chargeIntent(amount: number): Promise<{ intent: GatewaySettlementIntent; tenantId: string; budgetIds: readonly string[] }> {
    const caller = await gateway.tenantToken();
    const ports = gateway.ports();
    const identity = await ports.identity.authenticate(gatewayRequest(caller.token));
    return {
      tenantId: identity.tenantId,
      budgetIds: identity.budgetIds,
      intent: {
        kind: "charge",
        budgetIds: [...identity.budgetIds],
        event: {
          requestId: ports.ids.requestId(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          modelCode: gateway.textModel,
          kind: "text",
          upstreamId: "openai",
          credentialScope: "official",
          usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
          costMicroCredits: amount,
          priceVersion: "settle-run-test",
          catalogVersion: "settle-run-test",
          status: "settled",
          occurredAt: gateway.clock.now(),
        },
      },
    };
  }

  const spentOf = (tenantId: string) =>
    (sqlite.prepare(`SELECT spent_micro_credits AS spent FROM gateway_budget WHERE tenant_id = ? ORDER BY id`).all(tenantId) as Array<{ spent: number }>).map(
      (row) => row.spent,
    );

  it("retries a storage failure of the ledger write and charges once", async () => {
    const { settlement, drive } = harness();
    const { intent, tenantId } = await chargeIntent(9);
    const before = spentOf(tenantId);
    expect(await settlement.dispatch(intent)).toMatchObject({ kind: "charge", scheduled: false });
    let failures = 2;
    const flaky = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "batch")
          return (statements: Array<{ sql: string }>) =>
            failures > 0 && statements.some((statement) => statement.sql.includes("':settle:'"))
              ? (failures--, Promise.reject(new Error("D1_ERROR: transient")))
              : target.batch(statements as never);
        return Reflect.get(target, property, receiver);
      },
    });
    const run = await drive(flaky, intent);
    expect(failures).toBe(0);
    expect(run.phase).toBe("succeeded");
    expect(spentOf(tenantId)).toEqual(before.map((value) => value + 9));
    // A duplicate Workflow delivery of the finished run moves nothing.
    await drive(d1, intent);
    expect(spentOf(tenantId)).toEqual(before.map((value) => value + 9));
  });

  it("fails a coded refusal at once, logged, and recovery never re-dispatches it", async () => {
    const { clock, logs, settlement, drive } = harness();
    const requestId = `gwr_never_debited_${crypto.randomUUID()}`;
    const intent: GatewaySettlementIntent = {
      kind: "refund",
      requestId,
      tenantId: "tenant-without-debit",
      status: "upstream_failed",
      errorCode: "GATEWAY_UPSTREAM_ERROR",
      occurredAt: clock.now(),
    };
    await settlement.dispatch(intent);
    const run = await drive(d1, intent);
    expect(run.phase).toBe("failed");
    expect(logs.find((entry) => entry.event === "gateway.settle_run_failed")?.fields).toMatchObject({
      actionRunId: `gateway-settle:${requestId}`,
      kind: "refund",
      code: "GATEWAY_INTERNAL",
      retryable: false,
    });
    const due = await createD1CloudDurableRunJournal(d1).listRecoverable(GATEWAY_SETTLE_OWNER, clock.now() + 60_000);
    expect(due.some((entry) => entry.actionRunId === `gateway-settle:${requestId}`)).toBe(false);
  });
});

describe("official upstream credential custody", () => {
  const route = (accountId: string) =>
    ({ modelCode: "m", kind: "text", providerId: "official", accountId, upstreamId: "openai", upstreamModel: "m", apiShape: "openai-compatible", priority: 1 }) as const;

  async function account(id: string, columns: { secret_ref?: string; encrypted_credentials?: string }) {
    await d1
      .prepare(
        `INSERT INTO gateway_upstream_account (id, provider_id, upstream_id, secret_ref, encrypted_credentials)
         VALUES (?, 'official', 'openai', ?, ?)`,
      )
      .bind(id, columns.secret_ref ?? null, columns.encrypted_credentials ?? null)
      .run();
  }

  const secrets = {
    encryptionKey: "unit-kek",
    secret: (name: string) =>
      ({ GATEWAY_UPSTREAM_UNIT: '{"apiKey":"sk-unit-ref","baseUrl":"https://upstream.test/v1"}', BETTER_AUTH_SECRET: "auth-secret" })[name],
  };
  const port = createD1GatewayCredentialPort(d1, secrets);

  it("resolves a GATEWAY_UPSTREAM_* secret reference, never another Worker secret", async () => {
    await account("gwu_unit_ref", { secret_ref: "GATEWAY_UPSTREAM_UNIT" });
    await expect(port.resolve({ route: route("gwu_unit_ref"), scope: "official", tenantId: "t" })).resolves.toMatchObject({
      apiKey: "sk-unit-ref",
      baseUrl: "https://upstream.test/v1",
      keyId: "gwu_unit_ref",
    });
    await account("gwu_unit_auth", { secret_ref: "BETTER_AUTH_SECRET" });
    await expect(port.resolve({ route: route("gwu_unit_auth"), scope: "official", tenantId: "t" })).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
      details: { reason: "secret_ref_not_allowed" },
    });
  });

  it("fails closed on a foreign envelope, the tenant scope and a mismatched route", async () => {
    await account("gwu_unit_foreign", {
      encrypted_credentials: await sealGatewayUpstreamCredentials({ apiKey: "sk-foreign" }, "another-kek"),
    });
    const foreign = port.resolve({ route: route("gwu_unit_foreign"), scope: "official", tenantId: "t" });
    await expect(foreign).rejects.toMatchObject({ code: "GATEWAY_KEY_UNAVAILABLE", details: { reason: "decrypt_failed" } });
    await expect(foreign.catch((error: Error) => error.message)).resolves.not.toContain("sk-foreign");
    await expect(port.resolve({ route: route("gwu_unit_ref"), scope: "tenant", tenantId: "t" })).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
    });
    await expect(
      port.resolve({ route: { ...route("gwu_unit_ref"), upstreamId: "anthropic" }, scope: "official", tenantId: "t" }),
    ).rejects.toMatchObject({ code: "GATEWAY_KEY_UNAVAILABLE", details: { reason: "route_mismatch" } });
  });

  async function rotatingAccount(id: string, active: string, draining: string) {
    await d1
      .prepare(
        `INSERT INTO gateway_upstream_account
           (id, provider_id, upstream_id, key_version, key_serial, encrypted_credentials, draining_key_version, draining_encrypted_credentials)
         VALUES (?, 'official', 'openai', 'v3', 3, ?, 'v2', ?)`,
      )
      .bind(id, active, draining)
      .run();
  }

  it("resolves the active version first, the draining one only when the active one was refused, then none", async () => {
    const id = `gwu_unit_rotating_${crypto.randomUUID()}`;
    await rotatingAccount(
      id,
      await sealGatewayUpstreamCredentials({ apiKey: "sk-unit-active" }, secrets.encryptionKey),
      await sealGatewayUpstreamCredentials({ apiKey: "sk-unit-draining" }, secrets.encryptionKey),
    );
    const resolve = (excludeKeyVersions?: string[]) =>
      port.resolve({ route: route(id), scope: "official", tenantId: "t", ...(excludeKeyVersions ? { excludeKeyVersions } : {}) });
    await expect(resolve()).resolves.toMatchObject({ apiKey: "sk-unit-active", keyVersion: "v3", keyId: id });
    await expect(resolve(["v3"])).resolves.toMatchObject({ apiKey: "sk-unit-draining", keyVersion: "v2" });
    await expect(resolve(["v3", "v2"])).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
      details: { reason: "no_key_version" },
    });
  });

  it("fails closed when the active version cannot be decrypted, never falling back to the draining one", async () => {
    const id = `gwu_unit_broken_${crypto.randomUUID()}`;
    await rotatingAccount(
      id,
      await sealGatewayUpstreamCredentials({ apiKey: "sk-unit-foreign" }, "another-kek"),
      await sealGatewayUpstreamCredentials({ apiKey: "sk-unit-draining" }, secrets.encryptionKey),
    );
    const resolved = port.resolve({ route: route(id), scope: "official", tenantId: "t" });
    await expect(resolved).rejects.toMatchObject({ code: "GATEWAY_KEY_UNAVAILABLE", details: { reason: "decrypt_failed" } });
    const error = await resolved.catch((caught: Error) => JSON.stringify({ ...caught, message: caught.message }));
    for (const key of ["sk-unit-foreign", "sk-unit-draining"]) expect(error).not.toContain(key);
  });

  it("reads Cloudflare Secrets Store bindings and Worker secrets by name; a store failure fails closed", async () => {
    await account("gwu_unit_store", { secret_ref: "GATEWAY_UPSTREAM_STORE" });
    await account("gwu_unit_store_down", { secret_ref: "GATEWAY_UPSTREAM_STORE_DOWN" });
    await account("gwu_unit_worker", { secret_ref: "GATEWAY_UPSTREAM_WORKER" });
    const env = {
      GATEWAY_UPSTREAM_STORE: { get: async () => "sk-unit-store" },
      GATEWAY_UPSTREAM_STORE_DOWN: { get: () => Promise.reject(new Error("store unavailable")) },
      GATEWAY_UPSTREAM_WORKER: "sk-unit-worker",
    };
    const fromEnv = createD1GatewayCredentialPort(d1, workerSecrets(env as never));
    const resolve = (id: string) => fromEnv.resolve({ route: route(id), scope: "official", tenantId: "t" });
    await expect(resolve("gwu_unit_store")).resolves.toMatchObject({ apiKey: "sk-unit-store" });
    await expect(resolve("gwu_unit_worker")).resolves.toMatchObject({ apiKey: "sk-unit-worker" });
    await expect(resolve("gwu_unit_store_down")).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
      details: { reason: "secret_store_failed" },
    });
    expect(readSecretBinding(env, "GATEWAY_UPSTREAM_MISSING")).toBeUndefined();
  });

  it("keeps the official KEK distinct from the tenant BYOK key and envelope", async () => {
    const shared = `shared-kek-${crypto.randomUUID()}`;
    // One value configured for both vaults: the official vault has no KEK, so sealed keys fail closed.
    expect(gatewayEncryptionKey({ GATEWAY_ENCRYPTION_KEY: shared, ACTION_SECRET_KEY: shared })).toEqual({
      encryptionKeyProblem: "shared_with_byok",
    });
    expect(gatewayEncryptionKey({ GATEWAY_ENCRYPTION_KEY: shared, ACTION_SECRET_KEY: "other" })).toEqual({ encryptionKey: shared });
    const id = `gwu_unit_shared_${crypto.randomUUID()}`;
    await account(id, { encrypted_credentials: await sealGatewayUpstreamCredentials({ apiKey: "sk-unit-shared" }, shared) });
    const sharedPort = createD1GatewayCredentialPort(
      d1,
      workerSecrets({ GATEWAY_ENCRYPTION_KEY: shared, ACTION_SECRET_KEY: shared } as never),
    );
    await expect(sharedPort.resolve({ route: route(id), scope: "official", tenantId: "t" })).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
      details: { reason: "encryption_key_shared_with_byok" },
    });
    // A tenant BYOK envelope copied into the official vault never opens, even under the same key string.
    const byok = `gwu_unit_byok_${crypto.randomUUID()}`;
    await account(byok, { encrypted_credentials: await encryptProviderCredentials({ apiKey: "sk-unit-byok" }, secrets.encryptionKey) });
    await expect(port.resolve({ route: route(byok), scope: "official", tenantId: "t" })).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
      details: { reason: "decrypt_failed" },
    });
  });
});
