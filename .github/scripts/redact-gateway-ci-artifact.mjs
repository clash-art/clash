#!/usr/bin/env node
/**
 * Redact gateway CI artifacts before upload (#383).
 * Strips Bearer tokens and sk_/sk_gw_/clsh_ credential shapes from a file
 * (or every regular file under a directory). Never prints secret values.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

function redact(text) {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk_gw_[A-Za-z0-9._-]+/g, "sk_gw_[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/clsh_[A-Za-z0-9._-]+/g, "clsh_[REDACTED]");
}

async function redactPath(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) {
    const before = await readFile(path, "utf8");
    const after = redact(before);
    if (after !== before) await writeFile(path, after, "utf8");
    return 1;
  }
  if (!info.isDirectory()) return 0;
  let n = 0;
  for (const name of await readdir(path)) {
    n += await redactPath(join(path, name));
  }
  return n;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: redact-gateway-ci-artifact.mjs <file-or-dir>...");
  process.exit(2);
}
let total = 0;
for (const t of targets) total += await redactPath(t);
console.log(`redacted ${total} file(s)`);
