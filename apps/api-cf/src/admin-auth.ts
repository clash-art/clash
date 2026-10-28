/**
 * The admin identity's own Better Auth instance (#394; guide:
 * apps/docs/guide/gateway-admin.md). It is Better Auth's documented way to run
 * a second, independent auth: its own tables (admin_accounts, admin_sessions,
 * admin_credentials, admin_verifications, migration 0040), its own base path
 * (/api/admin-auth), its own cookie prefix (`clash-admin`). Nothing here reads
 * or writes the product users/sessions tables, so a product session, clsh_ or
 * sk_gw_ token is never an admin session and an admin session is never a
 * product user (services/admin-identity.ts enforces both on every request).
 *
 * Email and password only. Sign-up is off: admin accounts are created by the
 * bootstrap script (scripts/gateway-admin-account.ts) or by an admin through
 * POST /api/v1/admin/gateway/admin-accounts. A disabled account cannot sign
 * in (ADMIN_ACCOUNT_DISABLED) and has no sessions left.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

import * as adminAuthSchema from "@clash/shared-cloud-schema/admin-auth";
import { ADMIN_AUTH_BASE_PATH, ADMIN_COOKIE_PREFIX, newAdminAccountId } from "./services/admin-identity";
import { requireSecret } from "./services/require-secret";

export interface AdminAuthBindings {
  DB: D1Database;
  BETTER_AUTH_URL?: string;
  /** Optional dedicated signing secret for admin cookies; defaults to the product auth secret. */
  ADMIN_AUTH_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
  ENVIRONMENT: string;
}

/** Admin sessions are short and never cached in a cookie, so a disable or sign-out takes effect at once. */
export const ADMIN_SESSION_SECONDS = 60 * 60 * 12;

type AdminAuthInstance = ReturnType<typeof buildAdminAuth>;
const adminAuthByEnv = new WeakMap<object, AdminAuthInstance>();

/**
 * One instance per env object, per isolate, for both the /api/admin-auth/*
 * handler and the session check: it holds no per-request state, and sharing
 * it keeps the sign-in rate limit's memory store across requests.
 */
export function createAdminAuth(env: AdminAuthBindings): AdminAuthInstance {
  const cached = adminAuthByEnv.get(env);
  if (cached) return cached;
  const auth = buildAdminAuth(env);
  adminAuthByEnv.set(env, auth);
  return auth;
}

function buildAdminAuth(env: AdminAuthBindings) {
  const secret = requireSecret(
    env,
    "ADMIN_AUTH_SECRET / BETTER_AUTH_SECRET / AUTH_SECRET",
    env.ADMIN_AUTH_SECRET ?? env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET,
    "dev-secret-change-me",
  );
  const db = drizzle(env.DB as unknown as Parameters<typeof drizzle>[0], { schema: adminAuthSchema });
  return betterAuth({
    appName: "Clash admin",
    basePath: ADMIN_AUTH_BASE_PATH,
    baseURL: env.BETTER_AUTH_URL,
    secret,
    trustedOrigins: [
      "https://clash.art",
      "https://www.clash.art",
      "https://next.clash.art",
      "https://api.clash.art",
      "https://clash.video",
      "https://www.clash.video",
      "https://api.clash.video",
      ...(env.ENVIRONMENT === "development"
        ? ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"]
        : []),
    ],
    database: drizzleAdapter(db, { provider: "sqlite", schema: adminAuthSchema }),
    user: {
      modelName: "adminAccounts",
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "platform_admin", input: false },
        disabledAt: { type: "date", required: false, input: false },
      },
    },
    session: {
      modelName: "adminSessions",
      expiresIn: ADMIN_SESSION_SECONDS,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    account: { modelName: "adminCredentials", accountLinking: { enabled: false } },
    verification: { modelName: "adminVerifications" },
    emailAndPassword: { enabled: true, disableSignUp: true },
    advanced: {
      cookiePrefix: ADMIN_COOKIE_PREFIX,
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true },
      database: { generateId: () => newAdminAccountId() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    databaseHooks: {
      session: {
        create: {
          // Password check passed; a disabled account still gets no session.
          async before(session) {
            const row = await env.DB.prepare(`SELECT disabled_at FROM admin_accounts WHERE id = ?`)
              .bind(session.userId)
              .first<{ disabled_at: number | null }>();
            if (!row || row.disabled_at !== null)
              throw new APIError("FORBIDDEN", { code: "ADMIN_ACCOUNT_DISABLED", message: "This admin account is disabled." });
            return { data: session };
          },
        },
      },
    },
    // No secondary storage on purpose: sessions must stay in admin_sessions,
    // where disabling an account deletes them in the same D1 batch.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      storage: "memory",
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
  });
}
