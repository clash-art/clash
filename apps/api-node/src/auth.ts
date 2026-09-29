import { betterAuth } from "better-auth";
import type { Pool } from "pg";

/** Host-owned PG pool; schema is migrated explicitly, never on request. */
export function createNodeAuth(options: {
  pool: Pool;
  publicUrl: string;
  secret: string;
}) {
  if (options.secret.length < 32)
    throw Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(options.publicUrl).origin;
  return betterAuth({
    database: options.pool,
    baseURL: origin,
    basePath: "/api/better-auth",
    secret: options.secret,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session", cookieCache: { enabled: false } },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
    },
  });
}
export type NodeAuth = ReturnType<typeof createNodeAuth>;
