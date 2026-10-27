import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SqlConnection } from "./postgres.ts";
export interface Migration {
  id: string;
  sql: string;
}
export interface MigrationDatabase {
  transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T>;
}
export async function loadMigrations(): Promise<Migration[]> {
  return Promise.all(
    [
      "0001_project_admission.sql",
      "0002_api_tokens.sql",
      "0003_replica_log.sql",
      "0004_replica_checkpoint.sql",
      "0005_replica_batch.sql",
      "0006_client_checkpoint.sql",
      "0007_retire_checkpoint_tasks.sql",
      "0008_checkpoint_outbox.sql",
      "0009_cloud_runs.sql",
      "0010_auth.sql",
      "0011_personal_assets.sql",
      "0012_project_resources.sql",
      "0013_project_content_ref.sql",
      "0014_text_revisions.sql",
      "0015_provider_settings.sql",
      "0016_gateway.sql",
      "0017_gateway_keyring.sql",
      "0018_gateway_virtual_key.sql",
      "0019_gateway_credential_priority.sql",
      "0020_gateway_billing.sql",
      "0021_gateway_admin.sql",
    ].map(async (id) => ({
      id,
      sql: await readFile(
        new URL(
          `../../../packages/shared-cloud-schema/postgres/${id}`,
          import.meta.url,
        ),
        "utf8",
      ),
    })),
  );
}

export type MigrationErrorCode =
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_CONTRACT_REFUSED"
  | "MIGRATION_LOCK_TIMEOUT";
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migrationIds: readonly string[];
  constructor(
    code: MigrationErrorCode,
    message: string,
    migrationIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.migrationIds = migrationIds;
  }
}

/**
 * Expand/contract phase of one migration (see
 * apps/docs/guide/gateway-node-rollout.md). An expand step keeps the previous
 * release working against the new schema; a contract step removes something
 * the previous release may still use, so it may only run once no node of
 * that release is left. A migration is contract when its SQL declares
 * `-- migration-phase: contract`, or when it contains a statement the
 * previous release cannot survive (the scanner is a safety net, the
 * checklist is the rule).
 */
export type MigrationPhase = "expand" | "contract";
const CONTRACT_MARKER = /^\s*--\s*migration-phase:\s*contract\b/im;
const ALTER_CLAUSE_CONTRACT: readonly [RegExp, string][] = [
  [
    /^DROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)/i,
    "drops a column",
  ],
  [/\bSET\s+NOT\s+NULL\b/i, "sets a column NOT NULL"],
  [
    /^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    "changes a column type",
  ],
  [/^RENAME\b/i, "renames"],
];
/** SQL without comments, string literals and dollar-quoted bodies. */
function codeOnly(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}
/** Top-level comma split of an ALTER TABLE action list. */
function alterClauses(actions: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < actions.length; i++) {
    const char = actions[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      clauses.push(actions.slice(start, i));
      start = i + 1;
    }
  }
  clauses.push(actions.slice(start));
  return clauses.map((clause) => clause.trim()).filter(Boolean);
}
export function classifyMigration(sql: string): {
  phase: MigrationPhase;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (CONTRACT_MARKER.test(sql)) reasons.push("declared contract");
  for (const raw of codeOnly(sql).split(";")) {
    const statement = raw.replace(/\s+/g, " ").trim();
    const drop =
      /^DROP (TABLE|VIEW|MATERIALIZED VIEW|TYPE|SCHEMA|SEQUENCE)\b/i.exec(
        statement,
      );
    if (drop) reasons.push(`drops a ${drop[1]!.toLowerCase()}`);
    if (/^TRUNCATE\b/i.test(statement)) reasons.push("truncates a table");
    const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?\S+ (.*)$/i.exec(
      statement,
    );
    if (!alter) continue;
    for (const clause of alterClauses(alter[1]!)) {
      if (/^ADD\b/i.test(clause)) {
        if (
          !/^ADD (?:CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN|EXCLUDE)\b/i.test(
            clause,
          ) &&
          /\bNOT NULL\b/i.test(clause) &&
          !/\bDEFAULT\b/i.test(clause) &&
          !/\bGENERATED\b/i.test(clause)
        )
          reasons.push("adds a NOT NULL column without a default");
        continue;
      }
      for (const [pattern, reason] of ALTER_CLAUSE_CONTRACT)
        if (pattern.test(clause)) reasons.push(reason);
    }
  }
  const unique = [...new Set(reasons)];
  return { phase: unique.length ? "contract" : "expand", reasons: unique };
}

export interface PendingMigration {
  id: string;
  phase: MigrationPhase;
  reasons: string[];
}
export interface MigrationReport {
  /** No migration was recorded yet: nothing old runs against this database. */
  bootstrap: boolean;
  /** Recorded and known to this release. */
  applied: string[];
  /** Not recorded yet, in apply order. */
  pending: PendingMigration[];
  /** Recorded but unknown to this release: the database is ahead (rollback). */
  ahead: string[];
  /** Applied by this run (empty for a plan). */
  appliedNow: string[];
}
export interface RunMigrationsOptions {
  migrations?: Migration[];
  /** Report what would run, without changing the database. */
  plan?: boolean;
  /**
   * Allow contract migrations on a database that already has migrations.
   * Bootstrap databases apply every phase.
   */
  allowContract?: boolean;
  /**
   * Bound the wait for the migration lock and for each DDL table lock,
   * instead of queueing behind another runner or live traffic indefinitely.
   */
  lockTimeoutMs?: number;
}

const MIGRATION_LOCK =
  "SELECT pg_advisory_xact_lock(hashtext('clash:cloud:migrations'))";
const checksumOf = (sql: string) =>
  createHash("sha256").update(sql).digest("hex");

/**
 * One-shot migration run: one transaction, serialized across processes by a
 * transaction advisory lock (released at COMMIT/ROLLBACK, so a killed runner
 * never leaves it held). Checksums and the expand/contract gate are checked
 * under the lock before anything is applied; a failure rolls everything back.
 */
export async function runMigrations(
  db: MigrationDatabase,
  options: RunMigrationsOptions = {},
): Promise<MigrationReport> {
  const entries = options.migrations ?? (await loadMigrations());
  const lockTimeoutMs = options.lockTimeoutMs;
  if (
    lockTimeoutMs !== undefined &&
    (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1)
  )
    throw RangeError("lockTimeoutMs must be a positive integer");
  try {
    return await db.transaction(async (tx) => {
      if (lockTimeoutMs !== undefined)
        await tx.exec(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      // Serializes migration runners across processes; the lock ends with this transaction.
      await tx.query(MIGRATION_LOCK);
      const exists = await tx.query<{ name: string | null }>(
        "SELECT to_regclass('cloud_schema_migration')::text AS name",
      );
      if (!exists.rows[0]?.name && !options.plan)
        await tx.query(
          "CREATE TABLE IF NOT EXISTS cloud_schema_migration (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        );
      const recorded = new Map(
        exists.rows[0]?.name
          ? (
              await tx.query<{ id: string; checksum: string }>(
                "SELECT id, checksum FROM cloud_schema_migration",
              )
            ).rows.map((row) => [row.id, row.checksum])
          : [],
      );
      const mismatched = entries
        .filter(
          (migration) =>
            recorded.has(migration.id) &&
            recorded.get(migration.id) !== checksumOf(migration.sql),
        )
        .map((migration) => migration.id);
      if (mismatched.length)
        throw new MigrationError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `Migration checksum mismatch: ${mismatched.join(", ")}`,
          mismatched,
        );
      const known = new Set(entries.map((migration) => migration.id));
      const pending = entries
        .filter((migration) => !recorded.has(migration.id))
        .map((migration) => ({
          id: migration.id,
          ...classifyMigration(migration.sql),
        }));
      const report: MigrationReport = {
        bootstrap: recorded.size === 0,
        applied: entries
          .filter((migration) => recorded.has(migration.id))
          .map((migration) => migration.id),
        pending,
        ahead: [...recorded.keys()].filter((id) => !known.has(id)).sort(),
        appliedNow: [],
      };
      if (options.plan) return report;
      const contract = pending
        .filter((migration) => migration.phase === "contract")
        .map((migration) => migration.id);
      if (!report.bootstrap && contract.length && !options.allowContract)
        throw new MigrationError(
          "MIGRATION_CONTRACT_REFUSED",
          `Contract migrations need --allow-contract after every node of the previous release is gone: ${contract.join(", ")}`,
          contract,
        );
      for (const migration of entries) {
        if (recorded.has(migration.id)) continue;
        await tx.exec(migration.sql);
        await tx.query(
          "INSERT INTO cloud_schema_migration (id,checksum) VALUES ($1,$2)",
          [migration.id, checksumOf(migration.sql)],
        );
        report.appliedNow.push(migration.id);
      }
      return report;
    });
  } catch (error) {
    // 55P03 lock_not_available: lock_timeout expired (advisory or DDL lock).
    if ((error as { code?: unknown } | null)?.code === "55P03")
      throw new MigrationError(
        "MIGRATION_LOCK_TIMEOUT",
        `Timed out after ${lockTimeoutMs} ms waiting for a migration or table lock; nothing was applied`,
      );
    throw error;
  }
}

/** Apply every pending migration (tests and bootstrap embedding). */
export async function migrateDatabase(
  db: MigrationDatabase,
  migrations?: Migration[],
): Promise<void> {
  await runMigrations(db, {
    ...(migrations ? { migrations } : {}),
    allowContract: true,
  });
}
