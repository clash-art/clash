/**
 * Admin identity, separate from product users (#394), through the Worker app
 * on node:sqlite with every migration applied:
 *
 * - admin login, session and logout run on the admin Better Auth instance
 *   (/api/admin-auth/*, `clash-admin.*` cookies, admin_* tables), never the
 *   product one; sign-up is closed and a disabled account cannot sign in;
 * - every /api/v1/admin/* route, read from the route table, refuses no
 *   credential with GATEWAY_AUTH_REQUIRED (401) and any product credential
 *   (session, clsh_, sk_gw_, spoofed x-user-id) with
 *   GATEWAY_ADMIN_SESSION_REQUIRED (403);
 * - every product /api/v1 route, read from the route table, refuses a request
 *   whose only credential is an admin session with ADMIN_SESSION_NOT_ACCEPTED
 *   (403), and the admin session never resolves as a product user;
 * - admin accounts are created and disabled through the audited API, the
 *   audit actor is the admin account, and the last enabled one stays.
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
import { adminSignIn, cookiesFrom, seedAdminAccount, signedInAdmin } from "../../../services/admin-session.test-support";
import { adminRolePermissions } from "../../../services/gateway-authz";
import { v1Routes } from "../index";
import { adminGatewayRoutes } from "./gateway";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();
const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-admin-identity-0123456789",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env as never,
  );
}

async function expectCode(res: Response, status: number, code: string, label = "") {
  const text = await res.clone().text();
  expect(res.status, `${label} ${text}`).toBe(status);
  expect(res.headers.get("x-clash-error-code"), `${label} ${text}`).toBe(code);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** A product user signed in through the product Better Auth instance, with a clsh_ token. */
async function productUser() {
  const email = `user-${crypto.randomUUID()}@example.test`;
  const res = await call("POST", "/api/better-auth/sign-up/email", {}, { email, password: "product-password-123", name: "Product" });
  expect(res.status, await res.clone().text()).toBe(200);
  const { id } = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'p', ?, 'clsh_pp', 1)")
    .run(`tok-${crypto.randomUUID()}`, id, sha256(raw));
  return { userId: id, email, cookie: cookiesFrom(res), token: raw };
}

const bodyFor = (method: string) => (method === "GET" || method === "HEAD" ? undefined : {});

const auditCount = () => (sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_admin_audit`).get() as { n: number }).n;

/** Concrete request paths for a Hono route table: every parameter filled in. */
function concrete(routes: ReadonlyArray<{ method: string; path: string }>, prefix: string): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const route of routes) {
    const path = `${prefix}${route.path}`
      .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, "adm_x")
      .replace(/\*+/g, "x")
      .replace(/\/+$/, "");
    const method = route.method === "ALL" ? "GET" : route.method;
    const key = `${method} ${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([method, path || "/"]);
    }
  }
  return out;
}

describe("admin login, session and logout (admin Better Auth instance)", () => {
  it("signs in with an admin account, sets only clash-admin cookies, and /me describes the account", async () => {
    const admin = await seedAdminAccount(d1, { email: "Ops@Admin.Test", name: "Ops" });
    const { response, cookie } = await adminSignIn(app, env, { email: "ops@admin.test", password: admin.password }, ORIGIN);
    expect(response.status, await response.clone().text()).toBe(200);
    const names = response.headers.getSetCookie().map((line) => line.split("=")[0]);
    expect(names).toContain("clash-admin.session_token");
    expect(names.some((name) => name.includes("better-auth"))).toBe(false);
    const me = await json<{ admin: { id: string; email: string; role: string }; permissions: string[]; promptAccess: boolean }>(
      await call("GET", "/api/v1/admin/gateway/me", { cookie }),
    );
    expect(me.admin).toEqual({ id: admin.id, email: "ops@admin.test", name: "Ops", role: "platform_admin" });
    expect(me.permissions).toEqual([...adminRolePermissions("platform_admin")]);
    expect(me.promptAccess).toBe(false);
    // The session lives in the admin store, not the product one.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id = ?`).get(admin.id)).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).get(admin.id)).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ? OR email = ?`).get(admin.id, admin.email)).toEqual({ n: 0 });
    const session = await json<{ user: { id: string } } | null>(await call("GET", "/api/admin-auth/get-session", { cookie }));
    expect(session?.user.id).toBe(admin.id);
  });

  it("refuses a wrong password or an unknown email with Better Auth's coded 401, and keeps sign-up closed", async () => {
    const admin = await seedAdminAccount(d1);
    for (const credentials of [
      { email: admin.email, password: `${admin.password}-wrong` },
      { email: "nobody@admin.test", password: admin.password },
    ]) {
      const { response, cookie } = await adminSignIn(app, env, credentials, ORIGIN);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(cookie).toBe("");
    }
    const signUp = await call("POST", "/api/admin-auth/sign-up/email", {}, { email: "new@admin.test", password: "a-long-password-1", name: "N" });
    expect(signUp.status).toBe(400);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_accounts WHERE email = 'new@admin.test'`).get()).toEqual({ n: 0 });
  });

  it("rate-limits sign-in attempts per client address", async () => {
    const admin = await seedAdminAccount(d1);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1)
      statuses.push((await adminSignIn(app, env, { email: admin.email, password: "wrong-password-0" }, ORIGIN, "10.9.9.9")).response.status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await adminSignIn(app, env, admin, ORIGIN)).response.status).toBe(200);
  });

  it("does not accept product credentials at the admin sign-in", async () => {
    const user = await productUser();
    const { response } = await adminSignIn(app, env, { email: user.email, password: "product-password-123" }, ORIGIN);
    expect(response.status).toBe(401);
  });

  it("signs out: the session row is deleted and the cookie no longer opens the console", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    await json(await call("GET", "/api/v1/admin/gateway/me", admin.auth));
    const out = await call("POST", "/api/admin-auth/sign-out", admin.auth, {});
    expect(out.status, await out.clone().text()).toBe(200);
    expect(out.headers.getSetCookie().some((line) => line.startsWith("clash-admin.session_token=;"))).toBe(true);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id = ?`).get(admin.id)).toEqual({ n: 0 });
    await expectCode(await call("GET", "/api/v1/admin/gateway/me", admin.auth), 401, "GATEWAY_AUTH_REQUIRED");
  });
});

describe("isolation, enforced by the server for every route", () => {
  const adminRoutes = (): Array<[string, string]> => [
    ...concrete(adminGatewayRoutes.routes, "/api/v1/admin/gateway"),
    ["GET", "/api/v1/admin"],
    ["POST", "/api/v1/admin/unknown"],
  ];

  it("reads a non-trivial admin route table", () => {
    const routes = adminRoutes();
    expect(routes).toEqual(expect.arrayContaining([["GET", "/api/v1/admin/gateway/me"], ["GET", "/api/v1/admin/gateway/catalog"]]));
    expect(routes.length).toBeGreaterThan(30);
  });

  it("refuses a product session or token on every /api/v1/admin/* route (403) and no credential (401), writing nothing", async () => {
    const user = await productUser();
    const admin = await signedInAdmin(app, env, ORIGIN);
    const before = auditCount();
    const product: Array<[string, Record<string, string>]> = [
      ["product session", { cookie: user.cookie }],
      ["clsh_ token", { authorization: `Bearer ${user.token}` }],
      ["sk_gw_ token", { authorization: `Bearer sk_gw_${"a".repeat(40)}` }],
      ["x-api-key", { "x-api-key": `sk_gw_${"b".repeat(40)}` }],
      ["admin cookie with a clsh_ token", { ...admin.auth, authorization: `Bearer ${user.token}` }],
    ];
    for (const [method, path] of adminRoutes()) {
      const body = bodyFor(method);
      await expectCode(await call(method, path, {}, body), 401, "GATEWAY_AUTH_REQUIRED", `${method} ${path} anonymous`);
      // A caller header is never identity.
      await expectCode(await call(method, path, { "x-user-id": user.userId }, body), 401, "GATEWAY_AUTH_REQUIRED", `${method} ${path} x-user-id`);
      for (const [label, headers] of product)
        await expectCode(await call(method, path, headers, body), 403, "GATEWAY_ADMIN_SESSION_REQUIRED", `${method} ${path} ${label}`);
    }
    expect(auditCount()).toBe(before);
  });

  it("lets the admin session through every admin route's identity gate", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    // A browser signed in to both carries both cookies: the admin one decides.
    const both = { cookie: `${admin.auth.cookie}; ${(await productUser()).cookie}` };
    for (const [method, path] of adminRoutes())
      for (const headers of [admin.auth, both]) {
        const res = await call(method, path, headers, bodyFor(method));
        expect(["GATEWAY_AUTH_REQUIRED", "GATEWAY_ADMIN_SESSION_REQUIRED", "GATEWAY_FORBIDDEN"], `${method} ${path}`).not.toContain(
          res.headers.get("x-clash-error-code"),
        );
      }
  });

  it("refuses an admin session on every product /api/v1 route (403 ADMIN_SESSION_NOT_ACCEPTED)", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    // The web gateway asks api-cf to fail closed on /api/v1/* (except two public endpoints).
    const required = { "x-clash-require-identity": "1" };
    const routes = concrete(v1Routes.routes, "/api/v1").filter(
      ([, path]) => !path.startsWith("/api/v1/admin") && path !== "/api/v1/cloud" && path !== "/api/v1/cli-auth/token",
    );
    expect(routes.length).toBeGreaterThan(30);
    for (const [method, path] of routes) {
      const res = await call(method, path, { ...admin.auth, ...required }, bodyFor(method));
      await expectCode(res, 403, "ADMIN_SESSION_NOT_ACCEPTED", `${method} ${path}`);
    }
  });

  it("never resolves an admin session as a product user, on any product surface", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    for (const path of ["/api/v1/me", "/api/v1/projects", "/api/projects", "/loro/p1/snapshot"])
      expect((await call("GET", path, admin.auth)).status, path).toBe(401);
    // With a product session as well, the product user is the identity, never the admin.
    const user = await productUser();
    const me = await json<{ id: string }>(await call("GET", "/api/v1/me", { cookie: `${admin.auth.cookie}; ${user.cookie}` }));
    expect(me.id).toBe(user.userId);
  });
});

describe("admin accounts through the audited API", () => {
  it("creates an account that can sign in, audits it with the admin account as actor, and never stores or returns the password", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    const email = `second-${crypto.randomUUID()}@admin.test`;
    const password = `second-password-${crypto.randomUUID()}`;
    const created = await json<{ account: { id: string; email: string; disabledAt: string | null } }>(
      await call("POST", "/api/v1/admin/gateway/admin-accounts", admin.auth, { email, name: "Second", password, reason: "on-call" }),
      201,
    );
    expect(created.account).toMatchObject({ email, disabledAt: null });
    expect(created.account.id).toMatch(/^adm_/);
    expect(JSON.stringify(created)).not.toContain(password);
    const rows = sqlite
      .prepare(`SELECT actor_kind, actor_id, actor_role, action, target_id, after_json, reason FROM gateway_admin_audit WHERE target_id = ?`)
      .all(created.account.id);
    expect(rows).toEqual([
      {
        actor_kind: "admin",
        actor_id: admin.id,
        actor_role: "platform_admin",
        action: "admin_account.create",
        target_id: created.account.id,
        after_json: JSON.stringify({ email, name: "Second", role: "platform_admin" }),
        reason: "on-call",
      },
    ]);
    const second = await adminSignIn(app, env, { email, password }, ORIGIN);
    expect(second.response.status).toBe(200);
    await json(await call("GET", "/api/v1/admin/gateway/catalog", { cookie: second.cookie }));
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/admin-accounts", admin.auth, { email, name: "Again", password }),
      409,
      "GATEWAY_ADMIN_ACCOUNT_EXISTS",
    );
    for (const bad of [{ email, name: "x", password: "short" }, { email: "not-an-email", name: "x", password }, { email, name: "x", password, role: "root" }])
      await expectCode(await call("POST", "/api/v1/admin/gateway/admin-accounts", admin.auth, bad), 400, "GATEWAY_INVALID_REQUEST");
  });

  it("records the admin account as the actor of console mutations", async () => {
    const admin = await signedInAdmin(app, env, ORIGIN);
    const upstream = await json<{ upstream: { id: string } }>(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, { providerId: `p-${crypto.randomUUID()}`, credential: { secretRef: "GATEWAY_UPSTREAM_X" } }),
      201,
    );
    expect(
      sqlite.prepare(`SELECT actor_kind, actor_id, actor_role FROM gateway_admin_audit WHERE target_id = ?`).all(upstream.upstream.id),
    ).toEqual([{ actor_kind: "admin", actor_id: admin.id, actor_role: "platform_admin" }]);
    const audit = await json<{ entries: Array<{ actorKind: string; actorId: string }> }>(
      await call("GET", `/api/v1/admin/gateway/audit?actorKind=admin&actorId=${admin.id}`, admin.auth),
    );
    expect(audit.entries).toEqual([expect.objectContaining({ actorKind: "admin", actorId: admin.id })]);
  });

  it("disables an account: signed out at once, cannot sign in again, audited; the last enabled account stays", async () => {
    sqlite.exec(`UPDATE admin_accounts SET disabled_at = 1 WHERE disabled_at IS NULL`);
    const first = await signedInAdmin(app, env, ORIGIN);
    const second = await signedInAdmin(app, env, ORIGIN);
    const disabled = await json<{ disabled: boolean }>(
      await call("POST", `/api/v1/admin/gateway/admin-accounts/${second.id}/disable`, first.auth, { reason: "left" }),
    );
    expect(disabled.disabled).toBe(true);
    await expectCode(await call("GET", "/api/v1/admin/gateway/me", second.auth), 401, "GATEWAY_AUTH_REQUIRED");
    expect((await adminSignIn(app, env, second, ORIGIN)).response.status).toBe(401);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id = ?`).get(second.id)).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM admin_credentials WHERE admin_id = ?`).get(second.id)).toEqual({ n: 0 });
    // Again is a no-op, unknown is coded.
    expect((await json<{ disabled: boolean }>(await call("POST", `/api/v1/admin/gateway/admin-accounts/${second.id}/disable`, first.auth, {}))).disabled).toBe(false);
    await expectCode(await call("POST", `/api/v1/admin/gateway/admin-accounts/adm_none/disable`, first.auth, {}), 404, "GATEWAY_ADMIN_ACCOUNT_NOT_FOUND");
    // `first` is now the only enabled account.
    await expectCode(await call("POST", `/api/v1/admin/gateway/admin-accounts/${first.id}/disable`, first.auth, {}), 409, "GATEWAY_LAST_ADMIN_ACCOUNT");
    await json(await call("GET", "/api/v1/admin/gateway/me", first.auth));
    expect(
      sqlite.prepare(`SELECT actor_kind, actor_id, action, reason FROM gateway_admin_audit WHERE target_id = ? ORDER BY rowid`).all(second.id),
    ).toEqual([{ actor_kind: "admin", actor_id: first.id, action: "admin_account.disable", reason: "left" }]);
    const accounts = await json<{ accounts: Array<{ id: string; disabledAt: string | null }> }>(
      await call("GET", "/api/v1/admin/gateway/admin-accounts", first.auth),
    );
    expect(accounts.accounts.find((account) => account.id === second.id)?.disabledAt).not.toBeNull();
  });

  it("refuses a disabled account a session even with the right password", async () => {
    const admin = await seedAdminAccount(d1);
    // Disabled out of band, password still present: the session hook refuses.
    sqlite.prepare(`UPDATE admin_accounts SET disabled_at = ? WHERE id = ?`).run(Date.now(), admin.id);
    const { response, cookie } = await adminSignIn(app, env, admin, ORIGIN);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ADMIN_ACCOUNT_DISABLED");
    expect(cookie).toBe("");
  });
});
