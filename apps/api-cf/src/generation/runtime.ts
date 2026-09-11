import {
  executableFailureFromThrown,
  providerHttpFailure,
} from "@clash/action-sdk/executable-failure";
import {
  createBoundedRetryPolicy,
  durableRunIdempotencyKey,
  type DurableRunRecord,
  type DurableProviderFailure,
} from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import {
  applyModelProviderImplementation,
  MODEL_CARDS,
  normalizeModelId,
  validateModelCardConfiguration,
  type ModelUpstreamRoute,
} from "@clash/shared-types";
import {
  createCloudDurableRun,
  createCloudDurableRunCoordinator,
  type CloudDurableRunJournal,
} from "../cloud-runs/cloud-durable-run-coordinator";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import type { Env } from "../config";
import { getPlugins } from "../plugins/registry";
import type { Plugin } from "../plugins/types";
import { probeAsset } from "../services/asset-probe";
import { GenerationContext } from "./context";
import { createGenerationOutputBroker } from "./output";
import { resolveAdapter } from "./registry";
import type { GenerationAdapter } from "./adapter";
import type { GenerationParams } from "./params";
import { resolveGenerationModelProviderRoute } from "./model-provider-route";
import {
  GenerationPublicationConflict,
  assertHostedGenerationAccess,
  claimHostedGenerationNode,
  publishHostedGeneration,
  type HostedGenerationPublication,
} from "./publication";

const OWNER = "api-cf:generation";
export const HOSTED_GENERATION_OUTPUT_SLOT = "output";
interface FrozenGeneration {
  params: GenerationParams;
  workflowId: string;
}
export function frozenGeneration(run: DurableRunRecord): FrozenGeneration {
  const input = run.executorInput as unknown as FrozenGeneration;
  if (
    !input?.params?.taskId ||
    input.params.taskId !== run.actionRunId ||
    !input.workflowId ||
    run.owner.id !== OWNER ||
    run.owner.realm !== "cloud"
  )
    throw new Error("Invalid hosted generation journal identity.");
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
export interface HostedGenerationOptions {
  journal?: CloudDurableRunJournal;
  resolveRoute?: (
    env: Env,
    params: GenerationParams,
  ) => Promise<ModelUpstreamRoute | undefined>;
  assertAccess?: (env: Env, params: GenerationParams) => Promise<void>;
  claim?: (env: Env, params: GenerationParams) => Promise<void>;
  hooks?: NonNullable<Plugin["generation"]>;
  clock?: { now(): number };
  adapter?: (params: GenerationParams) => GenerationAdapter;
  publish?: (
    params: GenerationParams,
    publication: HostedGenerationPublication,
  ) => Promise<void>;
  hookCheckpoint?: (name: string, action: () => Promise<void>) => Promise<void>;
}

function assertSameRequest(
  run: DurableRunRecord,
  workflowId: string,
  params: GenerationParams,
): void {
  const frozen = frozenGeneration(run);
  const { selectedRoute: _ignored, ...request } = params;
  const { selectedRoute: _frozenRoute, ...prior } = frozen.params;
  if (
    frozen.workflowId !== workflowId ||
    stable(request) !== stable(prior) ||
    (params.selectedRoute !== undefined &&
      stable(params.selectedRoute) !== stable(frozen.params.selectedRoute))
  )
    throw new Error(
      "Generation task already exists with different frozen input.",
    );
}

/** New requests freeze route/account references before the journal and Workflow boundaries. */
export async function enqueueHostedGeneration(
  env: Env,
  workflowId: string,
  params: GenerationParams,
  options: HostedGenerationOptions = {},
): Promise<DurableRunRecord> {
  if (!params.actorUserId || !params.projectId || !params.taskId)
    throw new Error("Generation requires actor, Project and task identity.");
  const journal = options.journal ?? createD1CloudDurableRunJournal(env.DB);
  const existing = await journal.load({
    actionRunId: params.taskId,
    outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
  });
  await (options.assertAccess ?? assertHostedGenerationAccess)(env, params);
  const hooks = options.hooks ?? getPlugins().generation;
  await hooks?.beforeGenerationStart?.({ env, params });
  let run = existing;
  if (existing) {
    assertSameRequest(existing, workflowId, params);
  } else {
    const selectedRoute = await (
      options.resolveRoute ?? resolveGenerationModelProviderRoute
    )(env, params);
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
      if (error) throw new Error(error);
    }
    const now = options.clock?.now() ?? Date.now();
    try {
      run = await createCloudDurableRun({
        ownerId: OWNER,
        journal,
        clock: options.clock,
        command: {
          actionRunId: params.taskId,
          outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
          deadlineAt: now + 30 * 60_000,
          executorInput: json({ params: frozen, workflowId }),
        },
      });
    } catch (error) {
      // Concurrent requests may compute different wall-clock deadlines. The
      // first journal row owns that deadline; only the original request facts
      // decide whether the loser can reuse its identity.
      const winner = await journal.load({
        actionRunId: params.taskId,
        outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
      });
      if (!winner) throw error;
      assertSameRequest(winner, workflowId, params);
      run = winner;
    }
  }
  await (options.claim ?? claimHostedGenerationNode)(
    env,
    frozenGeneration(run!).params,
  );
  try {
    await env.GENERATION_WORKFLOW.create({
      id: workflowId,
      params: {
        actionRunId: params.taskId,
        outputSlot: HOSTED_GENERATION_OUTPUT_SLOT,
      },
    });
  } catch (error) {
    if (
      !/already exists|already started|duplicate/i.test(
        error instanceof Error ? error.message : String(error),
      )
    )
      throw error;
  }
  return run!;
}

/** Hook markers prevent ordinary replay; a crash between the external hook and its
 * marker remains at-least-once. Billing plugins must deduplicate by params.taskId. */
async function hookReceipt(
  env: Env,
  run: DurableRunRecord,
  name: string,
  action: () => Promise<void>,
) {
  const identity = durableRunIdempotencyKey(run);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const key = `generation/hooks/${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}/${name}.json`;
  if (await env.R2_BUCKET.get(key)) return;
  await action();
  await env.R2_BUCKET.put(key, JSON.stringify({ done: true }), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
}

export function createHostedGenerationRuntime(
  env: Env,
  options: HostedGenerationOptions = {},
) {
  const hooks = options.hooks ?? getPlugins().generation;
  const context = (run: DurableRunRecord) =>
    new GenerationContext(
      frozenGeneration(run).params,
      env,
      createGenerationOutputBroker(
        env.R2_BUCKET,
        run,
        frozenGeneration(run).params.projectId,
      ),
      createGenerationOutputBroker(
        env.R2_BUCKET,
        { ...run, outputSlot: `${run.outputSlot}:cover` },
        frozenGeneration(run).params.projectId,
      ),
    );
  const hook = (
    run: DurableRunRecord,
    name: string,
    action: () => Promise<void>,
  ) =>
    options.hookCheckpoint
      ? options.hookCheckpoint(
          `${durableRunIdempotencyKey(run)}:${name}`,
          action,
        )
      : hookReceipt(env, run, name, action);
  const publish =
    options.publish ??
    ((params, publication) =>
      publishHostedGeneration(env, params, publication));
  return createCloudDurableRunCoordinator({
    ownerId: OWNER,
    journal: options.journal ?? createD1CloudDurableRunJournal(env.DB),
    clock: options.clock,
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
    classifyThrownError(error, operation): DurableProviderFailure {
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
      async submit({ run }) {
        const ctx = context(run);
        await (options.assertAccess ?? assertHostedGenerationAccess)(
          env,
          ctx.params,
        );
        await (options.claim ?? claimHostedGenerationNode)(env, ctx.params);
        await hook(run, "beforeGenerate", async () => {
          await hooks?.beforeGenerate?.({ env, params: ctx.params });
        });
        return (options.adapter ?? resolveAdapter)(ctx.params).submit(ctx);
      },
      async poll({ run, pollState }) {
        const ctx = context(run);
        await (options.assertAccess ?? assertHostedGenerationAccess)(
          env,
          ctx.params,
        );
        const adapter = (options.adapter ?? resolveAdapter)(ctx.params);
        if (!adapter.poll)
          throw new Error("Accepted generation adapter has no poll operation.");
        return adapter.poll(ctx, pollState);
      },
    },
    outputStore: {
      async stage({ run, outputs }) {
        const params = frozenGeneration(run).params;
        const output = outputs.find(
          (candidate) => candidate.slot === HOSTED_GENERATION_OUTPUT_SLOT,
        );
        if (output?.kind === "value") return json({ updates: output.value });
        if (output?.kind !== "asset")
          throw new Error("Generation did not produce its declared output.");
        const receipt = await createGenerationOutputBroker(
          env.R2_BUCKET,
          run,
          params.projectId,
        ).resolve(output.asset);
        const hints = outputs.find(
          (candidate) => candidate.slot === "projection",
        );
        const projection = (hints?.kind === "value" ? hints.value : {}) as {
          durationMs?: number;
          metadata?: Record<string, unknown>;
          cover?: import("@clash/shared-types/executable-plugin").ExecutablePluginAssetHandle;
        };
        const cover = projection.cover
          ? await createGenerationOutputBroker(
              env.R2_BUCKET,
              { ...run, outputSlot: `${run.outputSlot}:cover` },
              params.projectId,
            ).resolve(projection.cover)
          : undefined;
        const probe =
          params.type === "video_render"
            ? { metadata: projection.metadata ?? {}, coverR2Key: undefined }
            : await probeAsset(
                env,
                receipt.kind,
                receipt.storageKey,
                params.projectId,
                { skipVideoCover: !!cover },
              );
        const durationMs =
          probe.metadata.durationMs ??
          projection.durationMs ??
          (typeof params.duration === "number"
            ? Math.round(params.duration * 1000)
            : undefined);
        return json({
          updates: { assetId: params.taskId },
          asset: {
            id: params.taskId,
            userId: params.actorUserId,
            projectId: params.projectId,
            sourceTaskId: params.taskId,
            kind: receipt.kind,
            srcR2Key: receipt.storageKey,
            coverR2Key: cover?.storageKey ?? probe.coverR2Key,
            metadata: {
              ...projection.metadata,
              ...probe.metadata,
              ...(durationMs == null ? {} : { durationMs }),
              bytes: receipt.byteLength,
              contentType: receipt.mediaType,
            },
            sourceModel: params.modelName ?? params.videoModel,
            sourcePrompt: params.prompt,
            sources: params.sources,
          },
        });
      },
    },
    publisher: {
      async publish({ run, stagedOutput }) {
        const params = frozenGeneration(run).params;
        await publish(
          params,
          stagedOutput as unknown as HostedGenerationPublication,
        );
        await hook(run, "afterGenerate", async () => {
          await hooks?.afterGenerate?.({ env, params }, {});
        });
      },
      async publishFailure({ run, failure }) {
        const params = frozenGeneration(run).params;
        await hook(run, "onFailure", async () => {
          await hooks?.onFailure?.(
            { env, params },
            new Error(run.failure?.message ?? failure.message),
          );
        });
        await publish(params, {
          updates: { errorMessage: failure.message },
          failure,
        });
      },
    },
  });
}
