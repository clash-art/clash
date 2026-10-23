/**
 * Bootstrap of the first admin account (#353, #394; guide:
 * apps/docs/guide/gateway-admin.md). Nobody can create an admin account
 * through the API until one can sign in, so the first is this explicit SQL,
 * run by apps/api-cf/scripts/gateway-admin-account.ts against a local or
 * staging D1 only. It writes the admin store (admin_accounts and its
 * credential), never the product users table. There is no
 * environment-variable grant.
 *
 * Dependency-free so the script can run it under native Node TypeScript; the
 * script hashes the password with Better Auth's own hasher.
 */

/** What the bootstrap SQL embeds is bounded by these, because `wrangler d1 execute` takes no bind parameters. */
export const ADMIN_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ADMIN_NAME_PATTERN = /^[\p{L}\p{N} ._'-]{1,100}$/u;
const ADMIN_ID_PATTERN = /^adm_[a-f0-9]{32}$/;
/** Better Auth scrypt hashes: `<hex salt>:<hex key>`. */
const PASSWORD_HASH_PATTERN = /^[a-f0-9]{16,256}:[a-f0-9]{16,1024}$/;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface AdminAccountBootstrap {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

/**
 * Idempotent on the email: the account is INSERT OR IGNORE on its unique
 * email, and its credential and audit row (actor kind `bootstrap`) are
 * written only when the account was new. Running it again for an existing
 * email changes nothing, its password included.
 */
export function adminAccountBootstrapSql(input: AdminAccountBootstrap): string {
  const email = input.email.trim().toLowerCase();
  if (!ADMIN_EMAIL_PATTERN.test(email)) throw new Error(`Refusing email ${JSON.stringify(input.email)}: not an email address.`);
  if (!ADMIN_NAME_PATTERN.test(input.name)) throw new Error(`Refusing name ${JSON.stringify(input.name)}: expected ${ADMIN_NAME_PATTERN}.`);
  if (!ADMIN_ID_PATTERN.test(input.id)) throw new Error("Refusing account id: expected adm_ and 32 hex digits.");
  if (!PASSWORD_HASH_PATTERN.test(input.passwordHash)) throw new Error("Refusing password hash: not a Better Auth scrypt hash.");
  const nowMs = `CAST(unixepoch('subsecond') * 1000 AS INTEGER)`;
  const id = quote(input.id);
  // One line, so a printed command can be pasted into a shell as is.
  return [
    `INSERT OR IGNORE INTO admin_accounts (id, name, email, email_verified, role, created_at, updated_at)`,
    `VALUES (${id}, ${quote(input.name)}, ${quote(email)}, 1, 'platform_admin', ${nowMs}, ${nowMs});`,
    `INSERT INTO admin_credentials (id, account_id, provider_id, admin_id, password, created_at, updated_at)`,
    `SELECT 'adm_' || lower(hex(randomblob(16))), ${id}, 'credential', ${id}, ${quote(input.passwordHash)}, ${nowMs}, ${nowMs} WHERE changes() = 1;`,
    `INSERT INTO gateway_admin_audit (id, tenant_id, actor_id, actor_kind, actor_role, action, target_type, target_id, after_json, reason, occurred_at)`,
    `SELECT 'gwa_' || lower(hex(randomblob(16))), '', 'bootstrap', 'bootstrap', NULL, 'admin_account.create', 'admin_account', ${id},`,
    `json_object('email', ${quote(email)}, 'role', 'platform_admin'), 'bootstrap', CAST(strftime('%s', 'now') AS INTEGER) WHERE changes() = 1;`,
  ].join(" ");
}

export type BootstrapTarget = { kind: "local" } | { kind: "staging" };

/** Only a local or the staging D1; anything else (production included) is refused. */
export function parseBootstrapArgs(argv: readonly string[]): {
  email: string;
  name: string;
  target: BootstrapTarget;
  dryRun: boolean;
} {
  let email: string | undefined;
  let name: string | undefined;
  let target: BootstrapTarget | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--email") email = argv[++index];
    else if (arg === "--name") name = argv[++index];
    else if (arg === "--local") target = { kind: "local" };
    else if (arg === "--env") {
      const env = argv[++index];
      if (env !== "staging") throw new Error(`Refusing --env ${env ?? ""}: only --local or --env staging are allowed.`);
      target = { kind: "staging" };
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--remote" || arg === "--production" || arg?.startsWith("--env="))
      throw new Error(`Refusing ${arg}: only --local or --env staging are allowed.`);
    else if (arg === "--password" || arg?.startsWith("--password="))
      throw new Error("Refusing --password: pass the password in CLASH_ADMIN_PASSWORD or at the prompt, never on the command line.");
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!email) throw new Error("Missing --email <admin email>.");
  if (!target) throw new Error("Choose --local or --env staging.");
  const resolvedName = name ?? email.split("@")[0] ?? "";
  // Validate everything the SQL embeds before any password is asked for.
  adminAccountBootstrapSql({ id: `adm_${"0".repeat(32)}`, email, name: resolvedName, passwordHash: `${"0".repeat(32)}:${"0".repeat(128)}` });
  return { email: email.trim().toLowerCase(), name: resolvedName, target, dryRun };
}

/** Refuse a password the admin instance would not accept, without ever echoing it. */
export function checkAdminPassword(password: string): void {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > ADMIN_PASSWORD_MAX_LENGTH)
    throw new Error(`The password must be ${ADMIN_PASSWORD_MIN_LENGTH} to ${ADMIN_PASSWORD_MAX_LENGTH} characters.`);
}

/** The wrangler invocation for `target` and a SQL file, run from apps/web (whose D1 config local dev uses). */
export function bootstrapWranglerArgs(target: BootstrapTarget, sqlFile: string): string[] {
  return target.kind === "local"
    ? ["exec", "wrangler", "d1", "execute", "clash-d1", "--local", "--file", sqlFile]
    : ["exec", "wrangler", "d1", "execute", "clash-staging", "--env", "staging", "--remote", "--file", sqlFile];
}

/** The SQL as the dry run prints it: the password hash is never shown. */
export function redactBootstrapSql(sql: string, passwordHash: string): string {
  return sql.replaceAll(passwordHash, "<password hash>");
}
