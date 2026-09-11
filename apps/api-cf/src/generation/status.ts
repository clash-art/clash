import { durablePublicFailure } from "@clash/shared-runtime/durable-run-engine";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import type { Env } from "../config";
import { Status } from "../domain/canvas";
import { frozenGeneration, HOSTED_GENERATION_OUTPUT_SLOT } from "./runtime";

/** Presence of a journal row takes precedence over every legacy completion hint. */
export async function hostedGenerationStatus(
  env: Pick<Env, "DB">,
  taskId: string,
) {
  const run = await createD1CloudDurableRunJournal(env.DB).load({
    actionRunId: taskId,
    outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
  });
  if (!run) return undefined;
  const { params } = frozenGeneration(run);
  const staged = run.stagedOutput as
    { updates?: Record<string, unknown> } | undefined;
  return {
    managedByJournal: true as const,
    actorUserId: params.actorUserId,
    projectId: params.projectId,
    status:
      run.phase === "succeeded" && run.projectedAt !== undefined
        ? Status.Completed
        : run.phase === "failed"
          ? Status.Failed
          : Status.Generating,
    ...(run.phase === "succeeded" && run.projectedAt !== undefined
      ? {
          updates: staged?.updates,
          assetId:
            typeof staged?.updates?.assetId === "string"
              ? staged.updates.assetId
              : undefined,
        }
      : {}),
    ...(run.phase === "failed" && run.failure
      ? { error: durablePublicFailure(run.failure).message }
      : {}),
  };
}
