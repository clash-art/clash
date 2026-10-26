import type { ModelUpstreamRoute, ProviderAccountId } from "@clash/shared-types";
import { getProviderCredentials } from "../../services/provider-accounts";
import type { GenerationContext } from "../context";
import { officialMediaCredentials, officialMediaRuntime } from "../official-media";

/**
 * The credentials for the run's route: the official key when the run is an
 * admitted official media job (only that run can resolve it), otherwise the
 * user's own provider account.
 */
export async function credentialsForRoute(
  ctx: GenerationContext,
  route: Pick<ModelUpstreamRoute, "accountId" | "modelCode" | "providerId" | "upstreamId" | "region" | "requiredCredentials">,
): Promise<Record<string, string>> {
  const official = await officialMediaCredentials(officialMediaRuntime(ctx.env), ctx.params);
  if (official) return official;
  return getProviderCredentials(ctx.env, ctx.params.actorUserId, {
    accountId: route.accountId,
    providerId: route.providerId ?? (route.upstreamId as ProviderAccountId),
    upstreamId: route.upstreamId,
    region: route.region,
    modelCode: route.modelCode,
    requiredCredentials: route.requiredCredentials,
  });
}

export async function credentialsForProvider(
  ctx: GenerationContext,
  providerId: ProviderAccountId,
  requiredCredentials: string[],
  options: { upstreamId?: ModelUpstreamRoute["upstreamId"]; region?: string; modelCode?: string } = {},
): Promise<Record<string, string>> {
  return getProviderCredentials(ctx.env, ctx.params.actorUserId, {
    providerId,
    upstreamId: options.upstreamId,
    region: options.region,
    modelCode: options.modelCode,
    requiredCredentials,
  });
}

export { googleServiceAccountFromCredentials as googleServiceAccountFromProvider } from "@clash/shared-runtime/google-service-account-auth";
