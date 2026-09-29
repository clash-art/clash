import type {
  DurableRunIdentity,
  DurableRunPhase,
  DurableRunRecord,
} from "./durable-run-engine.js";

export interface CloudRunRow {
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

export function identityText(identity: DurableRunIdentity): string {
  return `${identity.actionRunId}/${identity.outputSlot}`;
}

export function assertIdentity(identity: DurableRunIdentity): void {
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

export function parseRow(row: CloudRunRow): DurableRunRecord {
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

export function serialize(run: DurableRunRecord): string {
  const json = JSON.stringify(run);
  // Parse once at the write boundary so undefined/function values cannot be
  // silently persisted as a shape the recovery reader cannot understand.
  parseRecord(json, identityText(run));
  return json;
}

export function recoveryAt(run: DurableRunRecord): number | null {
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

export function sameFrozenFields(
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
