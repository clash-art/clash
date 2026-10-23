#!/usr/bin/env node
/**
 * Bootstrap the first gateway admin account (#353, #394; guide:
 * apps/docs/guide/gateway-admin.md). Local or staging D1 only; production is
 * refused. Idempotent: running it again for the same email changes nothing.
 * It writes the admin account store, never the product users table.
 *
 *   node apps/api-cf/scripts/gateway-admin-account.ts --email ops@example.com --local
 *   node apps/api-cf/scripts/gateway-admin-account.ts --email ops@example.com --name Ops --env staging
 *   ... --dry-run   prints the SQL (password hash redacted) and the wrangler command without running them
 *
 * The password is read from CLASH_ADMIN_PASSWORD or a hidden prompt, never
 * from the command line, and never printed. Sign in at /admin/login. Every
 * later admin account goes through the audited admin API
 * (POST /api/v1/admin/gateway/admin-accounts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";

import {
  adminAccountBootstrapSql,
  bootstrapWranglerArgs,
  checkAdminPassword,
  parseBootstrapArgs,
  redactBootstrapSql,
} from "../src/gateway/admin-account-bootstrap.ts";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");

/** A prompt that echoes nothing typed, or all of stdin when it is not a terminal. */
async function readPassword(): Promise<string> {
  const fromEnv = process.env.CLASH_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    let piped = "";
    for await (const chunk of process.stdin) piped += String(chunk);
    return piped.replace(/\r?\n$/, "");
  }
  process.stderr.write("Admin password (not echoed): ");
  const prompt = createInterface({ input: process.stdin, terminal: true });
  // Swallow the echo: readline writes typed characters through this method.
  (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
  return new Promise((resolvePassword) =>
    prompt.question("", (answer) => {
      prompt.close();
      process.stderr.write("\n");
      resolvePassword(answer);
    }),
  );
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseBootstrapArgs>;
  try {
    parsed = parseBootstrapArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const password = await readPassword();
  try {
    checkAdminPassword(password);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const passwordHash = await hashPassword(password);
  const sql = adminAccountBootstrapSql({
    id: `adm_${crypto.randomUUID().replaceAll("-", "")}`,
    email: parsed.email,
    name: parsed.name,
    passwordHash,
  });
  const dir = mkdtempSync(join(tmpdir(), "clash-admin-bootstrap-"));
  const file = join(dir, "bootstrap.sql");
  try {
    const args = bootstrapWranglerArgs(parsed.target, file);
    if (parsed.dryRun) {
      console.log(redactBootstrapSql(sql, passwordHash));
      console.log(`\n(cd apps/web && pnpm ${args.join(" ")})`);
      return 0;
    }
    // A file, not --command: the hash stays out of the process list.
    writeFileSync(file, sql, { mode: 0o600 });
    const result = spawnSync("pnpm", args, { cwd: webDir, stdio: "inherit" });
    if (result.status === 0) console.log(`Admin account ${parsed.email} exists; sign in at /admin/login.`);
    return result.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
