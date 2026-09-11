import type { WorkflowStep } from "cloudflare:workers";

import type {
  DurableRunAdvanceResult,
  DurableRunIdentity,
} from "@clash/shared-runtime/durable-run-engine";
import type {
  CloudDurableRunCoordinator,
  CloudDurableRunCoordinatorResult,
} from "./cloud-durable-run-coordinator";

export interface CloudDurableRunWorkflowPayload extends DurableRunIdentity {}

/**
 * The smallest Workflow surface the shared runner needs. Keeping this port
 * narrow lets Node containers and Miniflare tests drive the exact same loop.
 */
export interface CloudDurableWorkflowStep {
  do<T>(
    name: string,
    config: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
}

const ADVANCE_CONFIG = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "30 minutes",
};
const CONTENDED_RETRY_MS = 100;

function isTerminal(
  result: CloudDurableRunCoordinatorResult,
): result is Extract<DurableRunAdvanceResult, { kind: "terminal" }> {
  return result.kind === "terminal";
}

/**
 * Drive one run until the shared engine reaches a terminal state. Every
 * `advance` is a named Workflow step, while waiting is represented by
 * `sleepUntil`; a replay therefore reuses the journal CAS and never turns a
 * Workflow retry into a second side effect.
 */
export async function runCloudDurableWorkflow(options: {
  coordinator: CloudDurableRunCoordinator;
  identity: DurableRunIdentity;
  step: CloudDurableWorkflowStep;
  now?: () => number;
  maxSteps?: number;
}): Promise<Extract<DurableRunAdvanceResult, { kind: "terminal" }>["run"]> {
  const now = options.now ?? (() => Date.now());
  const maxSteps = options.maxSteps ?? 10_000;
  for (let stepNumber = 0; stepNumber < maxSteps; stepNumber += 1) {
    const result = await options.step.do(
      `durable-run-advance-${stepNumber}`,
      ADVANCE_CONFIG,
      () =>
        options.coordinator.coordinate({
          type: "advance",
          identity: options.identity,
        }),
    );
    if (isTerminal(result)) return result.run;
    if (result.kind === "waiting") {
      await options.step.sleepUntil(
        `durable-run-wake-${stepNumber}`,
        result.wakeAt,
      );
      continue;
    }
    // A CAS loser does not carry a wake time. Yield briefly to let the winner
    // checkpoint its transition before this Workflow retries the same run.
    await options.step.sleepUntil(
      `durable-run-contended-${stepNumber}`,
      now() + CONTENDED_RETRY_MS,
    );
  }
  throw new Error(
    `Cloud durable run ${options.identity.actionRunId}/${options.identity.outputSlot} ` +
      `exceeded ${maxSteps} Workflow advances without reaching a terminal state.`,
  );
}

/** Thin adapter used by a Cloudflare WorkflowEntrypoint subclass. */
export async function runCloudDurableWorkflowEntrypoint(options: {
  coordinator: CloudDurableRunCoordinator;
  payload: CloudDurableRunWorkflowPayload;
  step: WorkflowStep;
  now?: () => number;
  maxSteps?: number;
}): Promise<Extract<DurableRunAdvanceResult, { kind: "terminal" }>["run"]> {
  return runCloudDurableWorkflow({
    coordinator: options.coordinator,
    identity: options.payload,
    step: options.step as unknown as CloudDurableWorkflowStep,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
}
