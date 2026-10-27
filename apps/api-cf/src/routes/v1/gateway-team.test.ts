/**
 * Team settings (#354) through the Worker app on node:sqlite with every
 * migration applied. Product identity is a real clsh_ token row (and a users
 * row for the invited email), so the /api/* middleware resolves it as in
 * production. Covers: teams, invite / accept / remove / role change with the
 * last-owner guard and one audit row per mutation that rolls back with it;
 * members cannot manage; owner-only purchases; owner budget allocation with
 * hard/soft/alert enforcement on plain and streamed requests, overrides with
 * a reason; configurable rate limits validated with the limits schema, a
 * coded 429 with Retry-After; members see only their own usage and budget.
 * Role expectations come from the exported permission matrix.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { GATEWAY_BUDGET_HEADER } from "@clash/gateway-core";

import { createApp } from "../../app";
import { createSqliteD1 } from "../../../../web/app/test-support/sqlite-d1";
import { GATEWAY_CREDIT_FLOOR } from "../../gateway";
import { createD1GatewayBudgetPorts } from "../../gateway/d1-budgets";
import { seedGateway, type SeededGateway } from "../../gateway/test-support";
import { createGatewayTokenStore } from "../../services/gateway-tokens";
import { tenantRolePermissions, type GatewayTenantPermission } from "../../services/gateway-authz";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

let gateway: SeededGateway;
beforeAll(async () => {
  gateway = await seedGateway(d1);
});
const env = () => ({
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-team-0123456789",
  GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
  GENERATION_WORKFLOW: gateway.workflow,
});

/** A product user: a users row (with an email) and a clsh_ token. */
function user(email = `${hex()}@team.test`) {
  const userId = `user-${hex()}`;
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  const parentId = `tok-${hex()}`;
  sqlite.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).run(userId, `Name ${userId}`, email);
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(parentId, userId, sha256(raw));
  return { userId, email, parentId, auth: { authorization: `Bearer ${raw}` } };
}
type User = ReturnType<typeof user>;

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    env() as never,
  );
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const base = (tenantId: string) => `/api/v1/gateway/tenants/${encodeURIComponent(tenantId)}`;

/** A team created through the API by `owner`, with `member` joined through an accepted invite. */
async function team() {
  const owner = user();
  const member = user();
  const { team: created } = await json<{ team: { tenantId: string; role: string } }>(
    await call("POST", "/api/v1/gateway/teams", owner.auth, { name: `Team ${hex()}` }),
    201,
  );
  expect(created.role).toBe("owner");
  const invited = await json<{ token: string }>(await call("POST", `${base(created.tenantId)}/invites`, owner.auth, { email: member.email }), 201);
  await json(await call("POST", "/api/v1/gateway/invites/accept", member.auth, { token: invited.token }));
  return { tenantId: created.tenantId, base: base(created.tenantId), owner, member };
}

function audit(tenantId: string) {
  return sqlite
    .prepare(`SELECT action, actor_kind, actor_id, actor_role, target_id, before_json, after_json, reason FROM gateway_admin_audit WHERE tenant_id = ? ORDER BY occurred_at, rowid`)
    .all(tenantId) as Array<{
    action: string;
    actor_kind: string;
    actor_id: string;
    actor_role: string;
    target_id: string;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
  }>;
}

/** Makes every audit insert fail, so a mutation batch must roll back whole. */
async function withAuditFailing<T>(run: () => Promise<T>): Promise<T> {
  sqlite.exec(`CREATE TRIGGER test_audit_down BEFORE INSERT ON gateway_admin_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  try {
    return await run();
  } finally {
    sqlite.exec(`DROP TRIGGER test_audit_down`);
  }
}

describe("teams, invites and members", () => {
  it("creates a team owned by its creator and lists the caller's teams", async () => {
    const t = await team();
    const owned = await json<{ teams: Array<{ tenantId: string; role: string; kind: string; members: number }> }>(
      await call("GET", "/api/v1/gateway/teams", t.owner.auth),
    );
    expect(owned.teams.find((entry) => entry.tenantId === t.tenantId)).toMatchObject({ role: "owner", kind: "team", members: 2 });
    const joined = await json<{ teams: Array<{ tenantId: string; role: string }> }>(await call("GET", "/api/v1/gateway/teams", t.member.auth));
    expect(joined.teams.find((entry) => entry.tenantId === t.tenantId)?.role).toBe("member");
    expect(audit(t.tenantId).map((row) => row.action)).toEqual(["team.create", "invite.create", "invite.accept"]);
    await expectCode(await call("GET", "/api/v1/gateway/teams"), 401, "GATEWAY_AUTH_REQUIRED");
  });

  it("invites by email once, shows the link's team, and accepts only for the invited account", async () => {
    const t = await team();
    const invitee = user();
    const stranger = user();
    const created = await json<{ invite: { id: string; role: string }; token: string; acceptPath: string }>(
      await call("POST", `${t.base}/invites`, t.owner.auth, { email: invitee.email.toUpperCase(), role: "owner" }),
      201,
    );
    expect(created.acceptPath).toContain(encodeURIComponent(created.token));
    // Only the hash is stored.
    const stored = sqlite.prepare(`SELECT email, token_hash FROM tenant_invite WHERE id = ?`).get(created.invite.id) as { email: string; token_hash: string };
    expect(stored).toEqual({ email: invitee.email, token_hash: sha256(created.token) });
    await expectCode(await call("POST", `${t.base}/invites`, t.owner.auth, { email: invitee.email }), 409, "GATEWAY_INVITE_EXISTS");
    await expectCode(await call("POST", `${t.base}/invites`, t.owner.auth, { email: t.member.email }), 409, "GATEWAY_MEMBER_EXISTS");
    const listed = await json<{ invites: Array<{ id: string }> }>(await call("GET", `${t.base}/invites`, t.owner.auth));
    expect(listed.invites.map((invite) => invite.id)).toEqual([created.invite.id]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const lookup = await json<{ team: { tenantId: string }; invite: { role: string } }>(
      await call("POST", "/api/v1/gateway/invites/lookup", invitee.auth, { token: created.token }),
    );
    expect(lookup).toMatchObject({ team: { tenantId: t.tenantId }, invite: { role: "owner" } });
    await expectCode(await call("POST", "/api/v1/gateway/invites/accept", stranger.auth, { token: created.token }), 403, "GATEWAY_INVITE_EMAIL_MISMATCH");
    const accepted = await json<{ team: { role: string } }>(
      await call("POST", "/api/v1/gateway/invites/accept", invitee.auth, { token: created.token }),
    );
    expect(accepted.team.role).toBe("owner");
    // An accepted invite is spent: it is no longer pending for anyone.
    await expectCode(await call("POST", "/api/v1/gateway/invites/accept", invitee.auth, { token: created.token }), 404, "GATEWAY_INVITE_NOT_FOUND");
    const acceptRow = audit(t.tenantId).find((row) => row.action === "invite.accept" && row.actor_id === invitee.userId);
    expect(acceptRow).toMatchObject({ actor_kind: "user", actor_role: "owner", target_id: created.invite.id });
    await expectCode(await call("POST", "/api/v1/gateway/invites/accept", invitee.auth, { token: "gwi_nope" }), 400, "GATEWAY_INVALID_REQUEST");
  });

  it("refuses revoked and expired invites with coded errors", async () => {
    const t = await team();
    const later = user();
    const revoked = await json<{ invite: { id: string }; token: string }>(await call("POST", `${t.base}/invites`, t.owner.auth, { email: later.email }), 201);
    await json(await call("DELETE", `${t.base}/invites/${revoked.invite.id}`, t.owner.auth));
    await expectCode(await call("POST", "/api/v1/gateway/invites/accept", later.auth, { token: revoked.token }), 404, "GATEWAY_INVITE_NOT_FOUND");
    await expectCode(await call("DELETE", `${t.base}/invites/${revoked.invite.id}`, t.owner.auth), 404, "GATEWAY_INVITE_NOT_FOUND");
    const expiring = await json<{ invite: { id: string }; token: string }>(await call("POST", `${t.base}/invites`, t.owner.auth, { email: later.email }), 201);
    sqlite.prepare(`UPDATE tenant_invite SET expires_at = 1 WHERE id = ?`).run(expiring.invite.id);
    await expectCode(await call("POST", "/api/v1/gateway/invites/lookup", later.auth, { token: expiring.token }), 410, "GATEWAY_INVITE_EXPIRED");
    await expectCode(await call("POST", "/api/v1/gateway/invites/accept", later.auth, { token: expiring.token }), 410, "GATEWAY_INVITE_EXPIRED");
    expect(audit(t.tenantId).map((row) => row.action)).toContain("invite.revoke");
  });

  it("changes roles keeping one owner, and removes members (revoking their keys) keeping one owner, audited", async () => {
    const t = await team();
    const path = `${t.base}/members/${t.member.userId}/role`;
    expect((await json<{ member: { role: string } }>(await call("PUT", path, t.owner.auth, { role: "owner", reason: "co-owner" }))).member.role).toBe("owner");
    expect((await json<{ member: { role: string } }>(await call("PUT", path, t.owner.auth, { role: "member" }))).member.role).toBe("member");
    await expectCode(await call("PUT", `${t.base}/members/${t.owner.userId}/role`, t.owner.auth, { role: "member" }), 409, "GATEWAY_LAST_OWNER");
    await expectCode(await call("PUT", path, t.owner.auth, { role: "root" }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("DELETE", `${t.base}/members/${t.owner.userId}`, t.owner.auth), 409, "GATEWAY_LAST_OWNER");
    const roleRows = audit(t.tenantId).filter((row) => row.action === "member.role");
    expect(roleRows.map((row) => [JSON.parse(row.before_json!).role, JSON.parse(row.after_json!).role, row.reason])).toEqual([
      ["member", "owner", "co-owner"],
      ["owner", "member", null],
    ]);

    const keyId = `gwk_${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash) VALUES (?, ?, ?, 'ci', 'sk_gw_ab', ?)`)
      .run(keyId, t.tenantId, t.member.userId, sha256(keyId));
    await json(await call("DELETE", `${t.base}/members/${t.member.userId}`, t.owner.auth));
    expect(sqlite.prepare(`SELECT 1 FROM tenant_member WHERE tenant_id = ? AND user_id = ?`).get(t.tenantId, t.member.userId)).toBeUndefined();
    expect((sqlite.prepare(`SELECT revoked_at FROM gateway_key WHERE id = ?`).get(keyId) as { revoked_at: number | null }).revoked_at).not.toBeNull();
    await expectCode(await call("DELETE", `${t.base}/members/${t.member.userId}`, t.owner.auth), 404, "GATEWAY_MEMBER_NOT_FOUND");
    expect(audit(t.tenantId).filter((row) => row.action === "member.remove").map((row) => row.target_id)).toEqual([t.member.userId]);
    // A removed member's product credential no longer reaches the team.
    await expectCode(await call("GET", `${t.base}/me`, t.member.auth), 403, "GATEWAY_FORBIDDEN");
  });

  it("refuses member management in a personal workspace", async () => {
    const solo = user();
    const minted = await createGatewayTokenStore(d1).mint({ userId: solo.userId, parent: { kind: "api_token", id: solo.parentId } });
    await expectCode(await call("POST", `${base(minted.tenantId)}/invites`, solo.auth, { email: "x@team.test" }), 409, "GATEWAY_TENANT_NOT_TEAM");
  });

  it("rolls each team mutation back, coded, when its audit row cannot be written", async () => {
    const t = await team();
    const another = user();
    const before = {
      members: sqlite.prepare(`SELECT user_id, role FROM tenant_member WHERE tenant_id = ? ORDER BY user_id`).all(t.tenantId),
      invites: sqlite.prepare(`SELECT id, status FROM tenant_invite WHERE tenant_id = ? ORDER BY id`).all(t.tenantId),
      budgets: sqlite.prepare(`SELECT * FROM gateway_budget WHERE tenant_id = ?`).all(t.tenantId),
      member: sqlite.prepare(`SELECT rate_limit_json FROM tenant_member WHERE tenant_id = ?`).all(t.tenantId),
    };
    await withAuditFailing(async () => {
      for (const [method, path, body] of [
        ["PUT", `${t.base}/members/${t.member.userId}/role`, { role: "owner" }],
        ["DELETE", `${t.base}/members/${t.member.userId}`, undefined],
        ["POST", `${t.base}/invites`, { email: another.email }],
        ["PUT", `${t.base}/budgets/user/${t.member.userId}`, { limitMicroCredits: 1_000_000 }],
        ["PUT", `${t.base}/members/${t.member.userId}/rate-limit`, { rateLimit: { requestsPerMinute: 5 } }],
        ["PUT", `${t.base}/rate-limit`, { rateLimit: { concurrency: 3 } }],
      ] as const)
        await expectCode(await call(method, path, t.owner.auth, body), 409, "GATEWAY_CONFLICT");
      await expectCode(await call("POST", "/api/v1/gateway/teams", t.owner.auth, { name: "Nope" }), 409, "GATEWAY_CONFLICT");
    });
    expect({
      members: sqlite.prepare(`SELECT user_id, role FROM tenant_member WHERE tenant_id = ? ORDER BY user_id`).all(t.tenantId),
      invites: sqlite.prepare(`SELECT id, status FROM tenant_invite WHERE tenant_id = ? ORDER BY id`).all(t.tenantId),
      budgets: sqlite.prepare(`SELECT * FROM gateway_budget WHERE tenant_id = ?`).all(t.tenantId),
      member: sqlite.prepare(`SELECT rate_limit_json FROM tenant_member WHERE tenant_id = ?`).all(t.tenantId),
    }).toEqual(before);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM tenant WHERE name = 'Nope'`).get()).toEqual({ n: 0 });
  });
});

describe("permissions in team settings", () => {
  it("answers each role per the matrix: a member manages nothing, and only reads their own", async () => {
    const t = await team();
    const keyId = `gwk_${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash) VALUES (?, ?, ?, 'ci', 'sk_gw_ab', ?)`)
      .run(keyId, t.tenantId, t.member.userId, sha256(keyId));
    const routes: Array<[GatewayTenantPermission, string, string, unknown?]> = [
      ["tenant.read", "GET", t.base],
      ["limits.write", "PUT", `${t.base}/rate-limit`, { rateLimit: { requestsPerMinute: 100 } }],
      ["team.members.read", "GET", `${t.base}/members`],
      ["team.members.manage", "PUT", `${t.base}/members/${t.owner.userId}/role`, { role: "owner" }],
      ["limits.write", "PUT", `${t.base}/members/${t.owner.userId}/rate-limit`, { rateLimit: null }],
      ["team.members.read", "GET", `${t.base}/invites`],
      ["team.members.manage", "POST", `${t.base}/invites`, { email: `${hex()}@team.test` }],
      ["budgets.read", "GET", `${t.base}/budgets`],
      ["team.budgets.allocate", "PUT", `${t.base}/budgets/key/${keyId}`, { limitMicroCredits: 1_000_000 }],
      ["keys.read", "GET", `${t.base}/keys`],
      ["limits.write", "PUT", `${t.base}/keys/${keyId}/rate-limit`, { rateLimit: { concurrency: 2 } }],
      ["usage.read", "GET", `${t.base}/usage`],
      ["audit.read", "GET", `${t.base}/audit`],
      ["billing.read", "GET", `${t.base}/billing/offers`],
      ["billing.read", "GET", `${t.base}/billing`],
      ["billing.purchase", "POST", `${t.base}/topups`, { packId: "missing", idempotencyKey: `k-${hex()}` }],
      ["usage.read_own", "GET", `${t.base}/me`],
    ];
    for (const [role, caller] of [
      ["owner", t.owner],
      ["member", t.member],
    ] as const)
      for (const [permission, method, path, body] of routes) {
        const res = await call(method, path, caller.auth, body);
        if (tenantRolePermissions(role).includes(permission))
          expect(res.status, `${role} ${method} ${path}: ${await res.clone().text()}`).not.toBe(403);
        else {
          await expectCode(res, 403, "GATEWAY_FORBIDDEN");
          expect(((await res.json()) as { error: { message: string } }).error.message).toBeTruthy();
        }
      }
  });

  it("never lets a team role act on another team", async () => {
    const a = await team();
    const b = await team();
    for (const path of [`${b.base}/members`, `${b.base}/budgets`, `${b.base}/me`])
      await expectCode(await call("GET", path, a.owner.auth), 403, "GATEWAY_FORBIDDEN");
  });

  it("lets only the owner buy packages and top-ups for the team wallet, and lists the offers", async () => {
    const t = await team();
    const packId = `pack-${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_topup_pack (id, name, status, price_minor, price_currency, credits_micro) VALUES (?, 'Pack', 'active', 500, 'USD', 5000000)`)
      .run(packId);
    const offers = await json<{ packs: Array<{ id: string }> }>(await call("GET", `${t.base}/billing/offers`, t.owner.auth));
    expect(offers.packs.map((pack) => pack.id)).toContain(packId);
    const purchase = { packId, idempotencyKey: `buy-${hex()}` };
    await expectCode(await call("POST", `${t.base}/topups`, t.member.auth, purchase), 403, "GATEWAY_FORBIDDEN");
    const bought = await json<{ wallet: { limitMicroCredits: number } }>(await call("POST", `${t.base}/topups`, t.owner.auth, purchase), 201);
    expect(bought.wallet.limitMicroCredits).toBe(5_000_000);
  });
});

describe("owner budget allocation and enforcement", () => {
  /** A team whose wallet holds credits, so only the member budget can refuse. */
  async function funded() {
    const t = await team();
    const packId = `pack-${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_topup_pack (id, name, status, price_minor, price_currency, credits_micro) VALUES (?, 'Pack', 'active', 500, 'USD', 1000000000)`)
      .run(packId);
    await json(await call("POST", `${t.base}/topups`, t.owner.auth, { packId, idempotencyKey: `fund-${hex()}` }), 201);
    const minted = await createGatewayTokenStore(d1, { clock: gateway.clock }).mint({
      userId: t.member.userId,
      parent: { kind: "api_token", id: t.member.parentId },
      tenantId: t.tenantId,
    });
    return { ...t, gatewayToken: minted.token };
  }

  /** A postpaid charge on one budget, as a text request's settle run writes it. */
  async function overdraw(t: { tenantId: string; member: User }, budgetId: string, costMicroCredits: number) {
    await createD1GatewayBudgetPorts(d1, { clock: gateway.clock }).budgets.charge({
      requestId: `gwr_overdraw_${hex()}`,
      tenantId: t.tenantId,
      userId: t.member.userId,
      modelCode: gateway.textModel,
      kind: "text",
      upstreamId: "team-test",
      credentialScope: "official",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
      costMicroCredits,
      priceVersion: "team-test",
      catalogVersion: "team-test",
      status: "settled",
      occurredAt: gateway.clock.now(),
      budgetIds: [budgetId],
    });
  }

  const chatBody = (stream: boolean) => ({
    model: gateway.textModel,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    ...(stream ? { stream: true } : {}),
  });

  function stubUpstream(stream: boolean) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      stream
        ? new Response(
            `data: {"id":"c","object":"chat.completion.chunk","model":"vendor-internal","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n` +
              `data: {"id":"c","object":"chat.completion.chunk","model":"vendor-internal","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n` +
              `data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({
            id: "c",
            object: "chat.completion",
            model: "vendor-internal",
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
    );
  }

  const chat = (token: string, stream: boolean) =>
    app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` },
        body: JSON.stringify(chatBody(stream)),
      },
      env() as never,
    );

  it("allocates member budgets with hard, soft and alert enforcement, enforced on plain and streamed requests", async () => {
    const t = await funded();
    const budgetPath = `${t.base}/budgets/user/${t.member.userId}`;
    const set = (body: Record<string, unknown>) => call("PUT", budgetPath, t.owner.auth, body);
    for (const stream of [false, true]) {
      // Hard at zero: text is postpaid (#399), so it is refused once the balance
      // is at -floor, before any upstream call, naming the member budget.
      // (The second round's budget already has spend: a zero limit needs an override.)
      const { budget } = await json<{ budget: { id: string; enforcement: string } }>(
        await set({ limitMicroCredits: 0, enforcement: "hard", override: true, reason: "freeze" }),
      );
      expect(budget.enforcement).toBe("hard");
      await overdraw(t, budget.id, GATEWAY_CREDIT_FLOOR);
      const spy = stubUpstream(stream);
      const refused = await chat(t.gatewayToken, stream);
      await expectCode(refused, 402, "GATEWAY_BUDGET_EXCEEDED");
      expect(((await refused.json()) as { error: { budget_id: string } }).error.budget_id).toBe(budget.id);
      expect(spy).not.toHaveBeenCalled();

      // Soft: admitted past the limit, flagged on the answer and recorded.
      await json(await set({ limitMicroCredits: 0, enforcement: "soft", override: true, reason: "let the demo run" }));
      const soft = await chat(t.gatewayToken, stream);
      expect(soft.status, await soft.clone().text()).toBe(200);
      expect(soft.headers.get(GATEWAY_BUDGET_HEADER)).toBe(`soft_exceeded; budget_id=${budget.id}; scope=user`);
      const softText = await soft.text();
      if (stream) expect(softText).not.toContain("vendor-internal");

      // Alert: admitted, one notification per limit and threshold.
      // A limit of its own per round: an alert is raised once per limit and threshold.
      await json(await set({ limitMicroCredits: stream ? 2 : 1, enforcement: "alert", override: true, reason: "watch only" }));
      const alerted = await chat(t.gatewayToken, stream);
      expect(alerted.headers.get(GATEWAY_BUDGET_HEADER)).toBe(`alert_threshold; budget_id=${budget.id}; scope=user`);
      await alerted.arrayBuffer();
      const quiet = await chat(t.gatewayToken, stream);
      expect(quiet.status).toBe(200);
      expect(quiet.headers.get(GATEWAY_BUDGET_HEADER)).toBeNull();
      await quiet.arrayBuffer();
      spy.mockRestore();

      const { events } = await json<{ events: Array<{ kind: string; budgetId: string }> }>(await call("GET", `${t.base}/budgets`, t.owner.auth));
      expect(events.filter((event) => event.budgetId === budget.id).map((event) => event.kind)).toEqual(
        expect.arrayContaining(["soft_exceeded", "alert_threshold"]),
      );
      await json(await set({ limitMicroCredits: null, enforcement: "hard", alertThresholdPct: null }));
    }
  });

  it("refuses a limit below usage unless overridden with a reason, audited as an override", async () => {
    const t = await funded();
    const budgetPath = `${t.base}/budgets/user/${t.member.userId}`;
    await json(await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 1_000_000_000, enforcement: "soft", alertThresholdPct: 80 }));
    const spy = stubUpstream(false);
    expect((await chat(t.gatewayToken, false)).status).toBe(200);
    spy.mockRestore();
    const { budgets } = await json<{ budgets: Array<{ scope: string; scopeId: string; spentMicroCredits: number; reservedMicroCredits: number; enforcement: string; alertThresholdPct: number }> }>(
      await call("GET", `${t.base}/budgets`, t.owner.auth),
    );
    const allocated = budgets.find((entry) => entry.scope === "user" && entry.scopeId === t.member.userId)!;
    expect(allocated).toMatchObject({ enforcement: "soft", alertThresholdPct: 80, reservedMicroCredits: 0 });
    expect(allocated.spentMicroCredits).toBeGreaterThan(0);
    await expectCode(await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 0 }), 409, "GATEWAY_BUDGET_BELOW_USAGE");
    await expectCode(await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 0, override: true }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 0, enforcement: "strict" }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 0, alertThresholdPct: 0 }), 400, "GATEWAY_INVALID_REQUEST");
    const overridden = await json<{ budget: { limitMicroCredits: number } }>(
      await call("PUT", budgetPath, t.owner.auth, { limitMicroCredits: 0, override: true, reason: "stop spend now" }),
    );
    expect(overridden.budget.limitMicroCredits).toBe(0);
    const row = audit(t.tenantId).find((entry) => entry.action === "budget.override")!;
    expect(row).toMatchObject({ actor_kind: "user", actor_id: t.owner.userId, actor_role: "owner", reason: "stop spend now" });
    expect(JSON.parse(row.before_json!)).toMatchObject({ spentMicroCredits: allocated.spentMicroCredits, enforcement: "soft" });
  });

  it("shows a member only their own budget, keys and usage", async () => {
    const t = await funded();
    const colleague = user();
    const invite = await json<{ token: string }>(await call("POST", `${t.base}/invites`, t.owner.auth, { email: colleague.email }), 201);
    await json(await call("POST", "/api/v1/gateway/invites/accept", colleague.auth, { token: invite.token }));
    for (const subject of [t.member, colleague])
      await json(await call("PUT", `${t.base}/budgets/user/${subject.userId}`, t.owner.auth, { limitMicroCredits: 1_000_000_000 }));
    const spy = stubUpstream(false);
    expect((await chat(t.gatewayToken, false)).status).toBe(200);
    spy.mockRestore();
    const me = await json<{
      member: { userId: string; role: string };
      budgets: Array<{ scope: string; scopeId: string }>;
      usage: Array<{ userId: string; costMicroCredits: number }>;
    }>(await call("GET", `${t.base}/me`, t.member.auth));
    expect(me.member).toMatchObject({ userId: t.member.userId, role: "member" });
    expect(me.budgets.map((budget) => budget.scopeId)).toEqual([t.member.userId]);
    expect(me.usage.length).toBeGreaterThan(0);
    for (const entry of me.usage) expect(entry.userId).toBe(t.member.userId);
    expect(JSON.stringify(me)).not.toContain(colleague.userId);
    expect(JSON.stringify(me.usage)).not.toContain("upstream");
    const theirs = await json<{ usage: unknown[] }>(await call("GET", `${t.base}/me`, colleague.auth));
    expect(theirs.usage).toEqual([]);
  });
});

describe("configurable rate limits", () => {
  it("validates limits with the limits schema and persists exactly what the limits port reads", async () => {
    const t = await team();
    const path = `${t.base}/members/${t.member.userId}/rate-limit`;
    for (const rateLimit of [{}, { requestsPerMinute: 0 }, { rpm: 5 }, { concurrency: 1.5 }, { mediaJobs: -1 }])
      await expectCode(await call("PUT", path, t.owner.auth, { rateLimit }), 400, "GATEWAY_INVALID_REQUEST");
    const limit = { requestsPerMinute: 30, tokensPerMinute: 1000, concurrency: 2, mediaJobs: 1 };
    const { member } = await json<{ member: { rateLimit: unknown } }>(await call("PUT", path, t.owner.auth, { rateLimit: limit }));
    expect(member.rateLimit).toEqual(limit);
    expect(sqlite.prepare(`SELECT rate_limit_json FROM tenant_member WHERE tenant_id = ? AND user_id = ?`).get(t.tenantId, t.member.userId)).toEqual({
      rate_limit_json: JSON.stringify(limit),
    });
    const { tenant } = await json<{ tenant: { rateLimit: unknown } }>(await call("PUT", `${t.base}/rate-limit`, t.owner.auth, { rateLimit: { requestsPerMinute: 600 } }));
    expect(tenant.rateLimit).toEqual({ requestsPerMinute: 600 });
    expect((await json<{ member: { rateLimit: unknown } }>(await call("PUT", path, t.owner.auth, { rateLimit: null }))).member.rateLimit).toBeNull();
    expect(audit(t.tenantId).map((row) => row.action)).toEqual(expect.arrayContaining(["member.rate_limit", "tenant.rate_limit"]));
  });

  it("answers a coded 429 with Retry-After once a member's configured limit is used", async () => {
    const t = await team();
    sqlite
      .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, NULL)`)
      .run(`gwb_t_${hex()}`, t.tenantId, t.tenantId);
    await json(await call("PUT", `${t.base}/members/${t.member.userId}/rate-limit`, t.owner.auth, { rateLimit: { requestsPerMinute: 1 } }));
    const minted = await createGatewayTokenStore(d1, { clock: gateway.clock }).mint({
      userId: t.member.userId,
      parent: { kind: "api_token", id: t.member.parentId },
      tenantId: t.tenantId,
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ id: "c", model: "x", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const send = () =>
      app.request(
        "/gateway/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${minted.token}` },
          body: JSON.stringify({ model: gateway.textModel, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
        },
        env() as never,
      );
    expect((await send()).status).toBe(200);
    const limited = await send();
    await expectCode(limited, 429, "GATEWAY_RATE_LIMITED");
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
