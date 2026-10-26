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
    const [
      { runCloudDurableWorkflowEntrypoint },
      { createD1CloudDurableRunJournal },
      { EXECUTABLE_ACTION_OWNER, GATEWAY_SETTLE_OWNER },
    ] = await Promise.all([
      import("../cloud-runs/cloud-durable-workflow"),
      import("../cloud-runs/cloud-durable-run-journal"),
      import("../cloud-runs/owners"),
    ]);
    // The D1 row owns the run; never infer the executor from the payload.
    const journal = createD1CloudDurableRunJournal(this.env.DB);
    const record = await journal.load(event.payload);
    const coordinator =
      record?.owner.id === EXECUTABLE_ACTION_OWNER
        ? (
            await import("../generation/executable-runtime")
          ).createExecutableActionRuntime(this.env, { journal })
        : record?.owner.id === GATEWAY_SETTLE_OWNER
          ? (
              await import("../gateway/settle-runs")
            ).createGatewaySettleCoordinator({ db: this.env.DB, journal })
          : (
              await import("../generation/runtime")
            ).createHostedGenerationRuntime(this.env);
    const run = await runCloudDurableWorkflowEntrypoint({
      coordinator,
      payload: event.payload,
      step,
    });
    if (run.phase === "failed")
      throw new Error(run.failure?.message ?? "Generation failed");
  }
}
