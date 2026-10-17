import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../config";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
export type { GenerationParams } from "../generation/params";

/** Workflow schedules shared transitions. Provider tokens and output receipts live in D1/R2. */
export class GenerationWorkflow extends WorkflowEntrypoint<
  Env,
  DurableRunIdentity
> {
  async run(
    event: WorkflowEvent<DurableRunIdentity>,
    step: WorkflowStep,
  ): Promise<void> {
    if (!event.payload.actionRunId || !event.payload.outputSlot) {
      throw new Error(
        "Legacy Workflow has no durable run identity; owner-side reconciliation is required before retrying generation.",
      );
    }
    // Loaded on first run, not at Worker startup (#161).
    const [{ runCloudDurableWorkflowEntrypoint }, { createHostedGenerationRuntime }] =
      await Promise.all([
        import("../cloud-runs/cloud-durable-workflow"),
        import("../generation/runtime"),
      ]);
    const run = await runCloudDurableWorkflowEntrypoint({
      coordinator: createHostedGenerationRuntime(this.env),
      payload: event.payload,
      step,
    });
    if (run.phase === "failed")
      throw new Error(run.failure?.message ?? "Generation failed");
  }
}
