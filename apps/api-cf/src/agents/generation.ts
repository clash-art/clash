import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../config";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import { runCloudDurableWorkflowEntrypoint } from "../cloud-runs/cloud-durable-workflow";
import { createHostedGenerationRuntime } from "../generation/runtime";
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
    const run = await runCloudDurableWorkflowEntrypoint({
      coordinator: createHostedGenerationRuntime(this.env),
      payload: event.payload,
      step,
    });
    if (run.phase === "failed")
      throw new Error(run.failure?.message ?? "Generation failed");
  }
}
