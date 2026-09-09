import type {
  DurableRunIdentity,
  DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";

import {
  createCloudDurableRun,
  type CloudDurableRunCreateCommand,
  type CloudDurableRunJournal,
} from "./cloud-durable-run-coordinator";

export interface CloudDurableWorkflowBinding {
  create(input: {
    id: string;
    params: Readonly<DurableRunIdentity>;
  }): Promise<unknown>;
}

export interface CloudDurableRunDispatchResult {
  run: DurableRunRecord;
  workflowId: string;
  workflowStarted: boolean;
}

export interface CloudDurableRunRecoveryResult {
  scanned: number;
  scheduled: number;
}

/** Stable instance id; Workflow is a scheduler, not the idempotency record. */
export function cloudDurableWorkflowId(identity: DurableRunIdentity): string {
  if (!identity.actionRunId.trim() || !identity.outputSlot.trim()) {
    throw new Error("A cloud Workflow identity requires non-empty fields.");
  }
  return `cloud-run-${identity.actionRunId}-${encodeURIComponent(identity.outputSlot)}`;
}

function isAlreadyExists(error: unknown): boolean {
  return /already exists|already started|duplicate/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Journal first, Workflow second. If Workflow.create fails transiently the
 * queued row remains recoverable; a later recovery tick calls this function
 * again and can safely retry the scheduler without replacing frozen input.
 */
export async function dispatchCloudDurableRun(options: {
  ownerId: string;
  journal: CloudDurableRunJournal;
  workflow: CloudDurableWorkflowBinding;
  command: CloudDurableRunCreateCommand;
  clock?: { now(): number };
}): Promise<CloudDurableRunDispatchResult> {
  const run = await createCloudDurableRun({
    ownerId: options.ownerId,
    journal: options.journal,
    command: options.command,
    clock: options.clock,
  });
  const identity = { actionRunId: run.actionRunId, outputSlot: run.outputSlot };
  const workflowId = cloudDurableWorkflowId(identity);
  const workflowStarted = await scheduleCloudDurableWorkflow({
    workflow: options.workflow,
    identity,
  });
  return { run, workflowId, workflowStarted };
}

/** Resume an existing row without reconstructing or mutating its frozen input. */
export async function scheduleCloudDurableWorkflow(options: {
  workflow: CloudDurableWorkflowBinding;
  identity: DurableRunIdentity;
}): Promise<boolean> {
  try {
    await options.workflow.create({
      id: cloudDurableWorkflowId(options.identity),
      params: options.identity,
    });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * A cron/alarm handler can call this after a Worker restart. It only schedules
 * identities returned by the journal's due scan; it never creates a new run
 * or rehydrates executor input from Project Loro.
 */
export async function recoverCloudDurableRuns(options: {
  ownerId: string;
  journal: CloudDurableRunJournal;
  workflow: CloudDurableWorkflowBinding;
  now: number;
}): Promise<CloudDurableRunRecoveryResult> {
  const records = await options.journal.listRecoverable(
    options.ownerId,
    options.now,
  );
  let scheduled = 0;
  for (const run of records) {
    const started = await scheduleCloudDurableWorkflow({
      workflow: options.workflow,
      identity: { actionRunId: run.actionRunId, outputSlot: run.outputSlot },
    });
    if (started) scheduled += 1;
  }
  return { scanned: records.length, scheduled };
}
