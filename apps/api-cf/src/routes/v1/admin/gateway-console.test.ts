/**
 * Admin console API (#353, #392) through the Worker app on node:sqlite with
 * every migration applied: the console answers platform_admin only (team
 * roles get coded 403s), tenant billing follows the owner/member matrix, one
 * redacted `gateway_admin_audit` row per mutation that rolls back with it,
 * write-only upstream secrets, rate-limit validation and staff prompt-access
 * gating. Identity is a real clsh_ token row, so the /api/* middleware
 * resolves it as in production. Role expectations are derived from the
 * exported matrix, so the suite proves the server enforces it rather than
 * restating it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { createApp } from "../../../app";
import { createSqliteD1 } from "../../../../../web/app/test-support/sqlite-d1";
import { createRetainedBodyCopy, gatewayRetentionKeys, retainGatewayExchange } from "@clash/gateway-core";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1GatewayBudgetPorts } from "../../../gateway/d1-budgets";
import { gatewayRetentionPorts, purgeGatewayRetention } from "../../../gateway/d1-retention";
import { createD1TenantAdmin } from "../../../gateway/d1-tenant-admin";
import { createMemoryBucket, officialChatCard } from "../../../gateway/test-support";
import { GATEWAY_TENANT_ROLES, tenantRolePermissions, type GatewayTenantPermission } from "../../../services/gateway-authz";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const ENCRYPTION_KEY = `console-kek-${hex()}${hex()}`;

const baseEnv = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-console-0123456789",
  GATEWAY_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

function user() {
  const userId = `user-${hex()}`;
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(`tok-${hex()}`, userId, sha256(raw));
  return { userId, auth: { authorization: `Bearer ${raw}` } };
}

const platformAdmin = user();
sqlite.prepare(`INSERT INTO gateway_platform_role (user_id, role) VALUES (?, 'platform_admin')`).run(platformAdmin.userId);

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  env: Record<string, unknown> = baseEnv,
) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    env as never,
  );
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
  expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(code);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** A team tenant with one member per team role (owner, member), and one virtual key. */
function team() {
  const tenantId = `team:${hex()}`;
  const members = Object.fromEntries(GATEWAY_TENANT_ROLES.map((role) => [role, user()])) as Record<
    (typeof GATEWAY_TENANT_ROLES)[number],
    ReturnType<typeof user>
  >;
  sqlite.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', 'team')`).run(tenantId, members.owner.userId);
  for (const [role, member] of Object.entries(members))
    sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, ?)`).run(tenantId, member.userId, role);
  const keyId = `gwk_${hex()}`;
  sqlite
    .prepare(
      `INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash) VALUES (?, ?, ?, 'ci', 'sk_gw_ab', ?)`,
    )
    .run(keyId, tenantId, members.member.userId, sha256(keyId));
  return { tenantId, members, keyId, base: `/api/v1/admin/gateway/tenants/${encodeURIComponent(tenantId)}` };
}

function auditRows(where: string, ...args: unknown[]) {
  return sqlite
    .prepare(`SELECT * FROM gateway_admin_audit WHERE ${where} ORDER BY occurred_at, rowid`)
    .all(...(args as never[])) as Array<{
    action: string;
    actor_user_id: string;
    actor_role: string;
    tenant_id: string;
    target_id: string;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
  }>;
}

/** Makes every audit insert fail, so a mutation batch must roll back whole. */
function withAuditFailing<T>(run: () => T | Promise<T>): Promise<T> {
  sqlite.exec(`CREATE TRIGGER test_audit_down BEFORE INSERT ON gateway_admin_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  return Promise.resolve()
    .then(run)
    .finally(() => sqlite.exec(`DROP TRIGGER test_audit_down`));
}

const card = () => officialChatCard();

/** The console's tenant-scoped routes; like every console route they answer platform grants only. */
const tenantConsoleRoutes = (t: ReturnType<typeof team>): Array<[string, string, unknown?]> => [
  ["GET", `/api/v1/admin/gateway/overview?tenantId=${encodeURIComponent(t.tenantId)}`],
  ["GET", `/api/v1/admin/gateway/usage?tenantId=${encodeURIComponent(t.tenantId)}`],
  ["GET", `/api/v1/admin/gateway/audit?tenantId=${encodeURIComponent(t.tenantId)}`],
  ["GET", `${t.base}/members`],
  ["GET", `${t.base}/budgets`],
  ["PUT", `${t.base}/budgets/key/${t.keyId}`, { limitMicroCredits: 1_000_000 }],
  ["GET", `${t.base}/keys`],
  ["PUT", `${t.base}/keys/${t.keyId}/rate-limit`, { rateLimit: { requestsPerMinute: 10 } }],
];

describe("permission matrix, enforced by the server", () => {
  // Tenant billing is the one tenant-role surface (#352). An allowed request
  // may still fail for its own reasons (404 pack), but never with a 403.
  const billing: Array<[GatewayTenantPermission, (t: ReturnType<typeof team>) => [string, string, unknown?]]> = [
    ["billing.read", (t) => ["GET", `/api/v1/gateway/tenants/${encodeURIComponent(t.tenantId)}/billing`]],
    [
      "billing.purchase",
      (t) => ["POST", `/api/v1/gateway/tenants/${encodeURIComponent(t.tenantId)}/topups`, { packId: "none", idempotencyKey: "k1" }],
    ],
  ];

  for (const role of GATEWAY_TENANT_ROLES)
    it(`answers ${role} on tenant billing per the matrix: allowed actions pass, others are coded 403s`, async () => {
      for (const [permission, request] of billing) {
        const t = team();
        const [method, path, body] = request(t);
        const res = await call(method, path, t.members[role].auth, body);
        if (tenantRolePermissions(role).includes(permission)) expect(res.status, `${role} ${permission}`).not.toBe(403);
        else await expectCode(res, 403, "GATEWAY_FORBIDDEN");
      }
    });

  it("never lets a tenant role act on another tenant", async () => {
    const a = team();
    const b = team();
    for (const [, request] of billing) {
      const [method, path, body] = request(b);
      await expectCode(await call(method, path, a.members.owner.auth, body), 403, "GATEWAY_FORBIDDEN");
    }
  });

  it("keeps every console route platform_admin-only: team owners and members get 403, anonymous 401", async () => {
    const t = team();
    const platformRoutes: Array<[string, string, unknown?]> = [
      ...tenantConsoleRoutes(t),
      ["GET", "/api/v1/admin/gateway/catalog"],
      ["POST", "/api/v1/admin/gateway/catalog/versions/v1/clone", { from: "v0" }],
      ["PUT", "/api/v1/admin/gateway/catalog/versions/v1/models/m", { card: {} }],
      ["DELETE", "/api/v1/admin/gateway/catalog/versions/v1/models/m"],
      ["POST", "/api/v1/admin/gateway/catalog/versions/v1/publish"],
      ["GET", "/api/v1/admin/gateway/upstreams"],
      ["POST", "/api/v1/admin/gateway/upstreams", { providerId: "official", credential: { secretRef: "GATEWAY_UPSTREAM_X" } }],
      ["PATCH", "/api/v1/admin/gateway/upstreams/gwu_x", { enabled: false }],
      ["POST", "/api/v1/admin/gateway/upstreams/gwu_x/rotate", { credential: { secretRef: "GATEWAY_UPSTREAM_X" } }],
      ["GET", "/api/v1/admin/gateway/tenants"],
      ["GET", "/api/v1/admin/gateway/platform-admins"],
      ["POST", "/api/v1/admin/gateway/platform-admins", { userId: "u" }],
      ["POST", `/api/v1/admin/gateway/platform-admins/${platformAdmin.userId}/revoke`, {}],
      ["GET", "/api/v1/admin/gateway/overview"],
      ["GET", "/api/v1/admin/gateway/usage"],
      ["GET", "/api/v1/admin/gateway/audit"],
      ["GET", "/api/v1/admin/gateway/abuse"],
      ["POST", "/api/v1/admin/gateway/prompts/gwr_x/access", { reason: "incident" }],
      ["POST", "/api/v1/admin/gateway/retention/purge", {}],
      ["POST", "/api/v1/admin/gateway/holds/sweep", {}],
      ["PUT", `${t.base}/subscription/rate-limit`, { rateLimit: null }],
      ["POST", `${t.base}/wallet/adjust`, { deltaMicroCredits: 1, reason: "x", idempotencyKey: "k" }],
      ["POST", `${t.base}/wallet/status`, { status: "suspended", reason: "x" }],
      ["GET", "/api/v1/admin/gateway/prices"],
      ["POST", "/api/v1/admin/gateway/packages", { name: "p" }],
    ];
    for (const [method, path, body] of platformRoutes) {
      await expectCode(await call(method, path, {}, body), 401, "GATEWAY_AUTH_REQUIRED");
      for (const role of GATEWAY_TENANT_ROLES)
        await expectCode(await call(method, path, t.members[role].auth, body), 403, "GATEWAY_FORBIDDEN");
      // A caller header is never identity.
      await expectCode(
        await call(method, path, { ...t.members.owner.auth, "x-user-id": platformAdmin.userId }, body),
        403,
        "GATEWAY_FORBIDDEN",
      );
    }
    expect(auditRows("actor_user_id IN (?, ?)", t.members.owner.userId, t.members.member.userId)).toEqual([]);
  });

  it("lets platform_admin use the tenant console routes of any tenant without being a member", async () => {
    const t = team();
    for (const [method, path, body] of tenantConsoleRoutes(t)) {
      const res = await call(method, path, platformAdmin.auth, body);
      expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(200);
    }
    const members = await json<{ members: Array<{ userId: string; role: string }> }>(await call("GET", `${t.base}/members`, platformAdmin.auth));
    expect(members.members.map((m) => [m.userId, m.role])).toEqual(
      expect.arrayContaining([
        [t.members.owner.userId, "owner"],
        [t.members.member.userId, "member"],
      ]),
    );
    expect(auditRows("tenant_id = ? AND action LIKE 'budget.%'", t.tenantId)[0]?.actor_role).toBe("platform_admin");
  });

  it("has no team role assignment in the console (team settings own it, #354)", async () => {
    const t = team();
    expect((await call("PUT", `${t.base}/members/${t.members.member.userId}/role`, platformAdmin.auth, { role: "owner" })).status).toBe(404);
    expect(sqlite.prepare(`SELECT role FROM tenant_member WHERE tenant_id = ? AND user_id = ?`).get(t.tenantId, t.members.member.userId)).toEqual({
      role: "member",
    });
  });

  it("describes the caller's platform access on /me, and nothing for team roles", async () => {
    const t = team();
    await expectCode(await call("GET", "/api/v1/admin/gateway/me"), 401, "GATEWAY_AUTH_REQUIRED");
    for (const role of GATEWAY_TENANT_ROLES) {
      const me = await json<Record<string, unknown>>(await call("GET", "/api/v1/admin/gateway/me", t.members[role].auth));
      expect(me, role).toEqual({ userId: t.members[role].userId, platformRoles: [], platformPermissions: [], promptAccess: false });
    }
    const staff = await json<{ platformRoles: string[]; platformPermissions: string[] }>(
      await call("GET", "/api/v1/admin/gateway/me", platformAdmin.auth),
    );
    expect(staff.platformRoles).toEqual(["platform_admin"]);
    expect(staff.platformPermissions).toContain("catalog.write");
  });
});

describe("tenant administration", () => {
  it("sets member and key budgets with audit, refuses limits below usage and unknown subjects", async () => {
    const t = team();
    const actor = platformAdmin;
    const created = await json<{ budget: { id: string; scope: string; limitMicroCredits: number } }>(
      await call("PUT", `${t.base}/budgets/user/${t.members.member.userId}`, actor.auth, {
        limitMicroCredits: 5_000_000,
        reason: "allocation",
      }),
    );
    expect(created.budget).toMatchObject({ scope: "user", limitMicroCredits: 5_000_000 });
    sqlite.prepare(`UPDATE gateway_budget SET spent_micro_credits = 4000000 WHERE id = ?`).run(created.budget.id);
    await expectCode(
      await call("PUT", `${t.base}/budgets/user/${t.members.member.userId}`, actor.auth, { limitMicroCredits: 3_000_000 }),
      409,
      "GATEWAY_BUDGET_BELOW_USAGE",
    );
    await json(await call("PUT", `${t.base}/budgets/user/${t.members.member.userId}`, actor.auth, { limitMicroCredits: null }));
    await expectCode(
      await call("PUT", `${t.base}/budgets/user/nobody`, actor.auth, { limitMicroCredits: 1 }),
      404,
      "GATEWAY_MEMBER_NOT_FOUND",
    );
    await expectCode(await call("PUT", `${t.base}/budgets/key/gwk_none`, actor.auth, { limitMicroCredits: 1 }), 404, "GATEWAY_KEY_NOT_FOUND");
    await expectCode(await call("PUT", `${t.base}/budgets/tenant/${t.tenantId}`, actor.auth, { limitMicroCredits: 1 }), 400, "GATEWAY_INVALID_REQUEST");
    const key = await json<{ budget: { id: string } }>(
      await call("PUT", `${t.base}/budgets/key/${t.keyId}`, actor.auth, { limitMicroCredits: 2_000_000 }),
    );
    expect(sqlite.prepare(`SELECT budget_id FROM gateway_key WHERE id = ?`).get(t.keyId)).toEqual({ budget_id: key.budget.id });
    const audit = auditRows("tenant_id = ? AND action LIKE 'budget.%'", t.tenantId);
    expect(audit.map((row) => [row.action, row.actor_role])).toEqual([
      ["budget.create", "platform_admin"],
      ["budget.update", "platform_admin"],
      ["budget.create", "platform_admin"],
    ]);
    expect(audit[0]?.reason).toBe("allocation");
    expect(JSON.parse(audit[1]!.before_json!)).toEqual({ limitMicroCredits: 5_000_000, status: "active" });
  });

  it("validates rate limits with the limits schema and persists exactly what d1-limits reads", async () => {
    const t = team();
    const path = `${t.base}/keys/${t.keyId}/rate-limit`;
    for (const rateLimit of [
      {},
      { requestsPerMinute: 0 },
      { requestsPerMinute: 1.5 },
      { requestsPerMinute: -1 },
      { requestsPerMinutes: 10 },
      { concurrency: "4" },
    ])
      await expectCode(await call("PUT", path, platformAdmin.auth, { rateLimit }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("PUT", path, platformAdmin.auth, {}), 400, "GATEWAY_INVALID_REQUEST");
    const limits = { requestsPerMinute: 60, tokensPerMinute: 200_000, concurrency: 4 };
    const set = await json<{ key: { rateLimit: unknown } }>(await call("PUT", path, platformAdmin.auth, { rateLimit: limits }));
    expect(set.key.rateLimit).toEqual(limits);
    expect(JSON.parse((sqlite.prepare(`SELECT rate_limit_json FROM gateway_key WHERE id = ?`).get(t.keyId) as { rate_limit_json: string }).rate_limit_json)).toEqual(limits);
    await json(await call("PUT", path, platformAdmin.auth, { rateLimit: null }));
    expect(sqlite.prepare(`SELECT rate_limit_json FROM gateway_key WHERE id = ?`).get(t.keyId)).toEqual({ rate_limit_json: null });
    const keys = await json<{ keys: Array<Record<string, unknown>> }>(await call("GET", `${t.base}/keys`, platformAdmin.auth));
    expect(JSON.stringify(keys)).not.toContain(sha256(t.keyId));
    expect(auditRows("tenant_id = ? AND action = 'key.rate_limit'", t.tenantId)).toHaveLength(2);
  });

  it("changes team roles through the D1 port (team settings, #354): one owner kept, audited in the same batch", async () => {
    const t = team();
    const admin = createD1TenantAdmin(d1, { clock: monotonicClock() });
    const actor = { userId: t.members.owner.userId, role: "owner" };
    const roleOf = (userId: string) =>
      (sqlite.prepare(`SELECT role FROM tenant_member WHERE tenant_id = ? AND user_id = ?`).get(t.tenantId, userId) as { role: string }).role;
    await expect(admin.setMemberRole({ tenantId: t.tenantId, userId: t.members.owner.userId, role: "member", actor })).rejects.toMatchObject({
      code: "GATEWAY_LAST_OWNER",
    });
    await expect(admin.setMemberRole({ tenantId: t.tenantId, userId: "nobody", role: "owner", actor })).rejects.toMatchObject({
      code: "GATEWAY_MEMBER_NOT_FOUND",
    });
    // No audit row, no change: the promotion rolls back whole.
    await withAuditFailing(() =>
      expect(admin.setMemberRole({ tenantId: t.tenantId, userId: t.members.member.userId, role: "owner", actor })).rejects.toThrow(),
    );
    expect(roleOf(t.members.member.userId)).toBe("member");
    await admin.setMemberRole({ tenantId: t.tenantId, userId: t.members.member.userId, role: "owner", actor });
    await admin.setMemberRole({ tenantId: t.tenantId, userId: t.members.owner.userId, role: "member", actor, reason: "handover" });
    expect([roleOf(t.members.owner.userId), roleOf(t.members.member.userId)]).toEqual(["member", "owner"]);
    expect(
      auditRows("tenant_id = ? AND action = 'member.role'", t.tenantId).map((row) => [JSON.parse(row.after_json!), row.actor_role, row.reason]),
    ).toEqual([
      [{ role: "owner" }, "owner", null],
      [{ role: "member" }, "owner", "handover"],
    ]);
    // D1 refuses any other team role (0038), however it is written.
    expect(() =>
      sqlite.prepare(`UPDATE tenant_member SET role = 'platform_admin' WHERE tenant_id = ? AND user_id = ?`).run(t.tenantId, t.members.owner.userId),
    ).toThrow(/owner or member/);
    expect(() => sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, 'u-x', 'root')`).run(t.tenantId)).toThrow(
      /owner or member/,
    );
  });

  it("adjusts and suspends the wallet (platform only), idempotently and with a reason", async () => {
    const t = team();
    const body = { deltaMicroCredits: 7_000_000, reason: "goodwill credit", idempotencyKey: "adj-1" };
    const first = await json<{ replayed: boolean; wallet: { limitMicroCredits: number } }>(
      await call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, body),
      201,
    );
    expect(first).toMatchObject({ replayed: false, wallet: { limitMicroCredits: 7_000_000 } });
    expect(await json(await call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, body))).toMatchObject({ replayed: true });
    await expectCode(
      await call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, { ...body, deltaMicroCredits: 1 }),
      409,
      "GATEWAY_IDEMPOTENCY_CONFLICT",
    );
    await expectCode(
      await call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, { ...body, deltaMicroCredits: -8_000_000, idempotencyKey: "adj-2" }),
      409,
      "GATEWAY_BUDGET_BELOW_USAGE",
    );
    await expectCode(
      await call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, { ...body, reason: undefined, idempotencyKey: "adj-3" }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    const suspended = await json<{ wallet: { status: string } }>(
      await call("POST", `${t.base}/wallet/status`, platformAdmin.auth, { status: "suspended", reason: "chargeback" }),
    );
    expect(suspended.wallet.status).toBe("suspended");
    expect(auditRows("tenant_id = ? AND action LIKE 'wallet.%'", t.tenantId).map((row) => [row.action, row.reason])).toEqual([
      ["wallet.adjust", "goodwill credit"],
      ["wallet.status", "chargeback"],
    ]);
  });
});

describe("platform catalog and upstreams", () => {
  it("drafts, publishes and freezes catalog versions, enforcing the card schema and DeepSeek Flash only", async () => {
    const version = `c-${hex()}`;
    const model = card();
    const path = `/api/v1/admin/gateway/catalog/versions/${version}/models/${encodeURIComponent(model.id)}`;
    const put = await json<{ model: { modelCode: string; rateLimit: unknown } }>(
      await call("PUT", path, platformAdmin.auth, { card: model, maxOutputTokens: 4096, rateLimit: { requestsPerMinute: 30 } }),
    );
    expect(put.model).toMatchObject({ modelCode: model.id, rateLimit: { requestsPerMinute: 30 } });
    await expectCode(
      await call("PUT", path, platformAdmin.auth, { card: { ...model, id: "other" } }),
      400,
      "GATEWAY_CATALOG_MODEL_INVALID",
    );
    await expectCode(await call("PUT", path, platformAdmin.auth, { card: { id: model.id } }), 400, "GATEWAY_CATALOG_MODEL_INVALID");
    await expectCode(
      await call("PUT", path, platformAdmin.auth, { card: model, rateLimit: { requestsPerMinute: 0 } }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      await call("PUT", `/api/v1/admin/gateway/catalog/versions/${version}/models/deepseek-v4-pro`, platformAdmin.auth, {
        card: { ...model, id: "deepseek-v4-pro" },
      }),
      400,
      "GATEWAY_CATALOG_MODEL_BLOCKED",
    );
    const published = await json<{ version: { status: string } }>(
      await call("POST", `/api/v1/admin/gateway/catalog/versions/${version}/publish`, platformAdmin.auth),
    );
    expect(published.version.status).toBe("published");
    const list = await json<{ versions: Array<{ version: string; live: boolean }> }>(
      await call("GET", "/api/v1/admin/gateway/catalog", platformAdmin.auth),
    );
    expect(list.versions.find((entry) => entry.version === version)?.live).toBe(true);
    await expectCode(await call("PUT", path, platformAdmin.auth, { card: model }), 409, "GATEWAY_CATALOG_VERSION_PUBLISHED");
    await expectCode(await call("DELETE", path, platformAdmin.auth), 409, "GATEWAY_CATALOG_VERSION_PUBLISHED");

    const next = `c-${hex()}`;
    const cloned = await json<{ version: { status: string; models: unknown[] } }>(
      await call("POST", `/api/v1/admin/gateway/catalog/versions/${next}/clone`, platformAdmin.auth, { from: version }),
      201,
    );
    expect(cloned.version).toMatchObject({ status: "draft", models: [expect.objectContaining({ modelCode: model.id })] });
    await json(await call("DELETE", `/api/v1/admin/gateway/catalog/versions/${next}/models/${encodeURIComponent(model.id)}`, platformAdmin.auth));
    await expectCode(await call("GET", `/api/v1/admin/gateway/catalog/versions/${next}`, platformAdmin.auth), 404, "GATEWAY_CATALOG_VERSION_NOT_FOUND");
    expect(auditRows("target_id IN (?, ?, ?, ?)", version, next, `${version}/${model.id}`, `${next}/${model.id}`).map((row) => row.action)).toEqual([
      "catalog.model.create",
      "catalog.publish",
      "catalog.clone",
      "catalog.model.remove",
    ]);
  });

  it("never returns or audits upstream secrets; rotation bumps the key version", async () => {
    const apiKey = `sk-live-${hex()}${hex()}`;
    const rotatedKey = `sk-next-${hex()}${hex()}`;
    const created = await call("POST", "/api/v1/admin/gateway/upstreams", platformAdmin.auth, {
      providerId: "official",
      upstreamId: "openai",
      apiShape: "openai-compatible",
      label: "primary",
      credential: { apiKey, baseUrl: "https://api.example.test/v1" },
    });
    const createdText = await created.clone().text();
    expect(created.status, createdText).toBe(201);
    const { upstream } = (await created.json()) as { upstream: { id: string; credential: Record<string, unknown> } };
    expect(upstream.credential).toEqual({ kind: "sealed", secretRef: null, fields: ["apiKey", "baseUrl"], keyVersion: "v1", rotatedAt: null });
    const sealed = (sqlite.prepare(`SELECT encrypted_credentials FROM gateway_upstream_account WHERE id = ?`).get(upstream.id) as {
      encrypted_credentials: string;
    }).encrypted_credentials;
    expect(sealed).not.toContain(apiKey);

    const rotated = await call("POST", `/api/v1/admin/gateway/upstreams/${upstream.id}/rotate`, platformAdmin.auth, {
      credential: { apiKey: rotatedKey },
      reason: "scheduled rotation",
    });
    const disabled = await call("PATCH", `/api/v1/admin/gateway/upstreams/${upstream.id}`, platformAdmin.auth, { enabled: false });
    const listed = await call("GET", "/api/v1/admin/gateway/upstreams", platformAdmin.auth);
    const rotatedBody = await json<{ upstream: { credential: { keyVersion: string; rotatedAt: string | null } } }>(rotated.clone());
    expect(rotatedBody.upstream.credential.keyVersion).toBe("v2");
    expect(rotatedBody.upstream.credential.rotatedAt).not.toBeNull();
    expect(((await disabled.clone().json()) as { upstream: { enabled: boolean } }).upstream.enabled).toBe(false);
    const audits = auditRows("target_id = ?", upstream.id);
    expect(audits.map((row) => row.action)).toEqual(["upstream.create", "upstream.rotate", "upstream.disable"]);
    expect(audits[1]?.reason).toBe("scheduled rotation");
    const everything = [createdText, await rotated.text(), await disabled.text(), await listed.text(), JSON.stringify(audits)].join("\n");
    for (const secret of [apiKey, rotatedKey, sealed]) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("encrypted");

    // A secret reference needs no encryption key; a sealed key does.
    const { GATEWAY_ENCRYPTION_KEY: _key, ...noKeyEnv } = baseEnv;
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/upstreams", platformAdmin.auth, { providerId: "official", credential: { apiKey } }, noKeyEnv),
      503,
      "GATEWAY_ENCRYPTION_KEY_MISSING",
    );
    const byRef = await json<{ upstream: { credential: { kind: string; secretRef: string } } }>(
      await call(
        "POST",
        "/api/v1/admin/gateway/upstreams",
        platformAdmin.auth,
        { providerId: "official", credential: { secretRef: "GATEWAY_UPSTREAM_OPENAI" } },
        noKeyEnv,
      ),
      201,
    );
    expect(byRef.upstream.credential).toMatchObject({ kind: "secret_ref", secretRef: "GATEWAY_UPSTREAM_OPENAI" });
    for (const credential of [{ secretRef: "BETTER_AUTH_SECRET" }, { apiKey: "short" }, { apiKey, extra: 1 }])
      await expectCode(
        await call("POST", "/api/v1/admin/gateway/upstreams", platformAdmin.auth, { providerId: "official", credential }),
        400,
        "GATEWAY_INVALID_REQUEST",
      );
    await expectCode(await call("PATCH", "/api/v1/admin/gateway/upstreams/gwu_none", platformAdmin.auth, { enabled: false }), 404, "GATEWAY_UPSTREAM_NOT_FOUND");
  });

  it("grants and revokes platform admins with audit, never the last one", async () => {
    const staff = user();
    const granted = await json<{ granted: boolean }>(
      await call("POST", "/api/v1/admin/gateway/platform-admins", platformAdmin.auth, { userId: staff.userId, reason: "on-call" }),
      201,
    );
    expect(granted.granted).toBe(true);
    expect((await json<{ granted: boolean }>(await call("POST", "/api/v1/admin/gateway/platform-admins", platformAdmin.auth, { userId: staff.userId }))).granted).toBe(false);
    // The new admin can now use platform routes, and revoke themselves while another admin remains.
    await json(await call("GET", "/api/v1/admin/gateway/catalog", staff.auth));
    await json(await call("POST", `/api/v1/admin/gateway/platform-admins/${staff.userId}/revoke`, staff.auth, {}));
    await expectCode(await call("GET", "/api/v1/admin/gateway/catalog", staff.auth), 403, "GATEWAY_FORBIDDEN");
    expect(auditRows("target_id = ? AND target_type = 'platform_role'", staff.userId).map((row) => row.action)).toEqual([
      "platform_role.grant",
      "platform_role.revoke",
    ]);
    // Revoking every other admin leaves the last one protected.
    const others = sqlite.prepare(`SELECT user_id FROM gateway_platform_role WHERE user_id <> ?`).all(platformAdmin.userId) as Array<{ user_id: string }>;
    for (const { user_id } of others)
      await json(await call("POST", `/api/v1/admin/gateway/platform-admins/${user_id}/revoke`, platformAdmin.auth, {}));
    await expectCode(
      await call("POST", `/api/v1/admin/gateway/platform-admins/${platformAdmin.userId}/revoke`, platformAdmin.auth, {}),
      409,
      "GATEWAY_LAST_PLATFORM_ADMIN",
    );
  });
});

describe("audit is atomic with every mutation", () => {
  it("rolls each mutation back with a coded error when its audit row cannot be written", async () => {
    const t = team();
    const count = (sql: string, ...args: unknown[]) => (sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n;
    const mutations: Array<[string, () => Response | Promise<Response>, () => number]> = [
      [
        "package",
        () => call("POST", "/api/v1/admin/gateway/packages", platformAdmin.auth, { name: "Atomic", billingPeriod: "month", priceMinor: 1, priceCurrency: "USD", periodMicroCredits: 1 }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_package WHERE name = 'Atomic'`),
      ],
      [
        "price",
        () => call("PUT", "/api/v1/admin/gateway/prices/versions/atomic-v", platformAdmin.auth, { effectiveFrom: new Date().toISOString(), rates: [{ modelCode: "m", unit: "input_token", amountMicroCredits: 1, per: 1 }] }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_price WHERE price_version = 'atomic-v'`),
      ],
      [
        "catalog",
        () => call("PUT", `/api/v1/admin/gateway/catalog/versions/atomic-c/models/${encodeURIComponent(card().id)}`, platformAdmin.auth, { card: card() }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_model WHERE catalog_version = 'atomic-c'`),
      ],
      [
        "upstream",
        () => call("POST", "/api/v1/admin/gateway/upstreams", platformAdmin.auth, { providerId: "atomic", credential: { secretRef: "GATEWAY_UPSTREAM_ATOMIC" } }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_upstream_account WHERE provider_id = 'atomic'`),
      ],
      [
        "budget",
        () => call("PUT", `${t.base}/budgets/user/${t.members.member.userId}`, platformAdmin.auth, { limitMicroCredits: 1 }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_budget WHERE tenant_id = ? AND scope = 'user'`, t.tenantId),
      ],
      [
        "rate limit",
        () => call("PUT", `${t.base}/keys/${t.keyId}/rate-limit`, platformAdmin.auth, { rateLimit: { concurrency: 1 } }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_key WHERE id = ? AND rate_limit_json IS NOT NULL`, t.keyId),
      ],
      [
        "wallet",
        () => call("POST", `${t.base}/wallet/adjust`, platformAdmin.auth, { deltaMicroCredits: 5, reason: "atomic", idempotencyKey: "atomic" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE tenant_id = ? AND kind = 'adjust'`, t.tenantId),
      ],
      [
        "platform role",
        () => call("POST", "/api/v1/admin/gateway/platform-admins", platformAdmin.auth, { userId: "atomic-staff" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_platform_role WHERE user_id = 'atomic-staff'`),
      ],
    ];
    for (const [name, mutate, state] of mutations) {
      const before = state();
      const audits = count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`);
      const res = await withAuditFailing(mutate);
      expect(res.status, `${name}: ${await res.clone().text()}`).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("x-clash-error-code"), name).toMatch(/^GATEWAY_/);
      expect(state(), name).toBe(before);
      expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`), name).toBe(audits);
      // The same mutation succeeds, with its audit row, once the audit store is back.
      expect((await mutate()).status, name).toBeLessThan(300);
      expect(state(), name).not.toBe(before);
      expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`), name).toBe(audits + 1);
    }
  });

  it("rolls back the remaining mutation types the same way", async () => {
    const t = team();
    const admin = platformAdmin.auth;
    const count = (sql: string, ...args: unknown[]) => (sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n;
    const created = async <T>(res: Response | Promise<Response>, status = 201) => json<T>(await res, status);
    // Fixtures, created normally (each with its own audit row) before the audit store fails.
    const pkg = (
      await created<{ package: { id: string } }>(
        call("POST", "/api/v1/admin/gateway/packages", admin, { name: "Atomic2", billingPeriod: "month", priceMinor: 1, priceCurrency: "USD", periodMicroCredits: 5, rateLimit: { concurrency: 4 } }),
      )
    ).package;
    const pack = (
      await created<{ pack: { id: string } }>(
        call("POST", "/api/v1/admin/gateway/topup-packs", admin, { name: "Atomic pack", priceMinor: 1, priceCurrency: "USD", microCredits: 9 }),
      )
    ).pack;
    const upstream = (
      await created<{ upstream: { id: string } }>(
        call("POST", "/api/v1/admin/gateway/upstreams", admin, { providerId: "atomic2", credential: { secretRef: "GATEWAY_UPSTREAM_A2" } }),
      )
    ).upstream;
    const priceVersion = `atomic-p-${hex()}`;
    await json(
      await call("PUT", `/api/v1/admin/gateway/prices/versions/${priceVersion}`, admin, {
        effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
        rates: [{ modelCode: "m", unit: "input_token", amountMicroCredits: 1, per: 1 }],
      }),
    );
    const live = `atomic-live-${hex()}`;
    const model = card();
    const modelPath = (version: string) => `/api/v1/admin/gateway/catalog/versions/${version}/models/${encodeURIComponent(model.id)}`;
    await json(await call("PUT", modelPath(live), admin, { card: model }));
    const draft = `atomic-draft-${hex()}`;
    const staff = user();
    await created(call("POST", "/api/v1/admin/gateway/platform-admins", admin, { userId: staff.userId }));

    const mutations: Array<[string, () => Response | Promise<Response>, () => number]> = [
      [
        "top-up pack",
        () => call("POST", "/api/v1/admin/gateway/topup-packs", admin, { name: "Atomic pack 2", priceMinor: 1, priceCurrency: "USD", microCredits: 1 }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_topup_pack WHERE name = 'Atomic pack 2'`),
      ],
      [
        "price publish",
        () => call("POST", `/api/v1/admin/gateway/prices/versions/${priceVersion}/publish`, admin),
        () => count(`SELECT COUNT(*) AS n FROM gateway_price WHERE price_version = ? AND published_at IS NOT NULL`, priceVersion),
      ],
      [
        "catalog publish",
        () => call("POST", `/api/v1/admin/gateway/catalog/versions/${live}/publish`, admin),
        () => count(`SELECT COUNT(*) AS n FROM gateway_model WHERE catalog_version = ? AND published_at IS NOT NULL`, live),
      ],
      [
        "catalog clone",
        () => call("POST", `/api/v1/admin/gateway/catalog/versions/${draft}/clone`, admin, { from: live }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_model WHERE catalog_version = ?`, draft),
      ],
      [
        "catalog remove",
        () => call("DELETE", modelPath(draft), admin),
        () => count(`SELECT COUNT(*) AS n FROM gateway_model WHERE catalog_version = ?`, draft),
      ],
      [
        "upstream disable",
        () => call("PATCH", `/api/v1/admin/gateway/upstreams/${upstream.id}`, admin, { enabled: false }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_upstream_account WHERE id = ? AND enabled = 0`, upstream.id),
      ],
      [
        "upstream rotate",
        () => call("POST", `/api/v1/admin/gateway/upstreams/${upstream.id}/rotate`, admin, { credential: { secretRef: "GATEWAY_UPSTREAM_A3" } }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_upstream_account WHERE id = ? AND key_version = 'v2'`, upstream.id),
      ],
      [
        "subscribe",
        () => call("POST", `/api/v1/gateway/tenants/${encodeURIComponent(t.tenantId)}/subscription`, t.members.owner.auth, { packageId: pkg.id, idempotencyKey: "atomic-sub" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_tenant_subscription WHERE tenant_id = ?`, t.tenantId),
      ],
      [
        "subscription rate limit",
        () => call("PUT", `${t.base}/subscription/rate-limit`, admin, { rateLimit: { concurrency: 1 }, reason: "abuse" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_tenant_subscription WHERE tenant_id = ? AND rate_limit_json = '{"concurrency":1}'`, t.tenantId),
      ],
      [
        "subscription cancel",
        () => call("POST", `/api/v1/gateway/tenants/${encodeURIComponent(t.tenantId)}/subscription/cancel`, t.members.owner.auth),
        () => count(`SELECT COUNT(*) AS n FROM gateway_tenant_subscription WHERE tenant_id = ? AND cancel_at IS NOT NULL`, t.tenantId),
      ],
      [
        "top-up purchase",
        () => call("POST", `/api/v1/gateway/tenants/${encodeURIComponent(t.tenantId)}/topups`, t.members.owner.auth, { packId: pack.id, idempotencyKey: "atomic-topup" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE tenant_id = ? AND kind = 'topup'`, t.tenantId),
      ],
      [
        "wallet status",
        () => call("POST", `${t.base}/wallet/status`, admin, { status: "suspended", reason: "atomic" }),
        () => count(`SELECT COUNT(*) AS n FROM gateway_budget WHERE tenant_id = ? AND scope = 'tenant' AND status = 'suspended'`, t.tenantId),
      ],
      [
        "package archive",
        () => call("POST", `/api/v1/admin/gateway/packages/${pkg.id}/archive`, admin),
        () => count(`SELECT COUNT(*) AS n FROM gateway_package WHERE id = ? AND status = 'archived'`, pkg.id),
      ],
      [
        "platform revoke",
        () => call("POST", `/api/v1/admin/gateway/platform-admins/${staff.userId}/revoke`, admin, {}),
        () => count(`SELECT COUNT(*) AS n FROM gateway_platform_role WHERE user_id = ?`, staff.userId),
      ],
    ];
    for (const [name, mutate, state] of mutations) {
      const before = state();
      const audits = count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`);
      const res = await withAuditFailing(mutate);
      expect(res.status, `${name}: ${await res.clone().text()}`).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("x-clash-error-code"), name).toMatch(/^GATEWAY_/);
      expect(state(), name).toBe(before);
      expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`), name).toBe(audits);
      const retried = await mutate();
      expect(retried.status, `${name}: ${await retried.clone().text()}`).toBeLessThan(300);
      expect(state(), name).not.toBe(before);
      expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit`), name).toBe(audits + 1);
    }
  });

  it("is append-only: the schema refuses UPDATE and in-retention DELETE, and no route edits rows", async () => {
    const t = team();
    await json(await call("PUT", `${t.base}/keys/${t.keyId}/rate-limit`, platformAdmin.auth, { rateLimit: { concurrency: 2 } }));
    const [row] = auditRows("tenant_id = ?", t.tenantId);
    expect(() => sqlite.prepare(`UPDATE gateway_admin_audit SET reason = 'x' WHERE id = ?`).run((row as unknown as { id: string }).id)).toThrow(/append-only/);
    expect(() => sqlite.prepare(`DELETE FROM gateway_admin_audit WHERE tenant_id = ?`).run(t.tenantId)).toThrow(/13 months/);
    for (const method of ["PUT", "PATCH", "DELETE", "POST"])
      expect((await call(method, "/api/v1/admin/gateway/audit", platformAdmin.auth, {})).status).toBe(404);
  });

  it("filters audit reads by tenant", async () => {
    const a = team();
    const b = team();
    await json(await call("PUT", `${a.base}/keys/${a.keyId}/rate-limit`, platformAdmin.auth, { rateLimit: { concurrency: 2 } }));
    await json(await call("PUT", `${b.base}/keys/${b.keyId}/rate-limit`, platformAdmin.auth, { rateLimit: { concurrency: 3 } }));
    const scoped = await json<{ entries: Array<{ tenantId: string }> }>(
      await call("GET", `/api/v1/admin/gateway/audit?tenantId=${encodeURIComponent(a.tenantId)}`, platformAdmin.auth),
    );
    expect(scoped.entries.length).toBeGreaterThan(0);
    expect(new Set(scoped.entries.map((entry) => entry.tenantId))).toEqual(new Set([a.tenantId]));
    const filtered = await json<{ entries: Array<{ action: string }> }>(
      await call("GET", `/api/v1/admin/gateway/audit?action=key&tenantId=${encodeURIComponent(b.tenantId)}`, platformAdmin.auth),
    );
    expect(filtered.entries.map((entry) => entry.action)).toEqual(["key.rate_limit"]);
    await expectCode(await call("GET", "/api/v1/admin/gateway/audit?limit=0", platformAdmin.auth), 400, "GATEWAY_INVALID_REQUEST");
  });
});

describe("staff prompt access and body retention", () => {
  const bucket = createMemoryBucket();
  const enabled = { ...baseEnv, R2_BUCKET: bucket, GATEWAY_STAFF_PROMPT_ACCESS: "enabled" };
  const access = (requestId: string) => `/api/v1/admin/gateway/prompts/${requestId}/access`;
  const audited = (requestId: string) => auditRows("action = 'prompt.view' AND target_id = ?", requestId);
  const encode = (text: string) => new TextEncoder().encode(text);

  /** Retain one exchange through the same ports the data plane uses. */
  async function retained(tenantId: string, options: { ttlMs?: number } = {}) {
    const requestId = `gwr_${hex()}`;
    const marker = `secret-prompt-${hex()}`;
    const request = JSON.stringify({ model: "m", messages: [{ role: "user", content: marker }] });
    const response = JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply to ${marker}` } }] });
    const outcome = await retainGatewayExchange(gatewayRetentionPorts(enabled), {
      requestId,
      identity: { tenantId, userId: "u-caller", keyId: "gwk_caller" },
      request: { body: encode(request), contentType: "application/json" },
      response: { status: 200, body: encode(response), contentType: "application/json" },
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
    expect(outcome).toEqual({ status: "stored" });
    return { requestId, marker, request, response };
  }

  it("is off without the hosted flag and platform_admin-only with it; refusals write no audit row", async () => {
    const t = team();
    const { requestId } = await retained(t.tenantId);
    await expectCode(await call("POST", access(requestId), platformAdmin.auth, { reason: "incident 42" }, { ...enabled, GATEWAY_STAFF_PROMPT_ACCESS: undefined }), 403, "GATEWAY_PROMPT_ACCESS_DISABLED");
    expect((await json<{ promptAccess: boolean }>(await call("GET", "/api/v1/admin/gateway/me", platformAdmin.auth))).promptAccess).toBe(false);
    expect((await json<{ promptAccess: boolean }>(await call("GET", "/api/v1/admin/gateway/me", platformAdmin.auth, undefined, enabled))).promptAccess).toBe(true);
    // The tenant's own owner and members may not read its prompts.
    for (const role of GATEWAY_TENANT_ROLES) {
      await expectCode(await call("POST", access(requestId), t.members[role].auth, { reason: "x" }, enabled), 403, "GATEWAY_FORBIDDEN");
      expect((await json<{ promptAccess: boolean }>(await call("GET", "/api/v1/admin/gateway/me", t.members[role].auth, undefined, enabled))).promptAccess).toBe(false);
    }
    await expectCode(await call("POST", access(requestId), platformAdmin.auth, {}, enabled), 400, "GATEWAY_INVALID_REQUEST");
    expect(audited(requestId)).toEqual([]);
  });

  it("returns the stored bytes and audits every view with who, request id and reason, never the body", async () => {
    const t = team();
    const { requestId, marker, request, response } = await retained(t.tenantId);
    for (const reason of ["incident 42", "follow-up 43"]) {
      const viewed = await json<{
        prompt: { requestId: string; tenantId: string; keyId: string; request: { body: string; sha256: string; bytes: number }; response: { body: string; sha256: string } };
      }>(await call("POST", access(requestId), platformAdmin.auth, { reason }, enabled));
      expect(viewed.prompt).toMatchObject({ requestId, tenantId: t.tenantId, keyId: "gwk_caller" });
      expect(viewed.prompt.request.body).toBe(request);
      expect(viewed.prompt.response.body).toBe(response);
      expect(viewed.prompt.request.bytes).toBe(encode(request).byteLength);
      expect(viewed.prompt.response.sha256).toBe(sha256(response));
    }
    const rows = audited(requestId);
    expect(rows.map((row) => [row.actor_user_id, row.actor_role, row.tenant_id, row.reason])).toEqual([
      [platformAdmin.userId, "platform_admin", t.tenantId, "incident 42"],
      [platformAdmin.userId, "platform_admin", t.tenantId, "follow-up 43"],
    ]);
    expect(JSON.parse(rows[0]!.after_json!)).toMatchObject({ outcome: "viewed", requestFound: true, responseSha256: sha256(response) });
    const raw = sqlite.prepare(`SELECT * FROM gateway_admin_audit WHERE target_id = ?`).all(requestId) as Array<Record<string, unknown>>;
    expect(raw.every((row) => row.request_id === requestId)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain(marker);
  });

  it("shows a streamed answer cut at the retention cap as truncated, with the size delivered, and audits it", async () => {
    const t = team();
    const requestId = `gwr_${hex()}`;
    const copy = createRetainedBodyCopy(8);
    const delivered = 'data: {"choices":[{"delta":{"content":"long reply"}}]}\n\ndata: [DONE]\n\n';
    copy.append(encode(delivered));
    const { body, truncated } = copy.result();
    expect(
      await retainGatewayExchange(gatewayRetentionPorts(enabled), {
        requestId,
        identity: { tenantId: t.tenantId, userId: "u-caller" },
        request: { body: encode('{"model":"m","stream":true}'), contentType: "application/json" },
        response: { status: 200, body, contentType: "text/event-stream", ...(truncated ? { truncated } : {}) },
      }),
    ).toEqual({ status: "stored", truncated: true });
    const viewed = await json<{ prompt: { response: { body: string; bytes: number; truncated: boolean; observedBytes: number } } }>(
      await call("POST", access(requestId), platformAdmin.auth, { reason: "stream incident" }, enabled),
    );
    expect(viewed.prompt.response).toMatchObject({
      truncated: true,
      observedBytes: encode(delivered).byteLength,
      bytes: body.byteLength,
      body: new TextDecoder().decode(body),
    });
    expect(viewed.prompt.response.body.startsWith(delivered.slice(0, 8))).toBe(true);
    expect(viewed.prompt.response.body).toContain("code=GATEWAY_RETENTION_TRUNCATED");
    expect(JSON.parse(audited(requestId)[0]!.after_json!)).toMatchObject({ outcome: "viewed", responseTruncated: true });
    expect(sqlite.prepare(`SELECT response_truncated, response_observed_bytes FROM gateway_request_retention WHERE request_id = ?`).get(requestId)).toEqual({
      response_truncated: 1,
      response_observed_bytes: encode(delivered).byteLength,
    });
  });

  it("discloses nothing when the audit row cannot be written", async () => {
    const t = team();
    const { requestId, marker } = await retained(t.tenantId);
    const res = await withAuditFailing(() => call("POST", access(requestId), platformAdmin.auth, { reason: "incident" }, enabled));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(marker);
  });

  it("answers GATEWAY_PROMPT_EXPIRED past the 30 days even before purge, and purge is idempotent", async () => {
    const t = team();
    const { requestId } = await retained(t.tenantId, { ttlMs: 0 });
    const keys = gatewayRetentionKeys(requestId);
    expect(bucket.objects.has(keys.request)).toBe(true);
    await expectCode(await call("POST", access(requestId), platformAdmin.auth, { reason: "late" }, enabled), 410, "GATEWAY_PROMPT_EXPIRED");
    expect(JSON.parse(audited(requestId)[0]!.after_json!)).toMatchObject({ outcome: "expired", code: "GATEWAY_PROMPT_EXPIRED" });

    for (const role of GATEWAY_TENANT_ROLES)
      await expectCode(await call("POST", "/api/v1/admin/gateway/retention/purge", t.members[role].auth, {}, enabled), 403, "GATEWAY_FORBIDDEN");
    const first = await json<{ purge: { purged: number; failed: number } }>(
      await call("POST", "/api/v1/admin/gateway/retention/purge", platformAdmin.auth, { limit: 1000 }, enabled),
    );
    expect(first.purge.purged).toBeGreaterThan(0);
    expect(bucket.objects.has(keys.request)).toBe(false);
    expect(bucket.objects.has(keys.response)).toBe(false);
    const row = () => sqlite.prepare(`SELECT status, purged_at FROM gateway_request_retention WHERE request_id = ?`).get(requestId);
    const purged = row();
    expect(purged).toMatchObject({ status: "purged" });
    const purgeAudits = () => auditRows("action = 'retention.purge'").length;
    const auditsAfterFirst = purgeAudits();
    expect(auditsAfterFirst).toBeGreaterThan(0);

    // Again, through the scheduled entry point and the route: nothing left, nothing recorded.
    expect(await purgeGatewayRetention(enabled as never)).toEqual({ purged: 0, failed: 0 });
    const second = await json<{ purge: { purged: number } }>(await call("POST", "/api/v1/admin/gateway/retention/purge", platformAdmin.auth, undefined, enabled));
    expect(second.purge.purged).toBe(0);
    expect(purgeAudits()).toBe(auditsAfterFirst);
    expect(row()).toEqual(purged);
    await expectCode(await call("POST", access(requestId), platformAdmin.auth, { reason: "later" }, enabled), 410, "GATEWAY_PROMPT_EXPIRED");
  });

  it("reports a request that has no retained body as not retained, audited", async () => {
    const t = team();
    const requestId = `gwr_${hex()}`;
    sqlite
      .prepare(
        `INSERT INTO gateway_usage_ledger (id, request_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
         VALUES (?, ?, 'settle', 'settled', ?, 10, 1)`,
      )
      .run(`l_${requestId}`, requestId, t.tenantId);
    await expectCode(await call("POST", access(requestId), platformAdmin.auth, { reason: "incident 42" }, enabled), 404, "GATEWAY_PROMPT_NOT_RETAINED");
    expect(audited(requestId)).toEqual([
      expect.objectContaining({ tenant_id: t.tenantId, actor_user_id: platformAdmin.userId, reason: "incident 42" }),
    ]);
    expect(JSON.parse(audited(requestId)[0]!.after_json!)).toEqual({ outcome: "not_retained", requestFound: true, code: "GATEWAY_PROMPT_NOT_RETAINED" });
  });
});

describe("stale-hold sweep", () => {
  it("is platform_admin-only, expires stale holds once at zero, and audits only a sweep that changed something", async () => {
    const t = team();
    const budgetId = `gwb_sweep_${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, 1000000)`)
      .run(budgetId, t.tenantId, t.tenantId);
    const { budgets } = createD1GatewayBudgetPorts(d1, { clock: { now: () => Date.now() } });
    const requestId = `gwr_${hex()}`;
    await budgets.reserve({ requestId, tenantId: t.tenantId, budgetIds: [budgetId], holdMicroCredits: 9, expiresAt: Date.now() - 5_000 });
    const sweepAudits = () => auditRows("action = 'holds.sweep'").length;
    const auditsBefore = sweepAudits();

    for (const role of ["owner", "admin", "finance"] as const)
      await expectCode(await call("POST", "/api/v1/admin/gateway/holds/sweep", t.members[role].auth, {}), 403, "GATEWAY_FORBIDDEN");
    expect(sqlite.prepare(`SELECT reserved_micro_credits AS reserved FROM gateway_budget WHERE id = ?`).get(budgetId)).toEqual({ reserved: 9 });

    const first = await json<{ sweep: { expired: number; failed: number } }>(
      await call("POST", "/api/v1/admin/gateway/holds/sweep", platformAdmin.auth, { limit: 1000 }),
    );
    expect(first.sweep.expired).toBeGreaterThan(0);
    expect(sqlite.prepare(`SELECT reserved_micro_credits AS reserved, spent_micro_credits AS spent FROM gateway_budget WHERE id = ?`).get(budgetId)).toEqual({
      reserved: 0,
      spent: 0,
    });
    expect(await budgets.settle({
      requestId,
      tenantId: t.tenantId,
      userId: "late",
      modelCode: "m",
      kind: "text",
      upstreamId: "openai",
      credentialScope: "official",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" },
      costMicroCredits: 5,
      priceVersion: "p",
      catalogVersion: "c",
      status: "settled",
      occurredAt: Date.now(),
    })).toMatchObject({ duplicate: true, costMicroCredits: 0 });
    expect(sweepAudits()).toBe(auditsBefore + 1);
    expect(JSON.parse(auditRows("action = 'holds.sweep'").at(-1)!.after_json!)).toMatchObject({ expired: first.sweep.expired, failed: 0 });

    const second = await json<{ sweep: { expired: number } }>(await call("POST", "/api/v1/admin/gateway/holds/sweep", platformAdmin.auth));
    expect(second.sweep.expired).toBe(0);
    expect(sweepAudits()).toBe(auditsBefore + 1);
  });
});

describe("console reads", () => {
  it("serves overview, usage and abuse with tenant scoping", async () => {
    const t = team();
    sqlite
      .prepare(
        `INSERT INTO gateway_usage_ledger (id, request_id, kind, status, tenant_id, amount_micro_credits, model_code, input_tokens, output_tokens, occurred_at)
         VALUES (?, ?, 'settle', 'settled', ?, 1500, 'model-a', 10, 20, ?)`,
      )
      .run(`l_${hex()}`, `gwr_${hex()}`, t.tenantId, Math.floor(Date.now() / 1000));
    const enc = encodeURIComponent(t.tenantId);
    const overview = await json<{ overview: { requests: number; spentMicroCredits: number; tenant: { members: number } } }>(
      await call("GET", `/api/v1/admin/gateway/overview?tenantId=${enc}`, platformAdmin.auth),
    );
    expect(overview.overview).toMatchObject({ requests: 1, spentMicroCredits: 1500, tenant: { members: GATEWAY_TENANT_ROLES.length } });
    const usage = await json<{ entries: Array<{ tenantId: string }>; byModel: Array<{ modelCode: string; amountMicroCredits: number }> }>(
      await call("GET", `/api/v1/admin/gateway/usage?tenantId=${enc}&kind=settle`, platformAdmin.auth),
    );
    expect(usage.entries).toHaveLength(1);
    expect(usage.byModel).toEqual([expect.objectContaining({ modelCode: "model-a", amountMicroCredits: 1500 })]);
    const platform = await json<{ overview: { platform: { tenants: number } } }>(await call("GET", "/api/v1/admin/gateway/overview", platformAdmin.auth));
    expect(platform.overview.platform.tenants).toBeGreaterThan(0);
    const abuse = await json<{ abuse: { events: { available: boolean } } }>(await call("GET", "/api/v1/admin/gateway/abuse", platformAdmin.auth));
    expect(abuse.abuse.events.available).toBe(false);
    await expectCode(await call("GET", `/api/v1/admin/gateway/usage?tenantId=${enc}&from=yesterday`, platformAdmin.auth), 400, "GATEWAY_INVALID_REQUEST");
  });
});
