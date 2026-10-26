/**
 * What a hosted media run measures about itself, and the one usage writer for
 * every hosted adapter (#359). Adapters never meter: the lifecycle does, once
 * per run, so an adapter that forgets usage cannot exist.
 *
 * - An official run (`official-media.ts`) is metered by the gateway ledger:
 *   held at admission from `mediaQuantities`, settled from
 *   `measuredMediaQuantities` on success and at zero on failure.
 * - A BYOK run spends the user's own provider account: one
 *   `provider_usage_audit` row when it ends (`recordProviderUsage`), unless
 *   its adapter records the provider's own lifecycle events (Pika).
 */
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { GatewayMediaQuantities, GatewayModelKind } from "@clash/gateway-core";

import type { Env } from "../config";
import { appendProviderUsageEvent } from "../services/provider-usage";
import type { GenerationParams } from "./params";

export function generationMediaKind(type: GenerationParams["type"]): Exclude<GatewayModelKind, "text"> | null {
  if (type === "image_gen") return "image";
  if (type === "video_gen") return "video";
  if (type === "audio_gen") return "audio";
  return null;
}

const wholeSeconds = (seconds: unknown): number | undefined => {
  const value = typeof seconds === "string" && seconds.trim() ? Number(seconds) : seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
};

/**
 * The quantities a run asks for, before it runs: one request, one image per
 * image run (every hosted adapter delivers one asset), the requested duration
 * in whole seconds, and the prompt's characters. The price book decides which
 * of them are charged (`pricedMediaUnits`).
 */
export function mediaQuantities(params: GenerationParams): GatewayMediaQuantities {
  const kind = generationMediaKind(params.type);
  const seconds = wholeSeconds(params.duration ?? params.modelParams?.duration);
  return {
    request: 1,
    ...(kind === "image" ? { image: 1 } : {}),
    ...(kind === "video" && seconds !== undefined ? { video_second: seconds } : {}),
    ...(kind === "audio" && seconds !== undefined ? { audio_second: seconds } : {}),
    ...(params.prompt ? { character: [...params.prompt].length } : {}),
  };
}

/**
 * What a succeeded run delivered, from the output it staged: the media's
 * probed duration in whole seconds, one image. Anything not measured is
 * charged as held (`deliveredMediaUnits`).
 */
export function measuredMediaQuantities(params: GenerationParams, run?: Pick<DurableRunRecord, "stagedOutput">): GatewayMediaQuantities {
  const kind = generationMediaKind(params.type);
  const staged = run?.stagedOutput as { asset?: { metadata?: { durationMs?: unknown } } } | undefined;
  const durationMs = staged?.asset?.metadata?.durationMs;
  const seconds = typeof durationMs === "number" ? wholeSeconds(durationMs / 1000) : undefined;
  return {
    ...(kind === "image" ? { image: 1 } : {}),
    ...(kind === "video" && seconds !== undefined ? { video_second: seconds } : {}),
    ...(kind === "audio" && seconds !== undefined ? { audio_second: seconds } : {}),
  };
}

export type GenerationUsageOutcome =
  | { status: "completed"; run?: Pick<DurableRunRecord, "stagedOutput"> }
  | { status: "failed"; errorCode: string };

/**
 * The BYOK usage row of a run that ended: provider, account, model and what
 * was delivered, unpriced (`pricingSource: unavailable`). One row per run and
 * outcome (the id is the task's), so a replayed hook writes nothing new.
 * Runs without a selected provider route (renders, descriptions) have none.
 */
export async function recordProviderUsage(
  env: Pick<Env, "DB">,
  params: GenerationParams,
  outcome: GenerationUsageOutcome,
  now: () => number = Date.now,
): Promise<void> {
  const route = params.selectedRoute;
  if (!route) return;
  const kind = generationMediaKind(params.type);
  await appendProviderUsageEvent(env.DB, {
    id: `${params.taskId}:generation:${outcome.status}`,
    userId: params.actorUserId,
    providerId: route.providerId ?? route.upstreamId,
    ...(route.accountId ? { providerAccountId: route.accountId } : {}),
    modelId: route.modelCode,
    operation: route.upstreamModel,
    taskId: params.taskId,
    projectId: params.projectId,
    nodeId: params.nodeId,
    actorType: params.actorType,
    actorUserId: params.actorUserId,
    ...(params.actorAgentId ? { actorAgentId: params.actorAgentId } : {}),
    idempotencyKey: params.taskId,
    status: outcome.status,
    estimateComplete: false,
    currency: "USD",
    pricingSource: "unavailable",
    billingBasis: outcome.status === "completed" && kind ? measuredMediaQuantities(params, outcome.run) : {},
    ...(outcome.status === "failed" ? { errorCode: outcome.errorCode } : {}),
    occurredAt: new Date(now()).toISOString(),
  });
}
