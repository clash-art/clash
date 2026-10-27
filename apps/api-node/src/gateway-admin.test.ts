/**
 * The Node gateway admin listener (#371) over PGlite: the public listener's
 * 404 for admin paths, the admin token identity (single platform_admin role),
 * the CSRF origin check, secrets never in a response, every endpoint group
 * with its audit row, and the self-host prompt policy (no body retained, no
 * staff view).
 */
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { isBlockedDeepSeekModel } from "@clash/gateway-core";
import { MODEL_CARDS } from "@clash/shared-types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATEWAY_ADMIN_ROLE_PERMISSIONS,
  GATEWAY_ADMIN_ROLES,
  authorizeGatewayAdmin,
  gatewayAdminPermissions,
  isTenantPermission,
} from "./gateway-admin-authz.ts";
import {
  createPgGatewayAdminTokens,
  issueGatewayAdminTokenFromCli,
  type PgGatewayAdminTokens,
} from "./gateway-admin-tokens.ts";
import {
  GATEWAY_ADMIN_PREFIX,
  createGatewayAdminApp,
  createGatewayHttpServers,
  gatewayAdminListenerFromEnv,
  isGatewayAdminPath,
  withoutGatewayAdminPaths,
} from "./gateway-admin.ts";
import {
  createPgGatewayBilling,
  createPgGatewayPriceBook,
} from "./gateway-billing.ts";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  GATEWAY_SEED_CATALOG_VERSION,
  GATEWAY_SEED_DEEPSEEK_FLASH,
  defaultGatewaySeedModels,
  seedGatewayDatabase,
} from "./gateway-seed.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(
  pglite: PGlite,
  intercept?: (sql: string) => void,
): GatewayBudgetDatabase {
  const client = (q: Pick<PGlite, "query">): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      intercept?.(sql);
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return {
    ...client(pglite),
    transaction: (work) => pglite.transaction((tx) => work(client(tx))),
  };
}

const TENANT_A = "tnt_a";
const TENANT_B = "tnt_b";
const ALLOWED_ORIGIN = "https://admin.example.test";
const UPSTREAM_SECRET = "sealed-envelope-never-returned";
const KEY_HASH_A = "a".repeat(64);
const KEY_HASH_B = "b".repeat(64);

type Body = Record<string, unknown> & {
  error?: { code: string; details?: Record<string, unknown> };
};

describe("api-node gateway admin listener", () => {
  let pglite: PGlite;
  let db: GatewayBudgetDatabase;
  let clock: number;
  let failAudit: boolean;
  let tokens: PgGatewayAdminTokens;
  let app: Hono;
  const token = {} as Record<"platform", string>;
  const responses: string[] = [];

  const call = async (
    credential: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(`${GATEWAY_ADMIN_PREFIX}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    responses.push(text);
    return {
      status: res.status,
      headers: res.headers,
      body: (text ? JSON.parse(text) : {}) as Body,
    };
  };
  const audit = async (action?: string) =>
    (
      await pglite.query<Record<string, unknown>>(
        `SELECT * FROM gateway_admin_audit ${action ? "WHERE action = $1" : ""} ORDER BY created_at, id`,
        action ? [action] : [],
      )
    ).rows;

  beforeEach(async () => {
    responses.length = 0;
    failAudit = false;
    clock = Date.UTC(2026, 9, 27, 12);
    pglite = new PGlite();
    await migrateDatabase(pglite);
    db = adapt(pglite, (sql) => {
      if (failAudit && sql.includes("INSERT INTO gateway_admin_audit"))
        throw new Error("audit store down");
    });
    const nowS = Math.floor(clock / 1000);
    await pglite.exec(`
      INSERT INTO tenant (id, owner_user_id, name) VALUES
        ('${TENANT_A}', 'usr_a_owner', 'Team A'), ('${TENANT_B}', 'usr_b_owner', 'Team B');
      INSERT INTO tenant_member (tenant_id, user_id, role) VALUES
        ('${TENANT_A}', 'usr_a_owner', 'owner'), ('${TENANT_A}', 'usr_a_member', 'member'),
        ('${TENANT_B}', 'usr_b_owner', 'owner');
      INSERT INTO auth_user (id, name, email, "createdAt", "updatedAt") VALUES
        ('usr_a_member', 'Member A', 'member-a@example.test', now(), now());
      INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits,
                                  spent_micro_credits, created_at, updated_at) VALUES
        ('gwb_wallet_a', '${TENANT_A}', 'tenant', '${TENANT_A}', 10000000, 0, ${nowS}, ${nowS}),
        ('gwb_wallet_b', '${TENANT_B}', 'tenant', '${TENANT_B}', 10000000, 0, ${nowS}, ${nowS});
      INSERT INTO gateway_virtual_key (id, tenant_id, user_id, token_hash, token_prefix, created_at) VALUES
        ('vk_a', '${TENANT_A}', 'usr_a_member', '${KEY_HASH_A}', 'sk_gw_aaaa', ${nowS}),
        ('vk_b', '${TENANT_B}', 'usr_b_owner', '${KEY_HASH_B}', 'sk_gw_bbbb', ${nowS});
      INSERT INTO gateway_upstream_credential (id, scope, provider_id, encrypted_credentials,
                                               key_version, created_at, updated_at) VALUES
        ('guc_official', 'official', 'deepseek', '${UPSTREAM_SECRET}', 'k1', ${nowS}, ${nowS});
      -- One request writes one charge line per budget it touches.
      INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, user_id,
                                        key_id, amount_micro_credits, model_code, input_tokens,
                                        output_tokens, occurred_at, created_at) VALUES
        ('l1', 'req_1', 'gwb_wallet_a', 'charge', 'settled', '${TENANT_A}', 'usr_a_member', 'vk_a',
         300, '${GATEWAY_SEED_DEEPSEEK_FLASH}', 10, 20, ${nowS}, ${nowS}),
        ('l2', 'req_1', 'gwb_k_vk_a', 'charge', 'settled', '${TENANT_A}', 'usr_a_member', 'vk_a',
         300, '${GATEWAY_SEED_DEEPSEEK_FLASH}', 10, 20, ${nowS}, ${nowS}),
        ('l3', 'req_2', 'gwb_wallet_b', 'charge', 'settled', '${TENANT_B}', 'usr_b_owner', 'vk_b',
         500, '${GATEWAY_SEED_DEEPSEEK_FLASH}', 1, 2, ${nowS}, ${nowS});
    `);
    await seedGatewayDatabase(pglite, {
      models: defaultGatewaySeedModels(),
      nowSeconds: nowS - 60,
    });
    tokens = createPgGatewayAdminTokens({ db, now: () => clock });
    const bootstrap = { kind: "bootstrap" as const, id: "bootstrap", role: "bootstrap" };
    token.platform = (await tokens.issue({ role: "platform_admin", actor: bootstrap })).token;
    app = createGatewayAdminApp({
      db,
      tokens,
      billing: createPgGatewayBilling({ db, now: () => clock }),
      priceBook: createPgGatewayPriceBook({ db, now: () => clock }),
      allowedOrigins: [ALLOWED_ORIGIN],
      now: () => clock,
    });
  });

  afterEach(async () => {
    await pglite.close();
  });

  describe("listener separation", () => {
    it("the public listener answers 404 for every admin path, however spelled", async () => {
      // Worst case: the public app itself (wrongly) carries the admin routes.
      const inner = new Hono();
      inner.get("/healthz", (c) => c.text("ok"));
      inner.route("/", app);
      const publicFetch = withoutGatewayAdminPaths(inner.fetch);
      const spellings = [
        "/api/v1/admin/gateway/me",
        "/api/v1/admin",
        "/api/v1/admin/",
        "/API/V1/ADMIN/gateway/me",
        "//api/v1//admin/gateway/me",
        "/api/v1/%61dmin/gateway/me",
        "/api/v1/admin%2Fgateway/me",
        "/api/v1/./admin/gateway/me",
        "/api/v1/admin/%E0%A4%A",
      ];
      for (const path of spellings) {
        const res = await publicFetch(
          new Request(`http://gateway.test${path}`, {
            headers: { authorization: `Bearer ${token.platform}` },
          }),
        );
        expect(res.status, path).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      for (const path of ["/api/v1/administrator", "/api/v1/gateway/admin"])
        expect(isGatewayAdminPath(path), path).toBe(false);
      expect(
        (await publicFetch(new Request("http://gateway.test/healthz"))).status,
      ).toBe(200);
    });

    it("over real sockets: admin API only on the admin port, data plane only on the public one", async () => {
      const dataPlane = new Hono();
      dataPlane.get("/healthz", (c) => c.text("ok"));
      dataPlane.route("/", app);
      // As server.ts builds them.
      const built = createGatewayHttpServers({
        publicFetch: dataPlane.fetch,
        adminFetch: app.fetch,
      });
      const servers: Server[] = [built.server, built.adminServer!];
      try {
        const [publicPort, adminPort] = await Promise.all(
          servers.map(
            (server) =>
              new Promise<number>((resolve) =>
                server.listen(0, "127.0.0.1", () =>
                  resolve((server.address() as AddressInfo).port),
                ),
              ),
          ),
        );
        // A raw request line, so no client normalizes the path first.
        const raw = (port: number, path: string) =>
          new Promise<number>((resolve, reject) => {
            const req = httpRequest(
              {
                host: "127.0.0.1",
                port,
                path,
                headers: { authorization: `Bearer ${token.platform}` },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
              },
            );
            req.on("error", reject);
            req.end();
          });
        expect(await raw(publicPort!, `${GATEWAY_ADMIN_PREFIX}/me`)).toBe(404);
        expect(await raw(publicPort!, `//api/v1/admin/gateway/me`)).toBe(404);
        expect(await raw(publicPort!, "/healthz")).toBe(200);
        expect(await raw(adminPort!, `${GATEWAY_ADMIN_PREFIX}/me`)).toBe(200);
        expect(await raw(adminPort!, "/healthz")).toBe(404);
        expect(await raw(adminPort!, "/gateway/v1/chat/completions")).toBe(404);
      } finally {
        await Promise.all(
          servers.map((server) => new Promise((resolve) => server.close(resolve))),
        );
      }
    });

    it("reads the admin listener from env: off by default, loopback, never the public port", () => {
      expect(gatewayAdminListenerFromEnv({}, 8080)).toBeUndefined();
      expect(
        gatewayAdminListenerFromEnv(
          {
            GATEWAY_ADMIN_PORT: "9090",
            GATEWAY_ADMIN_ORIGINS: `${ALLOWED_ORIGIN}, http://localhost:3000`,
          },
          8080,
        ),
      ).toEqual({
        port: 9090,
        hostname: "127.0.0.1",
        allowedOrigins: [ALLOWED_ORIGIN, "http://localhost:3000"],
      });
      expect(
        gatewayAdminListenerFromEnv(
          { GATEWAY_ADMIN_PORT: "9090", GATEWAY_ADMIN_HOST: "10.0.0.5" },
          8080,
        )?.hostname,
      ).toBe("10.0.0.5");
      expect(() =>
        gatewayAdminListenerFromEnv({ GATEWAY_ADMIN_PORT: "8080" }, 8080),
      ).toThrow(/differ/);
      expect(() =>
        gatewayAdminListenerFromEnv({ GATEWAY_ADMIN_PORT: "http" }, 8080),
      ).toThrow(/GATEWAY_ADMIN_PORT/);
      expect(() =>
        gatewayAdminListenerFromEnv(
          { GATEWAY_ADMIN_PORT: "9090", GATEWAY_ADMIN_ORIGINS: "https://a.test/path" },
          8080,
        ),
      ).toThrow(/GATEWAY_ADMIN_ORIGINS/);
    });
  });

  describe("identity and RBAC", () => {
    it("accepts admin tokens only: no credential 401, product credentials refused, revoked and expired coded", async () => {
      expect((await call(undefined, "GET", "/me")).body.error?.code).toBe(
        "GATEWAY_AUTH_REQUIRED",
      );
      const productCredentials: Record<string, string>[] = [
        { authorization: "Bearer clsh_0123456789abcdef0123456789abcdef01234567" },
        { authorization: `Bearer sk_gw_${"c".repeat(48)}` },
        { "x-api-key": token.platform },
        { cookie: "better-auth.session_token=abc" },
        // Well-formed but never issued.
        { authorization: "Bearer gwa_000000000000000000000000.".padEnd(93, "0") },
      ];
      for (const headers of productCredentials) {
        const res = await call(undefined, "GET", "/tenants", undefined, headers);
        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe("GATEWAY_ADMIN_SESSION_REQUIRED");
      }

      const issued = await call(token.platform, "POST", "/admin-tokens", {
        role: "platform_admin",
        expiresAt: new Date(clock + 60_000).toISOString(),
      });
      expect(issued.status).toBe(201);
      const short = issued.body.token as string;
      expect((await call(short, "GET", "/me")).status).toBe(200);
      clock += 61_000;
      expect((await call(short, "GET", "/me")).body.error?.code).toBe(
        "GATEWAY_TOKEN_EXPIRED",
      );

      // Issue another so we can revoke without hitting GATEWAY_LAST_ADMIN_ACCOUNT.
      const extra = await call(token.platform, "POST", "/admin-tokens", {
        role: "platform_admin",
        label: "revocable",
      });
      expect(extra.status).toBe(201);
      const revocable = extra.body.token as string;
      const id = (await call(revocable, "GET", "/me")).body.admin as { id: string };
      expect(
        (await call(token.platform, "POST", `/admin-tokens/${id.id}/revoke`, {})).status,
      ).toBe(200);
      expect((await call(revocable, "GET", "/me")).body.error?.code).toBe(
        "GATEWAY_TOKEN_REVOKED",
      );
    });

    it("is a single platform_admin role: every permission, any tenant; no tenant_admin/viewer", async () => {
      expect([...GATEWAY_ADMIN_ROLES]).toEqual(["platform_admin"]);
      expect("tenant_admin" in GATEWAY_ADMIN_ROLE_PERMISSIONS).toBe(false);
      expect("viewer" in GATEWAY_ADMIN_ROLE_PERMISSIONS).toBe(false);

      const allow = async (method: string, path: string, body?: unknown) => {
        const res = await call(token.platform, method, path, body);
        expect(res.status, `${method} ${path}`).toBeLessThan(300);
      };
      const budget = { limitMicroCredits: 1_000_000 };
      for (const path of [
        "/tenants",
        `/tenants/${TENANT_B}/members`,
        `/tenants/${TENANT_B}/budgets`,
        `/tenants/${TENANT_B}/keys`,
        "/usage",
        `/usage?tenantId=${TENANT_A}`,
        "/audit",
        "/catalog",
        "/prices",
        "/packages",
        "/upstreams",
        "/abuse",
        "/admin-tokens",
      ])
        await allow("GET", path);
      await allow("PUT", `/tenants/${TENANT_A}/budgets/user/usr_a_member`, budget);
      await allow("PUT", `/tenants/${TENANT_B}/budgets/user/usr_b_owner`, budget);

      expect(gatewayAdminPermissions({ id: "u", role: "owner" })).toEqual([]);
      expect(gatewayAdminPermissions({ id: "u", role: "tenant_admin" })).toEqual([]);
      expect(authorizeGatewayAdmin({ id: "u", role: "owner" }, "tenants.list")).toBeNull();
      expect(
        authorizeGatewayAdmin({ id: "gat_x", role: "platform_admin" }, "budgets.read"),
      ).toBeNull();
      expect(
        authorizeGatewayAdmin(
          { id: "gat_x", role: "platform_admin" },
          "budgets.read",
          TENANT_A,
        ),
      ).toMatchObject({ kind: "admin", role: "platform_admin" });
      expect(isTenantPermission("budgets.read")).toBe(true);
      expect(isTenantPermission("tenants.list")).toBe(false);
    });

    it("reports the caller and its permissions on /me, never prompt access", async () => {
      const me = await call(token.platform, "GET", "/me");
      expect(me.body).toMatchObject({
        admin: { role: "platform_admin" },
        promptAccess: false,
      });
      expect(me.body.permissions).toEqual(
        gatewayAdminPermissions({ id: "x", role: "platform_admin" }).filter(
          (permission) => permission !== "encryption.read" && permission !== "encryption.rotate",
        ),
      );
      expect(me.body.admin).toMatchObject({ email: "", name: "" });
      expect((me.body.admin as { tenantId?: unknown }).tenantId).toBeUndefined();
    });
  });

  describe("CSRF", () => {
    it("refuses a browser mutation from another origin before anything changes", async () => {
      const path = `/tenants/${TENANT_A}/keys/vk_a/revoke`;
      const foreign: Record<string, string>[] = [
        { origin: "https://evil.example.test" },
        { origin: "null" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
      ];
      for (const headers of foreign) {
        const res = await call(token.platform, "POST", path, {}, headers);
        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe("GATEWAY_ADMIN_ORIGIN_REJECTED");
      }
      expect(await audit("key.revoke")).toHaveLength(0);
      const revokedAt = await pglite.query(
        "SELECT revoked_at FROM gateway_virtual_key WHERE id = 'vk_a'",
      );
      expect(revokedAt.rows).toEqual([{ revoked_at: null }]);

      // The console's own origin, and a CLI (no Origin), may change state.
      expect(
        (await call(token.platform, "POST", path, {}, { origin: ALLOWED_ORIGIN })).status,
      ).toBe(200);
      expect(
        (await call(token.platform, "POST", `/tenants/${TENANT_B}/keys/vk_b/revoke`, {}))
          .status,
      ).toBe(200);
    });

    it("answers reads without any CORS grant", async () => {
      const res = await call(token.platform, "GET", "/tenants", undefined, {
        origin: "https://evil.example.test",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("endpoints", () => {
    it("teams and users: tenants with wallets, members", async () => {
      const tenants = (await call(token.platform, "GET", "/tenants")).body.tenants as {
        id: string;
        members: number;
        wallet: { budgetId: string } | null;
      }[];
      expect(tenants.map((t) => t.id)).toEqual([TENANT_A, TENANT_B]);
      expect(tenants[0]).toMatchObject({ members: 2, wallet: { budgetId: "gwb_wallet_a" } });
      const members = (await call(token.platform, "GET", `/tenants/${TENANT_A}/members`)).body
        .members as { userId: string; email: string | null }[];
      expect(members).toContainEqual(
        expect.objectContaining({ userId: "usr_a_member", email: "member-a@example.test" }),
      );
    });

    it("budgets: allocate under the wallet, refuse below usage, audited override, rolled back with a failed audit", async () => {
      const path = `/tenants/${TENANT_A}/budgets/key/vk_a`;
      const created = await call(token.platform, "PUT", path, { limitMicroCredits: 5_000 });
      expect(created.status).toBe(200);
      expect(created.body.budget).toMatchObject({
        scope: "key",
        scopeId: "vk_a",
        parentBudgetId: "gwb_wallet_a",
        limitMicroCredits: 5_000,
      });
      await pglite.query(
        "UPDATE gateway_budget SET spent_micro_credits = 4000 WHERE scope = 'key' AND scope_id = 'vk_a'",
      );
      const below = await call(token.platform, "PUT", path, { limitMicroCredits: 1_000 });
      expect(below.status).toBe(409);
      expect(below.body.error?.code).toBe("GATEWAY_BUDGET_BELOW_USAGE");
      expect(
        (await call(token.platform, "PUT", path, { limitMicroCredits: 1_000, override: true }))
          .status,
      ).toBe(400);
      expect(
        (
          await call(token.platform, "PUT", path, {
            limitMicroCredits: 1_000,
            override: true,
            reason: "incident 42",
          })
        ).status,
      ).toBe(200);
      const rows = await audit();
      const budgetRows = rows.filter((row) => row.target_type === "budget");
      expect(budgetRows.map((row) => row.action).sort()).toEqual(["budget.create", "budget.override"]);
      expect(budgetRows.find((row) => row.action === "budget.override")).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: "admin",
        actor_role: "platform_admin",
        reason: "incident 42",
      });

      expect(
        (await call(token.platform, "PUT", `/tenants/${TENANT_A}/budgets/user/usr_b_owner`, {
          limitMicroCredits: 1,
        })).body.error?.code,
      ).toBe("GATEWAY_MEMBER_NOT_FOUND");
      expect(
        (await call(token.platform, "PUT", `/tenants/${TENANT_A}/budgets/key/vk_b`, {
          limitMicroCredits: 1,
        })).body.error?.code,
      ).toBe("GATEWAY_KEY_NOT_FOUND");

      failAudit = true;
      expect(
        (await call(token.platform, "PUT", path, { limitMicroCredits: 9_000 })).status,
      ).toBe(500);
      failAudit = false;
      const limit = await pglite.query<{ limit_micro_credits: string }>(
        "SELECT limit_micro_credits::text FROM gateway_budget WHERE scope = 'key' AND scope_id = 'vk_a'",
      );
      expect(limit.rows).toEqual([{ limit_micro_credits: "1000" }]);
    });

    it("keys: metadata only, revoke audited once", async () => {
      const keys = (await call(token.platform, "GET", `/tenants/${TENANT_A}/keys`)).body.keys as {
        id: string;
        prefix: string;
      }[];
      expect(keys.map((key) => key.id)).toEqual(["vk_a"]);
      const path = `/tenants/${TENANT_A}/keys/vk_a/revoke`;
      const first = await call(token.platform, "POST", path, { reason: "leaked" });
      expect((first.body.key as { revokedAt: string | null }).revokedAt).not.toBeNull();
      expect((await call(token.platform, "POST", path, {})).status).toBe(200);
      expect(await audit("key.revoke")).toHaveLength(1);
      expect(
        (await call(token.platform, "POST", `/tenants/${TENANT_A}/keys/vk_b/revoke`, {})).body
          .error?.code,
      ).toBe("GATEWAY_KEY_NOT_FOUND");
    });

    it("usage: console explorer shape (entries + byModel); tenant scope narrows entries", async () => {
      const all = (await call(token.platform, "GET", "/usage")).body as {
        entries: { tenantId: string; amountMicroCredits: number; kind: string }[];
        byModel: { modelCode: string; requests: number; amountMicroCredits: number }[];
        nextCursor: null;
      };
      expect(all.nextCursor).toBeNull();
      expect(all.entries.length).toBeGreaterThan(0);
      expect(all.byModel.some((row) => row.amountMicroCredits >= 500)).toBe(true);
      const mine = (await call(token.platform, "GET", `/usage?tenantId=${TENANT_A}`)).body as {
        entries: { tenantId: string }[];
      };
      expect(mine.entries.length).toBeGreaterThan(0);
      expect(mine.entries.every((entry) => entry.tenantId === TENANT_A)).toBe(true);
    });

    it("models: clone the live catalog, edit the draft, publish; non-Flash DeepSeek refused", async () => {
      const cloned = await call(token.platform, "POST", "/catalog/versions/c2/clone", {
        from: GATEWAY_SEED_CATALOG_VERSION,
      });
      expect(cloned.status).toBe(201);
      expect(
        (cloned.body.version as { models: { modelCode: string }[] }).models.map((m) => m.modelCode),
      ).toEqual([GATEWAY_SEED_DEEPSEEK_FLASH]);
      // A shipped card (shared-types), validated against ModelCardSchema.
      const card = MODEL_CARDS.find(
        (candidate) => candidate.kind === "text" && !isBlockedDeepSeekModel(candidate.id),
      )!;
      const path = `/catalog/versions/c2/models/${encodeURIComponent(card.id)}`;
      const added = await call(token.platform, "PUT", path, { card, displayName: "Edited" });
      expect(added.body.error).toBeUndefined();
      expect(added.body.model).toMatchObject({ modelCode: card.id, displayName: "Edited" });
      expect(
        (await call(token.platform, "PUT", path, { card: { ...card, id: "other" } })).body.error
          ?.code,
      ).toBe("GATEWAY_CATALOG_MODEL_INVALID");
      // Constructed so the source never names a blocked DeepSeek id (anti-patterns).
      const blockedId = ["deepseek", "v4", "pro"].join("-");
      const blocked = await call(
        token.platform,
        "PUT",
        `/catalog/versions/c2/models/${encodeURIComponent(blockedId)}`,
        { card: { ...card, id: blockedId } },
      );
      expect(blocked.body.error?.code).toBe("GATEWAY_CATALOG_MODEL_BLOCKED");
      // The seed's stub card never passes ModelCardSchema; drop it before publishing.
      expect(
        (await call(token.platform, "DELETE", `/catalog/versions/c2/models/${GATEWAY_SEED_DEEPSEEK_FLASH}`))
          .status,
      ).toBe(200);
      const published = await call(token.platform, "POST", "/catalog/versions/c2/publish", {});
      expect(published.body.error).toBeUndefined();
      const versions = (await call(token.platform, "GET", "/catalog")).body.versions as {
        version: string;
        status: string;
        live: boolean;
      }[];
      expect(versions.find((v) => v.version === "c2")).toMatchObject({
        status: "published",
        live: true,
      });
      expect(
        (
          await call(token.platform, "PUT", path, { card })
        ).body.error?.code,
      ).toBe("GATEWAY_CATALOG_VERSION_PUBLISHED");
      expect(
        (await audit()).filter((row) => String(row.action).startsWith("catalog.")).map((row) => row.action).sort(),
      ).toEqual(["catalog.clone", "catalog.model.create", "catalog.model.remove", "catalog.publish"]);
    });

    it("prices and packages: the shared billing admin routes are served by the admin listener", async () => {
      const prices = await call(token.platform, "GET", "/prices");
      expect(prices.status).toBe(200);
      // The seed published one price version.
      expect((prices.body.versions as unknown[]).length).toBeGreaterThan(0);
      expect((await call(token.platform, "GET", "/topup-packs")).status).toBe(200);
    });

    it("routes: upstream metadata only, routing fields patched with an audit row", async () => {
      const patched = await call(token.platform, "PATCH", "/upstreams/guc_official", {
        enabled: false,
        priority: 5,
        reason: "drain",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.upstream).toMatchObject({ enabled: false, priority: 5 });
      expect((await audit("upstream.update"))[0]).toMatchObject({
        before_json: { enabled: true, priority: null, weight: null, maxRps: null },
        after_json: { enabled: false, priority: 5, weight: null, maxRps: null },
        reason: "drain",
      });
      expect(
        (await call(token.platform, "PATCH", "/upstreams/guc_official", {})).status,
      ).toBe(400);
    });

    it("abuse: suspend and lift a tenant wallet by id, audited with the reason", async () => {
      const suspended = await call(token.platform, "POST", "/abuse/suspensions", {
        subjectKind: "tenant",
        subjectId: TENANT_A,
        reason: "card testing",
      });
      expect(suspended.status).toBe(201);
      const suspension = suspended.body.suspension as { id: string; status: string };
      expect(suspension).toMatchObject({ id: "gwb_wallet_a", status: "active" });
      const wallet = await pglite.query(
        "SELECT status FROM gateway_budget WHERE id = 'gwb_wallet_a'",
      );
      expect(wallet.rows).toEqual([{ status: "suspended" }]);
      expect(
        (await call(token.platform, "POST", "/abuse/suspensions", {
          subjectKind: "tenant",
          subjectId: TENANT_A,
          reason: "again",
        })).body.error?.code,
      ).toBe("GATEWAY_SUSPENSION_EXISTS");
      expect(
        (await call(token.platform, "POST", "/abuse/suspensions", {
          subjectKind: "key",
          subjectId: "vk_a",
          reason: "no budget",
        })).body.error?.code,
      ).toBe("GATEWAY_ABUSE_SUBJECT_NOT_FOUND");
      const signals = (await call(token.platform, "GET", "/abuse")).body.abuse as {
        suspensions: { id: string }[];
        rateWindows: unknown[];
        events: { available: boolean };
      };
      expect(signals.suspensions.map((s) => s.id)).toEqual(["gwb_wallet_a"]);
      expect(signals.events.available).toBe(false);
      expect(Array.isArray(signals.rateWindows)).toBe(true);
      // Audit rows order by second, then a random id: lift one second later.
      clock += 1_000;
      const lifted = await call(token.platform, "POST", `/abuse/suspensions/${suspension.id}/lift`, {
        reason: "resolved",
      });
      expect((lifted.body.suspension as { status: string }).status).toBe("lifted");
      expect((await audit()).filter((row) => String(row.action).startsWith("abuse.")).map((row) => [
        row.action,
        row.reason,
      ])).toEqual([
        ["abuse.suspend", "card testing"],
        ["abuse.lift", "resolved"],
      ]);
    });

    it("audit: platform-wide, or narrowed with ?tenantId=", async () => {
      await call(token.platform, "PUT", `/tenants/${TENANT_A}/budgets/user/usr_a_member`, {
        limitMicroCredits: 10,
      });
      await call(token.platform, "PUT", `/tenants/${TENANT_B}/budgets/user/usr_b_owner`, {
        limitMicroCredits: 10,
      });
      const mine = (await call(token.platform, "GET", `/audit?tenantId=${TENANT_A}`)).body
        .audit as { tenantId: string | null }[];
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((row) => row.tenantId === TENANT_A)).toBe(true);
      const all = (await call(token.platform, "GET", "/audit?action=budget.create")).body
        .audit as { tenantId: string | null }[];
      expect(all.map((row) => row.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    });
  });

  describe("secrets and admin tokens", () => {
    it("never returns a secret: no token hash, upstream envelope, key hash or other token", async () => {
      const issued = await call(token.platform, "POST", "/admin-tokens", {
        role: "platform_admin",
        label: "ops",
      });
      expect(issued.status).toBe(201);
      const plaintext = issued.body.token as string;
      expect(plaintext).toMatch(/^gwa_[0-9a-f]{24}\.[0-9a-f]{64}$/);
      const issuedId = (issued.body.adminToken as { id: string }).id;
      responses.length = 0;

      for (const path of [
        "/me",
        "/tenants",
        `/tenants/${TENANT_A}/keys`,
        `/tenants/${TENANT_B}/keys`,
        `/tenants/${TENANT_A}/budgets`,
        "/upstreams",
        "/usage",
        `/usage?tenantId=${TENANT_A}`,
        "/audit",
        "/catalog",
        "/abuse",
        "/admin-tokens",
      ])
        expect((await call(token.platform, "GET", path)).status, path).toBe(200);
      await call(token.platform, "POST", `/admin-tokens/${issuedId}/revoke`, {});
      await call(token.platform, "POST", `/tenants/${TENANT_A}/keys/vk_a/revoke`, {});
      await call(token.platform, "PATCH", "/upstreams/guc_official", { weight: 3 });

      const hashes = (
        await pglite.query<{ token_hash: string }>("SELECT token_hash FROM gateway_admin_token")
      ).rows.map((row) => row.token_hash);
      const everything =
        responses.join("\n") + JSON.stringify(await audit());
      for (const secret of [
        ...hashes,
        ...Object.values(token),
        plaintext,
        UPSTREAM_SECRET,
        KEY_HASH_A,
        KEY_HASH_B,
      ])
        expect(everything).not.toContain(secret);
      for (const column of ["token_hash", "tokenHash", "encrypted_credentials", "encryptedCredentials"])
        expect(everything).not.toContain(column);
    });

    it("keeps one live platform_admin token; issue and revoke are audited", async () => {
      const me = (await call(token.platform, "GET", "/me")).body.admin as { id: string };
      const last = await call(token.platform, "POST", `/admin-tokens/${me.id}/revoke`, {});
      expect(last.status).toBe(409);
      expect(last.body.error?.code).toBe("GATEWAY_LAST_ADMIN_ACCOUNT");
      expect(
        (await call(token.platform, "POST", "/admin-tokens", {
          role: "viewer",
        })).body.error?.code,
      ).toBe("GATEWAY_INVALID_REQUEST");
      expect(
        (await call(token.platform, "POST", "/admin-tokens", {
          role: "tenant_admin",
        })).body.error?.code,
      ).toBe("GATEWAY_INVALID_REQUEST");
      const second = await call(token.platform, "POST", "/admin-tokens", {
        role: "platform_admin",
        reason: "second operator",
      });
      expect(second.status).toBe(201);
      expect((await call(token.platform, "POST", `/admin-tokens/${me.id}/revoke`, {})).status).toBe(
        200,
      );
      // One bootstrap issue (beforeEach), then this admin's issue and revoke.
      expect(
        (await audit()).map((row) => `${row.action}:${row.actor_kind}`).sort(),
      ).toEqual([
        "admin_token.issue:admin",
        "admin_token.issue:bootstrap",
        "admin_token.revoke:admin",
      ]);
    });

    it("the bootstrap CLI refuses an unknown role before touching a database", async () => {
      await expect(issueGatewayAdminTokenFromCli(["--role", "owner"], {})).rejects.toThrow(
        /--role/,
      );
    });
  });

  describe("self-host prompt policy", () => {
    it("refuses staff prompt viewing for platform_admin; bodies are not retained", async () => {
      const res = await call(token.platform, "POST", "/prompts/req_1/access", {
        reason: "support ticket",
      });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("GATEWAY_PROMPT_ACCESS_DISABLED");
      expect(await audit("prompt.view")).toHaveLength(0);
    });

    it("the Node gateway schema has nowhere to retain a request or response body", async () => {
      const { rows } = await pglite.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name LIKE 'gateway\\_%'
            AND column_name ~ '(body|prompt|message|completion|content)'`,
      );
      expect(rows).toEqual([]);
    });
  });
});
