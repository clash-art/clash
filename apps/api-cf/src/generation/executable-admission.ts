/**
 * Admission of one pending Canvas custom Action into the Durable Run graph.
 *
 * The node's frozen `pluginBinding` is the authored contract. It must resolve
 * to code-registered first-party execution or to this user's installed remote
 * endpoint; otherwise the node fails `plugin_unavailable` and no journal row
 * exists. A journal row is written before the existing GENERATION_WORKFLOW is
 * scheduled, so a lost scheduling request is recoverable by identity.
 */
import {
  ExecutablePluginBindingSchema,
  ExecutablePluginJsonValueSchema,
} from "@clash/shared-types/executable-plugin";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import {
  createCloudDurableRun,
  type CloudDurableRunJournal,
} from "@clash/shared-runtime/cloud-run-coordinator";
import {
  freezeCanvasCustomAction,
  pendingCustomActionNode,
} from "@clash/shared-runtime/canvas-executable-node";

import type { Env } from "../config";
import {
  scheduleCloudDurableWorkflow,
  type CloudDurableWorkflowBinding,
} from "../cloud-runs/cloud-durable-dispatcher";
import { EXECUTABLE_ACTION_OWNER } from "../cloud-runs/owners";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { executableActionGenerationParams } from "./executable-action-params";
import { claimHostedGenerationNode } from "./publication";
import type { GenerationParams } from "./params";
import {
  resolveExecutableBinding,
  type ResolvedExecutableBinding,
} from "./executable-binding";

/** The same lifetime the Local adapter gives one frozen executable Action. */
export const EXECUTABLE_ACTION_DEADLINE_MS = 30 * 60_000;

export class ExecutableActionUnavailableError extends Error {
  override name = "ExecutableActionUnavailableError";
}

export interface SubmitExecutableActionInput {
  projectId: string;
  nodeId: string;
  data: Record<string, unknown>;
  /** Accountable human user; owns the project and installs third-party plugins. */
  userId: string;
  custom?: {
    actionId: string;
    outputType: "image" | "video" | "audio" | "model" | "text";
  };
  resolveMention?: (
    nodeId: string,
  ) =>
    | { assetId: string; kind: "image" | "video" | "audio" | "model" }
    | undefined;
  /**
   * Runs after freezing and before the claim/journal. NodeProcessor uses it to
   * install the optimistic `pendingTask` lock, which ProjectRoom then persists
   * when the matching admission request arrives.
   */
  onFrozen?: (frozen: {
    identity: { actionRunId: string; outputSlot: string };
    executor: Record<string, unknown>;
    binding: ResolvedExecutableBinding["binding"];
  }) => void | Promise<void>;
}

export interface ExecutableActionAdmissionOptions {
  journal?: CloudDurableRunJournal;
  workflow?: CloudDurableWorkflowBinding;
  claim?: (env: Env, params: GenerationParams) => Promise<void>;
  resolveBinding?: (
    env: Env,
    userId: string,
    binding: ResolvedExecutableBinding["binding"],
  ) => Promise<ResolvedExecutableBinding | undefined>;
  now?: () => number;
}

export async function submitExecutableAction(
  env: Env,
  input: SubmitExecutableActionInput,
  options: ExecutableActionAdmissionOptions = {},
): Promise<DurableRunRecord> {
  const parsed = ExecutablePluginBindingSchema.safeParse(
    input.data.pluginBinding,
  );
  if (!parsed.success) {
    throw new ExecutableActionUnavailableError(
      `plugin_unavailable: custom Action ${String(input.data.customActionId ?? input.data.actionType)} has no executable plugin binding.`,
    );
  }
  const custom = input.custom ?? pendingCustomActionNode({ data: input.data });
  if (!custom) {
    throw new ExecutableActionUnavailableError(
      `plugin_unavailable: custom Action ${parsed.data.exportId} is not pending.`,
    );
  }
  const resolved = await (options.resolveBinding ?? resolveExecutableBinding)(
    env,
    input.userId,
    parsed.data,
  );
  if (!resolved) {
    throw new ExecutableActionUnavailableError(
      `plugin_unavailable: ${parsed.data.pluginId}/${parsed.data.exportId} is not executable in this deployment.`,
    );
  }

  const frozen = freezeCanvasCustomAction({
    projectId: input.projectId,
    nodeId: input.nodeId,
    data: input.data,
    binding: resolved.binding,
    custom,
    resolveMention: input.resolveMention ?? (() => undefined),
  });
  const executor = {
    ...frozen.executor,
    ...(resolved.idempotentSubmit ? { idempotentSubmit: true } : {}),
  };
  await input.onFrozen?.({
    identity: frozen.identity,
    executor,
    binding: resolved.binding,
  });

  const params = executableActionGenerationParams(
    frozen.identity,
    executor,
    input.userId,
  );
  await (options.claim ?? claimHostedGenerationNode)(env, params);

  const now = (options.now ?? Date.now)();
  const journal = options.journal ?? createD1CloudDurableRunJournal(env.DB);
  // The identity is content-addressed, so re-admitting the same node revision
  // (a lost optimistic lock, a duplicate ProjectRoom pass) must find the same
  // row. Reusing its creation time and deadline keeps the creation identical; a fresh deadline
  // would make createCloudDurableRun reject it and fail a live run's node.
  const existing = await journal.load(frozen.identity);
  const run = await createCloudDurableRun({
    ownerId: EXECUTABLE_ACTION_OWNER,
    journal,
    clock: { now: () => existing?.createdAt ?? now },
    command: {
      actionRunId: frozen.identity.actionRunId,
      outputSlot: frozen.identity.outputSlot,
      deadlineAt: existing?.deadlineAt ?? now + EXECUTABLE_ACTION_DEADLINE_MS,
      executorInput: ExecutablePluginJsonValueSchema.parse({
        schemaVersion: 1,
        ...executor,
      }),
    },
  });

  // The row is authoritative now. A transient scheduler failure is recovered
  // by the cron scan from this identity, never by re-running admission.
  try {
    await scheduleCloudDurableWorkflow({
      workflow: options.workflow ?? env.GENERATION_WORKFLOW,
      identity: {
        actionRunId: run.actionRunId,
        outputSlot: run.outputSlot,
      },
    });
  } catch (error) {
    console.warn("executable-action.workflow_schedule_failed", {
      actionRunId: run.actionRunId,
      outputSlot: run.outputSlot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return run;
}
