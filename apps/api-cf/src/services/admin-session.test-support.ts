/**
 * Test-only: create an admin account (#394) in the admin store and sign in
 * through the real /api/admin-auth/sign-in/email endpoint, so suites hold the
 * same `clash-admin.*` session cookie a browser would.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { hashPassword } from "better-auth/crypto";

import { newAdminAccountId } from "./admin-identity";

type Fetchable = { request: (path: string, init: RequestInit, env: never) => Response | Promise<Response> };

export interface SeededAdmin {
  id: string;
  email: string;
  password: string;
}

export interface AdminSeedInput {
  email?: string;
  name?: string;
  password?: string;
  /** `admin_accounts.role`; absent: `platform_admin`. */
  role?: string;
}

/** An enabled admin account with a password credential, written straight to the admin tables. */
export async function seedAdminAccount(
  db: D1Database,
  input: AdminSeedInput = {},
): Promise<SeededAdmin> {
  const id = newAdminAccountId();
  const email = (input.email ?? `${id}@admin.test`).toLowerCase();
  const password = input.password ?? `pw-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO admin_accounts (id, name, email, email_verified, role, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(id, input.name ?? "Test admin", email, input.role ?? "platform_admin", now, now),
    db
      .prepare(
        `INSERT INTO admin_credentials (id, account_id, provider_id, admin_id, password, created_at, updated_at)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      )
      .bind(newAdminAccountId(), id, id, await hashPassword(password), now, now),
  ]);
  return { id, email, password };
}

/** The `Cookie` header value for the cookies a response sets. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]!.trim())
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join(".")}`;

/**
 * Sign in through the admin Better Auth endpoint; returns the response and its
 * session cookie. Sign-in is rate limited per client IP, so each call comes
 * from its own address unless `ip` is given.
 */
export async function adminSignIn(
  app: Fetchable,
  env: Record<string, unknown>,
  credentials: { email: string; password: string },
  origin: string,
  ip = randomIp(),
): Promise<{ response: Response; cookie: string }> {
  const response = await app.request(
    "/api/admin-auth/sign-in/email",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin, "cf-connecting-ip": ip },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    },
    env as never,
  );
  return { response, cookie: cookiesFrom(response) };
}

/** A seeded, signed-in admin account: `auth` is the request headers its console calls carry. */
export async function signedInAdmin(
  app: Fetchable,
  env: Record<string, unknown> & { DB: D1Database },
  origin: string,
  input: AdminSeedInput = {},
): Promise<SeededAdmin & { auth: { cookie: string } }> {
  const admin = await seedAdminAccount(env.DB, input);
  const { response, cookie } = await adminSignIn(app, env, admin, origin);
  if (response.status !== 200 || !cookie.includes("clash-admin.session_token"))
    throw new Error(`admin sign-in failed: ${response.status} ${await response.text()}`);
  return { ...admin, auth: { cookie } };
}
