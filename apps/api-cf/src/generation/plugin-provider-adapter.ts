import {
  durableRunIdempotencyKey,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";
import {
  executableProviderRequest,
  executableProviderResultStep,
  providerPluginExecutorRequest,
  remainingAttemptTimeoutMs,
  type ProviderPluginExecutorRequest,
} from "@clash/shared-runtime/executable-run";
import type { PluginExecutionPort } from "@clash/shared-runtime/executable-plugin-port";
import {
  ExecutablePluginBindingSchema,
  ExecutablePluginInvocationSchema,
  type ExecutablePluginBinding,
  type ExecutablePluginJsonValue,
  type ExecutablePluginReference,
  type ModelKind,
  type ModelUpstreamRoute,
} from "@clash/shared-types";

import type { GenerationContext } from "./context";
import type { GenerationAdapter } from "./adapter";
import type { GenerationParams } from "./params";

/** First-party provider executors admitted to the Cloudflare adapter. */
export const PLUGIN_PROVIDER_PLUGIN_IDS = ["clash.fal"] as const;
const PLUGIN_PROVIDER_PLUGIN_ID_SET = new Set<string>(
  PLUGIN_PROVIDER_PLUGIN_IDS,
);

export function isExecutablePluginProviderRoute(
  route: ModelUpstreamRoute | undefined,
): route is ModelUpstreamRoute & {
  executorPluginId: string;
  executorExportId: string;
} {
  return !!(
    route?.executorPluginId &&
    route.executorExportId &&
    PLUGIN_PROVIDER_PLUGIN_ID_SET.has(route.executorPluginId)
  );
}

function generationKind(
  type: GenerationParams["type"],
): ModelKind {
  if (type === "image_gen") return "image";
  if (type === "video_gen") return "video";
  if (type === "audio_gen") return "audio";
  if (type === "text_gen") return "text";
  throw new Error(
    `Provider-executor plugin routes do not support generation type ${type}.`,
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

/**
 * Translate the hosted generation request's R2-key references into the
 * immutable references the plugin protocol carries. The Host-side resolver
 * reads the same R2 object; the plugin never learns the key.
 */
function hostedPluginReferences(
  params: GenerationParams,
): ExecutablePluginReference[] {
  const references: ExecutablePluginReference[] = [];
  let index = 0;
  const push = (
    key: string | undefined,
    slot: string,
    kind: "image" | "video" | "audio",
  ) => {
    if (!key) return;
    references.push({
      slot,
      index: index++,
      asset: {
        assetId: key,
        uri: `clash-asset://${key}`,
        kind,
      },
    });
  };
  push(params.startFrameR2Key, "startFrame", "image");
  push(params.endFrameR2Key, "endFrame", "image");
  for (const key of stringList(params.referenceImageR2Keys)) {
    push(key, "content", "image");
  }
  for (const key of stringList(params.referenceVideoR2Keys)) {
    push(key, "content", "video");
  }
  for (const key of stringList(params.referenceAudioR2Keys)) {
    push(key, "content", "audio");
  }
  return references;
}

async function pluginBinding(
  route: ModelUpstreamRoute,
): Promise<ExecutablePluginBinding> {
  if (route.executorBinding) {
    return ExecutablePluginBindingSchema.parse(route.executorBinding);
  }
  const { resolveCloudPluginBinding } = await import("./plugin-execution");
  const binding = await resolveCloudPluginBinding(
    route.executorPluginId!,
    route.executorExportId!,
  );
  if (!binding) {
    throw new Error(
      `Executable provider plugin ${route.executorPluginId}/${route.executorExportId} ` +
        "is not registered for the Cloudflare adapter.",
    );
  }
  return binding;
}

function invocationFor(
  request: ProviderPluginExecutorRequest,
  binding: ExecutablePluginBinding,
  pollState: ExecutablePluginJsonValue | undefined,
) {
  const {
    accountId: _untrustedAccountId,
    credentials: _untrustedCredentials,
    ...pluginValues
  } = request.input.values;
  return ExecutablePluginInvocationSchema.parse({
    protocol: "clash.plugin.invoke/v1",
    // Stable across every attempt for one frozen run; a retry must look like
    // the same invocation to the plugin, never a new job.
    invocationId: request.taskId,
    taskId: request.taskId,
    projectId: request.projectId,
    ...(request.nodeId ? { nodeId: request.nodeId } : {}),
    target: { ...binding, kind: "provider-executor" },
    assetInputs: request.assetInputs ?? [],
    input: {
      values: {
        ...pluginValues,
        kind: request.kind,
      },
      references: request.input.references,
    },
    actor: { kind: "system", id: "api-cf" },
    ...(pollState === undefined
      ? {}
      : { operation: "poll" as const, pollState }),
  });
}

function requestFromContext(
  ctx: GenerationContext,
  pollState?: unknown,
): ProviderPluginExecutorRequest {
  if (!ctx.run) {
    throw new Error("Hosted plugin execution requires its durable run.");
  }
  const params = ctx.params;
  const route = params.selectedRoute;
  if (!isExecutablePluginProviderRoute(route)) {
    throw new Error("Hosted plugin execution requires a registered plugin route.");
  }
  const idempotencyKey =
    ctx.idempotencyKey ?? durableRunIdempotencyKey(ctx.run);
  return providerPluginExecutorRequest({
    route,
    kind: generationKind(params.type),
    taskId: idempotencyKey,
    projectId: params.projectId,
    nodeId: params.nodeId,
    prompt: params.prompt ?? "",
    ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
    ...(params.duration === undefined ? {} : { duration: params.duration }),
    ...(params.modelParams ? { modelParams: params.modelParams } : {}),
    references: hostedPluginReferences(params),
    ...(pollState === undefined ? {} : { pollState }),
    ...(ctx.run.activeAttempt
      ? { deadlineAt: ctx.run.activeAttempt.expiresAt }
      : {}),
  });
}

async function invoke(
  ctx: GenerationContext,
  pollState?: unknown,
  injectedPort?: PluginExecutionPort,
): Promise<Awaited<ReturnType<GenerationAdapter["submit"]>>> {
  const run = ctx.run;
  if (!run) throw new Error("Hosted plugin execution requires its durable run.");
  const request = requestFromContext(ctx, pollState);
  const binding = await pluginBinding(ctx.params.selectedRoute!);
  let port = injectedPort;
  if (!port) {
    const { createCloudPluginExecution } = await import("./plugin-execution");
    port = await createCloudPluginExecution(ctx.env, { run });
  }
  const result = await port.invoke({
    run,
    invocation: invocationFor(
      request,
      binding,
      pollState as ExecutablePluginJsonValue | undefined,
    ),
    timeoutMs: remainingAttemptTimeoutMs(run, Date.now()),
  });
  return executableProviderResultStep(run, binding, request.kind, result);
}

export function createPluginProviderAdapter(
  route: ModelUpstreamRoute,
  port?: PluginExecutionPort,
): GenerationAdapter {
  if (!isExecutablePluginProviderRoute(route)) {
    throw new Error(
      `Provider ${route.providerId ?? route.upstreamId} is not an allowlisted ` +
        "executable plugin route.",
    );
  }
  return {
    name: `plugin-provider:${route.executorPluginId}`,
    submit: (ctx) => invoke(ctx, undefined, port),
    poll: (ctx, token) => invoke(ctx, token, port),
  };
}

export function pluginProviderAdapterFor(
  route: ModelUpstreamRoute,
): GenerationAdapter {
  return createPluginProviderAdapter(route);
}
