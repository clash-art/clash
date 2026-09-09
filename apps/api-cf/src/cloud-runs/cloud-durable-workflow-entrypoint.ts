import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import type { CloudDurableRunCoordinator } from "./cloud-durable-run-coordinator";
import {
  runCloudDurableWorkflowEntrypoint,
  type CloudDurableRunWorkflowPayload,
} from "./cloud-durable-workflow";

/**
 * Optional Cloudflare binding adapter. A deployment supplies the three cloud
 * ports (provider, OSS staging, Project publisher) in `createCoordinator`; no
 * Cloudflare type leaks into the shared engine or the Node implementation.
 */
export abstract class CloudDurableRunWorkflowEntrypoint<
  TEnv,
> extends WorkflowEntrypoint<TEnv, CloudDurableRunWorkflowPayload> {
  protected abstract createCoordinator(
    env: TEnv,
    payload: CloudDurableRunWorkflowPayload,
  ): CloudDurableRunCoordinator | Promise<CloudDurableRunCoordinator>;

  async run(
    event: WorkflowEvent<CloudDurableRunWorkflowPayload>,
    step: WorkflowStep,
  ): Promise<void> {
    const coordinator = await this.createCoordinator(this.env, event.payload);
    await runCloudDurableWorkflowEntrypoint({
      coordinator,
      payload: event.payload,
      step,
    });
  }
}
