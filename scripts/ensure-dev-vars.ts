// Committed wrangler configs describe deployed Workers and must not mark
// themselves as development. Local dev gets that marker from the git-ignored
// `.dev.vars` beside each Worker config; this creates or completes that file
// so `make dev` keeps working without manual setup.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "ENVIRONMENT=development";

/** Returns true when the file was created or extended. An existing ENVIRONMENT value is never changed. */
export function ensureDevVars(workerDir: string): boolean {
  const file = path.join(workerDir, ".dev.vars");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\s*ENVIRONMENT\s*=/m.test(current)) return false;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(
    file,
    `${current}${separator}# Local development marker (never upload as a deployed var or secret).\n${MARKER}\n`,
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) {
    if (ensureDevVars(path.resolve(dir))) {
      console.log(`[dev] wrote ${MARKER} to ${path.join(dir, ".dev.vars")}`);
    }
  }
}
