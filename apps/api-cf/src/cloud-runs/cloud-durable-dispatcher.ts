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
  /** Present on the Cloudflare binding; recovery uses it to revive a finished instance. */
  get?(id: string): Promise<{
    status(): Promise<{ status: string }>;
    restart(): Promise<void>;
  }>;
}

export interface CloudDurableRunDispatchResult {
  run: DurableRunRecord;
  workflowId: string;
  workflowStarted: boolean;
}

export interface CloudDurableRunRecoveryResult {
  scanned: number;
  scheduled: number;
  failed: number;
}

/**
 * Stable instance id; Workflow is a scheduler, not the idempotency record.
 * Cloudflare rejects ids that are long or contain ":" (`instance.invalid_id`),
 * and executable identities are content-addressed `project:…:revision:<hex>`
 * strings, so the id is a digest of the identity: same identity, same id.
 */
export async function cloudDurableWorkflowId(
  identity: DurableRunIdentity,
): Promise<string> {
  if (!identity.actionRunId.trim() || !identity.outputSlot.trim()) {
    throw new Error("A cloud Workflow identity requires non-empty fields.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([identity.actionRunId, identity.outputSlot]),
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `cloud-run-${hex.slice(0, 48)}`;
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
  const workflowId = await cloudDurableWorkflowId(identity);
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
      id: await cloudDurableWorkflowId(options.identity),
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
 * The row is still due but its instance already exists. An instance that
 * ended (step retries exhausted, Worker evicted mid-step) would otherwise
 * never run again; the journal row, not the instance, decides what happens.
 */
async function restartFinishedWorkflow(
  workflow: CloudDurableWorkflowBinding,
  identity: DurableRunIdentity,
): Promise<boolean> {
  if (!workflow.get) return false;
  const instance = await workflow.get(await cloudDurableWorkflowId(identity));
  const { status } = await instance.status();
  if (!["errored", "terminated", "complete"].includes(status)) return false;
  await instance.restart();
  return true;
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
  let failed = 0;
  for (const run of records) {
    // One row the scheduler rejects must not starve every row after it; the
    // failed row stays queued and is retried on the next tick.
    try {
      const identity = {
        actionRunId: run.actionRunId,
        outputSlot: run.outputSlot,
      };
      if (
        (await scheduleCloudDurableWorkflow({
          workflow: options.workflow,
          identity,
        })) ||
        (await restartFinishedWorkflow(options.workflow, identity))
      )
        scheduled += 1;
    } catch (error) {
      failed += 1;
      console.warn("cloud-durable-run.recovery_schedule_failed", {
        actionRunId: run.actionRunId,
        outputSlot: run.outputSlot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { scanned: records.length, scheduled, failed };
}
