import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

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
};

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

/**
 * Build a Better Auth instance bound to the current request's Cloudflare env.
 * Called per request to avoid stale bindings.
 */
export function createAuth(env: AuthBindings, cf?: IncomingRequestCfProperties) {
  const secret =
    env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? "dev-secret-change-me";
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
          db: drizzle(env.DB, { schema: betterAuthSchema }) as unknown as any,
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
