import type { Env } from "../config";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { frozenGeneration } from "./runtime";

/** Reuses frozen identities. A lost Workflow scheduling request never loses the queued run. */
export async function recoverHostedGenerations(
  env: Env,
  now = Date.now(),
): Promise<void> {
  const runs = await createD1CloudDurableRunJournal(env.DB).listRecoverable(
    "api-cf:generation",
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
