import {
  buildEffectiveModelCards,
  resolveModelUpstreamRoute,
  type ModelKind,
  type ModelUpstreamRoute,
  type ProviderAccountAvailability,
} from "@clash/shared-types";

import type { Env } from "../config";
import { listModelCardConfigs } from "../services/model-card-configs";
import { listProviderAccounts } from "../services/provider-accounts";
import { applyProviderOAuth, listProviderOAuthRecords } from "../services/provider-oauth";
import { hostedBaseModelCards } from "./hosted-model-cards";
import type { GenerationParams } from "./params";

function generationKind(type: GenerationParams["type"]): ModelKind | null {
  if (type === "image_gen") return "image";
  if (type === "video_gen") return "video";
  if (type === "audio_gen") return "audio";
  if (type === "text_gen") return "text";
  return null;
}

export async function resolveGenerationModelProviderRoute(
  env: Pick<Env, "DB">,
  params: GenerationParams,
): Promise<ModelUpstreamRoute | undefined> {
  const kind = generationKind(params.type);
  if (!kind) return undefined;
  const modelCode = params.modelName ?? params.videoModel;
  if (!modelCode) {
    throw new Error(`No model code was supplied for ${params.type}`);
  }

  const [accounts, oauthRecords, configs] = await Promise.all([
    listProviderAccounts(env.DB, params.actorUserId),
    listProviderOAuthRecords(env.DB, params.actorUserId),
    listModelCardConfigs(env.DB, params.actorUserId),
  ]);
  const configuredProviders: ProviderAccountAvailability[] = applyProviderOAuth(accounts, oauthRecords)
    .map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...account }) => account);
  const models = buildEffectiveModelCards({
    configs,
    providers: configuredProviders,
    baseModels: await hostedBaseModelCards(),
  });
  const route = resolveModelUpstreamRoute({
    modelCode,
    kind,
    models,
    configuredProviders,
  });
  if (!route) {
    throw new Error(`No configured provider route for ${modelCode}`);
  }
  return route;
}
