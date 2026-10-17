import type { Env } from "../config";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { recoverCloudDurableRuns as recoverOwnerRuns } from "../cloud-runs/cloud-durable-dispatcher";
import {
  CLOUD_DURABLE_RUN_OWNERS,
  HOSTED_GENERATION_OWNER,
} from "../cloud-runs/owners";
import { frozenGeneration } from "./runtime";

/** Reuses frozen identities. A lost Workflow scheduling request never loses the queued run. */
async function recoverHostedGenerationRuns(
  env: Env,
  now: number,
): Promise<void> {
  const runs = await createD1CloudDurableRunJournal(env.DB).listRecoverable(
    HOSTED_GENERATION_OWNER,
    now,
  );
  for (const run of runs) {
    if (
      run.phase === "failed" &&
      run.projectionFailure &&
      run.nextAttemptAt === undefined
    )
      continue;
    const { workflowId } = frozenGeneration(run);
    try {
      await env.GENERATION_WORKFLOW.create({
        id: workflowId,
        params: { actionRunId: run.actionRunId, outputSlot: run.outputSlot },
      });
    } catch (error) {
      if (
        !/already exists|already started|duplicate/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      const instance = await env.GENERATION_WORKFLOW.get(workflowId);
      const state = await instance.status();
      if (["errored", "terminated", "complete"].includes(state.status))
        await instance.restart();
    }
  }
}

/**
 * The cron scan. Every owner is listed once; an owner's due rows are
 * re-scheduled by their frozen identity only, never reconstructed from Loro.
 */
export async function recoverCloudDurableRuns(
  env: Env,
  now = Date.now(),
): Promise<void> {
  for (const ownerId of CLOUD_DURABLE_RUN_OWNERS) {
    if (ownerId === HOSTED_GENERATION_OWNER) {
      await recoverHostedGenerationRuns(env, now);
      continue;
    }
    await recoverOwnerRuns({
      ownerId,
      journal: createD1CloudDurableRunJournal(env.DB),
      workflow: env.GENERATION_WORKFLOW,
      now,
    });
  }
}
