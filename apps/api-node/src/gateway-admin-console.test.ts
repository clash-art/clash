/**
 * The Node admin listener (#372) over PGlite: the shared console build is
 * served only when GATEWAY_ROLE=admin; gateway-core's admin gate refuses a
 * missing or wrong-kind credential; the role matrix decides each admin route
 * (support_agent never reaches keys, prices or the key ring); `/me` reports
 * only permissions this listener answers; and the budget, usage, key ring and
 * abuse views read and rotate through the same listener.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { adminRolePermissions, type GatewayAdminAccountIdentity } from "@clash/gateway-core";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGatewayAdminListener,
  loadAdminWebBuild,
  NODE_ADMIN_SERVED_PERMISSIONS,
  withGatewayAdminListener,
} from "./gateway-admin-console.ts";
import { createPgGatewayBilling, createPgGatewayPriceBook } from "./gateway-billing.ts";
import { createGatewayBillingAdminRoutes } from "./gateway-billing-routes.ts";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyAdminRoutes } from "./gateway-key-admin.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  const client = (q: Pick<PGlite, "query">): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return { ...client(pglite), transaction: (work) => pglite.transaction((tx) => work(client(tx))) };
}

const NOW_MS = Date.parse("2026-10-20T12:00:00Z");
const NOW_S = NOW_MS / 1000;
const TENANT = "team:acme";

const buildDir = mkdtempSync(join(tmpdir(), "clash-admin-build-"));
mkdirSync(join(buildDir, "_app"));
writeFileSync(join(buildDir, "index.html"), "<!doctype html><title>Clash</title><div id=root></div>");
writeFileSync(join(buildDir, "_app", "entry-abc123.js"), "console.log('console')");
writeFileSync(join(buildDir, "favicon.svg"), "<svg/>");
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

/** Admin sessions by cookie value: what admin-auth.ts's verifier resolves. */
const SESSIONS: Record<string, GatewayAdminAccountIdentity> = {
  "sess-admin": { id: "adm_root", email: "root@admin.test", name: "Root", role: "platform_admin" },
  "sess-support": { id: "adm_support", email: "support@admin.test", name: "Support", role: "support_agent" },
};
const adminCookie = (session: string) => ({ cookie: `clash-admin.session_token=${session}` });

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

describe("Node admin listener", () => {
  let db: GatewayBudgetDatabase;
  let listener: Hono;
  let verifierCalls: number;

  beforeEach(async () => {
    const pglite = new PGlite();
    await migrateDatabase(pglite);
    db = adapt(pglite);
    verifierCalls = 0;
    const ring = createGatewayKeyRing({
      keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
      current: "k1",
    });
    const billing = createPgGatewayBilling({ db });
    listener = createGatewayAdminListener({
      db,
      billing,
      build: loadAdminWebBuild(buildDir),
      clock: { now: () => NOW_MS },
      verifyAdminSession: async (request) => {
        verifierCalls += 1;
        const token = /clash-admin\.session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
        return (token && SESSIONS[token]) || null;
      },
      adminAuthHandler: async () => Response.json({ handledBy: "admin-auth" }),
      routes: (verifyAdmin) => [
        createGatewayBillingAdminRoutes({ billing, priceBook: createPgGatewayPriceBook({ db }), verifyAdmin }),
        createGatewayKeyAdminRoutes({
          db,
          ring,
          store: createPgGatewayCredentialStore({ db, ring }),
          verifyAdmin,
          now: () => NOW_S,
        }),
      ],
    });

    await db.query(`INSERT INTO tenant (id, owner_user_id, name) VALUES ($1, 'usr_owner', 'Acme')`, [TENANT]);
    await db.query(
      `INSERT INTO tenant_member (tenant_id, user_id, role) VALUES ($1, 'usr_owner', 'owner'), ($1, 'usr_ann', 'member')`,
      [TENANT],
    );
    await db.query(
      `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits, created_at, updated_at)
       VALUES ('b_wallet', $1, 'tenant', $1, 10000000, 2000000, $2, $2), ('b_key', $1, 'key', 'gwk_1', 1000000, 0, $2, $2)`,
      [TENANT, NOW_S],
    );
    await db.query(
      `INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix, label, created_at)
       VALUES ('gwk_1', $1, 'usr_ann', 'hash-never-shown', 'sk_gw_ab', 'ci', $2)`,
      [TENANT, NOW_S],
    );
    // One request settled against two budgets (wallet and key): one request in every view.
    for (const budget of ["b_wallet", "b_key"])
      await db.query(
        `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
           amount_micro_credits, model_code, input_tokens, output_tokens, occurred_at, created_at)
         VALUES ($1, 'req_1', $2, 'charge', 'settled', $3, 'usr_ann', 'gwk_1', 1500, 'gpt-test', 10, 20, $4, $4)`,
        [`led_${budget}`, budget, TENANT, NOW_S - 60],
      );
    await db.query(`INSERT INTO gateway_rate_window (subject, window_start, requests, tokens) VALUES ('key:gwk_1', $1, 7, 70)`, [
      NOW_S - 60,
    ]);
    await db.query(
      `INSERT INTO gateway_upstream_credential (id, scope, provider_id, encrypted_credentials, key_version, created_at, updated_at)
       VALUES ('cred_1', 'official', 'openai', 'v2.k1.sealed', 'k1', $1, $1)`,
      [NOW_S],
    );
  });

  const get = (path: string, headers: Record<string, string> = adminCookie("sess-admin")) => listener.request(path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = adminCookie("sess-admin")) =>
    listener.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  describe("the console build", () => {
    it("serves index.html for every console path and the build's assets", async () => {
      for (const path of ["/admin", "/admin/usage", "/admin/encryption"]) {
        const page = await listener.request(path);
        expect(page.status, path).toBe(200);
        expect(await page.text()).toContain('<div id=root>');
        expect(page.headers.get("cache-control")).toBe("no-store");
      }
      const asset = await listener.request("/_app/entry-abc123.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect((await listener.request("/favicon.svg")).status).toBe(200);
      expect((await listener.request("/_app/missing.js")).status).toBe(404);
    });

    it("is served by the admin role only: other roles never build the listener", async () => {
      const product = new Hono().all("*", (c) => c.text("product", 404));
      for (const role of ["api", "worker"] as const) {
        let built = false;
        const root = withGatewayAdminListener(role, product, () => {
          built = true;
          return listener;
        });
        for (const path of ["/admin", "/_app/entry-abc123.js", "/api/v1/admin/gateway/me"]) {
          const response = await root.request(path, { headers: adminCookie("sess-admin") });
          expect([role, path, response.status, await response.text()]).toEqual([role, path, 404, "product"]);
        }
        expect(built).toBe(false);
      }
      const admin = withGatewayAdminListener("admin", product, () => listener);
      expect((await admin.request("/admin")).status).toBe(200);
      // Paths the listener does not own still reach the product routes.
      expect(await (await admin.request("/api/v1/projects")).text()).toBe("product");
    });

    it("fails the start without a build", () => {
      expect(() => loadAdminWebBuild(undefined)).toThrow("GATEWAY_ADMIN_WEB_DIR");
      expect(() => loadAdminWebBuild(join(buildDir, "_app"))).toThrow("no index.html");
    });
  });

  describe("the admin gate", () => {
    it("routes /api/admin-auth/* to the admin identity's own Better Auth", async () => {
      expect(await json(await post("/api/admin-auth/sign-in/email", {}, {}))).toEqual({ handledBy: "admin-auth" });
    });

    it("refuses no credential with 401, and a token or product session with 403 GATEWAY_ADMIN_SESSION_REQUIRED", async () => {
      const none = await get("/api/v1/admin/gateway/me", {});
      expect(none.status).toBe(401);
      expect((await json(none)).error.code).toBe("GATEWAY_AUTH_REQUIRED");
      // A token is refused even next to a valid admin session, before any session lookup.
      const token = await get("/api/v1/admin/gateway/me", { ...adminCookie("sess-admin"), authorization: "Bearer sk_gw_x" });
      expect(token.status).toBe(403);
      expect((await json(token)).error).toMatchObject({ code: "GATEWAY_ADMIN_SESSION_REQUIRED" });
      expect(verifierCalls).toBe(0);
      const product = await get("/api/v1/admin/gateway/tenants", { cookie: "better-auth.session_token=user" });
      expect(product.status).toBe(403);
      expect((await json(product)).error.code).toBe("GATEWAY_ADMIN_SESSION_REQUIRED");
      // A browser signed in to both: the admin session decides.
      const both = await get("/api/v1/admin/gateway/me", { cookie: "better-auth.session_token=user; clash-admin.session_token=sess-admin" });
      expect(both.status).toBe(200);
    });

    it("gates the mounted billing and key ring routes too", async () => {
      for (const path of ["/api/v1/admin/gateway/packages", "/api/v1/admin/gateway/encryption"])
        expect((await get(path, {})).status, path).toBe(401);
    });

    it("answers an admin path this host does not serve with a coded 501, never a product route", async () => {
      const catalog = await get("/api/v1/admin/gateway/catalog");
      expect(catalog.status).toBe(501);
      expect((await json(catalog)).error.code).toBe("GATEWAY_CAPABILITY_UNAVAILABLE");
    });
  });

  describe("role gating", () => {
    it("reports to /me the role's permissions this listener serves", async () => {
      for (const [session, role] of [
        ["sess-admin", "platform_admin"],
        ["sess-support", "support_agent"],
      ] as const) {
        const me = await json(await get("/api/v1/admin/gateway/me", adminCookie(session)));
        expect(me.admin).toEqual({ ...SESSIONS[session], role });
        expect(me.permissions).toEqual(adminRolePermissions(role).filter((p) => NODE_ADMIN_SERVED_PERMISSIONS.has(p)));
        expect(me.promptAccess).toBe(false);
      }
    });

    it("lets support_agent read tenants, budgets, usage and abuse, and refuses keys, prices and the key ring", async () => {
      const support = adminCookie("sess-support");
      for (const path of [
        "/api/v1/admin/gateway/tenants",
        `/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/members`,
        `/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/budgets`,
        "/api/v1/admin/gateway/usage",
        "/api/v1/admin/gateway/overview",
        "/api/v1/admin/gateway/abuse",
      ])
        expect((await get(path, support)).status, path).toBe(200);
      const keys = await get(`/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/keys`, support);
      expect(keys.status).toBe(403);
      expect((await json(keys)).error).toMatchObject({ code: "GATEWAY_FORBIDDEN" });
      for (const path of ["/api/v1/admin/gateway/encryption", "/api/v1/admin/gateway/packages", "/api/v1/admin/gateway/prices"]) {
        const refused = await get(path, support);
        expect(refused.status, path).toBe(403);
        expect((await json(refused)).error.code, path).toBe("GATEWAY_FORBIDDEN");
      }
      const rotate = await post("/api/v1/admin/gateway/encryption/rotate", { kid: "k2" }, support);
      expect(rotate.status).toBe(403);
      const adjust = await post(
        `/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/wallet/adjust`,
        { deltaMicroCredits: 1, reason: "x", idempotencyKey: "k" },
        support,
      );
      expect(adjust.status).toBe(403);
    });
  });

  describe("the console's views", () => {
    it("budgets: the tenant's budgets and wallet", async () => {
      const result = await json(await get(`/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/budgets`));
      expect(result.budgets.map((b: { id: string }) => b.id)).toEqual(["b_wallet", "b_key"]);
      expect(result.budgets[0]).toMatchObject({ scope: "tenant", limitMicroCredits: 10_000_000, spentMicroCredits: 2_000_000 });
      const missing = await get("/api/v1/admin/gateway/tenants/team%3Anone/budgets");
      expect(missing.status).toBe(404);
      expect((await json(missing)).error.code).toBe("GATEWAY_TENANT_NOT_FOUND");
    });

    it("usage and overview: one entry per settled request, filtered by tenant", async () => {
      const usage = await json(await get(`/api/v1/admin/gateway/usage?tenantId=${encodeURIComponent(TENANT)}`));
      expect(usage.entries).toHaveLength(1);
      expect(usage.entries[0]).toMatchObject({ requestId: "req_1", kind: "charge", keyId: "gwk_1", amountMicroCredits: 1500 });
      expect(usage.byModel).toEqual([{ modelCode: "gpt-test", requests: 1, amountMicroCredits: 1500, inputTokens: 10, outputTokens: 20 }]);
      expect((await json(await get("/api/v1/admin/gateway/usage?tenantId=team%3Aother"))).entries).toEqual([]);
      const { overview } = await json(await get(`/api/v1/admin/gateway/overview?tenantId=${encodeURIComponent(TENANT)}`));
      expect(overview).toMatchObject({ requests: 1, spentMicroCredits: 1500, failedRequests: 0, tenant: { members: 2, activeKeys: 1 } });
      const bad = await get("/api/v1/admin/gateway/usage?limit=0");
      expect(bad.status).toBe(400);
      expect((await json(bad)).error.code).toBe("GATEWAY_INVALID_REQUEST");
    });

    it("keys: the tenant's virtual keys, never their hashes", async () => {
      const response = await get(`/api/v1/admin/gateway/tenants/${encodeURIComponent(TENANT)}/keys`);
      const text = await response.text();
      expect(text).not.toContain("hash-never-shown");
      expect(JSON.parse(text).keys).toEqual([
        expect.objectContaining({ id: "gwk_1", name: "ci", tokenPrefix: "sk_gw_ab", budgetId: "b_key", revokedAt: null }),
      ]);
    });

    it("abuse: the live rate counters, and says no signal is measured", async () => {
      const { abuse } = await json(await get("/api/v1/admin/gateway/abuse"));
      expect(abuse.rateWindows).toEqual([expect.objectContaining({ subject: "key:gwk_1", requests: 7, tokens: 70 })]);
      expect(abuse.events.available).toBe(false);
      expect(abuse.signals).toEqual([]);
    });

    it("key rotation: reads the ring and rotates it, audited as the signed-in admin account", async () => {
      const ring = await json(await get("/api/v1/admin/gateway/encryption"));
      expect(ring).toEqual({ current: "k1", ringKids: ["k1", "k2"], envelopes: [{ kid: "k1", scope: "official", count: 1 }] });
      const rotated = await post("/api/v1/admin/gateway/encryption/rotate", { kid: "k2" });
      expect(rotated.status).toBe(200);
      expect(await json(rotated)).toMatchObject({ previous: "k1", current: "k2" });
      const { rows } = await db.query<{ actor_kind: string; actor_id: string; action: string }>(
        `SELECT actor_kind, actor_id, action FROM gateway_admin_audit WHERE action = 'gateway.encryption.rotate'`,
      );
      expect(rows).toEqual([{ actor_kind: "admin", actor_id: "adm_root", action: "gateway.encryption.rotate" }]);
      const unknown = await post("/api/v1/admin/gateway/encryption/rotate", { kid: "k9" });
      expect(unknown.status).toBe(400);
      expect((await json(unknown)).error.code).toBe("GATEWAY_INVALID_REQUEST");
    });
  });
});
