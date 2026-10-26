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

/**
 * The user's effective hosted model cards and configured provider accounts.
 * One loader for every hosted consumer (generation routing, voice input).
 */
export async function loadHostedModelCards(
  env: Pick<Env, "DB">,
  userId: string,
  options: { excludeProviderIds?: readonly string[] } = {},
): Promise<{ models: ReturnType<typeof buildEffectiveModelCards>; configuredProviders: ProviderAccountAvailability[] }> {
  const [accounts, oauthRecords, configs] = await Promise.all([
    listProviderAccounts(env.DB, userId),
    listProviderOAuthRecords(env.DB, userId),
    listModelCardConfigs(env.DB, userId),
  ]);
  const configuredProviders: ProviderAccountAvailability[] = applyProviderOAuth(accounts, oauthRecords)
    .filter((account) => !options.excludeProviderIds?.includes(account.providerId))
    .map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...account }) => account);
  return {
    models: buildEffectiveModelCards({
      configs,
      providers: configuredProviders,
      baseModels: await hostedBaseModelCards(),
    }),
    configuredProviders,
  };
}

/** No enabled provider account of the user serves the model. */
export class NoConfiguredProviderRouteError extends Error {
  override name = "NoConfiguredProviderRouteError";
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

  const { models, configuredProviders } = await loadHostedModelCards(env, params.actorUserId);
  const route = resolveModelUpstreamRoute({
    modelCode,
    kind,
    models,
    configuredProviders,
  });
  if (!route) {
    throw new NoConfiguredProviderRouteError(`No configured provider route for ${modelCode}`);
  }
  return route;
}
