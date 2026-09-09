import type {
  DurableRunIdentity,
  DurableRunJournal,
  DurableRunPhase,
  DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";

/** D1-backed journal for the cloud owner. The table is installed by the app migration. */
export interface D1CloudDurableRunJournal extends DurableRunJournal {
  create(run: DurableRunRecord): Promise<void>;
  listRecoverable(ownerId: string, now: number): Promise<DurableRunRecord[]>;
}

interface CloudRunRow {
  action_run_id: string;
  output_slot: string;
  owner_realm: string;
  owner_id: string;
  revision: number;
  phase: string;
  recover_at: number | null;
  updated_at: number;
  record_json: string;
}

const PHASES = new Set<DurableRunPhase>([
  "queued",
  "submitting",
  "polling",
  "finalizing",
  "succeeded",
  "failed",
]);

function identityText(identity: DurableRunIdentity): string {
  return `${identity.actionRunId}/${identity.outputSlot}`;
}

function assertIdentity(identity: DurableRunIdentity): void {
  if (!identity.actionRunId.trim() || !identity.outputSlot.trim()) {
    throw new Error("A cloud durable run identity requires non-empty fields.");
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

function parseRecord(text: string, sourceIdentity: string): DurableRunRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} is invalid JSON.`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has an unsupported schema.`,
    );
  }
  if (typeof record.actionRunId !== "string" || !record.actionRunId.trim()) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has no actionRunId.`,
    );
  }
  if (typeof record.outputSlot !== "string" || !record.outputSlot.trim()) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has no outputSlot.`,
    );
  }
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0
  ) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has an invalid revision.`,
    );
  }
  if (
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as DurableRunPhase)
  ) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has an invalid phase.`,
    );
  }
  const owner = record.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has no owner.`,
    );
  }
  const ownerRecord = owner as Record<string, unknown>;
  if (
    ownerRecord.realm !== "cloud" ||
    typeof ownerRecord.id !== "string" ||
    !ownerRecord.id.trim()
  ) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has an invalid cloud owner.`,
    );
  }
  if (!("executorInput" in record)) {
    throw new Error(
      `Cloud durable run journal record ${sourceIdentity} has no frozen executor input.`,
    );
  }
  for (const field of ["createdAt", "updatedAt", "deadlineAt"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      throw new Error(
        `Cloud durable run journal record ${sourceIdentity} has an invalid ${field}.`,
      );
    }
  }
  return record as unknown as DurableRunRecord;
}

function parseRow(row: CloudRunRow): DurableRunRecord {
  const identity = `${row.action_run_id}/${row.output_slot}`;
  const record = parseRecord(row.record_json, identity);
  if (
    record.actionRunId !== row.action_run_id ||
    record.outputSlot !== row.output_slot
  ) {
    throw new Error(
      `Cloud durable run journal record ${identity} does not match its table key.`,
    );
  }
  if (
    record.revision !== Number(row.revision) ||
    record.phase !== row.phase ||
    record.owner.realm !== row.owner_realm ||
    record.owner.id !== row.owner_id
  ) {
    throw new Error(
      `Cloud durable run journal record ${identity} does not match its indexed fields.`,
    );
  }
  return record;
}

function serialize(run: DurableRunRecord): string {
  const json = JSON.stringify(run);
  // Parse once at the write boundary so undefined/function values cannot be
  // silently persisted as a shape the recovery reader cannot understand.
  parseRecord(json, identityText(run));
  return json;
}

function recoveryAt(run: DurableRunRecord): number | null {
  if (run.phase === "succeeded") return null;
  if (run.phase === "failed") {
    if (run.projectedAt !== undefined) return null;
    if (run.activeAttempt) return run.activeAttempt.expiresAt;
    return run.nextAttemptAt ?? run.updatedAt;
  }
  if (run.activeAttempt) {
    if (
      run.activeAttempt.operation === "poll" &&
      run.deadlineReconciliationPending
    ) {
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
    dueAt = Math.min(dueAt, run.recoveryFinalizationDeadlineAt);
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
    sameJson(current.executorInput, next.executorInput)
  );
}

/**
 * Build the cloud journal from a D1 binding. Each state transition uses an
 * optimistic `revision` and owner predicate; competing Workflow replays or
 * alarm deliveries therefore produce a CAS miss instead of a second side
 * effect. D1's single-row UPDATE is the only lock needed by the adapter.
 */
export function createD1CloudDurableRunJournal(
  db: D1Database,
): D1CloudDurableRunJournal {
  return {
    async create(run) {
      const json = serialize(run);
      await db
        .prepare(
          `INSERT OR IGNORE INTO cloud_durable_run_journal (
             action_run_id, output_slot, owner_realm, owner_id,
             revision, phase, recover_at, updated_at, record_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          run.actionRunId,
          run.outputSlot,
          run.owner.realm,
          run.owner.id,
          run.revision,
          run.phase,
          recoveryAt(run),
          run.updatedAt,
          json,
        )
        .run();
      const existing = await this.load({
        actionRunId: run.actionRunId,
        outputSlot: run.outputSlot,
      });
      if (!existing || !sameFrozenFields(existing, run)) {
        throw new Error(
          `Cloud durable run ${run.actionRunId}/${run.outputSlot} already exists with different content.`,
        );
      }
    },

    async load(identity) {
      assertIdentity(identity);
      const row = await db
        .prepare(
          `SELECT action_run_id, output_slot, owner_realm, owner_id,
                  revision, phase, recover_at, updated_at, record_json
             FROM cloud_durable_run_journal
            WHERE action_run_id = ? AND output_slot = ?`,
        )
        .bind(identity.actionRunId, identity.outputSlot)
        .first<CloudRunRow>();
      return row ? parseRow(row) : undefined;
    },

    async compareAndSet(identity, expectedRevision, next) {
      assertIdentity(identity);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error(
          "A cloud durable run CAS requires a non-negative expected revision.",
        );
      }
      if (
        next.actionRunId !== identity.actionRunId ||
        next.outputSlot !== identity.outputSlot ||
        next.revision !== expectedRevision + 1
      ) {
        throw new Error(
          `Cloud durable run CAS identity/version is invalid for ${identityText(identity)}.`,
        );
      }
      const current = await this.load(identity);
      if (
        !current ||
        current.revision !== expectedRevision ||
        !sameFrozenFields(current, next)
      ) {
        return false;
      }
      const result = await db
        .prepare(
          `UPDATE cloud_durable_run_journal
              SET owner_realm = ?, owner_id = ?, revision = ?, phase = ?,
                  recover_at = ?, updated_at = ?, record_json = ?
            WHERE action_run_id = ? AND output_slot = ?
              AND revision = ? AND owner_realm = ? AND owner_id = ?`,
        )
        .bind(
          next.owner.realm,
          next.owner.id,
          next.revision,
          next.phase,
          recoveryAt(next),
          next.updatedAt,
          serialize(next),
          identity.actionRunId,
          identity.outputSlot,
          expectedRevision,
          current.owner.realm,
          current.owner.id,
        )
        .run();
      return Number(result.meta.changes) === 1;
    },

    async listRecoverable(ownerId, now) {
      if (!ownerId.trim())
        throw new Error("A cloud recoverable scan requires an owner id.");
      if (!Number.isFinite(now))
        throw new Error("A cloud recoverable scan requires a finite time.");
      const rows = await db
        .prepare(
          `SELECT action_run_id, output_slot, owner_realm, owner_id,
                  revision, phase, recover_at, updated_at, record_json
             FROM cloud_durable_run_journal
            WHERE owner_realm = 'cloud' AND owner_id = ?
              AND recover_at IS NOT NULL AND recover_at <= ?
            ORDER BY recover_at ASC, action_run_id ASC, output_slot ASC`,
        )
        .bind(ownerId, now)
        .all<CloudRunRow>();
      return (rows.results ?? []).map(parseRow);
    },
  };
}
