/**
 * The official catalog (#351; guide: apps/docs/guide/gateway-admin.md), over
 * the same shared resolver routing uses:
 *
 * - launch seeding: which cards a first draft holds. AIGC/media cards an
 *   enabled official account serves come first; chat-only text cards are
 *   added only when configured by name. The DeepSeek Flash-only policy
 *   applies before anything is chosen.
 * - the "Clash official" provider row: the live published catalog as the
 *   provider lists (`/model-providers`, `/models/catalog`) show it.
 * - route pins: a route frozen under one catalog version keeps resolving after
 *   a newer version is published, through the live catalog when it still
 *   holds the exact implementation and otherwise through the pinned published
 *   snapshot, which never changes. Accounts are not versioned, so a disabled
 *   account ends every pin on it.
 */
import {
  MODEL_PROVIDER_DEFINITIONS,
  OFFICIAL_MODEL_PROVIDER_ID,
  listModelUpstreamRoutes,
  matchesFrozenModelRoutePin,
  type FrozenModelRoutePin,
  type ModelUpstreamRoute,
  type OfficialModelProvider,
  type ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { GatewayError, isGatewayError } from "./errors.js";
import type { GatewayIdentity, GatewayRoutesPort } from "./ports.js";
import type { GatewayModelKind } from "./request.js";
import type { GatewayCatalog, GatewayModelCard, GatewayRouteAttempt, GatewayRoutePlan } from "./routing.js";

/** Everything but chat-only text is AIGC/media (image, video, audio, 3D). */
export function isGatewayMediaKind(kind: GatewayModelKind): boolean {
  return kind !== "text";
}

/** AIGC/media models before chat-only ones; the order within each group is kept. */
export function orderGatewayCatalogMediaFirst<T extends { kind: GatewayModelKind }>(models: readonly T[]): T[] {
  return [...models.filter((model) => isGatewayMediaKind(model.kind)), ...models.filter((model) => !isGatewayMediaKind(model.kind))];
}

// `local` routes run on the user's machine; the gateway never serves them.
const gatewayExecutable = (route: ModelUpstreamRoute) => route.upstreamId !== "local";

/** Routes of `card` that one of `accounts` can serve, best first (the shared resolver's order). */
function servedRoutes(card: GatewayModelCard, accounts: readonly ProviderAccountAvailability[]): ModelUpstreamRoute[] {
  if (accounts.length === 0) return [];
  return listModelUpstreamRoutes({
    modelCode: card.id,
    kind: card.kind,
    models: [card],
    configuredProviders: [...accounts],
    isRouteExecutable: gatewayExecutable,
  });
}

export interface GatewayLaunchCatalogExclusion {
  modelCode: string;
  reason: "deepseek-not-flash" | "text-not-configured" | "no-official-account";
}

export interface GatewayLaunchCatalogPlan {
  /** Cards for the draft, AIGC/media first, each with the policy applied. */
  models: GatewayModelCard[];
  excluded: GatewayLaunchCatalogExclusion[];
  /** Configured text model codes no card has. */
  unknownTextModelCodes: string[];
}

/**
 * Choose a launch draft from `cards`: every AIGC/media card an enabled
 * official account in `accounts` serves, then the text cards named in
 * `textModelCodes` that one serves. A card is never served by a route the
 * DeepSeek policy drops.
 */
export function planGatewayLaunchCatalog(input: {
  cards: readonly GatewayModelCard[];
  accounts: readonly ProviderAccountAvailability[];
  textModelCodes?: readonly string[];
}): GatewayLaunchCatalogPlan {
  const accounts = input.accounts.filter((account) => account.enabled !== false);
  const text = new Set(input.textModelCodes ?? []);
  const policy = applyGatewayCatalogPolicy({ version: "launch", models: input.cards });
  const excluded: GatewayLaunchCatalogExclusion[] = policy.excluded.map(({ modelCode, reason }) => ({ modelCode, reason }));
  const models: GatewayModelCard[] = [];
  for (const card of policy.catalog.models) {
    if (!isGatewayMediaKind(card.kind) && !text.has(card.id)) {
      excluded.push({ modelCode: card.id, reason: "text-not-configured" });
      continue;
    }
    if (servedRoutes(card, accounts).length === 0) {
      excluded.push({ modelCode: card.id, reason: "no-official-account" });
      continue;
    }
    models.push(card);
  }
  const known = new Set(input.cards.map((card) => card.id));
  return {
    models: orderGatewayCatalogMediaFirst(models),
    excluded,
    unknownTextModelCodes: [...text].filter((code) => !known.has(code)),
  };
}

export const OFFICIAL_MODEL_PROVIDER_LABEL = "Clash official";

/**
 * The provider-list row for the live published catalog: models an enabled
 * official account serves (AIGC/media first) and the upstreams behind them.
 * Accounts are reported by provider, upstream and region only, never by id
 * or credential.
 */
export function buildOfficialModelProvider(input: {
  catalog: GatewayCatalog;
  accounts: readonly ProviderAccountAvailability[];
  publishedAt: string | null;
}): Extract<OfficialModelProvider, { status: "published" }> {
  const accounts = input.accounts.filter((account) => account.enabled !== false);
  const { catalog } = applyGatewayCatalogPolicy(input.catalog);
  const upstreams = new Map<string, { providerId: string; upstreamId: string; region?: string }>();
  const models = catalog.models.flatMap((card) => {
    const routes = servedRoutes(card, accounts);
    if (routes.length === 0) return [];
    for (const route of routes) {
      const providerId = route.providerId ?? "official";
      upstreams.set(`${providerId}\u0000${route.upstreamId}\u0000${route.region ?? ""}`, {
        providerId,
        upstreamId: route.upstreamId,
        ...(route.region ? { region: route.region } : {}),
      });
    }
    return [{ id: card.id, name: card.name, kind: card.kind, upstreamIds: [...new Set(routes.map((route) => route.upstreamId))] }];
  });
  return {
    id: OFFICIAL_MODEL_PROVIDER_ID,
    label: OFFICIAL_MODEL_PROVIDER_LABEL,
    managed: true,
    status: "published",
    catalogVersion: catalog.version,
    publishedAt: input.publishedAt,
    models: orderGatewayCatalogMediaFirst(models),
    upstreams: [...upstreams.values()],
  };
}

/** One exact official implementation, frozen with the catalog version it was chosen from. */
export interface GatewayRoutePin extends FrozenModelRoutePin {
  modelCode: string;
  kind?: GatewayModelKind;
  catalogVersion: string;
}

/** Freeze the route of `attempt` (an attempt of `plan`) as a pin. */
export function gatewayRoutePin(plan: GatewayRoutePlan, attempt: GatewayRouteAttempt): GatewayRoutePin {
  const { route } = attempt;
  return {
    modelCode: plan.modelCode,
    kind: route.kind,
    catalogVersion: plan.catalogVersion,
    upstreamId: route.upstreamId,
    upstreamModel: route.upstreamModel,
    apiShape: route.apiShape,
    ...(route.providerId ? { providerId: route.providerId } : {}),
    ...(route.accountId ? { accountId: route.accountId } : {}),
    ...(route.region ? { region: route.region } : {}),
    ...(route.executorPluginId ? { executorPluginId: route.executorPluginId } : {}),
    ...(route.executorExportId ? { executorExportId: route.executorExportId } : {}),
  };
}

export interface ResolvedGatewayRoutePin {
  route: ModelUpstreamRoute;
  /** The published version that served the pin: the live one, or the pinned snapshot. */
  catalogVersion: string;
}

/**
 * Resolve a pin in the caller's scope: the live catalog when it still holds
 * the exact implementation, else the pinned published snapshot. The catalog
 * policy applies to both, and only enabled accounts serve, so a DeepSeek
 * Pro/Reasoner pin or a pin on a disabled account is
 * GATEWAY_ROUTE_PIN_UNAVAILABLE.
 */
export async function resolveGatewayRoutePin(
  routes: Pick<GatewayRoutesPort, "catalog" | "providers">,
  identity: GatewayIdentity,
  pin: GatewayRoutePin,
): Promise<ResolvedGatewayRoutePin> {
  const providers = (await routes.providers(identity, identity.credentialScope)).filter(
    (provider) => provider.enabled !== false && (!pin.accountId || provider.id === pin.accountId),
  );
  const find = (catalog: GatewayCatalog) =>
    providers.length === 0
      ? undefined
      : listModelUpstreamRoutes({
          modelCode: pin.modelCode,
          ...(pin.kind ? { kind: pin.kind } : {}),
          models: applyGatewayCatalogPolicy(catalog).catalog.models,
          configuredProviders: providers,
          isRouteExecutable: gatewayExecutable,
        }).find((route) => matchesFrozenModelRoutePin(route, pin));

  const live = await routes.catalog(identity);
  const fromLive = find(live);
  if (fromLive) return { route: fromLive, catalogVersion: live.version };
  if (pin.catalogVersion !== live.version) {
    const pinned = await routes.catalog(identity, { version: pin.catalogVersion }).catch((error: unknown) => {
      if (isGatewayError(error) && error.code === "GATEWAY_CATALOG_VERSION_NOT_FOUND") return undefined;
      throw error;
    });
    const fromPinned = pinned && find(pinned);
    if (pinned && fromPinned) return { route: fromPinned, catalogVersion: pinned.version };
  }
  throw new GatewayError("GATEWAY_ROUTE_PIN_UNAVAILABLE", {
    details: {
      modelCode: pin.modelCode,
      catalogVersion: pin.catalogVersion,
      liveCatalogVersion: live.version,
      upstreamId: pin.upstreamId,
      ...(pin.accountId ? { accountId: pin.accountId } : {}),
    },
  });
}

/**
 * Credential fields an official account of a known provider lacks (Kling
 * signs with `accessKey` + `secretKey`, Google Cloud Agent Platform with a
 * service account, the others with `apiKey`). A provider no shared
 * definition names (an `openai-compatible` endpoint, say) has no
 * requirement here; its routes still check their own.
 */
export function missingOfficialUpstreamCredentials(account: {
  providerId: string;
  upstreamId?: string;
  apiShape?: string | null;
  fields: readonly string[];
}): string[] {
  const upstreamId = account.upstreamId || account.providerId;
  const definitions = MODEL_PROVIDER_DEFINITIONS.filter(
    (definition) =>
      definition.providerId === account.providerId &&
      definition.upstreamId === upstreamId &&
      (!account.apiShape || definition.apiShape === account.apiShape),
  );
  if (definitions.length === 0) return [];
  const configured = new Set(account.fields);
  const missing = definitions.map((definition) => (definition.requiredCredentials ?? []).filter((field) => !configured.has(field)));
  // Several shapes of one upstream (OpenAI images and chat): the account serves whichever it satisfies.
  return missing.reduce((best, next) => (next.length < best.length ? next : best));
}
