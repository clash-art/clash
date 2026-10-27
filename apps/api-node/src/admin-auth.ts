/**
 * The admin identity on the Node admin listener (#372; #394; guide:
 * apps/docs/guide/gateway-admin.md): its own Better Auth instance, as on
 * api-cf (apps/api-cf/src/admin-auth.ts), with the same base path
 * (/api/admin-auth) and cookie prefix (`clash-admin`) so the shared console
 * signs in unchanged, over its own Postgres tables (0022: admin_account,
 * admin_session, admin_credential, admin_verification, admin_rate_limit).
 * Nothing here reads or writes auth_user / auth_session, so a product session
 * or token is never an admin session and an admin session is never a product
 * user.
 *
 * Email and password only. Sign-up is off: accounts are created by
 * `createNodeAdminAccount` (`pnpm admin-account:create`). A disabled account
 * cannot sign in (ADMIN_ACCOUNT_DISABLED) and its sessions verify as nobody.
 */
import { randomUUID } from "node:crypto";
import {
  GATEWAY_ADMIN_AUTH_BASE_PATH,
  GATEWAY_ADMIN_COOKIE_PREFIX,
  GATEWAY_PLATFORM_ROLES,
  type GatewayAdminAccountIdentity,
  type GatewayPlatformRole,
} from "@clash/gateway-core";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { Pool } from "pg";
import type { GatewayBudgetDatabase } from "./gateway-budget.ts";
import { appendGatewayAdminAudit } from "./gateway-key-admin.ts";

/** Admin sessions are short and never cached in a cookie, so a disable or sign-out takes effect at once. */
export const NODE_ADMIN_SESSION_SECONDS = 60 * 60 * 12;

/** Admin account ids are distinguishable from product user ids wherever they are recorded. */
export const newAdminAccountId = () => `adm_${randomUUID().replaceAll("-", "")}`;

/** The pg pool surface Better Auth and the disabled-account check use. */
export type AdminAuthPool = Pick<Pool, "connect" | "query">;

/** Host-owned PG pool; schema is migrated explicitly (0022), never on request. */
export function createNodeAdminAuth(options: {
  pool: AdminAuthPool;
  publicUrl: string;
  secret: string;
}) {
  if (options.secret.length < 32)
    throw Error("ADMIN_AUTH_SECRET / BETTER_AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(options.publicUrl).origin;
  return betterAuth({
    appName: "Clash admin",
    database: options.pool as Pool,
    baseURL: origin,
    basePath: GATEWAY_ADMIN_AUTH_BASE_PATH,
    secret: options.secret,
    trustedOrigins: [origin],
    user: {
      modelName: "admin_account",
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "platform_admin", input: false },
        disabledAt: { type: "date", required: false, input: false },
      },
    },
    session: {
      modelName: "admin_session",
      expiresIn: NODE_ADMIN_SESSION_SECONDS,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    account: { modelName: "admin_credential", accountLinking: { enabled: false } },
    verification: { modelName: "admin_verification" },
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: {
      cookiePrefix: GATEWAY_ADMIN_COOKIE_PREFIX,
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true },
      database: { generateId: () => newAdminAccountId() },
    },
    databaseHooks: {
      session: {
        create: {
          // Password check passed; a disabled account still gets no session.
          async before(session) {
            const { rows } = await options.pool.query<{ disabledAt: Date | null }>(
              `SELECT "disabledAt" FROM admin_account WHERE id = $1`,
              [session.userId],
            );
            if (!rows[0] || rows[0].disabledAt !== null)
              throw new APIError("FORBIDDEN", {
                code: "ADMIN_ACCOUNT_DISABLED",
                message: "This admin account is disabled.",
              });
            return { data: session };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      // As api-cf (apps/api-cf/src/admin-auth.ts): 5 sign-in attempts a minute per client address.
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
      storage: "database",
      modelName: "admin_rate_limit",
    },
  });
}
export type NodeAdminAuth = ReturnType<typeof createNodeAdminAuth>;

/** The admin account behind the request's admin session cookie, or null. */
export function nodeAdminSessionVerifier(auth: NodeAdminAuth) {
  return async (request: Request): Promise<GatewayAdminAccountIdentity | null> => {
    let session: unknown;
    try {
      session = await auth.api.getSession({ headers: new Headers(request.headers) });
    } catch {
      return null;
    }
    const user = (session as { user?: Record<string, unknown> } | null)?.user;
    if (!user || typeof user.id !== "string" || typeof user.role !== "string") return null;
    if (user.disabledAt !== null && user.disabledAt !== undefined) return null;
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : "",
      name: typeof user.name === "string" ? user.name : "",
      role: user.role,
    };
  };
}

/**
 * Create an admin account and its password credential in one transaction,
 * audited as `admin_account.create`. The hash is Better Auth's own, the one
 * sign-in verifies with. Used by the bootstrap CLI (actor `bootstrap`).
 */
export async function createNodeAdminAccount(input: {
  auth: NodeAdminAuth;
  db: GatewayBudgetDatabase;
  email: string;
  name: string;
  password: string;
  role?: GatewayPlatformRole;
  now?: () => number;
}): Promise<GatewayAdminAccountIdentity> {
  const role = input.role ?? "platform_admin";
  if (!(GATEWAY_PLATFORM_ROLES as readonly string[]).includes(role)) throw Error(`Unknown admin role: ${role}`);
  const context = await input.auth.$context;
  if (input.password.length < context.password.config.minPasswordLength)
    throw Error(`The password must have at least ${context.password.config.minPasswordLength} characters`);
  const hash = await context.password.hash(input.password);
  const email = input.email.trim().toLowerCase();
  const id = newAdminAccountId();
  const atMs = (input.now ?? Date.now)();
  const at = new Date(atMs);
  await input.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO admin_account (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, $4, $5, $5)`,
      [id, input.name, email, role, at],
    );
    await tx.query(
      `INSERT INTO admin_credential (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [newAdminAccountId(), id, hash, at],
    );
    await appendGatewayAdminAudit(
      tx,
      {
        actor: { kind: "bootstrap", id: "bootstrap", role: "" },
        action: "admin_account.create",
        targetType: "admin_account",
        targetId: id,
        after: { email, name: input.name, role },
      },
      Math.floor(atMs / 1000),
    );
  });
  return { id, email, name: input.name, role };
}
