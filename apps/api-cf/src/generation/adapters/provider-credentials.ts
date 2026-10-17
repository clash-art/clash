import type { ModelUpstreamRoute, ProviderAccountId } from "@clash/shared-types";
import { getProviderCredentials } from "../../services/provider-accounts";
import type { GenerationContext } from "../context";

export async function credentialsForRoute(
  ctx: GenerationContext,
  route: Pick<ModelUpstreamRoute, "accountId" | "modelCode" | "providerId" | "upstreamId" | "region" | "requiredCredentials">,
): Promise<Record<string, string>> {
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
