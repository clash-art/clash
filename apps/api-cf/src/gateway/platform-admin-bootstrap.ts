/**
 * Bootstrap of the first platform admin (#353; guide:
 * apps/docs/guide/gateway-admin.md). Nobody can grant `platform_admin`
 * through the API until someone holds it, so the first grant is this explicit
 * SQL, run by apps/api-cf/scripts/gateway-platform-admin.ts against a local
 * or staging D1 only. There is no environment-variable grant.
 *
 * Dependency-free so the script can run it under native Node TypeScript.
 */

/** Better Auth user ids are opaque text; this bounds what the bootstrap SQL embeds. */
export const PLATFORM_ADMIN_USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Idempotent: the grant is INSERT OR IGNORE on the (user_id, role) key, and
 * its audit row (actor `bootstrap`) is written only when the grant was new.
 * The user id is validated, then quoted, because `wrangler d1 execute
 * --command` takes no bind parameters.
 */
export function platformAdminBootstrapSql(userId: string): string {
  if (!PLATFORM_ADMIN_USER_ID_PATTERN.test(userId))
    throw new Error(`Refusing user id ${JSON.stringify(userId)}: expected ${PLATFORM_ADMIN_USER_ID_PATTERN}.`);
  const id = `'${userId.replaceAll("'", "''")}'`;
  // One line, so the printed dry-run command can be pasted into a shell as is.
  return [
    `INSERT OR IGNORE INTO gateway_platform_role (user_id, role, granted_by_user_id) VALUES (${id}, 'platform_admin', NULL);`,
    `INSERT INTO gateway_admin_audit (id, tenant_id, actor_user_id, actor_role, action, target_type, target_id, after_json, reason, occurred_at)`,
    `SELECT 'gwa_' || lower(hex(randomblob(16))), '', 'bootstrap', 'bootstrap', 'platform_role.grant', 'platform_role', ${id},`,
    `'{"role":"platform_admin"}', 'bootstrap', CAST(strftime('%s', 'now') AS INTEGER) WHERE changes() = 1;`,
  ].join(" ");
}

export type BootstrapTarget = { kind: "local" } | { kind: "staging" };

/** Only a local or the staging D1; anything else (production included) is refused. */
export function parseBootstrapArgs(argv: readonly string[]): {
  userId: string;
  target: BootstrapTarget;
  dryRun: boolean;
} {
  let userId: string | undefined;
  let target: BootstrapTarget | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--user") userId = argv[++index];
    else if (arg === "--local") target = { kind: "local" };
    else if (arg === "--env") {
      const env = argv[++index];
      if (env !== "staging") throw new Error(`Refusing --env ${env ?? ""}: only --local or --env staging are allowed.`);
      target = { kind: "staging" };
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--remote" || arg === "--production" || arg?.startsWith("--env="))
      throw new Error(`Refusing ${arg}: only --local or --env staging are allowed.`);
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!userId) throw new Error("Missing --user <better-auth user id>.");
  if (!target) throw new Error("Choose --local or --env staging.");
  platformAdminBootstrapSql(userId);
  return { userId, target, dryRun };
}

/** The wrangler invocation for `target`, run from apps/web (whose D1 config local dev uses). */
export function bootstrapWranglerArgs(target: BootstrapTarget, sql: string): string[] {
  return target.kind === "local"
    ? ["exec", "wrangler", "d1", "execute", "clash-d1", "--local", "--command", sql]
    : ["exec", "wrangler", "d1", "execute", "clash-staging", "--env", "staging", "--remote", "--command", sql];
}
