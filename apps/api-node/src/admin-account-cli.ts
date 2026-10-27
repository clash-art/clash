/**
 * Bootstrap an admin account for the Node admin listener (#372, #394):
 * `pnpm admin-account:create`. Admin sign-up is off, so the first account
 * comes from here, never from an environment grant. Run after `pnpm migrate`
 * (0022); it never migrates.
 *
 *   DATABASE_URL, CLOUD_PUBLIC_URL, ADMIN_AUTH_SECRET (or BETTER_AUTH_SECRET)
 *   ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD, ADMIN_ROLE (platform_admin | support_agent)
 *
 * The password is read from the environment, never argv, and is never printed.
 */
import { pathToFileURL } from "node:url";
import { isGatewayPlatformRole } from "@clash/gateway-core";
import { createNodeAdminAccount, createNodeAdminAuth } from "./admin-auth.ts";
import { databaseUrl, publicUrl } from "./config.ts";
import { openPostgres } from "./postgres.ts";

export async function createAdminAccountFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<{ id: string; email: string; role: string }> {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw Error(`${name} is required`);
    return value;
  };
  const role = env.ADMIN_ROLE?.trim() || "platform_admin";
  if (!isGatewayPlatformRole(role)) throw Error("ADMIN_ROLE must be platform_admin or support_agent");
  const secret = env.ADMIN_AUTH_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!secret) throw Error("ADMIN_AUTH_SECRET or BETTER_AUTH_SECRET is required");
  const database = openPostgres({ connectionString: databaseUrl(env) });
  try {
    const auth = createNodeAdminAuth({ pool: database.pool, publicUrl: publicUrl(env), secret });
    return await createNodeAdminAccount({
      auth,
      db: database.db,
      email: required("ADMIN_EMAIL"),
      name: required("ADMIN_NAME"),
      password: env.ADMIN_PASSWORD ?? required("ADMIN_PASSWORD"),
      role,
    });
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createAdminAccountFromEnv()
    .then((account) => console.log(`Admin account ${account.id} (${account.email}, ${account.role}) created`))
    .catch((error: unknown) => {
      // Never echo the password or the connection string: a code-free message only.
      console.error(error instanceof Error && !/postgres(ql)?:\/\//i.test(error.message) ? error.message : "Admin account creation failed");
      process.exitCode = 1;
    });
}
