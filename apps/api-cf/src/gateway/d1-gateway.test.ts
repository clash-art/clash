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
import { createD1GatewayBudgetPorts } from "./d1-budgets";
import { createD1GatewayCredentialPort, sealGatewayUpstreamCredentials } from "./d1-credentials";
import { d1ContractHarness, officialChatCard, seedGateway, type SeededGateway } from "./test-support";

const { d1, sqlite } = createSqliteD1();
const seeded: Promise<SeededGateway> = seedGateway(d1);

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

  it("answers coded 401/403/404/402/501/502 without calling or leaking the upstream", async () => {
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
    const noBudget = await send(unbudgeted.token, chat());
    expect([noBudget.status, code(noBudget)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
    const streaming = await send(caller.token, chat(gateway.textModel, { stream: true }));
    expect([streaming.status, code(streaming)]).toEqual([501, "GATEWAY_CAPABILITY_UNAVAILABLE"]);
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
