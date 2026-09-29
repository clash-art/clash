import {
  executableFailureFromThrown,
  providerHttpFailure,
} from "@clash/action-sdk/executable-failure";
import {
  applyModelProviderImplementation,
  MODEL_CARDS,
  normalizeModelId,
  validateModelCardConfiguration,
  type ModelUpstreamRoute,
} from "@clash/shared-types";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import {
  createCloudDurableRun,
  createCloudDurableRunCoordinator,
  type CloudDurableRunJournal,
} from "./cloud-run-coordinator.js";
import {
  createBoundedRetryPolicy,
  type DurableRunRecord,
  type DurableProviderExecutor,
  type DurableOutputStore,
  type DurableProjectPublisher,
  type DurableRunClock,
} from "./durable-run-engine.js";
import type { GenerationParams } from "./generation-params.js";

export const HOSTED_GENERATION_OUTPUT_SLOT = "output";
export class GenerationPublicationConflict extends Error {}
export interface GenerationPipelinePorts {
  ownerId: string;
  journal: CloudDurableRunJournal;
  clock?: DurableRunClock;
  resolveRoute(
    params: GenerationParams,
  ): Promise<ModelUpstreamRoute | undefined>;
  assertAccess(params: GenerationParams): Promise<void>;
  claim(params: GenerationParams): Promise<void>;
  beforeStart(params: GenerationParams): Promise<void>;
  schedule(workflowId: string, run: DurableRunRecord): Promise<void>;
  checkpoint(
    run: DurableRunRecord,
    name: string,
    action: () => Promise<void>,
  ): Promise<void>;
  beforeGenerate?(params: GenerationParams): Promise<void>;
  afterGenerate?(params: GenerationParams): Promise<void>;
  onFailure?(params: GenerationParams, error: Error): Promise<void>;
  provider: DurableProviderExecutor;
  stage: DurableOutputStore["stage"];
  publish: DurableProjectPublisher["publish"];
  publishFailure: NonNullable<DurableProjectPublisher["publishFailure"]>;
}
export function frozenGeneration(
  run: DurableRunRecord,
  ownerId: string,
): { params: GenerationParams; workflowId: string } {
  const input = run.executorInput as unknown as {
    params: GenerationParams;
    workflowId: string;
  };
  if (
    !input?.params?.taskId ||
    input.params.taskId !== run.actionRunId ||
    !input.workflowId ||
    run.owner.id !== ownerId ||
    run.owner.realm !== "cloud"
  )
    throw Error("Invalid hosted generation journal identity.");
  return input;
}
function json(value: unknown): ExecutablePluginJsonValue {
  return JSON.parse(JSON.stringify(value));
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function assertSameRequest(
  run: DurableRunRecord,
  workflowId: string,
  params: GenerationParams,
  ownerId: string,
) {
  const frozen = frozenGeneration(run, ownerId);
  const { selectedRoute: _ignored, ...request } = params;
  const { selectedRoute: _route, ...prior } = frozen.params;
  if (
    frozen.workflowId !== workflowId ||
    stable(request) !== stable(prior) ||
    (params.selectedRoute !== undefined &&
      stable(params.selectedRoute) !== stable(frozen.params.selectedRoute))
  )
    throw Error("Generation task already exists with different frozen input.");
}
export async function enqueueGeneration(
  ports: GenerationPipelinePorts,
  workflowId: string,
  params: GenerationParams,
): Promise<DurableRunRecord> {
  if (!params.actorUserId || !params.projectId || !params.taskId)
    throw Error("Generation requires actor, Project and task identity.");
  const existing = await ports.journal.load({
    actionRunId: params.taskId,
    outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
  });
  await ports.assertAccess(params);
  await ports.beforeStart(params);
  let run = existing;
  if (existing) assertSameRequest(existing, workflowId, params, ports.ownerId);
  else {
    const selectedRoute = await ports.resolveRoute(params);
    const frozen = { ...params, ...(selectedRoute ? { selectedRoute } : {}) };
    const modelId =
      normalizeModelId(params.modelName ?? params.videoModel) ??
      params.modelName ??
      params.videoModel;
    const base = MODEL_CARDS.find((card) => card.id === modelId);
    if (base) {
      const card = applyModelProviderImplementation(base, selectedRoute);
      const modelParams: Record<string, unknown> = {
        ...params.modelParams,
        ...(params.duration === undefined ? {} : { duration: params.duration }),
        ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
      };
      const lyrics = card.musicInput?.lyricsParam
        ? modelParams[card.musicInput.lyricsParam]
        : undefined;
      const error = validateModelCardConfiguration(card, {
        prompt: params.prompt,
        lyrics: typeof lyrics === "string" ? lyrics : undefined,
        modelParams: modelParams as never,
      });
      if (error) throw Error(error);
    }
    const now = ports.clock?.now() ?? Date.now();
    try {
      run = await createCloudDurableRun({
        ownerId: ports.ownerId,
        journal: ports.journal,
        clock: ports.clock,
        command: {
          actionRunId: params.taskId,
          outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
          deadlineAt: now + 30 * 60_000,
          executorInput: json({ params: frozen, workflowId }),
        },
      });
    } catch (error) {
      const winner = await ports.journal.load({
        actionRunId: params.taskId,
        outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
      });
      if (!winner) throw error;
      assertSameRequest(winner, workflowId, params, ports.ownerId);
      run = winner;
    }
  }
  await ports.claim(frozenGeneration(run!, ports.ownerId).params);
  await ports.schedule(workflowId, run!);
  return run!;
}

/** Platform-neutral admission, lifecycle and retry policy; ports own IO and scheduling. */
export function createGenerationPipeline(ports: GenerationPipelinePorts) {
  const params = (run: DurableRunRecord) =>
    frozenGeneration(run, ports.ownerId).params;
  return createCloudDurableRunCoordinator({
    ownerId: ports.ownerId,
    journal: ports.journal,
    clock: ports.clock,
    retryPolicy: createBoundedRetryPolicy({
      maxFailures: { submit: 2, poll: 4, stage: 4, publish: 4 },
      baseDelayMs: 2000,
      maxDelayMs: 60000,
    }),
    attemptTimeoutMs: {
      submit: 30 * 60_000,
      poll: 30 * 60_000,
      stage: 30 * 60_000,
      publish: 30 * 60_000,
    },
    classifyThrownError(error, operation) {
      if (operation === "submit" || operation === "poll") {
        const status =
          error && typeof error === "object"
            ? ((error as { status?: unknown; statusCode?: unknown }).status ??
              (error as { statusCode?: unknown }).statusCode)
            : undefined;
        if (typeof status === "number" && status >= 400 && status <= 599)
          return providerHttpFailure({
            status,
            operation,
            message: error instanceof Error ? error.message : String(error),
          });
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
    },
    provider: {
      async submit(input) {
        const p = params(input.run);
        await ports.assertAccess(p);
        await ports.claim(p);
        await ports.checkpoint(input.run, "beforeGenerate", async () => {
          await ports.beforeGenerate?.(p);
        });
        return ports.provider.submit(input);
      },
      async poll(input) {
        await ports.assertAccess(params(input.run));
        if (!ports.provider.poll)
          throw Error("Accepted generation adapter has no poll operation.");
        return ports.provider.poll(input);
      },
    },
    outputStore: { stage: ports.stage },
    publisher: {
      async publish(input) {
        await ports.publish(input);
        await ports.checkpoint(input.run, "afterGenerate", async () => {
          await ports.afterGenerate?.(params(input.run));
        });
      },
      async publishFailure(input) {
        await ports.checkpoint(input.run, "onFailure", async () => {
          await ports.onFailure?.(
            params(input.run),
            new Error(input.run.failure?.message ?? input.failure.message),
          );
        });
        await ports.publishFailure(input);
      },
    },
  });
}
