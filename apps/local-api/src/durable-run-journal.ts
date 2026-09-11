import { GeneratorDefinitionSchema, type GeneratorDefinition, type GeneratorDefinitionRef } from "@clash/shared-types";
import { createRequire } from "node:module";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  DurableRunIdentity,
  DurableRunJournal,
  DurableRunPhase,
  DurableRunRecord,
} from "@clash/shared-runtime";

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDurableRunJournal extends DurableRunJournal {
  /** Validated Host contracts retained for crash recovery across plugin changes. */
  rememberGeneratorDefinition?(definition: GeneratorDefinition): Promise<void>;
  readGeneratorDefinition?(ref: GeneratorDefinitionRef): Promise<GeneratorDefinition | undefined>;
  create(run: DurableRunRecord): Promise<void>;
  listRecoverable(ownerId: string, now: number): Promise<DurableRunRecord[]>;
  /** Projects whose non-terminal owner-private work must be reopened after Host restart. */
  listOwnedProjectIds(ownerId: string): Promise<string[]>;
  nextWakeAt(ownerId: string, projectId?: string): Promise<number | undefined>;
}

const nodeRequire = createRequire(import.meta.url);
const PHASES = new Set<DurableRunPhase>([
  "queued",
  "submitting",
  "polling",
  "finalizing",
  "succeeded",
  "failed",
]);

function databasePath(dataDir: string): string {
  return join(dataDir, "local.sqlite");
}

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  return database;
}

function applySchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS generator_definition_archive (
      plugin_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      PRIMARY KEY (plugin_id, definition_id, version, schema_hash)
    );
    CREATE TABLE IF NOT EXISTS durable_run_journal (
      action_run_id TEXT NOT NULL,
      output_slot TEXT NOT NULL,
      owner_realm TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      phase TEXT NOT NULL,
      recover_at INTEGER,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (action_run_id, output_slot)
    );

    CREATE INDEX IF NOT EXISTS durable_run_journal_recovery
      ON durable_run_journal (owner_realm, owner_id, recover_at);
  `);
}

function corrupt(identity: string, detail: string): Error {
  return new Error(
    `Durable run journal record ${identity} is corrupt: ${detail}.`,
  );
}

function parseRecord(text: string, sourceIdentity: string): DurableRunRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt(sourceIdentity, "record_json is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt(sourceIdentity, "the JSON root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw corrupt(sourceIdentity, "schemaVersion must be 1");
  }
  if (typeof record.actionRunId !== "string" || !record.actionRunId.trim()) {
    throw corrupt(sourceIdentity, "actionRunId must be a non-empty string");
  }
  if (typeof record.outputSlot !== "string" || !record.outputSlot.trim()) {
    throw corrupt(sourceIdentity, "outputSlot must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0
  ) {
    throw corrupt(
      sourceIdentity,
      "revision must be a non-negative safe integer",
    );
  }
  if (
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as DurableRunPhase)
  ) {
    throw corrupt(sourceIdentity, "phase is not recognized");
  }
  const owner = record.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw corrupt(sourceIdentity, "owner must be an object");
  }
  const ownerRecord = owner as Record<string, unknown>;
  if (
    ownerRecord.realm !== "local" &&
    ownerRecord.realm !== "cloud" &&
    ownerRecord.realm !== "client"
  ) {
    throw corrupt(
      sourceIdentity,
      "owner.realm must be local, cloud, or client",
    );
  }
  if (typeof ownerRecord.id !== "string" || !ownerRecord.id.trim()) {
    throw corrupt(sourceIdentity, "owner.id must be a non-empty string");
  }
  if (!("executorInput" in record)) {
    throw corrupt(sourceIdentity, "executorInput is missing");
  }
  for (const field of ["createdAt", "updatedAt", "deadlineAt"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw corrupt(sourceIdentity, `${field} must be a finite number`);
    }
  }
  if (
    record.recoveryFinalizationDeadlineAt !== undefined &&
    (!Number.isSafeInteger(record.recoveryFinalizationDeadlineAt) ||
      (record.recoveryFinalizationDeadlineAt as number) <=
        (record.deadlineAt as number))
  ) {
    throw corrupt(
      sourceIdentity,
      "recoveryFinalizationDeadlineAt must be a safe integer later than deadlineAt",
    );
  }
  return record as unknown as DurableRunRecord;
}

function identityText(identity: DurableRunIdentity): string {
  return `${identity.actionRunId}/${identity.outputSlot}`;
}

function assertIdentity(identity: DurableRunIdentity): void {
  if (!identity.actionRunId.trim() || !identity.outputSlot.trim()) {
    throw new Error(
      "A durable run identity requires actionRunId and outputSlot.",
    );
  }
}

function serializeRecord(run: DurableRunRecord): {
  json: string;
  normalized: DurableRunRecord;
} {
  let json: string;
  try {
    json = JSON.stringify(run);
  } catch (error) {
    throw new Error(
      `Durable run journal record ${run.actionRunId}/${run.outputSlot} is not JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    json,
    normalized: parseRecord(json, `${run.actionRunId}/${run.outputSlot}`),
  };
}

function parseRow(row: Record<string, unknown>): DurableRunRecord {
  const actionRunId =
    typeof row.action_run_id === "string" ? row.action_run_id : "<unknown>";
  const outputSlot =
    typeof row.output_slot === "string" ? row.output_slot : "<unknown>";
  const sourceIdentity = `${actionRunId}/${outputSlot}`;
  if (typeof row.record_json !== "string") {
    throw corrupt(sourceIdentity, "record_json is missing");
  }
  const record = parseRecord(row.record_json, sourceIdentity);
  if (record.actionRunId !== actionRunId || record.outputSlot !== outputSlot) {
    throw corrupt(sourceIdentity, "JSON identity does not match its table key");
  }
  if (record.revision !== row.revision) {
    throw corrupt(
      sourceIdentity,
      "JSON revision does not match its indexed revision",
    );
  }
  if (record.phase !== row.phase) {
    throw corrupt(
      sourceIdentity,
      "JSON phase does not match its indexed phase",
    );
  }
  if (
    record.owner.realm !== row.owner_realm ||
    record.owner.id !== row.owner_id
  ) {
    throw corrupt(
      sourceIdentity,
      "JSON owner does not match its indexed owner",
    );
  }
  return record;
}

function recoveryAt(run: DurableRunRecord): number | null {
  if (run.phase === "succeeded") return null;
  if (run.phase === "failed") {
    if (run.projectedAt !== undefined) return null;
    if (run.activeAttempt) return run.activeAttempt.expiresAt;
    if (run.projectionFailure && run.nextAttemptAt === undefined) return null;
    return run.nextAttemptAt ?? run.updatedAt;
  }
  if (run.activeAttempt) {
    const isDeadlineRecoveryPoll =
      run.activeAttempt.operation === "poll" &&
      run.deadlineReconciliationPending;
    if (isDeadlineRecoveryPoll) {
      return run.activeAttempt.expiresAt;
    }
    if (run.recoveryFinalizationDeadlineAt !== undefined) {
      return Math.min(
        run.activeAttempt.expiresAt,
        run.recoveryFinalizationDeadlineAt,
      );
    }
    return Math.min(run.activeAttempt.expiresAt, run.deadlineAt);
  }
  let dueAt = run.nextAttemptAt ?? run.updatedAt;
  if (
    run.phase === "finalizing" &&
    run.recoveryFinalizationDeadlineAt !== undefined
  ) {
    return Math.min(dueAt, run.recoveryFinalizationDeadlineAt);
  }
  if (
    (run.phase === "submitting" ||
      (run.phase === "polling" && !run.deadlineReconciliationPending) ||
      run.phase === "finalizing") &&
    run.deadlineAt < dueAt
  ) {
    dueAt = run.deadlineAt;
  }
  return dueAt;
}

function runProjectId(run: DurableRunRecord): string {
  const input = run.executorInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw corrupt(
      identityText(run),
      "executorInput must contain the owning projectId",
    );
  }
  const projectId = input.projectId;
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw corrupt(
      identityText(run),
      "executorInput.projectId must be a non-empty string",
    );
  }
  return projectId;
}

function sameFrozenFields(
  current: DurableRunRecord,
  next: DurableRunRecord,
): boolean {
  return (
    current.schemaVersion === next.schemaVersion &&
    current.actionRunId === next.actionRunId &&
    current.outputSlot === next.outputSlot &&
    current.owner.realm === next.owner.realm &&
    current.owner.id === next.owner.id &&
    current.createdAt === next.createdAt &&
    current.deadlineAt === next.deadlineAt &&
    (current.recoveryFinalizationDeadlineAt === undefined ||
      current.recoveryFinalizationDeadlineAt ===
        next.recoveryFinalizationDeadlineAt) &&
    isDeepStrictEqual(current.executorInput, next.executorInput)
  );
}

function changes(result: SqliteRunResult): number {
  return typeof result.changes === "bigint"
    ? Number(result.changes)
    : result.changes;
}

export function createSqliteDurableRunJournal(
  dataDir: string,
): SqliteDurableRunJournal {
  const path = databasePath(dataDir);

  async function withDatabase<T>(
    task: (database: SqliteDatabase) => T,
  ): Promise<T> {
    await mkdir(dataDir, { recursive: true });
    const database = openDatabase(path);
    try {
      applySchema(database);
      return task(database);
    } finally {
      database.close();
      await chmod(path, 0o600).catch(() => undefined);
    }
  }

  return {
    async rememberGeneratorDefinition(input) {
      const definition = GeneratorDefinitionSchema.parse(input);
      await withDatabase(database => {
        database.prepare("INSERT OR IGNORE INTO generator_definition_archive (plugin_id, definition_id, version, schema_hash, definition_json) VALUES (?, ?, ?, ?, ?)").run(
          definition.pluginId, definition.definitionId, definition.version, definition.schemaHash, JSON.stringify(definition),
        );
        const row = database.prepare("SELECT definition_json FROM generator_definition_archive WHERE plugin_id = ? AND definition_id = ? AND version = ? AND schema_hash = ?").get(
          definition.pluginId, definition.definitionId, definition.version, definition.schemaHash,
        );
        if (!row || !isDeepStrictEqual(GeneratorDefinitionSchema.parse(JSON.parse(String(row.definition_json))), definition)) {
          throw new Error("Generator Definition identity already has different archived content.");
        }
      });
    },
    async readGeneratorDefinition(ref) {
      return withDatabase(database => {
        const row = database.prepare("SELECT definition_json FROM generator_definition_archive WHERE plugin_id = ? AND definition_id = ? AND version = ? AND schema_hash = ?").get(
          ref.pluginId, ref.definitionId, ref.version, ref.schemaHash,
        );
        if (!row) return undefined;
        const definition = GeneratorDefinitionSchema.parse(JSON.parse(String(row.definition_json)));
        if (definition.pluginId !== ref.pluginId || definition.definitionId !== ref.definitionId || definition.version !== ref.version || definition.schemaHash !== ref.schemaHash) {
          throw new Error("Archived Generator Definition identity is corrupt.");
        }
        return definition;
      });
    },
    async create(run) {
      const serialized = serializeRecord(run);
      const normalized = serialized.normalized;
      return withDatabase((database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const existingRow = database
            .prepare(
              `
            SELECT action_run_id, output_slot, owner_realm, owner_id,
                   revision, phase, record_json
            FROM durable_run_journal
            WHERE action_run_id = ? AND output_slot = ?
          `,
            )
            .get(normalized.actionRunId, normalized.outputSlot);
          if (existingRow) {
            const existing = parseRow(existingRow);
            if (!isDeepStrictEqual(existing, normalized)) {
              throw new Error(
                `Durable run ${normalized.actionRunId}/${normalized.outputSlot} ` +
                  "already exists with different content.",
              );
            }
          } else {
            database
              .prepare(
                `
              INSERT INTO durable_run_journal (
                action_run_id, output_slot, owner_realm, owner_id,
                revision, phase, recover_at, updated_at, record_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
              )
              .run(
                normalized.actionRunId,
                normalized.outputSlot,
                normalized.owner.realm,
                normalized.owner.id,
                normalized.revision,
                normalized.phase,
                recoveryAt(normalized),
                normalized.updatedAt,
                serialized.json,
              );
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
    },

    async load(identity) {
      assertIdentity(identity);
      return withDatabase((database) => {
        const row = database
          .prepare(
            `
          SELECT action_run_id, output_slot, owner_realm, owner_id,
                 revision, phase, record_json
          FROM durable_run_journal
          WHERE action_run_id = ? AND output_slot = ?
        `,
          )
          .get(identity.actionRunId, identity.outputSlot);
        return row ? parseRow(row) : undefined;
      });
    },

    async compareAndSet(identity, expectedRevision, next) {
      assertIdentity(identity);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error(
          "A durable run CAS requires a non-negative expected revision.",
        );
      }
      const serialized = serializeRecord(next);
      const normalized = serialized.normalized;
      if (
        normalized.actionRunId !== identity.actionRunId ||
        normalized.outputSlot !== identity.outputSlot
      ) {
        throw new Error(
          `Durable run CAS identity ${identityText(identity)} does not match the next record.`,
        );
      }
      if (normalized.revision !== expectedRevision + 1) {
        throw new Error(
          "A durable run CAS must advance revision by exactly one.",
        );
      }
      return withDatabase((database) => {
        const currentRow = database
          .prepare(
            `
          SELECT action_run_id, output_slot, owner_realm, owner_id,
                 revision, phase, record_json
          FROM durable_run_journal
          WHERE action_run_id = ? AND output_slot = ?
        `,
          )
          .get(identity.actionRunId, identity.outputSlot);
        if (!currentRow) return false;
        const current = parseRow(currentRow);
        if (
          current.revision !== expectedRevision ||
          !sameFrozenFields(current, normalized)
        ) {
          return false;
        }
        const result = database
          .prepare(
            `
          UPDATE durable_run_journal
          SET owner_realm = ?, owner_id = ?, revision = ?, phase = ?,
              recover_at = ?, updated_at = ?, record_json = ?
          WHERE action_run_id = ? AND output_slot = ?
            AND revision = ? AND owner_realm = ? AND owner_id = ?
        `,
          )
          .run(
            normalized.owner.realm,
            normalized.owner.id,
            normalized.revision,
            normalized.phase,
            recoveryAt(normalized),
            normalized.updatedAt,
            serialized.json,
            identity.actionRunId,
            identity.outputSlot,
            expectedRevision,
            normalized.owner.realm,
            normalized.owner.id,
          );
        return changes(result) === 1;
      });
    },

    async listRecoverable(ownerId, now) {
      if (!ownerId.trim())
        throw new Error("A recoverable run scan requires an owner id.");
      if (!Number.isFinite(now))
        throw new Error("A recoverable run scan requires a finite time.");
      return withDatabase((database) =>
        database
          .prepare(
            `
          SELECT action_run_id, output_slot, owner_realm, owner_id,
                 revision, phase, record_json
          FROM durable_run_journal
          WHERE owner_realm = 'local' AND owner_id = ?
            AND recover_at IS NOT NULL AND recover_at <= ?
          ORDER BY recover_at ASC, action_run_id ASC, output_slot ASC
        `,
          )
          .all(ownerId, now)
          .map(parseRow),
      );
    },

    async listOwnedProjectIds(ownerId) {
      if (!ownerId.trim())
        throw new Error("A durable run project scan requires an owner id.");
      return withDatabase((database) => {
        const projectIds = new Set(
          database
            .prepare(
              `
            SELECT action_run_id, output_slot, owner_realm, owner_id,
                   revision, phase, record_json
            FROM durable_run_journal
            WHERE owner_realm = 'local' AND owner_id = ?
              AND recover_at IS NOT NULL
            ORDER BY action_run_id ASC, output_slot ASC
          `,
            )
            .all(ownerId)
            .map(parseRow)
            .map(runProjectId),
        );
        return [...projectIds].sort();
      });
    },

    async nextWakeAt(ownerId, projectId) {
      if (!ownerId.trim())
        throw new Error("A durable run wake query requires an owner id.");
      return withDatabase((database) => {
        const rows = database
          .prepare(
            `
          SELECT action_run_id, output_slot, owner_realm, owner_id,
                 revision, phase, recover_at, record_json
          FROM durable_run_journal
          WHERE owner_realm = 'local' AND owner_id = ?
            AND recover_at IS NOT NULL
          ORDER BY recover_at ASC, action_run_id ASC, output_slot ASC
        `,
          )
          .all(ownerId);
        const row = projectId
          ? rows.find((candidate) => {
              const run = parseRow(candidate);
              return runProjectId(run) === projectId;
            })
          : rows[0];
        return typeof row?.recover_at === "number" ? row.recover_at : undefined;
      });
    },
  };
}
