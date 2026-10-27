/**
 * Shared /admin console on the Node admin listener (#372): SPA assets only
 * when mounted (GATEWAY_ROLE=admin), dual auth (gwa_ token + admin session),
 * and overview / usage / encryption / abuse views through createGatewayAdminApp.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { presentsGatewayAdminSession, type GatewayAdminAccountIdentity } from "@clash/gateway-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createGatewayAdminApp } from "./gateway-admin.ts";
import { loadAdminWebBuild, mountAdminConsole } from "./gateway-admin-console.ts";
import { createPgGatewayAdminTokens } from "./gateway-admin-tokens.ts";
import { createPgGatewayBilling, createPgGatewayPriceBook } from "./gateway-billing.ts";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createGatewayKeyRing } from "./gateway-keyring.ts";
import { migrateDatabase } from "./migrations.ts";
import { Hono } from "hono";

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

const SESSIONS: Record<string, GatewayAdminAccountIdentity> = {
  "sess-admin": { id: "adm_root", email: "root@admin.test", name: "Root", role: "platform_admin" },
};
const adminCookie = (session: string) => ({ cookie: `clash-admin.session_token=${session}` });

describe("Node admin console (#372)", () => {
  let db: GatewayBudgetDatabase;
  let app: ReturnType<typeof createGatewayAdminApp>;
  let gwaToken: string;

  beforeEach(async () => {
    const pglite = new PGlite();
    await migrateDatabase(pglite);
    db = adapt(pglite);
    const ring = createGatewayKeyRing({
      keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
      current: "k1",
    });
    const tokens = createPgGatewayAdminTokens({ db, now: () => NOW_MS });
    gwaToken = (
      await tokens.issue({
        role: "platform_admin",
        actor: { kind: "bootstrap", id: "bootstrap", role: "bootstrap" },
      })
    ).token;
    app = createGatewayAdminApp({
      db,
      tokens,
      billing: createPgGatewayBilling({ db }),
      priceBook: createPgGatewayPriceBook({ db }),
      keyRing: { ring, store: createPgGatewayCredentialStore({ db, ring }) },
      now: () => NOW_MS,
      console: {
        build: loadAdminWebBuild(buildDir),
        adminAuthHandler: async () => Response.json({ handledBy: "admin-auth" }),
        verifyAdminSession: async (request) => {
          if (!presentsGatewayAdminSession(request)) return null;
          const token = /clash-admin\.session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
          return (token && SESSIONS[token]) || null;
        },
      },
    });

    await db.query(`INSERT INTO tenant (id, owner_user_id, name) VALUES ($1, 'usr_owner', 'Acme')`, [TENANT]);
    await db.query(
      `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, spent_micro_credits, created_at, updated_at)
       VALUES ('b_wallet', $1, 'tenant', $1, 10000000, 2000000, $2, $2)`,
      [TENANT, NOW_S],
    );
    await db.query(
      `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
         amount_micro_credits, model_code, input_tokens, output_tokens, occurred_at, created_at)
       VALUES ('led_1', 'req_1', 'b_wallet', 'charge', 'settled', $1, 'usr_ann', 'gwk_1', 1500, 'gpt-test', 10, 20, $2, $2)`,
      [TENANT, NOW_S - 60],
    );
    await db.query(`INSERT INTO gateway_rate_window (subject, window_start, requests, tokens) VALUES ('key:gwk_1', $1, 7, 70)`, [
      NOW_S - 60,
    ]);
    await db.query(
      `INSERT INTO gateway_upstream_credential (id, scope, provider_id, encrypted_credentials, key_version, created_at, updated_at)
       VALUES ('cred_1', 'official', 'openai', 'v2.k1.ciphertext', 'k1', $1, $1)`,
      [NOW_S],
    );
  });

  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/admin/gateway${path}`, { headers });

  it("serves the shared console build only when mounted", async () => {
    for (const path of ["/admin", "/admin/usage", "/admin/encryption"]) {
      const page = await app.request(path);
      expect(page.status, path).toBe(200);
      expect(await page.text()).toContain("<div id=root>");
      expect(page.headers.get("cache-control")).toBe("no-store");
    }
    const asset = await app.request("/_app/entry-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/favicon.svg")).status).toBe(200);

    // A plain Hono without mountAdminConsole has no SPA; mounting before any
    // request serves it (Hono builds its matcher on first dispatch).
    const bare = new Hono();
    expect((await bare.request("/admin")).status).toBe(404);
    const withConsole = new Hono();
    mountAdminConsole(withConsole, { build: loadAdminWebBuild(buildDir) });
    expect((await withConsole.request("/admin")).status).toBe(200);
  });

  it("accepts gwa_ tokens and admin sessions; refuses product credentials", async () => {
    const bearer = { authorization: `Bearer ${gwaToken}` };
    const meToken = await get("/me", bearer);
    expect(meToken.status).toBe(200);
    const meBody = (await meToken.json()) as { admin: { role: string }; promptAccess: boolean; permissions: string[] };
    expect(meBody).toMatchObject({
      admin: { role: "platform_admin" },
      promptAccess: false,
    });
    expect(meBody.permissions).toContain("encryption.read");
    expect(meBody.permissions).toContain("usage.read_all");

    const meSession = await get("/me", adminCookie("sess-admin"));
    expect(meSession.status).toBe(200);
    expect(await meSession.json()).toMatchObject({
      admin: { id: "adm_root", email: "root@admin.test", name: "Root", role: "platform_admin" },
    });

    expect((await get("/me", {})).status).toBe(401);
    expect((await get("/me", { authorization: "Bearer sk_gw_x" })).status).toBe(403);
    expect((await get("/me", { cookie: "better-auth.session_token=user" })).status).toBe(403);

    expect(await (await app.request("/api/admin-auth/sign-in/email", { method: "POST" })).json()).toEqual({
      handledBy: "admin-auth",
    });
  });

  it("wires overview, usage, abuse and encryption views", async () => {
    const headers = { authorization: `Bearer ${gwaToken}` };
    const overview = await get("/overview", headers);
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      overview: { windowDays: 30, requests: 1, spentMicroCredits: 1500 },
    });

    const usage = await get("/usage", headers);
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as { entries: unknown[]; byModel: unknown[]; nextCursor: null };
    expect(usageBody.entries.length).toBe(1);
    expect(usageBody.byModel.length).toBe(1);
    expect(usageBody.nextCursor).toBeNull();

    const abuse = await get("/abuse", headers);
    expect(abuse.status).toBe(200);
    expect(await abuse.json()).toMatchObject({
      abuse: { events: { available: false }, rateWindows: [{ subject: "key:gwk_1", requests: 7 }] },
    });

    const encryption = await get("/encryption", headers);
    expect(encryption.status).toBe(200);
    expect(await encryption.json()).toMatchObject({
      current: "k1",
      ringKids: expect.arrayContaining(["k1", "k2"]),
    });
  });

  it("fails the start without a build", () => {
    expect(() => loadAdminWebBuild(undefined)).toThrow("GATEWAY_ADMIN_WEB_DIR");
    expect(() => loadAdminWebBuild(join(buildDir, "_app"))).toThrow("no index.html");
  });
});
