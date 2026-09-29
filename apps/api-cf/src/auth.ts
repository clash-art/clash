/**
 * Better Auth handler — moved here from apps/web/app/lib/auth/better-auth.server.ts
 * so the API Worker is the single source of truth for auth state. Frontends
 * (apps/web, apps/web-tanstack) hit /api/better-auth/* and we either run it
 * here directly or proxy via the API_CF service binding.
 *
 * Schema lives in ./auth-schema.ts (same shape as the OSS schema; the D1
 * tables already exist from apps/web/drizzle migrations).
 */
import type {
  D1Database,
  IncomingRequestCfProperties,
  KVNamespace,
} from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as betterAuthSchema from "./auth-schema";
import { requireSecret } from "./services/require-secret";

const basePath = "/api/better-auth";

/** Cloudflare Email Service `send_email` binding shape. */
interface EmailBinding {
  send(input: {
    to: string;
    from: string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

export interface AuthBindings {
  DB: D1Database;
  KV?: KVNamespace<string>;
  /** Cloudflare Email Service binding — wrangler [[send_email]] name = "EMAIL". */
  EMAIL?: EmailBinding;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  /** Sender address; falls back to `auth@clash.art` if unset. Must be on a
   *  CF-DNS-managed domain that's onboarded into Email Service. */
  AUTH_EMAIL_FROM?: string;
  ENVIRONMENT: string;
}

async function sendOtpEmail(
  env: AuthBindings,
  to: string,
  otp: string,
  type: string,
): Promise<void> {
  if (!env.EMAIL) {
    // Dev fallback: print to console — copy-paste from `wrangler tail` into the UI.
    console.log(`[auth] OTP for ${to} (${type}): ${otp}  (expires in 10 min)`);
    return;
  }
  const from = env.AUTH_EMAIL_FROM ?? "Clash <auth@clash.art>";
  try {
    await env.EMAIL.send({
      to,
      from,
      subject: "Your Clash verification code",
      html: `<p>Your code: <strong style="font-size:24px">${otp}</strong></p><p>Expires in 10 minutes.</p>`,
      text: `Your Clash verification code: ${otp}\nExpires in 10 minutes.`,
    });
  } catch (err) {
    console.error("[auth] Email send failed:", err);
    // Fallback: log the OTP so a `wrangler tail` operator can still complete
    // login while the CF Email onboarding (DNS, destination verification) is
    // in flight. Safe-ish: prod tail requires CF account access.
    console.log(`[auth] OTP fallback for ${to} (${type}): ${otp}`);
  }
}

/** Build a Better Auth instance bound to the current request's env. */
export function createAuth(env: AuthBindings, cf?: IncomingRequestCfProperties) {
  const secret = requireSecret(
    env,
    "BETTER_AUTH_SECRET / AUTH_SECRET",
    env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET,
    "dev-secret-change-me",
  );
  const baseURL = env.BETTER_AUTH_URL;
  const googleClientId = env.AUTH_GOOGLE_ID;
  const googleClientSecret = env.AUTH_GOOGLE_SECRET;

  return betterAuth(
    withCloudflare(
      {
        // off — these turned every getSession into a SELECT + UPDATE
        // (writing IP/country/lastActive back to the sessions row), and
        // the UPDATE has to round-trip to D1's primary region. The geo
        // captured at sign-in is enough for our use cases.
        autoDetectIpAddress: false,
        geolocationTracking: false,
        cf: (cf ?? {}) as IncomingRequestCfProperties,
        d1: {
          db: drizzle(env.DB, { schema: betterAuthSchema }) as unknown as never,
          options: {
            usePlural: true,
            debugLogs: false,
          },
        },
        kv: env.KV,
      },
      {
        basePath,
        baseURL,
        trustedProxyHeaders: true,
        // Origins allowed to call /api/better-auth/*. Localhost entries are
        // only added in development so prod doesn't trust dev hosts (weakens
        // CSRF). Without these, cross-origin requests from the Vite dev proxy
        // (localhost:3001) get rejected with "Invalid origin".
        trustedOrigins: [
          "https://clash.art",
          "https://www.clash.art",
          "https://next.clash.art",
          "https://api.clash.art",
          ...(env.ENVIRONMENT === "development"
            ? [
                "http://localhost:3000",
                "http://localhost:3001",
                "http://127.0.0.1:3000",
                "http://127.0.0.1:3001",
              ]
            : []),
        ],
        secret,
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
            expiresIn: 600,
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
          // Without KV, falls back to in-memory storage per worker isolate.
          // With KV bound, rate-limit state persists across isolates.
          storage: env.KV ? "secondary-storage" : "memory",
          customRules: {
            "/email-otp/send-verification-otp": { window: 60, max: 1 },
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
