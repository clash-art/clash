/**
 * Cloudflare wiring for the shared voice-input contract. The HTTP routes,
 * catalog selection and Provider transcription live in shared-runtime; this
 * module supplies D1/R2-backed catalog, credential and audit ports.
 *
 * Local ASR install/models and builtin-rpc stay local-only.
 */
import type { Hono } from "hono";
import {
  listModelCatalogEntries,
  type ModelCatalogEntry,
} from "@clash/shared-types";
import {
  createHostedVoiceInputPorts,
  type VoiceInputHostedPorts,
  type VoiceInputPorts,
} from "@clash/shared-runtime/cloud-project-host/voice-input";
import { createVoiceInputRoutes as createSharedVoiceInputRoutes } from "@clash/shared-runtime/voice-input-routes";
import type { Env } from "../../config";
import { loadHostedModelCards } from "../../generation/model-provider-route";
import { getProviderCredentials } from "../../services/provider-accounts";
import { appendProviderUsageEvent } from "../../services/provider-usage";

export interface VoiceInputRouteOptions {
  /** Tests inject ports; production reads the user's hosted model settings. */
  createPorts?: (env: Env, userId: string) => VoiceInputPorts;
}

/** Hosted catalog from the shared loader; mock routes only run on the local Host. */
async function hostedCatalog(
  env: Env,
  userId: string,
): Promise<ModelCatalogEntry[]> {
  const { models, configuredProviders } = await loadHostedModelCards(
    env,
    userId,
    { excludeProviderIds: ["mock"] },
  );
  return listModelCatalogEntries({ models, configuredProviders });
}

function hostedPorts(env: Env): VoiceInputHostedPorts {
  return {
    catalog: { list: (userId) => hostedCatalog(env, userId) },
    credentials: {
      async resolve({ userId, route }) {
        const credentials = await getProviderCredentials(env, userId, {
          accountId: route.accountId,
          providerId: route.providerId ?? route.upstreamId,
          upstreamId: route.upstreamId,
          region: route.region,
          modelCode: route.modelCode,
          requiredCredentials: route.requiredCredentials,
        });
        return env.CF_AIG_TOKEN
          ? { ...credentials, cfAigToken: env.CF_AIG_TOKEN }
          : credentials;
      },
    },
    usage: { append: (event) => appendProviderUsageEvent(env.DB, event) },
  };
}

export function createVoiceInputRoutes(
  options: VoiceInputRouteOptions = {},
): Hono<{ Bindings: Env }> {
  const createPorts =
    options.createPorts ??
    ((env: Env, userId: string) =>
      createHostedVoiceInputPorts(userId, hostedPorts(env)));

  return createSharedVoiceInputRoutes<{ Bindings: Env }>({
    userId: (c) => c.req.header("x-user-id") ?? null,
    createPorts: (c, userId) => createPorts(c.env, userId),
  });
}
