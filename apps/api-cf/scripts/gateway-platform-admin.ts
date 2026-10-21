#!/usr/bin/env node
/**
 * Bootstrap the first gateway platform admin (#353; guide:
 * apps/docs/guide/gateway-admin.md). Local or staging D1 only; production is
 * refused. Idempotent: running it again for the same user changes nothing.
 *
 *   node apps/api-cf/scripts/gateway-platform-admin.ts --user <better-auth user id> --local
 *   node apps/api-cf/scripts/gateway-platform-admin.ts --user <id> --env staging
 *   ... --dry-run   prints the SQL and the wrangler command without running them
 *
 * Every later grant or revocation goes through the audited admin API
 * (POST /api/v1/admin/gateway/platform-admins, POST .../platform-admins/:userId/revoke).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bootstrapWranglerArgs,
  parseBootstrapArgs,
  platformAdminBootstrapSql,
} from "../src/gateway/platform-admin-bootstrap.ts";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");

function main(): number {
  let parsed: ReturnType<typeof parseBootstrapArgs>;
  try {
    parsed = parseBootstrapArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const sql = platformAdminBootstrapSql(parsed.userId);
  const args = bootstrapWranglerArgs(parsed.target, sql);
  if (parsed.dryRun) {
    console.log(sql);
    // The SQL holds no `$`, backtick or newline, so JSON quoting is valid shell double quoting.
    console.log(`\n(cd apps/web && pnpm ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")})`);
    return 0;
  }
  const result = spawnSync("pnpm", args, { cwd: webDir, stdio: "inherit" });
  return result.status ?? 1;
}

process.exitCode = main();
