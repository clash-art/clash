// D1 records each applied migration by file name and `wrangler d1 migrations
// apply` never reruns a recorded file. Editing an applied migration in place
// therefore never reaches a database that already ran it: 40a4812c added
// `project.deleted_at` (0000) and `chat_session.archived_at` (0005) that way.
//
// This predeploy gate reads a target D1 and fails when the repository has
// migrations the target has not applied, or when replaying the migrations the
// target did apply defines a table or column the target lacks. It only reads
// the target. For missing columns it prints repair SQL; applying that SQL to a
// deployed database is a human step (apps/docs/guide/d1-migrations.md), and
// the tool applies it itself only to a `--local` database.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(repoRoot, "apps/web");
export const DEFAULT_MIGRATIONS_DIR = path.join(webDir, "drizzle");

export type D1CheckErrorCode =
  | "D1_USAGE"
  | "D1_TARGET_UNREADABLE"
  | "D1_REPLAY_FAILED"
  | "D1_REMOTE_REPAIR_REFUSED";

export class D1CheckError extends Error {
  readonly code: D1CheckErrorCode;
  constructor(code: D1CheckErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export type Column = { type: string; notnull: boolean; dflt: string | null; pk: boolean };
/** table → column → definition, as `pragma_table_info` reports it. */
export type Schema = Map<string, Map<string, Column>>;
/** Runs one read statement against a database and returns its rows. */
export type QueryRunner = (sql: string) => Record<string, unknown>[];

export const APPLIED_SQL = "SELECT name FROM d1_migrations ORDER BY id";
// Mirrors drizzle-kit's D1 introspection; `_cf_*` tables are Cloudflare-internal.
export const SCHEMA_SQL =
  "SELECT m.name AS tbl, p.name AS col, p.type AS type, p.\"notnull\" AS nn, p.dflt_value AS dflt, p.pk AS pk " +
  "FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
  "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
  "AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND m.name != 'd1_migrations' " +
  "ORDER BY m.name, p.cid";

export function repoMigrations(dir = DEFAULT_MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function schemaFromRows(rows: Record<string, unknown>[]): Schema {
  const schema: Schema = new Map();
  for (const row of rows) {
    const table = String(row.tbl);
    const columns = schema.get(table) ?? new Map<string, Column>();
    columns.set(String(row.col), {
      type: String(row.type ?? ""),
      notnull: Number(row.nn) === 1,
      dflt: row.dflt == null ? null : String(row.dflt),
      pk: Number(row.pk) > 0,
    });
    schema.set(table, columns);
  }
  return schema;
}

/** Replays the named migrations into an empty SQLite database and returns the resulting schema. */
export function replaySchema(dir: string, names: string[]): Schema {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of names) {
      try {
        db.exec(readFileSync(path.join(dir, name), "utf8"));
      } catch (error) {
        throw new D1CheckError("D1_REPLAY_FAILED", `${name} does not replay: ${(error as Error).message}`);
      }
    }
    return schemaFromRows(db.prepare(SCHEMA_SQL).all() as Record<string, unknown>[]);
  } finally {
    db.close();
  }
}

export type TargetState = { applied: string[]; schema: Schema };

export function readTarget(run: QueryRunner): TargetState {
  return {
    applied: run(APPLIED_SQL).map((row) => String(row.name)),
    schema: schemaFromRows(run(SCHEMA_SQL)),
  };
}

export type MissingColumn = { table: string; column: string; definition: Column };

export type DriftReport = {
  /** Repository migrations the target has not recorded. */
  pending: string[];
  /** Recorded migrations no longer in the repository (retired files). Reported, never fatal. */
  retired: string[];
  /** Tables the target's own applied migrations define but the target lacks. */
  missingTables: string[];
  /** Columns the target's own applied migrations define but the target lacks. */
  missingColumns: MissingColumn[];
};

/**
 * The expected schema is replayed from the repository migrations the target
 * has recorded, so pending migrations are reported as pending rather than as
 * missing columns, and a lineage edit is reported even while others are pending.
 */
export function checkTarget(dir: string, target: TargetState): DriftReport {
  const repo = repoMigrations(dir);
  const recorded = new Set(target.applied);
  const known = new Set(repo);
  const expected = replaySchema(
    dir,
    repo.filter((name) => recorded.has(name)),
  );
  const missingTables: string[] = [];
  const missingColumns: MissingColumn[] = [];
  for (const [table, columns] of expected) {
    const actual = target.schema.get(table);
    if (!actual) {
      missingTables.push(table);
      continue;
    }
    for (const [column, definition] of columns)
      if (!actual.has(column)) missingColumns.push({ table, column, definition });
  }
  return {
    pending: repo.filter((name) => !recorded.has(name)),
    retired: target.applied.filter((name) => !known.has(name)),
    missingTables,
    missingColumns,
  };
}

export function hasDrift(report: DriftReport): boolean {
  return report.pending.length + report.missingTables.length + report.missingColumns.length > 0;
}

// SQLite's ADD COLUMN accepts only a constant default; pragma_table_info drops
// the parentheses around an expression default such as `(strftime('%s','now'))`.
const CONSTANT_DEFAULT = /^(?:NULL|TRUE|FALSE|[-+]?\d+(?:\.\d+)?|'(?:[^']|'')*'|X'[0-9a-f]*')$/i;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export type RepairPlan = {
  /** Statements safe to apply once, generated from columns verified missing. */
  statements: string[];
  /** Drift ADD COLUMN cannot express; needs a reviewed manual migration step. */
  manual: string[];
};

export function repairPlan(report: DriftReport): RepairPlan {
  const statements: string[] = [];
  const manual = report.missingTables.map(
    (table) => `table ${table} is missing; re-create it from the migration that defines it after review`,
  );
  for (const { table, column, definition } of report.missingColumns) {
    const { type, notnull, dflt, pk } = definition;
    const reason = pk
      ? "is part of the primary key"
      : dflt !== null && !CONSTANT_DEFAULT.test(dflt)
        ? `has the non-constant default ${dflt}`
        : notnull && dflt === null
          ? "is NOT NULL without a default"
          : null;
    if (reason) {
      manual.push(`${table}.${column} ${reason}; ADD COLUMN cannot add it, rebuild the table after review`);
      continue;
    }
    const parts = [`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)}`];
    if (type) parts.push(type);
    if (dflt !== null) parts.push(`DEFAULT ${dflt}`);
    if (notnull) parts.push("NOT NULL");
    statements.push(`${parts.join(" ")};`);
  }
  return { statements, manual };
}

export function formatReport(label: string, report: DriftReport, plan: RepairPlan): string[] {
  const lines: string[] = [];
  for (const name of report.retired)
    lines.push(`warning: ${label} recorded ${name}, which is no longer in the repository (retired migration)`);
  if (report.pending.length)
    lines.push(
      `D1_PENDING_MIGRATIONS: ${label} has not applied ${report.pending.length} migration(s): ${report.pending.join(", ")}`,
      "  apply them with `wrangler d1 migrations apply` after owner approval",
    );
  if (report.missingTables.length || report.missingColumns.length) {
    const missing = [
      ...report.missingTables.map((table) => `table ${table}`),
      ...report.missingColumns.map(({ table, column }) => `${table}.${column}`),
    ];
    lines.push(
      `D1_SCHEMA_DRIFT: ${label} recorded migrations that define ${missing.join(", ")}, but the database lacks them`,
      "  an applied migration was edited in place; see apps/docs/guide/d1-migrations.md",
    );
    if (plan.statements.length) lines.push("  repair SQL (review, then apply once):", ...plan.statements.map((s) => `    ${s}`));
    for (const note of plan.manual) lines.push(`  manual: ${note}`);
  }
  if (!hasDrift(report)) lines.push(`d1-migration-check: ${label} is up to date with the repository migrations`);
  return lines;
}

export type WranglerTarget = {
  database: string;
  location: "remote" | "local";
  env?: string;
  config?: string;
  persistTo?: string;
};

function wranglerArgs(target: WranglerTarget): string[] {
  const args = ["--silent", "--dir", webDir, "exec", "wrangler", "d1", "execute", target.database, `--${target.location}`];
  if (target.env) args.push("--env", target.env);
  if (target.config) args.push("--config", path.resolve(target.config));
  if (target.persistTo) args.push("--persist-to", path.resolve(target.persistTo));
  return args;
}

export function parseWranglerJson(sql: string, stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1CheckError("D1_TARGET_UNREADABLE", `wrangler did not return JSON for: ${sql}\n${stdout.slice(0, 2000)}`);
  }
  const first = Array.isArray(parsed) ? (parsed[0] as { results?: unknown; success?: boolean }) : undefined;
  if (!first || first.success === false || !Array.isArray(first.results))
    throw new D1CheckError("D1_TARGET_UNREADABLE", `wrangler query failed: ${sql}\n${stdout.slice(0, 2000)}`);
  return first.results as Record<string, unknown>[];
}

/** Read-only runner over `wrangler d1 execute --json`. */
export function wranglerRunner(target: WranglerTarget): QueryRunner {
  return (sql) => {
    let stdout: string;
    try {
      stdout = execFileSync("pnpm", [...wranglerArgs(target), "--json", "--command", sql], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message;
      throw new D1CheckError("D1_TARGET_UNREADABLE", `wrangler d1 execute failed for: ${sql}\n${detail.slice(0, 2000)}`);
    }
    return parseWranglerJson(sql, stdout);
  };
}

function applyLocal(target: WranglerTarget, statements: string[]): void {
  execFileSync("pnpm", [...wranglerArgs(target), "--command", statements.join("\n")], { stdio: "inherit" });
}

const USAGE =
  "usage: d1-migration-check.ts --remote|--local [--database DB] [--env NAME] [--config wrangler.toml] " +
  "[--persist-to DIR] [--migrations DIR] [--apply-repair]";

export type CliOptions = WranglerTarget & { migrations: string; applyRepair: boolean };

export function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { database: "DB", migrations: DEFAULT_MIGRATIONS_DIR, applyRepair: false };
  const valued: Record<string, "database" | "env" | "config" | "persistTo" | "migrations"> = {
    "--database": "database",
    "--env": "env",
    "--config": "config",
    "--persist-to": "persistTo",
    "--migrations": "migrations",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote" || arg === "--local") {
      if (options.location) throw new D1CheckError("D1_USAGE", `choose one of --remote or --local\n${USAGE}`);
      options.location = arg === "--remote" ? "remote" : "local";
    } else if (arg === "--apply-repair") options.applyRepair = true;
    else if (arg in valued) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new D1CheckError("D1_USAGE", `${arg} needs a value\n${USAGE}`);
      options[valued[arg]] = value;
    } else throw new D1CheckError("D1_USAGE", `unknown argument ${arg}\n${USAGE}`);
  }
  if (!options.location) throw new D1CheckError("D1_USAGE", `choose --remote or --local\n${USAGE}`);
  if (options.location === "remote" && options.persistTo)
    throw new D1CheckError("D1_USAGE", "--persist-to only applies to --local");
  if (options.location === "remote" && options.applyRepair)
    throw new D1CheckError(
      "D1_REMOTE_REPAIR_REFUSED",
      "this tool never writes to a deployed D1; review the printed repair SQL and follow apps/docs/guide/d1-migrations.md",
    );
  return options as CliOptions;
}

export type CliDeps = {
  run?: QueryRunner;
  apply?: (statements: string[]) => void;
  log?: (line: string) => void;
};

export function main(argv: string[], deps: CliDeps = {}): number {
  const log = deps.log ?? console.log;
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log((error as Error).message);
    return 2;
  }
  const label = `${options.location} D1 ${options.database}${options.env ? ` (env ${options.env})` : ""}`;
  try {
    const query = deps.run ?? wranglerRunner(options);
    const report = checkTarget(options.migrations, readTarget(query));
    const plan = repairPlan(report);
    for (const line of formatReport(label, report, plan)) log(line);
    if (options.applyRepair && plan.statements.length) {
      (deps.apply ?? ((statements) => applyLocal(options, statements)))(plan.statements);
      const after = checkTarget(options.migrations, readTarget(query));
      for (const line of formatReport(`${label} after repair`, after, repairPlan(after))) log(line);
      return hasDrift(after) ? 1 : 0;
    }
    return hasDrift(report) ? 1 : 0;
  } catch (error) {
    log((error as Error).message);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
