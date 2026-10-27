/**
 * The Node admin identity (#372, #394) over PGlite: the bootstrap account is
 * created with Better Auth's own hash and audited; it signs in through
 * /api/admin-auth with the `clash-admin` cookie the shared console expects;
 * sign-up is off; a disabled account neither signs in nor verifies; and no
 * product auth table is touched.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createNodeAdminAccount,
  createNodeAdminAuth,
  nodeAdminSessionVerifier,
  type AdminAuthPool,
  type NodeAdminAuth,
} from "./admin-auth.ts";
import type { GatewayBudgetDatabase, GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  const client = (q: Pick<PGlite, "query">): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return { ...client(pglite), transaction: (work) => pglite.transaction((tx) => work(client(tx))) };
}

/** The pg Pool surface Better Auth's Kysely Postgres dialect uses, over one PGlite connection. */
function pglitePool(pglite: PGlite): AdminAuthPool {
  const query = async (sql: string, parameters?: unknown[]) => {
    const result = await pglite.query(sql, parameters ?? []);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: sql.trim().split(/\s+/, 1)[0]!.toUpperCase(),
    };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as AdminAuthPool;
}

const ORIGIN = "http://admin.test";
const PASSWORD = "correct horse battery staple";

describe("Node admin identity", () => {
  let pglite: PGlite;
  let auth: NodeAdminAuth;

  const signIn = (email: string, password: string) =>
    auth.handler(
      new Request(`${ORIGIN}/api/admin-auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }),
    );
  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0]!)
      .find((cookie) => cookie.startsWith("clash-admin.session_token="));

  beforeEach(async () => {
    pglite = new PGlite();
    await migrateDatabase(pglite);
    auth = createNodeAdminAuth({ pool: pglitePool(pglite), publicUrl: ORIGIN, secret: "s".repeat(32) });
  });

  it("creates the bootstrap account audited, signs it in with the clash-admin cookie, and verifies its role", async () => {
    const account = await createNodeAdminAccount({
      auth,
      db: adapt(pglite),
      email: " Support@Admin.Test ",
      name: "Support",
      password: PASSWORD,
      role: "support_agent",
    });
    expect(account).toMatchObject({ email: "support@admin.test", role: "support_agent" });
    expect(account.id).toMatch(/^adm_/);
    const audit = await pglite.query(`SELECT actor_kind, action, target_id FROM gateway_admin_audit`);
    expect(audit.rows).toEqual([{ actor_kind: "bootstrap", action: "admin_account.create", target_id: account.id }]);

    expect((await signIn("support@admin.test", "wrong password")).status).toBe(401);
    const signedIn = await signIn("support@admin.test", PASSWORD);
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect(cookie).toBeDefined();
    const verify = nodeAdminSessionVerifier(auth);
    expect(await verify(new Request(`${ORIGIN}/api/v1/admin/gateway/me`, { headers: { cookie: cookie! } }))).toEqual({
      id: account.id,
      email: "support@admin.test",
      name: "Support",
      role: "support_agent",
    });
    expect(await verify(new Request(`${ORIGIN}/`, { headers: { cookie: "clash-admin.session_token=forged" } }))).toBeNull();
    // Admin accounts live in their own tables only.
    expect((await pglite.query(`SELECT count(*)::int AS n FROM auth_user`)).rows).toEqual([{ n: 0 }]);
    expect((await pglite.query(`SELECT count(*)::int AS n FROM auth_session`)).rows).toEqual([{ n: 0 }]);
  });

  it("has no sign-up, and refuses a disabled account at sign-in and on its existing sessions", async () => {
    const signUp = await auth.handler(
      new Request(`${ORIGIN}/api/admin-auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: "new@admin.test", password: PASSWORD, name: "New" }),
      }),
    );
    expect(signUp.ok).toBe(false);
    expect((await pglite.query(`SELECT count(*)::int AS n FROM admin_account`)).rows).toEqual([{ n: 0 }]);

    const account = await createNodeAdminAccount({ auth, db: adapt(pglite), email: "ops@admin.test", name: "Ops", password: PASSWORD });
    expect(account.role).toBe("platform_admin");
    const cookie = sessionCookie(await signIn("ops@admin.test", PASSWORD))!;
    await pglite.query(`UPDATE admin_account SET "disabledAt" = now() WHERE id = $1`, [account.id]);
    expect(await nodeAdminSessionVerifier(auth)(new Request(ORIGIN, { headers: { cookie } }))).toBeNull();
    const refused = await signIn("ops@admin.test", PASSWORD);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("ADMIN_ACCOUNT_DISABLED");
  });

  it("rejects a short secret and an unknown role", async () => {
    expect(() => createNodeAdminAuth({ pool: pglitePool(pglite), publicUrl: ORIGIN, secret: "short" })).toThrow("32 characters");
    await expect(
      createNodeAdminAccount({
        auth,
        db: adapt(pglite),
        email: "x@admin.test",
        name: "X",
        password: PASSWORD,
        role: "owner" as never,
      }),
    ).rejects.toThrow("Unknown admin role");
  });
});
