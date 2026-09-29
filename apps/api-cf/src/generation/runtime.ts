import {
  durableRunIdempotencyKey,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";
import {
  createGenerationPipeline,
  enqueueGeneration,
  frozenGeneration as readFrozenGeneration,
  HOSTED_GENERATION_OUTPUT_SLOT,
  type GenerationPipelinePorts,
} from "@clash/shared-runtime/hosted-generation";
import type { CloudDurableRunJournal } from "@clash/shared-runtime/cloud-run-coordinator";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import type { ModelUpstreamRoute } from "@clash/shared-types";
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
  assertHostedGenerationAccess,
  claimHostedGenerationNode,
  publishHostedGeneration,
  type HostedGenerationPublication,
} from "./publication";
const OWNER = "api-cf:generation";
export { HOSTED_GENERATION_OUTPUT_SLOT };
export function frozenGeneration(run: DurableRunRecord) {
  return readFrozenGeneration(run, OWNER);
}
function json(value: unknown): ExecutablePluginJsonValue {
  return JSON.parse(JSON.stringify(value));
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

function cloudflarePorts(
  env: Env,
  options: HostedGenerationOptions,
): GenerationPipelinePorts {
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
  const publish =
    options.publish ??
    ((params, publication) =>
      publishHostedGeneration(env, params, publication));
  return {
    ownerId: OWNER,
    journal: options.journal ?? createD1CloudDurableRunJournal(env.DB),
    clock: options.clock,
    resolveRoute: (params) =>
      (options.resolveRoute ?? resolveGenerationModelProviderRoute)(
        env,
        params,
      ),
    assertAccess: (params) =>
      (options.assertAccess ?? assertHostedGenerationAccess)(env, params),
    claim: (params) =>
      (options.claim ?? claimHostedGenerationNode)(env, params),
    beforeStart: async (params) => {
      await hooks?.beforeGenerationStart?.({ env, params });
    },
    async schedule(workflowId, run) {
      try {
        await env.GENERATION_WORKFLOW.create({
          id: workflowId,
          params: { actionRunId: run.actionRunId, outputSlot: run.outputSlot },
        });
      } catch (error) {
        if (
          !/already exists|already started|duplicate/i.test(
            error instanceof Error ? error.message : String(error),
          )
        )
          throw error;
      }
    },
    checkpoint: (run, name, action) =>
      options.hookCheckpoint
        ? options.hookCheckpoint(
            `${durableRunIdempotencyKey(run)}:${name}`,
            action,
          )
        : hookReceipt(env, run, name, action),
    beforeGenerate: async (params) => {
      await hooks?.beforeGenerate?.({ env, params });
    },
    afterGenerate: async (params) => {
      await hooks?.afterGenerate?.({ env, params }, {});
    },
    onFailure: async (params, error) => {
      await hooks?.onFailure?.({ env, params }, error);
    },
    provider: {
      submit: async ({ run }) =>
        (options.adapter ?? resolveAdapter)(
          frozenGeneration(run).params,
        ).submit(context(run)),
      async poll({ run, pollState }) {
        const ctx = context(run);
        const adapter = (options.adapter ?? resolveAdapter)(ctx.params);
        if (!adapter.poll)
          throw Error("Accepted generation adapter has no poll operation.");
        return adapter.poll(ctx, pollState);
      },
    },
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
    async publish({ run, stagedOutput }) {
      await publish(
        frozenGeneration(run).params,
        stagedOutput as unknown as HostedGenerationPublication,
      );
    },
    async publishFailure({ run, failure }) {
      await publish(frozenGeneration(run).params, {
        updates: { errorMessage: failure.message },
        failure,
      });
    },
  };
}
export function enqueueHostedGeneration(
  env: Env,
  workflowId: string,
  params: GenerationParams,
  options: HostedGenerationOptions = {},
) {
  return enqueueGeneration(cloudflarePorts(env, options), workflowId, params);
}
export function createHostedGenerationRuntime(
  env: Env,
  options: HostedGenerationOptions = {},
) {
  return createGenerationPipeline(cloudflarePorts(env, options));
}
