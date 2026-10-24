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

import { describeGatewayContract } from "@clash/gateway-core/contract";
import { listDeclaredModelUpstreamRoutes } from "@clash/shared-types";

import { createApp } from "../app";
import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { createD1GatewayBudgetPorts, sweepGatewayHolds } from "./d1-budgets";
import { createD1GatewayCredentialPort, sealGatewayUpstreamCredentials } from "./d1-credentials";
import { gatewayRetentionKeys } from "@clash/gateway-core";
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

  const send = (token: string | undefined, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
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
      { DB: d1, ENVIRONMENT: "test", GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as never,
    );

  const chat = (model = gateway.textModel, extra: Record<string, unknown> = {}) => ({
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
      { DB: d1, ENVIRONMENT: "test", GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey, GATEWAY_STAFF_PROMPT_ACCESS: "enabled", R2_BUCKET: bucket } as never,
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
  });

  it("marks the holds settle_failed, not open, when the settle batch fails; reconciliation charges once", async () => {
    const caller = await gateway.tenantToken();
    stubUpstream((body) => Response.json(completion(String(body.model))));
    // The node:sqlite shim exposes each statement's SQL; fail only the settle batch.
    const failingSettle = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "batch")
          return (statements: Array<{ sql: string }>) =>
            statements.some((statement) => statement.sql.includes("':settle:'"))
              ? Promise.reject(new Error("D1_ERROR: forced settle failure"))
              : target.batch(statements as never);
        return Reflect.get(target, property, receiver);
      },
    });
    const res = await app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
        body: JSON.stringify(chat()),
      },
      { DB: failingSettle, ENVIRONMENT: "test", GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as never,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const requestId = res.headers.get("x-clash-request-id")!;
    expect(res.headers.get("x-gateway-settlement")).toBe(
      `failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=${requestId}`,
    );

    const ledgerRows = () =>
      sqlite
        .prepare(`SELECT budget_id, kind, status, error_code FROM gateway_usage_ledger WHERE request_id = ? ORDER BY budget_id, kind`)
        .all(requestId) as Array<{ budget_id: string; kind: string; status: string; error_code: string | null }>;
    const budgetRows = () =>
      sqlite
        .prepare(`SELECT id, spent_micro_credits AS spent, reserved_micro_credits AS reserved FROM gateway_budget WHERE tenant_id = ? ORDER BY id`)
        .all(caller.tenantId) as Array<{ id: string; spent: number; reserved: number }>;
    const holds = ledgerRows();
    expect(holds.length).toBeGreaterThan(0);
    for (const row of holds)
      expect(row).toMatchObject({ kind: "hold", status: "settle_failed", error_code: "GATEWAY_INTERNAL" });
    const held = budgetRows();
    for (const budget of held) expect([budget.spent, budget.reserved > 0]).toEqual([0, true]);

    // Reconciliation (and any retry of it) settles the marked holds exactly once.
    const { budgets } = createD1GatewayBudgetPorts(d1, { clock: { now: () => Date.now() } });
    const event = {
      requestId,
      tenantId: caller.tenantId,
      userId: caller.userId,
      modelCode: gateway.textModel,
      kind: "text" as const,
      upstreamId: "openai",
      credentialScope: "official" as const,
      usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" as const },
      costMicroCredits: 7,
      priceVersion: "reconcile",
      catalogVersion: "reconcile",
      status: "settled" as const,
      occurredAt: Date.now(),
    };
    expect(await budgets.settle(event)).toMatchObject({ duplicate: false, costMicroCredits: 7 });
    expect(await budgets.settle({ ...event, costMicroCredits: 99 })).toMatchObject({ duplicate: true, costMicroCredits: 7 });
    expect(await budgets.markSettleFailed({ requestId, tenantId: caller.tenantId, errorCode: "GATEWAY_INTERNAL" })).toEqual({
      status: "settled",
    });
    for (const budget of budgetRows()) expect([budget.spent, budget.reserved]).toEqual([7, 0]);
    expect(ledgerRows().filter((row) => row.kind === "hold").map((row) => row.status)).toEqual(
      holds.map(() => "settled"),
    );
  });

  describe("body retention (GATEWAY_STAFF_PROMPT_ACCESS)", () => {
    const retainingEnv = (overrides: Record<string, unknown> = {}) =>
      ({
        DB: d1,
        ENVIRONMENT: "test",
        GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
        GATEWAY_STAFF_PROMPT_ACCESS: "enabled",
        R2_BUCKET: bucket,
        ...overrides,
      }) as never;
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

  it("sweeps stale holds through the scheduled entry point, idempotently, and leaves settle_failed holds reserved", async () => {
    const caller = await gateway.tenantToken();
    const ports = gateway.ports();
    const identity = await ports.identity.authenticate(gatewayRequest(caller.token));
    const now = gateway.clock.now();
    const reserve = (requestId: string) =>
      ports.budgets.reserve({ requestId, tenantId: identity.tenantId, budgetIds: identity.budgetIds, holdMicroCredits: 7, expiresAt: now - 5_000 });
    const stale = `gwr_sweep_${crypto.randomUUID()}`;
    const failed = `gwr_sweep_${crypto.randomUUID()}`;
    await reserve(stale);
    await reserve(failed);
    await ports.budgets.markSettleFailed({ requestId: failed, tenantId: identity.tenantId, errorCode: "GATEWAY_INTERNAL" });
    const rows = (requestId: string) =>
      sqlite
        .prepare(`SELECT kind, status, amount_micro_credits AS amount FROM gateway_usage_ledger WHERE request_id = ? ORDER BY kind, budget_id`)
        .all(requestId) as Array<{ kind: string; status: string; amount: number }>;
    const reserved = () =>
      (sqlite.prepare(`SELECT SUM(reserved_micro_credits) AS reserved FROM gateway_budget WHERE tenant_id = ?`).get(identity.tenantId) as {
        reserved: number;
      }).reserved;
    const heldBoth = reserved();

    const first = await sweepGatewayHolds({ DB: d1 }, { clock: gateway.clock, logger: { info() {}, warn() {}, error() {} } });
    expect(first.expired).toBeGreaterThan(0);
    const closed = rows(stale);
    expect(closed.filter((row) => row.kind === "hold").map((row) => row.status)).toEqual(identity.budgetIds.map(() => "expired"));
    expect(closed.filter((row) => row.kind === "settle")).toEqual(identity.budgetIds.map(() => ({ kind: "settle", status: "expired", amount: 0 })));
    expect(rows(failed).map((row) => row.status)).toEqual(identity.budgetIds.map(() => "settle_failed"));
    expect(heldBoth - reserved()).toBe(7 * identity.budgetIds.length);

    // Again: nothing left for these requests, nothing changes.
    await sweepGatewayHolds({ DB: d1 }, { clock: gateway.clock, logger: { info() {}, warn() {}, error() {} } });
    expect(rows(stale)).toEqual(closed);
    expect(reserved()).toBe(heldBoth - 7 * identity.budgetIds.length);
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
        { DB: d1, ENVIRONMENT: "test", GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as never,
      );
    const turn = { model: route.upstreamModel, messages: [{ role: "user", content: "hello" }] };

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
});
