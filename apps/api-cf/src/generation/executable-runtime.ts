/**
 * Cloudflare adapter composition root for executable-plugin Actions.
 *
 * One coordinator owns the same Durable Run journal, step graph, R2 staging
 * and ProjectRoom publication as local-api. The provider port only dispatches
 * through the shared PluginExecutionPort binding; it never picks an adapter by
 * caller or Project state.
 */
import { executableFailureFromThrown } from "@clash/action-sdk/executable-failure";
import {
  atMostOnceAmbiguousSubmit,
  GenerationPublicationConflict,
} from "@clash/shared-runtime/hosted-generation";
import {
  createBoundedRetryPolicy,
  type DurableOutputStore,
  type DurableProviderFailure,
  type DurableRunClock,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";
import {
  createCloudDurableRunCoordinator,
  type CloudDurableRunJournal,
} from "@clash/shared-runtime/cloud-run-coordinator";
import {
  createExecutableRunProvider,
  parseFrozenExecutableInput,
  type ExecutablePluginActionInvoker,
} from "@clash/shared-runtime/executable-run";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";

import type { Env } from "../config";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { EXECUTABLE_ACTION_OWNER } from "../cloud-runs/owners";
import { probeAsset } from "../services/asset-probe";
import { executableActionGenerationParams } from "./executable-action-params";
import { createCloudActionInvoker } from "./plugin-execution/action-invoker";
import { createGenerationOutputBroker } from "./output";
import type { GenerationParams } from "./params";
import {
  publishHostedGeneration,
  type HostedGenerationPublication,
} from "./publication";
import { hostedProjectOwnerId } from "./project-owner";

const ATTEMPT_TIMEOUT_MS = 30 * 60_000;

export interface ExecutableActionRuntimeOptions {
  journal?: CloudDurableRunJournal;
  clock?: DurableRunClock;
  /** Injected in tests; production resolves code first, then the user endpoint. */
  action?: ExecutablePluginActionInvoker;
  publish?: (
    params: GenerationParams,
    publication: HostedGenerationPublication,
  ) => Promise<void>;
  ownerForProject?: (env: Env, projectId: string) => Promise<string>;
}

function json(value: unknown): ExecutablePluginJsonValue {
  return JSON.parse(JSON.stringify(value));
}

function actionParams(
  run: DurableRunRecord,
  ownerId: string,
): GenerationParams {
  return executableActionGenerationParams(
    { actionRunId: run.actionRunId, outputSlot: run.outputSlot },
    parseFrozenExecutableInput(run.executorInput),
    ownerId,
  );
}

function classifyThrownError(
  error: unknown,
  operation: DurableRunOperation,
): DurableProviderFailure {
  if (operation === "submit" || operation === "poll") {
    return executableFailureFromThrown(error, operation);
  }
  return {
    code:
      operation === "stage"
        ? "output_persistence_failed"
        : "publication_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: !(error instanceof GenerationPublicationConflict),
    requestState: "accepted",
  };
}

/** The output store is replay-safe because the broker receipt is keyed by the run identity. */
function actionOutputStore(
  env: Env,
  ownerForProject: (env: Env, projectId: string) => Promise<string>,
): DurableOutputStore {
  return {
    async stage({ run, outputs }) {
      const frozen = parseFrozenExecutableInput(run.executorInput);
      const output = outputs.find(
        (candidate) => candidate.slot === run.outputSlot,
      );
      if (!output) {
        throw new Error(
          `Executable Action output slot ${run.outputSlot} is missing.`,
        );
      }
      if (frozen.kind === "text") {
        if (output.kind !== "value") {
          throw new Error(
            `Executable Action text slot ${run.outputSlot} is not a value.`,
          );
        }
        const content =
          typeof output.value === "string"
            ? output.value
            : JSON.stringify(output.value);
        if (!content.trim()) {
          throw new Error(
            "Executable Action text output must be a non-empty string.",
          );
        }
        return json({ updates: { content } });
      }
      if (output.kind !== "asset") {
        throw new Error(
          "Executable Action media output must be a canonical Asset handle.",
        );
      }
      const receipt = await createGenerationOutputBroker(
        env.R2_BUCKET,
        run,
        frozen.projectId,
      ).resolve(output.asset);
      const probe = await probeAsset(
        env,
        frozen.kind,
        receipt.storageKey,
        frozen.projectId,
      );
      const userId = await ownerForProject(env, frozen.projectId);
      return json({
        updates: { assetId: run.actionRunId },
        asset: {
          id: run.actionRunId,
          userId,
          projectId: frozen.projectId,
          sourceTaskId: run.actionRunId,
          kind: receipt.kind,
          srcR2Key: receipt.storageKey,
          ...(probe.coverR2Key ? { coverR2Key: probe.coverR2Key } : {}),
          metadata: {
            ...probe.metadata,
            bytes: receipt.byteLength,
            contentType: receipt.mediaType,
          },
          sourceModel: frozen.modelEndpoint ?? frozen.binding.pluginId,
          ...(typeof frozen.input.values.prompt === "string"
            ? { sourcePrompt: frozen.input.values.prompt }
            : {}),
        },
      });
    },
  };
}

export function createExecutableActionRuntime(
  env: Env,
  options: ExecutableActionRuntimeOptions = {},
) {
  const clock = options.clock ?? { now: () => Date.now() };
  const ownerForProject = options.ownerForProject ?? hostedProjectOwnerId;
  const publish =
    options.publish ??
    ((params, publication) =>
      publishHostedGeneration(env, params, publication));
  const paramsFor = async (run: DurableRunRecord) =>
    actionParams(
      run,
      await ownerForProject(
        env,
        parseFrozenExecutableInput(run.executorInput).projectId,
      ),
    );
  return createCloudDurableRunCoordinator({
    ownerId: EXECUTABLE_ACTION_OWNER,
    journal: options.journal ?? createD1CloudDurableRunJournal(env.DB),
    clock,
    // A legacy Action has no upstream deduplication of a repeated submit, so
    // an ambiguous submit is terminal unless its frozen declaration opts in.
    retryPolicy: atMostOnceAmbiguousSubmit(
      createBoundedRetryPolicy({
        maxFailures: { submit: 2, poll: 4, stage: 4, publish: 4 },
        baseDelayMs: 2000,
        maxDelayMs: 60000,
      }),
      (run) =>
        parseFrozenExecutableInput(run.executorInput).idempotentSubmit === true,
    ),
    attemptTimeoutMs: {
      submit: ATTEMPT_TIMEOUT_MS,
      poll: ATTEMPT_TIMEOUT_MS,
      stage: ATTEMPT_TIMEOUT_MS,
      publish: ATTEMPT_TIMEOUT_MS,
    },
    classifyThrownError,
    provider: createExecutableRunProvider({
      now: () => clock.now(),
      action: options.action ?? createCloudActionInvoker(env),
      unavailable: (message) => new Error(message),
    }),
    outputStore: actionOutputStore(env, ownerForProject),
    publisher: {
      async publish({ run, stagedOutput }) {
        await publish(
          await paramsFor(run),
          stagedOutput as unknown as HostedGenerationPublication,
        );
      },
      async publishFailure({ run, failure }) {
        await publish(await paramsFor(run), {
          updates: { errorMessage: failure.message },
          failure,
        });
      },
    },
  });
}
