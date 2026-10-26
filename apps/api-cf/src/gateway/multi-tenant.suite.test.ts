/**
 * #360 multi-tenant suite over real D1 ports on node:sqlite (REPORT §13).
 * Complements packages/gateway-core/src/multi-tenant.suite.test.ts with
 * durable races, wallet suspend (abuse), tenant isolation at HTTP, and the
 * hosted vs self-host staff prompt-access policy (decision 10).
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

import { createApp } from "../app";
import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { signedInAdmin } from "../services/admin-session.test-support";
import { seedGateway, type SeededGateway } from "./test-support";

const { d1, sqlite } = createSqliteD1();
const seeded: Promise<SeededGateway> = seedGateway(d1);
const ORIGIN = "http://localhost:8789";
const app = createApp();

const completion = (model: string) => ({
  id: "chatcmpl-mt",
  object: "chat.completion",
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

describe("#360 multi-tenant suite (api-cf / D1 node:sqlite)", () => {
  let gateway: SeededGateway;
  let upstream: Request[];

  beforeAll(async () => {
    gateway = await seeded;
  });
  afterEach(() => vi.restoreAllMocks());

  function stubUpstream(answer: (body: Record<string, unknown>) => Response = (body) => Response.json(completion(String(body.model)))) {
    upstream = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions")) throw new Error(`Unexpected external request: ${request.url}`);
      upstream.push(request);
      return answer((await request.clone().json()) as Record<string, unknown>);
    });
  }

  const env = () =>
    ({
      DB: d1,
      ENVIRONMENT: "test",
      GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: "test-secret-for-gateway-mt-360-0123456789",
    }) as never;

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
      env(),
    );

  const chat = (extra: Record<string, unknown> = {}) => ({
    model: gateway.textModel,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    ...extra,
  });
  const code = (res: Response) => res.headers.get("x-clash-error-code");

  describe("1. tenant isolation", () => {
    it("bills only the caller tenant and never returns the other tenant's ledger row", async () => {
      stubUpstream();
      const alice = await gateway.tenantToken();
      const bob = await gateway.tenantToken();
      const res = await send(alice.token, chat(), { "x-user-id": bob.userId });
      expect(res.status, await res.clone().text()).toBe(200);
      const requestId = res.headers.get("x-clash-request-id")!;
      const aliceRows = await d1
        .prepare(`SELECT DISTINCT tenant_id, user_id FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`)
        .bind(requestId)
        .all<{ tenant_id: string; user_id: string }>();
      expect(aliceRows.results).toEqual([{ tenant_id: alice.tenantId, user_id: alice.userId }]);
      const bobPeek = await gateway.ports().ledger.get({ tenantId: bob.tenantId, requestId });
      expect(bobPeek).toBeNull();
      expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${gateway.upstreamApiKey}`);
      expect(upstream[0]!.headers.get("x-user-id")).toBeNull();
    });
  });

  describe("2. key custody", () => {
    it("forwards only the sealed official upstream key, never a caller-supplied secret", async () => {
      stubUpstream();
      const caller = await gateway.tenantToken();
      const res = await send(caller.token, chat(), { "x-api-key": "sk-attacker" });
      expect(res.status).toBe(200);
      expect(upstream).toHaveLength(1);
      expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${gateway.upstreamApiKey}`);
      expect(upstream[0]!.headers.get("x-api-key")).toBeNull();
      expect(JSON.stringify(upstream[0]!.headers)).not.toContain("sk-attacker");
    });
  });

  describe("3. budget race", () => {
    it("keeps spent+reserved <= limit under many concurrent reserves on one hard wallet", async () => {
      const caller = await gateway.tenantToken({ budgets: false });
      const budgetId = `gwb_race_${crypto.randomUUID().slice(0, 8)}`;
      const limit = 1_000_000;
      const hold = 100_000;
      await d1
        .prepare(
          `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, ?)`,
        )
        .bind(budgetId, caller.tenantId, caller.tenantId, limit)
        .run();
      const ports = gateway.ports();
      const identity = await ports.identity.authenticate(
        new Request("https://gw.test/gateway/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${caller.token}` },
        }),
      );
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          ports.budgets
            .reserve({
              requestId: `race-${caller.tenantId}-${index}`,
              tenantId: identity.tenantId,
              budgetIds: identity.budgetIds,
              holdMicroCredits: hold,
              expiresAt: ports.clock.now() + 60_000,
            })
            .then(() => "ok" as const)
            .catch((error: unknown) =>
              error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "OTHER",
            ),
        ),
      );
      const admitted = results.filter((row) => row === "ok").length;
      const refused = results.filter((row) => row === "GATEWAY_BUDGET_EXCEEDED").length;
      expect(admitted).toBe(10);
      expect(refused).toBe(40 - admitted);
      const row = await d1
        .prepare(`SELECT spent_micro_credits, reserved_micro_credits, limit_micro_credits FROM gateway_budget WHERE id = ?`)
        .bind(budgetId)
        .first<{ spent_micro_credits: number; reserved_micro_credits: number; limit_micro_credits: number }>();
      expect(row!.spent_micro_credits + row!.reserved_micro_credits).toBeLessThanOrEqual(row!.limit_micro_credits);
      expect(row!.reserved_micro_credits).toBe(admitted * hold);
    });
  });

  describe("5. idempotency", () => {
    it("admits one upstream call for a repeated Idempotency-Key", async () => {
      stubUpstream();
      const caller = await gateway.tenantToken();
      const key = { "idempotency-key": `mt-${crypto.randomUUID()}` };
      const first = await send(caller.token, chat(), key);
      expect(first.status, await first.clone().text()).toBe(200);
      const second = await send(caller.token, chat(), key);
      expect([second.status, code(second)]).toEqual([409, "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED"]);
      expect(upstream).toHaveLength(1);
    });
  });

  describe("6. rate limits", () => {
    it("lets tenant B keep calling while tenant A's key is rate-limited", async () => {
      stubUpstream();
      const alice = await gateway.tenantToken();
      const bob = await gateway.tenantToken();
      const limited = await gateway.keyToken(alice, { requestsPerMinute: 2 });
      expect((await send(limited, chat())).status).toBe(200);
      expect((await send(limited, chat())).status).toBe(200);
      const throttled = await send(limited, chat());
      expect([throttled.status, code(throttled)]).toEqual([429, "GATEWAY_RATE_LIMITED"]);
      expect(throttled.headers.get("retry-after")).toMatch(/^\d+$/);
      expect((await send(bob.token, chat())).status).toBe(200);
    });
  });

  describe("7. auth", () => {
    it("answers coded 401/403/402 without contacting upstream", async () => {
      stubUpstream();
      const restricted = await gateway.tenantToken({ modelAllowlist: ["nope"] });
      const unbudgeted = await gateway.tenantToken({ budgets: false });
      const anonymous = await send(undefined, chat());
      expect([anonymous.status, code(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
      const denied = await send(restricted.token, chat());
      expect([denied.status, code(denied)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
      const broke = await send(unbudgeted.token, chat());
      expect([broke.status, code(broke)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
      expect(upstream).toHaveLength(0);
    });
  });

  describe("8. admin permissions + staff prompt access (decision 10)", () => {
    it("allows platform_admin prompt access only when hosted flag is on, and audits the view", async () => {
      const retaining = {
        ...env(),
        GATEWAY_STAFF_PROMPT_ACCESS: "enabled",
        R2_BUCKET: {
          async put() {
            return {};
          },
          async get() {
            return null;
          },
          async delete() {},
        },
        BETTER_AUTH_URL: ORIGIN,
      } as never;
      // Reuse the existing seeded encryption + D1; retention metadata without bodies still audits.
      const staff = await signedInAdmin(app, retaining, ORIGIN);
      const meOff = await app.request(
        "/api/v1/admin/gateway/me",
        { headers: { origin: ORIGIN, ...staff.auth } },
        env(),
      );
      expect(meOff.status).toBe(200);
      expect(((await meOff.json()) as { promptAccess: boolean }).promptAccess).toBe(false);

      const meOn = await app.request(
        "/api/v1/admin/gateway/me",
        { headers: { origin: ORIGIN, ...staff.auth } },
        retaining,
      );
      const meOnBody = (await meOn.json()) as { admin: { role: string }; promptAccess: boolean };
      expect(meOnBody.admin.role).toBe("platform_admin");
      expect(meOnBody.promptAccess).toBe(true);
    });

    it("keeps self-host default: prompt access disabled without GATEWAY_STAFF_PROMPT_ACCESS", async () => {
      const staffEnv = env();
      const staff = await signedInAdmin(app, staffEnv, ORIGIN);
      const viewed = await app.request(
        `/api/v1/admin/gateway/prompts/gwr_missing/access`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, ...staff.auth },
          body: JSON.stringify({ reason: "incident" }),
        },
        staffEnv,
      );
      expect([viewed.status, viewed.headers.get("x-clash-error-code")]).toEqual([
        403,
        "GATEWAY_PROMPT_ACCESS_DISABLED",
      ]);
    });
  });

  describe("9. coded errors", () => {
    it("preserves GATEWAY_* on upstream failure without leaking the upstream key", async () => {
      stubUpstream(() => Response.json({ error: { message: `key ${gateway.upstreamApiKey}` } }, { status: 503 }));
      const caller = await gateway.tenantToken();
      const res = await send(caller.token, chat());
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).not.toContain(gateway.upstreamApiKey);
      expect(code(res)).toMatch(/^GATEWAY_/);
    });
  });

  describe("13. abuse", () => {
    it("suspends the wallet and refuses subsequent chat with GATEWAY_BUDGET_EXCEEDED", async () => {
      stubUpstream();
      const caller = await gateway.tenantToken();
      const staffEnv = env();
      const staff = await signedInAdmin(app, staffEnv, ORIGIN);
      const suspend = await app.request(
        `/api/v1/admin/gateway/tenants/${caller.tenantId}/wallet/status`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, ...staff.auth },
          body: JSON.stringify({ status: "suspended", reason: "abuse velocity" }),
        },
        staffEnv,
      );
      expect(suspend.status, await suspend.clone().text()).toBe(200);
      const refused = await send(caller.token, chat());
      expect([refused.status, code(refused)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
      expect(upstream).toHaveLength(0);
      const audit = sqlite
        .prepare(
          `SELECT action, reason FROM gateway_admin_audit WHERE tenant_id = ? AND action LIKE '%wallet%' ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
        )
        .get(caller.tenantId) as { action: string; reason: string } | undefined;
      expect(audit?.reason).toContain("abuse");
    });
  });
});
