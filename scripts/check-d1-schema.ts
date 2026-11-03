#!/usr/bin/env node
/**
 * Predeploy D1 schema check (#64). Read-only: compares the D1 a wrangler
 * config binds as `DB` with the migrations in apps/web/drizzle and refuses
 * to continue when the database lacks anything the code was written for.
 *
 *   node scripts/check-d1-schema.ts --config apps/api-cf/wrangler.toml --env staging --remote
 *   node scripts/check-d1-schema.ts --config apps/web/wrangler.toml --local --persist-to .wrangler/state
 *
 * Two kinds of drift break a deploy with `D1_ERROR: no such table/column`:
 *   1. A migration file is not recorded in `d1_migrations` (wrangler's own
 *      ledger). `wrangler d1 migrations apply` fixes it.
 *   2. A migration recorded as applied was edited afterwards, so the database
 *      lacks an object that file now creates. wrangler never re-runs an
 *      applied file, so only a manual repair fixes it.
 *
 * The expected schema comes from applying every migration to an in-memory
 * SQLite; the actual schema comes from the bound database's `sqlite_master`
 * DDL, rebuilt in memory so both sides are introspected by the same SQLite.
 * Both queries are SELECTs; this script never writes to the database.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const DEFAULT_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/web/drizzle");
/** wrangler's default `migrations_table`; no Clash config overrides it. */
export const MIGRATIONS_TABLE = "d1_migrations";

export type D1SchemaIssueCode =
  | "D1_MIGRATION_UNAPPLIED"
  | "D1_MIGRATION_UNKNOWN"
  | "D1_SCHEMA_OBJECT_MISSING"
  | "D1_SCHEMA_DRIFT";

export interface D1SchemaIssue {
  code: D1SchemaIssueCode;
  message: string;
}

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Object keys: `table:x`, `column:x.y`, `index:x`, `trigger:x`, `view:x`. */
type SchemaKeys = Set<string>;

export class D1SchemaCheckError extends Error {
  readonly code = "D1_SCHEMA_QUERY_FAILED";
}

function isInternal(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_") || name === MIGRATIONS_TABLE;
}

function schemaRows(db: DatabaseSync): SchemaRow[] {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
    .all() as unknown as SchemaRow[];
}

function schemaKeys(db: DatabaseSync): SchemaKeys {
  const keys: SchemaKeys = new Set();
  const columns = db.prepare("SELECT name FROM pragma_table_info(?)");
  for (const row of schemaRows(db)) {
    if (isInternal(row.name)) continue;
    keys.add(`${row.type}:${row.name}`);
    if (row.type !== "table") continue;
    for (const column of columns.all(row.name) as Array<{ name: string }>) {
      keys.add(`column:${row.name}.${column.name}`);
    }
  }
  return keys;
}

export function listMigrationFiles(migrationsDir: string): string[] {
  // Same selection and order as wrangler's `d1 migrations apply`.
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export interface ExpectedSchema {
  migrations: string[];
  /** Each object of the final schema, keyed to the migration that last introduced it. */
  introducedBy: Map<string, string>;
}

export function buildExpectedSchema(migrationsDir: string): ExpectedSchema {
  const db = new DatabaseSync(":memory:");
  const migrations = listMigrationFiles(migrationsDir);
  const introducedBy = new Map<string, string>();
  let previous: SchemaKeys = new Set();
  for (const file of migrations) {
    db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
    const current = schemaKeys(db);
    for (const key of current) if (!previous.has(key)) introducedBy.set(key, file);
    for (const key of introducedBy.keys()) if (!current.has(key)) introducedBy.delete(key);
    previous = current;
  }
  db.close();
  return { migrations, introducedBy };
}

/** Rebuilds the bound database's tables from its DDL so columns can be introspected locally. */
export function actualSchemaKeys(rows: SchemaRow[]): SchemaKeys {
  const db = new DatabaseSync(":memory:");
  const keys: SchemaKeys = new Set();
  for (const row of rows) {
    if (!row.sql || isInternal(row.name)) continue;
    if (row.type !== "table") {
      keys.add(`${row.type}:${row.name}`);
      continue;
    }
    try {
      db.exec(row.sql);
    } catch (error) {
      // A virtual table creates its shadow tables, which sqlite_master also lists.
      if (!/already exists/.test(String(error))) throw error;
    }
  }
  for (const key of schemaKeys(db)) keys.add(key);
  db.close();
  return keys;
}

function describe(key: string): string {
  const separator = key.indexOf(":");
  return `${key.slice(0, separator)} ${key.slice(separator + 1)}`;
}

export function compareD1Schema(input: {
  expected: ExpectedSchema;
  applied: string[];
  actual: SchemaKeys;
}): D1SchemaIssue[] {
  const { expected, actual } = input;
  const applied = new Set(input.applied);
  const known = new Set(expected.migrations);
  const issues: D1SchemaIssue[] = [];
  for (const file of expected.migrations) {
    if (!applied.has(file)) {
      issues.push({ code: "D1_MIGRATION_UNAPPLIED", message: `${file} is not recorded in ${MIGRATIONS_TABLE}` });
    }
  }
  for (const file of input.applied) {
    if (!known.has(file)) {
      issues.push({
        code: "D1_MIGRATION_UNKNOWN",
        message: `${MIGRATIONS_TABLE} records ${file}, which is not in the repository's migrations (renamed or removed)`,
      });
    }
  }
  for (const [key, file] of expected.introducedBy) {
    if (actual.has(key)) continue;
    // A column of a missing table is implied by the table itself.
    if (key.startsWith("column:") && !actual.has(`table:${key.slice(7, key.lastIndexOf("."))}`)) continue;
    issues.push(
      applied.has(file)
        ? {
            code: "D1_SCHEMA_DRIFT",
            message: `${describe(key)} is missing although ${file} is recorded as applied; the file was edited after this database applied it (or the object was dropped by hand), and wrangler will not re-run it`,
          }
        : { code: "D1_SCHEMA_OBJECT_MISSING", message: `${describe(key)} is missing (created by unapplied ${file})` },
    );
  }
  return issues;
}

export type D1Query = (sql: string) => Array<Record<string, unknown>>;

export function checkD1Schema(query: D1Query, migrationsDir = DEFAULT_MIGRATIONS_DIR): D1SchemaIssue[] {
  const rows = query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL") as unknown as SchemaRow[];
  const hasLedger = rows.some((row) => row.type === "table" && row.name === MIGRATIONS_TABLE);
  const applied = hasLedger
    ? query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).map((row) => String(row.name))
    : [];
  return compareD1Schema({ expected: buildExpectedSchema(migrationsDir), applied, actual: actualSchemaKeys(rows) });
}

export interface WranglerTarget {
  config: string;
  env?: string;
  location: "remote" | "local";
  persistTo?: string;
}

/** Runs one read-only statement through `wrangler d1 execute DB --json`. */
export function wranglerQuery(target: WranglerTarget): D1Query {
  return (sql) => {
    const args = ["--silent", "--dir", path.dirname(target.config), "exec", "wrangler", "d1", "execute", "DB"];
    args.push("--config", target.config, `--${target.location}`, "--json", "--command", sql);
    if (target.env) args.push("--env", target.env);
    if (target.persistTo) args.push("--persist-to", target.persistTo);
    let stdout: string;
    try {
      stdout = execFileSync("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message;
      throw new D1SchemaCheckError(`wrangler d1 execute failed: ${detail.slice(-2000)}`);
    }
    const parsed = JSON.parse(stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.results)) {
      throw new D1SchemaCheckError(`wrangler d1 execute returned unexpected output: ${stdout.slice(0, 500)}`);
    }
    return parsed[0].results;
  };
}

export function parseArgs(argv: string[]): { target: WranglerTarget; migrationsDir: string } {
  let config: string | undefined;
  let env: string | undefined;
  let persistTo: string | undefined;
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  const locations: Array<"remote" | "local"> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") config = path.resolve(argv[++i] ?? "");
    else if (arg === "--env") env = argv[++i];
    else if (arg === "--persist-to") persistTo = path.resolve(argv[++i] ?? "");
    else if (arg === "--migrations") migrationsDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--remote" || arg === "--local") locations.push(arg === "--remote" ? "remote" : "local");
    else throw new D1SchemaCheckError(`unknown argument ${arg}`);
  }
  if (!config) throw new D1SchemaCheckError("--config <wrangler.toml> is required");
  // No default: checking the wrong side would report a healthy database.
  if (locations.length !== 1) throw new D1SchemaCheckError("pass exactly one of --remote or --local");
  return { target: { config, env, location: locations[0], persistTo }, migrationsDir };
}

export function main(argv: string[], queryFor: (target: WranglerTarget) => D1Query = wranglerQuery): number {
  let issues: D1SchemaIssue[];
  let label: string;
  try {
    const { target, migrationsDir } = parseArgs(argv);
    label = `${path.relative(REPO_ROOT, target.config)}${target.env ? ` --env ${target.env}` : ""} (${target.location})`;
    issues = checkD1Schema(queryFor(target), migrationsDir);
  } catch (error) {
    if (!(error instanceof D1SchemaCheckError)) throw error;
    console.error(`${error.code} ${error.message}`);
    return 2;
  }
  if (issues.length === 0) {
    console.log(`d1-schema: ${label} matches apps/web/drizzle`);
    return 0;
  }
  for (const issue of issues) console.error(`${issue.code} ${issue.message}`);
  console.error(`d1-schema: ${label} has ${issues.length} issue(s); deploying would fail requests with D1_ERROR`);
  if (issues.some((issue) => issue.code === "D1_MIGRATION_UNAPPLIED")) {
    console.error("  Unapplied migrations: run `wrangler d1 migrations apply DB --remote` with the same --config/--env.");
  }
  if (issues.some((issue) => issue.code === "D1_SCHEMA_DRIFT" || issue.code === "D1_MIGRATION_UNKNOWN")) {
    console.error("  Drift in applied migrations needs a manual repair; wrangler cannot apply it.");
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
