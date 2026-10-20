import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

import { gatewaySessionDatabaseHooks } from "@clash/shared-cloud-schema/gateway";
import * as betterAuthSchema from "../db/better-auth.schema";

const basePath = "/api/better-auth";
const devTrustedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
];

function isLocalAuthBaseUrl(baseURL?: string) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL ?? "");
}

export type AuthBindings = {
  DB: D1Database;
  KV?: KVNamespace<string>;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  RESEND_API_KEY?: string;
  NODE_ENV?: string;
  ENVIRONMENT?: string;
  /** Issues #154/#157: cookie cache lifetime in seconds (0..3600, default 3600); "0" turns it off. */
  BETTER_AUTH_COOKIE_CACHE_SECONDS?: string;
};

/**
 * Issues #154/#157: lifetime of Better Auth's signed `session_data` cookie.
 * While it is fresh, get-session answers from the cookie (HMAC-verified, no
 * D1 query). It is also the longest that get-session can keep reporting a
 * session revoked from another device as signed in: up to 1 hour by default.
 * Authorization is not affected: data routes (api-cf, meta) check the sessions
 * table on every request and reject a revoked session immediately, and the
 * client treats any API 401 as signed out.
 */
export const DEFAULT_COOKIE_CACHE_SECONDS = 3600;
export const MAX_COOKIE_CACHE_SECONDS = 3600;

export function resolveCookieCacheSeconds(env: AuthBindings): number {
  const raw = env.BETTER_AUTH_COOKIE_CACHE_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COOKIE_CACHE_SECONDS;
  const n = Number(raw);
  // Bounded on purpose: a long cache would stretch the revocation window.
  if (!Number.isInteger(n) || n < 0 || n > MAX_COOKIE_CACHE_SECONDS) return DEFAULT_COOKIE_CACHE_SECONDS;
  return n;
}

/**
 * The D1 handle Better Auth's queries go to for the current request. The
 * per-isolate instance below is built once, so it cannot hold a request's D1
 * Sessions API handle. Instead it reads through this scope, and get-session
 * runs a cache miss against a read replica (see get-session.server.ts).
 * Outside a scope, every query goes to the primary binding.
 */
type ScopedD1 = D1Database | D1DatabaseSession;
const d1Scope = new AsyncLocalStorage<ScopedD1>();

/** Better Auth (drizzle) only calls prepare/batch, which both handle types have. */
export function runWithD1<T>(db: ScopedD1, fn: () => T): T {
  return d1Scope.run(db, fn);
}

function routedD1(primary: D1Database): D1Database {
  const current = () => (d1Scope.getStore() ?? primary) as D1Database;
  return {
    prepare: (query: string) => current().prepare(query),
    batch: (statements: D1PreparedStatement[]) => current().batch(statements),
    exec: (query: string) => current().exec(query),
    dump: () => (current() as unknown as { dump(): Promise<ArrayBuffer> }).dump(),
    withSession: (constraint?: string) =>
      (primary as unknown as { withSession(c?: string): unknown }).withSession(constraint),
  } as unknown as D1Database;
}

/**
 * Resolve the session signing secret. The published dev fallback is only
 * acceptable in local development; a deployed Worker without a secret must
 * fail instead of signing cookies with a constant from this repository.
 */
export function resolveAuthSecret(env: AuthBindings): string {
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET;
  if (secret) return secret;
  if (env.ENVIRONMENT === "development") return "dev-secret-change-me";
  throw new Error(
    "BETTER_AUTH_SECRET / AUTH_SECRET is not configured — refusing to use a fallback secret in non-development environment",
  );
}

async function sendOtpEmail(
  env: AuthBindings,
  to: string,
  otp: string,
  type: string,
) {
  if (!env.RESEND_API_KEY) {
    // Dev mode: print to vite console. Copy-paste into the UI.
    console.log(
      `\n  📬 [dev] OTP for ${to} (${type}): \x1b[1m${otp}\x1b[0m  (expires in 10 min)\n`,
    );
    return;
  }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Clash <auth@clash.art>",
        to,
        subject: "Your Clash verification code",
        html: `<p>Your code: <strong style="font-size:24px">${otp}</strong></p><p>Expires in 10 minutes.</p>`,
      }),
    });
  } catch (err) {
    console.error("[auth] Resend failed:", err);
  }
}

type AuthInstance = ReturnType<typeof buildAuth>;
const authByEnv = new WeakMap<object, AuthInstance>();

/**
 * Better Auth instance for this env, built once per isolate (issue #154; the
 * same pattern api-cf uses since #134). Building one (plugin init, drizzle
 * adapter, schema merge) used to happen on every /api/better-auth/* request.
 * The instance keeps no per-request state. `cf` only feeds geolocation, which
 * is off below, so it is not part of the key. Rate limiting is unchanged: in
 * better-auth 1.6 the "memory" store is module-level, so it was already
 * per isolate. A different env object (tests) gets its own instance.
 */
export function createAuth(env: AuthBindings, _cf?: IncomingRequestCfProperties): AuthInstance {
  const cached = authByEnv.get(env);
  if (cached) return cached;
  const auth = buildAuth(env);
  authByEnv.set(env, auth);
  return auth;
}

function buildAuth(env: AuthBindings, cf?: IncomingRequestCfProperties) {
  const secret = resolveAuthSecret(env);
  const baseURL = env.BETTER_AUTH_URL;
  const googleClientId = env.AUTH_GOOGLE_ID;
  const googleClientSecret = env.AUTH_GOOGLE_SECRET;

  return betterAuth(
    withCloudflare(
      {
        // off — these turned every get-session into a SELECT + UPDATE
        // (writing IP/country/lastActive back to the sessions row), and
        // the UPDATE has to round-trip to D1's primary region. The geo
        // captured at sign-in is enough for our use cases.
        autoDetectIpAddress: false,
        geolocationTracking: false,
        cf: (cf ?? {}) as IncomingRequestCfProperties,
        d1: {
          db: drizzle(routedD1(env.DB), { schema: betterAuthSchema }) as unknown as any,
          options: {
            usePlural: true,
            debugLogs: false,
          },
        },
        kv: env.KV as any,
      },
      {
        basePath,
        baseURL,
        trustedProxyHeaders: true,
        trustedOrigins: [
          "https://clash.art",
          "https://www.clash.art",
          "https://next.clash.art",
          ...(isLocalAuthBaseUrl(baseURL) ? devTrustedOrigins : []),
        ],
        secret,
        // Sign-out / session revocation revokes child gateway tokens (#346).
        // Writes go to the primary binding, never a read-replica scope.
        databaseHooks: gatewaySessionDatabaseHooks(
          () => env.DB,
          (error) =>
            console.warn("[auth] gateway token cascade failed:", error instanceof Error ? error.name : typeof error),
        ),
        session: {
          // Issue #154: signed session_data cookie. Sign-out expires it along
          // with session_token. Sensitive endpoints (revoke-*, change-password,
          // ...) bypass it inside Better Auth.
          cookieCache: (() => {
            const maxAge = resolveCookieCacheSeconds(env);
            return maxAge > 0
              ? { enabled: true, maxAge, strategy: "compact" as const }
              : { enabled: false };
          })(),
        },
        // Keep email/password for Settings → API tokens flows that may rely on
        // password-style accounts; it's harmless if unused by the main login UI.
        emailAndPassword: { enabled: true },
        socialProviders:
          googleClientId && googleClientSecret
            ? {
                google: {
                  enabled: true,
                  clientId: googleClientId,
                  clientSecret: googleClientSecret,
                },
              }
            : undefined,
        plugins: [
          emailOTP({
            otpLength: 6,
            expiresIn: 600, // 10 minutes
            // First code counts; after that, same email/IP has to wait. The
            // plugin gates send-verification-otp on its own; the outer
            // rateLimit below is a second layer.
            sendVerificationOnSignUp: false,
            async sendVerificationOTP({ email, otp, type }) {
              await sendOtpEmail(env, email, otp, type);
            },
          }),
        ],
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
          // In dev (no KV) better-auth falls back to in-memory storage per
          // worker isolate. In prod, bind KV (binding name "KV") and it will
          // persist across isolates.
          storage: env.KV ? "secondary-storage" : "memory",
          customRules: {
            "/email-otp/send-verification-otp": { window: 60, max: 1 }, // 1/min per IP
            "/sign-in/email-otp": { window: 60, max: 10 },
            "/sign-in/email": { window: 60, max: 10 },
            "/sign-up/email": { window: 300, max: 5 },
            "/sign-in/social": { window: 60, max: 30 },
          },
        },
      },
    ),
  );
}

// For `npx @better-auth/cli@latest generate` — schema generation only.
export function getCliAuth() {
  return betterAuth({
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: true,
        cf: {} as IncomingRequestCfProperties,
      },
      {
        basePath,
        trustedProxyHeaders: true,
        emailAndPassword: { enabled: true },
        plugins: [
          emailOTP({
            async sendVerificationOTP() {
              /* noop — schema generation only */
            },
          }),
        ],
      },
    ),
    database: drizzleAdapter({} as unknown as D1Database, {
      provider: "sqlite",
      usePlural: true,
      debugLogs: false,
    }),
  });
}
