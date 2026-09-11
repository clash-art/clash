import { z } from "zod";

import { MOCK_MODEL_CARDS, MODEL_CARDS, ModelCardSchema, normalizeModelId, type ModelCard, type ModelCardConsumer, type ModelKind, type ModelParameter, type ProviderAssetInput, type ProviderCredentialRequirements, type ProviderInputAdaptation, type ReferenceBinding } from "./models.js";
import { findCompatibleModels, type Modality } from "./model-capabilities.js";
import type { ExecutablePluginBinding } from "./executable-plugin.js";

const DynamicProviderIdSchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "Provider ecosystem ids must be lowercase plugin-safe identifiers.",
);

export const BuiltinModelUpstreamIdSchema = z.enum([
  "local",
  "mock",
  "fal",
  "bfl",
  "pika",
  "google-ai-studio",
  "google-agent-platform",
  "openai",
  "anthropic",
  "openrouter",
  "replicate",
  "kling",
  "minimax",
  "volcengine-modelark",
  "elevenlabs",
  "suno",
]);
export const ModelUpstreamIdSchema = DynamicProviderIdSchema;
export type ModelUpstreamId = z.infer<typeof ModelUpstreamIdSchema>;

export const BuiltinModelUpstreamApiShapeSchema = z.enum([
  "local-asr",
  "local-tts",
  "fal",
  "bfl",
  "pika",
  "pika-chat",
  "google-agent-platform",
  "google-ai-studio",
  "google-ai-studio-interactions",
  "openai-images",
  "openai-compatible",
  "anthropic-compatible",
  "replicate",
  "kling",
  "minimax",
  "modelark",
  "elevenlabs",
  "suno",
]);
export const ModelUpstreamApiShapeSchema = DynamicProviderIdSchema;
export type ModelUpstreamApiShape = z.infer<typeof ModelUpstreamApiShapeSchema>;

export const BuiltinProviderOAuthIdSchema = z.never();
export const ProviderOAuthIdSchema = DynamicProviderIdSchema;
export type ProviderOAuthId = z.infer<typeof ProviderOAuthIdSchema>;

export const BuiltinProviderAccountIdSchema = z.enum([
  "local",
  "official",
  "fal",
  "pika",
  "replicate",
  "kling",
  "minimax",
  "volcengine-modelark",
  "elevenlabs",
  "suno",
  "mock",
  "custom",
]);
export const ProviderAccountIdSchema = DynamicProviderIdSchema;
export type ProviderAccountId = z.infer<typeof ProviderAccountIdSchema>;

export interface ModelUpstreamRoute {
  /** Public model code stored by the app, e.g. "seedance-2-ref". */
  modelCode: string;
  kind: ModelKind;
  /** User-facing account bucket. `official` can still route to OpenAI/Google/etc. adapters. */
  providerId?: ProviderAccountId;
  /** Pins a user-defined model implementation to one concrete provider account. */
  accountId?: string;
  /** Optional account region/channel, e.g. official global vs domestic. */
  region?: "global" | "cn" | string;
  upstreamId: ModelUpstreamId;
  /** Upstream-native model/endpoint string. */
  upstreamModel: string;
  /** Wire protocol shape this adapter exposes. Mock intentionally keeps fal shape. */
  apiShape: ModelUpstreamApiShape;
  /** Lower numbers win unless user provider order overrides them. */
  priority: number;
  /** Higher numbers win when user/provider route weighting is configured. */
  weight?: number;
  requiredCredentials?: string[];
  credentialRequirements?: ProviderCredentialRequirements;
  requiredOAuth?: ProviderOAuthId[];
  /** Effective inline-reference semantics after applying the provider implementation override. */
  referenceBinding?: ReferenceBinding;
  /** Provider-wire input spellings applied only for this selected implementation. */
  inputAdaptation?: ProviderInputAdaptation;
  /** Asset delivery forms accepted by this exact Provider/model binding. */
  assetInputs?: ProviderAssetInput[];
  /** Provider-specific replacements for user-configurable candidates/ranges. */
  parameterOverrides?: ModelParameter[];
  /** Provider-specific defaults paired with parameterOverrides. */
  defaultParamOverrides?: Record<string, string | number | boolean>;
  /** Base Card parameters not implemented by this provider. */
  excludedParameterIds?: string[];
  /** Executable Plugin projector selected for this provider/model route. */
  projectorPluginId?: string;
  projectorExportId?: string;
  /** Exact active projector resolved by the Kernel for author-time Canvas pinning. */
  projectorBinding?: ExecutablePluginBinding;
  /** Executable Plugin that owns the provider's full execution lifecycle. */
  executorPluginId?: string;
  executorExportId?: string;
  /** Exact active executor resolved by the Kernel for author-time Canvas pinning. */
  executorBinding?: ExecutablePluginBinding;
}

export interface ModelProviderSupportedModel {
  modelCode: string;
  kind: ModelKind;
  upstreamModel: string;
  priority?: number;
  weight?: number;
}

export interface ModelProviderDefinition {
  providerId: ProviderAccountId;
  upstreamId: ModelUpstreamId;
  region?: "global" | "cn" | string;
  apiShape: ModelUpstreamApiShape;
  priority: number;
  weight?: number;
  requiredCredentials?: string[];
  credentialRequirements?: ProviderCredentialRequirements;
  requiredOAuth?: ProviderOAuthId[];
}

export interface UpstreamAvailability {
  upstreamId: ModelUpstreamId;
  enabled?: boolean;
  configuredCredentials?: string[];
  availableOAuth?: ProviderOAuthId[];
  /** Lower numbers win within this upstream. */
  priority?: number;
  /** Higher numbers win before provider order when set. */
  weight?: number;
}

export interface ProviderAccountAvailability {
  id?: string;
  providerId: ProviderAccountId;
  upstreamId?: ModelUpstreamId;
  apiShape?: ModelUpstreamApiShape;
  region?: string;
  label?: string;
  enabled?: boolean;
  configuredCredentials?: string[];
  availableOAuth?: ProviderOAuthId[];
  readToken?: string;
  /** When set, this account only serves the listed public model card ids. Undefined means all models declared by the provider. */
  supportedModelIds?: string[];
  /** Lower numbers win for a specific public model card id. */
  modelPriorities?: Record<string, number>;
  /** Lower numbers win within equal weights. */
  priority?: number;
  /** Higher numbers win before declaration order. */
  weight?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelUpstreamRouteQuery {
  modelCode: string;
  kind?: ModelKind;
  models?: readonly ModelCard[];
  configuredUpstreams?: UpstreamAvailability[];
  configuredProviders?: ProviderAccountAvailability[];
  /** Canonical Card parameters materially selected for this invocation. */
  requestedParameterIds?: readonly string[];
  /** Host-supplied proof that this exact route's adapter/binding is executable now. */
  isRouteExecutable?: (route: ModelUpstreamRoute) => boolean;
  allowMock?: boolean;
}

export const ModelProviderIdSchema = ModelUpstreamIdSchema;
export const ModelProviderApiShapeSchema = ModelUpstreamApiShapeSchema;
export type ModelProviderId = ModelUpstreamId;
export type ModelProviderApiShape = ModelUpstreamApiShape;
export type ModelProviderRoute = ModelUpstreamRoute;
export type ProviderAvailability = UpstreamAvailability;
export type ModelProviderRouteQuery = ModelUpstreamRouteQuery;
export type ModelCatalogTier = "available" | "configured-provider" | "all";

export interface ModelCatalogEntry {
  /** Host-installed local speech runtime readiness, when applicable. */
  runtimeReadiness?: {
    capability: "speech-to-text" | "text-to-speech";
    model: string;
    readiness: "ready" | "not-installed";
    executable: boolean;
    message?: string;
  };
  model: ModelCard;
  tier: ModelCatalogTier;
  routes: ModelUpstreamRoute[];
  selectedRoute: ModelUpstreamRoute | null;
  candidateProviders: ProviderAccountId[];
  /** Canonical controls unsupported by every provider account the user configured for this model. */
  unavailableParameterIds: string[];
  missingCredentials: string[];
  missingOAuth: ProviderOAuthId[];
}

export const ModelCardProviderBindingSchema = z.object({
  providerAccountId: z.string().trim().min(1),
  upstreamModel: z.string().trim().min(1),
});
export type ModelCardProviderBinding = z.infer<typeof ModelCardProviderBindingSchema>;

export const UserModelCardConfigSchema = z.object({
  modelId: z.string().trim().min(1),
  custom: z.boolean().default(false),
  name: z.string().trim().min(1).optional(),
  kind: z.literal("text").default("text"),
  description: z.string().trim().optional(),
  promptGuidance: z.string().trim().optional(),
  providerBindings: z.array(ModelCardProviderBindingSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type UserModelCardConfig = z.infer<typeof UserModelCardConfigSchema>;

function compatibleTextApiShape(
  provider: Pick<ProviderAccountAvailability, "apiShape" | "upstreamId">,
): "openai-compatible" | "anthropic-compatible" | null {
  if (provider.apiShape === "openai-compatible" || provider.apiShape === "anthropic-compatible") {
    return provider.apiShape;
  }
  if (provider.upstreamId === "openai") return "openai-compatible";
  if (provider.upstreamId === "anthropic") return "anthropic-compatible";
  return null;
}

function customTextModelCard(
  config: UserModelCardConfig,
  providers: readonly ProviderAccountAvailability[],
): ModelCard | null {
  if (!config.custom || !config.name || MODEL_CARDS.some((model) => model.id === config.modelId)) return null;
  const providerByAccountId = new Map(
    providers
      .filter((provider): provider is ProviderAccountAvailability & { id: string } => !!provider.id)
      .map((provider) => [provider.id, provider]),
  );
  const providerImplementations = config.providerBindings.flatMap((binding, index) => {
    const provider = providerByAccountId.get(binding.providerAccountId);
    const apiShape = provider ? compatibleTextApiShape(provider) : null;
    if (!provider || !provider.upstreamId || !apiShape) return [];
    return [{
      providerId: provider.providerId,
      accountId: provider.id,
      upstreamId: provider.upstreamId,
      ...(provider.region ? { region: provider.region } : {}),
      upstreamModel: binding.upstreamModel,
      apiShape,
      priority: (index + 1) * 10,
      requiredCredentials: provider.providerId === "custom"
        ? [API_KEY_CREDENTIAL, BASE_URL_CREDENTIAL]
        : [API_KEY_CREDENTIAL],
    }];
  });
  if (providerImplementations.length === 0) return null;
  const availableProviders = [...new Set(providerImplementations.map((implementation) => implementation.providerId))];
  return ModelCardSchema.parse({
    id: config.modelId,
    name: config.name,
    provider: "Custom",
    custom: true,
    kind: "text",
    description: config.description,
    promptGuidance: config.promptGuidance,
    parameters: [
      {
        id: "system_prompt",
        label: "System prompt",
        type: "text",
        placeholder: "Optional instructions for tone, format, or role",
        defaultValue: "",
      },
    ],
    defaultParams: { system_prompt: "" },
    defaultAspectRatio: "1:1",
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 20 } },
      promptModalities: ["text", "image"],
      referenceBinding: {
        type: "ordered-content-parts",
        usesRoles: false,
        modalityScopedIndexes: false,
      },
    },
    availableProviders,
    defaultProvider: availableProviders[0],
    providerImplementations,
    maxRuntimeMs: 5 * 60 * 1000,
  });
}

export function buildEffectiveModelCards(options: {
  configs?: readonly UserModelCardConfig[];
  providers?: readonly ProviderAccountAvailability[];
  baseModels?: readonly ModelCard[];
} = {}): ModelCard[] {
  const configs = z.array(UserModelCardConfigSchema).parse(options.configs ?? []);
  const baseModels = options.baseModels ?? MODEL_CARDS;
  const configByModelId = new Map(configs.map((config) => [config.modelId, config]));
  const builtInModels = baseModels.map((model) => {
    const config = configByModelId.get(model.id);
    if (!config || config.custom) return model;
    return ModelCardSchema.parse({
      ...model,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.promptGuidance !== undefined ? { promptGuidance: config.promptGuidance } : {}),
    });
  });
  const customModels = configs.flatMap((config) => {
    const model = customTextModelCard(config, options.providers ?? []);
    return model ? [model] : [];
  });
  return [...builtInModels, ...customModels];
}

const API_KEY_CREDENTIAL = "apiKey";
const BASE_URL_CREDENTIAL = "baseUrl";
const ACCESS_KEY_CREDENTIAL = "accessKey";
const SECRET_KEY_CREDENTIAL = "secretKey";
const VERTEX_CREDENTIAL = "serviceAccountKey";

function falMock(
  modelCode: string,
  kind: ModelKind,
  upstreamModel: string,
): ModelProviderRoute {
  return {
    modelCode,
    kind,
    providerId: "mock",
    upstreamId: "mock",
    upstreamModel,
    apiShape: "fal",
    priority: 1,
  };
}

const FAL_IMAGE_ROUTES: Array<[string, string]> = [
  ["flux-schnell", "fal-ai/flux/schnell"],
  ["flux-dev", "fal-ai/flux/dev"],
  ["gpt-image-2", "openai/gpt-image-2"],
  ["nano-banana-2", "fal-ai/nano-banana-2"],
  ["seedream-4.5", "fal-ai/bytedance/seedream/v4.5/text-to-image"],
  ["recraft-v4", "fal-ai/recraft/v4/pro/text-to-image"],
  ["flux-2-pro", "fal-ai/flux-2-pro"],
];

const FAL_VIDEO_ROUTES: Array<[string, string]> = [
  ["sora-2", "fal-ai/sora-2/text-to-video"],
  ["kling-3", "fal-ai/kling-video/v3/pro/image-to-video"],
  ["seedance-2-startend", "bytedance/seedance-2.0/image-to-video"],
  ["seedance-2-ref", "bytedance/seedance-2.0/reference-to-video"],
];

const GOOGLE_IMAGE_ROUTES: Array<[string, string]> = [
  ["nano-banana-2", "gemini-3.1-flash-image"],
  ["nano-banana-pro", "gemini-3-pro-image"],
];

const GOOGLE_VIDEO_ROUTES: Array<[string, string]> = [
  ["veo-3.1", "veo-3.1-generate-001"],
  ["veo-3.1-startend", "veo-3.1-generate-001"],
  ["veo-3.1-fast", "veo-3.1-fast-generate-001"],
  ["veo-3.1-fast-startend", "veo-3.1-fast-generate-001"],
];

function routesFromModelCard(model: ModelCard): ModelUpstreamRoute[] {
  return (model.providerImplementations ?? []).map((implementation) => ({
    modelCode: model.id,
    kind: model.kind,
    providerId: implementation.providerId,
    ...(implementation.accountId ? { accountId: implementation.accountId } : {}),
    ...(implementation.region ? { region: implementation.region } : {}),
    upstreamId: ModelUpstreamIdSchema.parse(implementation.upstreamId),
    upstreamModel: implementation.upstreamModel,
    apiShape: ModelUpstreamApiShapeSchema.parse(implementation.apiShape),
    priority: implementation.priority ?? 100,
    ...(implementation.weight !== undefined ? { weight: implementation.weight } : {}),
    ...(implementation.requiredCredentials?.length ? { requiredCredentials: [...implementation.requiredCredentials] } : {}),
    ...(implementation.credentialRequirements ? {
      credentialRequirements: {
        ...implementation.credentialRequirements,
        anyOf: implementation.credentialRequirements.anyOf.map((credentials) => [...credentials]),
      },
    } : {}),
    ...(implementation.requiredOAuth?.length
      ? { requiredOAuth: implementation.requiredOAuth.map((provider) => ProviderOAuthIdSchema.parse(provider)) }
      : {}),
    ...((implementation.referenceBinding ?? model.input.referenceBinding)
      ? { referenceBinding: implementation.referenceBinding ?? model.input.referenceBinding }
      : {}),
    ...(implementation.inputAdaptation ? {
      inputAdaptation: {
        ...(implementation.inputAdaptation.audio ? {
          audio: {
            mimeAliases: { ...implementation.inputAdaptation.audio.mimeAliases },
          },
        } : {}),
      },
    } : {}),
    ...(implementation.assetInputs?.length ? {
      assetInputs: implementation.assetInputs.map((input) => ({
        match: {
          ...(input.match.kinds ? { kinds: [...input.match.kinds] } : {}),
          ...(input.match.slots ? { slots: [...input.match.slots] } : {}),
        },
        representations: [...input.representations],
        ...(input.mediaTypes ? { mediaTypes: [...input.mediaTypes] } : {}),
      })),
    } : {}),
    ...(implementation.parameterOverrides?.length
      ? { parameterOverrides: implementation.parameterOverrides.map((parameter) => ({ ...parameter })) }
      : {}),
    ...(implementation.defaultParamOverrides
      ? { defaultParamOverrides: { ...implementation.defaultParamOverrides } }
      : {}),
    ...(implementation.excludedParameterIds?.length
      ? { excludedParameterIds: [...implementation.excludedParameterIds] }
      : {}),
    ...(implementation.projectorPluginId ? { projectorPluginId: implementation.projectorPluginId } : {}),
    ...(implementation.projectorExportId ? { projectorExportId: implementation.projectorExportId } : {}),
    ...(implementation.executorPluginId ? { executorPluginId: implementation.executorPluginId } : {}),
    ...(implementation.executorExportId ? { executorExportId: implementation.executorExportId } : {}),
  }));
}

function routesFromModelCards(models: readonly ModelCard[]): ModelUpstreamRoute[] {
  return models.flatMap(routesFromModelCard);
}

export function listDeclaredModelUpstreamRoutes(
  models: readonly ModelCard[],
): ModelUpstreamRoute[] {
  return routesFromModelCards(models);
}

export const MODEL_PROVIDER_DEFINITIONS: ModelProviderDefinition[] = [
  {
    providerId: "local",
    upstreamId: "local",
    apiShape: "local-asr",
    priority: 1,
  },
  {
    providerId: "local",
    upstreamId: "local",
    apiShape: "local-tts",
    priority: 1,
  },
  {
    providerId: "official",
    upstreamId: "bfl",
    region: "global",
    apiShape: "bfl",
    priority: 10,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "replicate",
    upstreamId: "replicate",
    apiShape: "replicate",
    priority: 25,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "official",
    upstreamId: "google-ai-studio",
    region: "global",
    apiShape: "google-ai-studio",
    priority: 10,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "official",
    upstreamId: "google-agent-platform",
    region: "global",
    apiShape: "google-agent-platform",
    priority: 10,
    requiredCredentials: [VERTEX_CREDENTIAL],
  },
  {
    providerId: "official",
    upstreamId: "openai",
    region: "global",
    apiShape: "openai-images",
    priority: 10,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "official",
    upstreamId: "openai",
    region: "global",
    apiShape: "openai-compatible",
    priority: 10,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "official",
    upstreamId: "anthropic",
    region: "global",
    apiShape: "anthropic-compatible",
    priority: 10,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "kling",
    upstreamId: "kling",
    apiShape: "kling",
    priority: 8,
    requiredCredentials: [ACCESS_KEY_CREDENTIAL, SECRET_KEY_CREDENTIAL],
  },
  {
    providerId: "volcengine-modelark",
    upstreamId: "volcengine-modelark",
    apiShape: "modelark",
    priority: 9,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "minimax",
    upstreamId: "minimax",
    apiShape: "minimax",
    priority: 8,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "elevenlabs",
    upstreamId: "elevenlabs",
    apiShape: "elevenlabs",
    priority: 8,
    requiredCredentials: [API_KEY_CREDENTIAL],
  },
  {
    providerId: "suno",
    upstreamId: "suno",
    apiShape: "suno",
    priority: 8,
    requiredCredentials: [API_KEY_CREDENTIAL, "callbackUrl"],
  },
];

const MODEL_DECLARED_ROUTES = routesFromModelCards(MODEL_CARDS);
const MOCK_DECLARED_ROUTES = routesFromModelCards(MOCK_MODEL_CARDS);

const MOCK_ROUTES: ModelUpstreamRoute[] = [
  ...FAL_IMAGE_ROUTES.map(([modelCode, upstreamModel]) => falMock(modelCode, "image", upstreamModel)),
  ...FAL_VIDEO_ROUTES.map(([modelCode, upstreamModel]) => falMock(modelCode, "video", upstreamModel)),
  ...GOOGLE_IMAGE_ROUTES.map(([modelCode]) => falMock(modelCode, "image", "fal-ai/nano-banana-2")),
  ...GOOGLE_VIDEO_ROUTES.map(([modelCode]) => falMock(modelCode, "video", modelCode.includes("fast") ? "fal-ai/veo3/fast" : "fal-ai/veo3")),
  falMock("minimax-tts", "audio", "fal-ai/minimax/speech-02-hd"),
  falMock("elevenlabs-tts", "audio", "fal-ai/minimax/speech-02-hd"),
];

export const MODEL_UPSTREAM_ROUTES: ModelUpstreamRoute[] = [
  ...MODEL_DECLARED_ROUTES,
  ...MOCK_DECLARED_ROUTES,
  ...MOCK_ROUTES,
];

export const MODEL_PROVIDER_ROUTES = MODEL_UPSTREAM_ROUTES;

function providerIdForRoute(route: ModelUpstreamRoute): ProviderAccountId {
  if (route.providerId) return route.providerId;
  if (route.upstreamId === "local") return "local";
  if (
    route.upstreamId === "openai" ||
    route.upstreamId === "google-ai-studio" ||
    route.upstreamId === "google-agent-platform" ||
    route.upstreamId === "anthropic"
  ) return "official";
  if (route.upstreamId === "fal" || route.upstreamId === "pika" || route.upstreamId === "replicate" || route.upstreamId === "mock") {
    return route.upstreamId;
  }
  return "custom";
}

export interface ProviderModelSupport {
  providerId: ProviderAccountId;
  upstreamId: ModelUpstreamId;
  region?: string;
  models: Array<{
    id: string;
    aliases: string[];
    name: string;
    kind: ModelKind;
    upstreamModel: string;
    apiShape: ModelUpstreamApiShape;
    requiredCredentials: string[];
    credentialRequirements?: ProviderCredentialRequirements;
    requiredOAuth: ProviderOAuthId[];
  }>;
  requiredCredentials: string[];
  requiredOAuth: ProviderOAuthId[];
}

export interface InvalidProviderModelFilter {
  providerId: ProviderAccountId;
  upstreamId?: ModelUpstreamId;
  region?: string;
  unsupportedModelIds: string[];
}

export function listProviderModelSupport(options: {
  models?: readonly ModelCard[];
  includeMock?: boolean;
} = {}): ProviderModelSupport[] {
  const includeMock = options.includeMock ?? false;
  const models = options.models ?? (includeMock ? [...MODEL_CARDS, ...MOCK_MODEL_CARDS] : MODEL_CARDS);
  const modelById = new Map(models.map((model) => [model.id, model]));
  const modelDeclaredRoutes = routesFromModelCards(models);
  const routes = modelDeclaredRoutes.length > 0
    ? includeMock
      ? [...modelDeclaredRoutes, ...MOCK_ROUTES]
      : modelDeclaredRoutes
    : MODEL_UPSTREAM_ROUTES;
  const rows = new Map<string, ProviderModelSupport>();
  for (const route of routes) {
    if (!includeMock && route.upstreamId === "mock") continue;
    const model = modelById.get(route.modelCode);
    if (!model) continue;
    const providerId = providerIdForRoute(route);
    const key = [providerId, route.upstreamId, route.region ?? ""].join(":");
    const row = rows.get(key) ?? {
      providerId,
      upstreamId: route.upstreamId,
      ...(route.region ? { region: route.region } : {}),
      models: [],
      requiredCredentials: [],
      requiredOAuth: [],
    };
    row.models.push({
      id: model.id,
      aliases: [...model.aliases],
      name: model.name,
      kind: route.kind,
      upstreamModel: route.upstreamModel,
      apiShape: route.apiShape,
      requiredCredentials: [...(route.requiredCredentials ?? [])],
      ...(route.credentialRequirements ? {
        credentialRequirements: {
          ...route.credentialRequirements,
          anyOf: route.credentialRequirements.anyOf.map((credentials) => [...credentials]),
        },
      } : {}),
      requiredOAuth: [...(route.requiredOAuth ?? [])],
    });
    row.requiredCredentials = [...new Set([...row.requiredCredentials, ...(route.requiredCredentials ?? [])])].sort();
    row.requiredOAuth = [...new Set([...row.requiredOAuth, ...(route.requiredOAuth ?? [])])].sort();
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) =>
    [a.providerId, a.upstreamId, a.region ?? ""].join(":").localeCompare([b.providerId, b.upstreamId, b.region ?? ""].join(":")),
  );
}

export function unsupportedProviderModelFilterIds(
  provider: Pick<ProviderAccountAvailability, "providerId" | "upstreamId" | "region" | "supportedModelIds">,
  options: { models?: readonly ModelCard[]; includeMock?: boolean } = {},
): string[] {
  if (!provider.supportedModelIds?.length) return [];
  const support = listProviderModelSupport({
    models: options.models,
    includeMock: options.includeMock ?? true,
  }).find((row) =>
    row.providerId === provider.providerId &&
    (!provider.upstreamId || row.upstreamId === provider.upstreamId) &&
    (row.region ?? "") === (provider.region ?? "")
  );
  if (!support) return [...provider.supportedModelIds];
  const supported = new Set(support.models.map((model) => model.id));
  return provider.supportedModelIds.filter((id) => !supported.has(normalizeModelId(id) ?? id.trim()));
}

export function invalidProviderModelFilters(
  providers: readonly Pick<ProviderAccountAvailability, "providerId" | "upstreamId" | "region" | "supportedModelIds">[],
  options: { models?: readonly ModelCard[]; includeMock?: boolean } = {},
): InvalidProviderModelFilter[] {
  return providers.flatMap((provider) => {
    const unsupportedModelIds = unsupportedProviderModelFilterIds(provider, options);
    if (unsupportedModelIds.length === 0) return [];
    return [{
      providerId: provider.providerId,
      ...(provider.upstreamId ? { upstreamId: provider.upstreamId } : {}),
      ...(provider.region ? { region: provider.region } : {}),
      unsupportedModelIds,
    }];
  });
}

function upstreamIndex(configuredUpstreams: UpstreamAvailability[] | undefined, upstreamId: ModelUpstreamId): number {
  if (!configuredUpstreams) return Number.POSITIVE_INFINITY;
  const index = configuredUpstreams.findIndex((upstream) => upstream.upstreamId === upstreamId);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

function upstreamConfig(
  configuredUpstreams: UpstreamAvailability[] | undefined,
  upstreamId: ModelUpstreamId,
): UpstreamAvailability | undefined {
  return configuredUpstreams?.find((upstream) => upstream.upstreamId === upstreamId);
}

function matchesProviderAccount(route: ModelUpstreamRoute, provider: ProviderAccountAvailability): boolean {
  if (provider.providerId !== providerIdForRoute(route)) return false;
  if (route.accountId && provider.id !== route.accountId) return false;
  if (provider.upstreamId && provider.upstreamId !== route.upstreamId) return false;
  if (provider.region && route.region && provider.region !== route.region) return false;
  if (
    provider.supportedModelIds?.length &&
    !provider.supportedModelIds
      .map((modelId) => normalizeModelId(modelId) ?? modelId.trim())
      .includes(route.modelCode)
  ) return false;
  return true;
}

type ProviderAccountCandidate = {
  provider: ProviderAccountAvailability;
  index: number;
};

function providerCandidates(
  configuredProviders: ProviderAccountAvailability[] | undefined,
  route: ModelUpstreamRoute,
): ProviderAccountCandidate[] {
  return (configuredProviders ?? [])
    .map((provider, index) => ({ provider, index }))
    .filter((candidate) => matchesProviderAccount(route, candidate.provider));
}

function compareProviderCandidates(a: ProviderAccountCandidate, b: ProviderAccountCandidate): number {
  const priority = (a.provider.priority ?? 1000) - (b.provider.priority ?? 1000);
  if (priority !== 0) return priority;
  const weight = (b.provider.weight ?? 0) - (a.provider.weight ?? 0);
  if (weight !== 0) return weight;
  return a.index - b.index;
}

function compareProviderCandidatesForModel(
  a: ProviderAccountCandidate,
  b: ProviderAccountCandidate,
  modelCode: string,
): number {
  const aModelPriority = modelPriority(a.provider, modelCode);
  const bModelPriority = modelPriority(b.provider, modelCode);
  if (aModelPriority !== undefined || bModelPriority !== undefined) {
    const priority = (aModelPriority ?? Number.POSITIVE_INFINITY) - (bModelPriority ?? Number.POSITIVE_INFINITY);
    if (priority !== 0) return priority;
  }
  return compareProviderCandidates(a, b);
}

function canServeRoute(route: ModelUpstreamRoute, provider: ProviderAccountAvailability): boolean {
  return provider.enabled !== false && modelRouteCredentialsSatisfied(route, provider) && hasRequiredOAuth(route, provider);
}

function providerCandidate(
  configuredProviders: ProviderAccountAvailability[] | undefined,
  route: ModelUpstreamRoute,
): ProviderAccountCandidate | undefined {
  const candidates = providerCandidates(configuredProviders, route);
  if (!candidates.length) return undefined;
  const compare = (a: ProviderAccountCandidate, b: ProviderAccountCandidate) =>
    compareProviderCandidatesForModel(a, b, route.modelCode);
  const runnable = candidates
    .filter((candidate) => canServeRoute(route, candidate.provider))
    .sort(compare);
  if (runnable[0]) return runnable[0];
  const enabled = candidates
    .filter((candidate) => candidate.provider.enabled !== false)
    .sort(compare);
  if (enabled[0]) return enabled[0];
  return candidates.sort(compare)[0];
}

function providerIndex(configuredProviders: ProviderAccountAvailability[] | undefined, route: ModelUpstreamRoute): number {
  return providerCandidate(configuredProviders, route)?.index ?? Number.POSITIVE_INFINITY;
}

function providerConfig(
  configuredProviders: ProviderAccountAvailability[] | undefined,
  route: ModelUpstreamRoute,
): ProviderAccountAvailability | undefined {
  return providerCandidate(configuredProviders, route)?.provider;
}

function modelPriority(
  config: ProviderAccountAvailability | UpstreamAvailability | undefined,
  modelCode: string,
): number | undefined {
  if (!config || !("modelPriorities" in config)) return undefined;
  const priorities = config.modelPriorities ?? {};
  const priority = priorities[modelCode] ?? Object.entries(priorities)
    .find(([candidate]) => (normalizeModelId(candidate) ?? candidate.trim()) === modelCode)?.[1];
  return typeof priority === "number" && Number.isFinite(priority) ? priority : undefined;
}

function modelPriorityForRoute(
  query: Pick<ModelUpstreamRouteQuery, "configuredProviders" | "configuredUpstreams">,
  route: ModelUpstreamRoute,
  modelCode: string,
): number | undefined {
  if (query.configuredProviders) {
    const priorities = providerCandidates(query.configuredProviders, route)
      .map((candidate) => modelPriority(candidate.provider, modelCode))
      .filter((priority): priority is number => priority !== undefined);
    return priorities.length ? Math.min(...priorities) : undefined;
  }
  return modelPriority(upstreamConfig(query.configuredUpstreams, route.upstreamId), modelCode);
}

function configForRoute(
  query: Pick<ModelUpstreamRouteQuery, "configuredProviders" | "configuredUpstreams">,
  route: ModelUpstreamRoute,
): ProviderAccountAvailability | UpstreamAvailability | undefined {
  if (query.configuredProviders) return providerConfig(query.configuredProviders, route);
  return upstreamConfig(query.configuredUpstreams, route.upstreamId);
}

export function missingModelRouteCredentials(
  route: Pick<ModelUpstreamRoute, "requiredCredentials" | "credentialRequirements">,
  config: ProviderAccountAvailability | UpstreamAvailability | undefined,
): string[] {
  if (!route.requiredCredentials?.length && !route.credentialRequirements) return [];
  if (!config) return [];
  const configured = new Set(config.configuredCredentials ?? []);
  const commonMissing = (route.requiredCredentials ?? [])
    .filter((credential) => !configured.has(credential));
  const alternatives = route.credentialRequirements?.anyOf;
  if (!alternatives?.length) return commonMissing;
  const alternativeChecks = alternatives.map((credentials) => ({
    missing: credentials.filter((credential) => !configured.has(credential)),
    matched: credentials.filter((credential) => configured.has(credential)).length,
  }));
  if (alternativeChecks.some((check) => check.missing.length === 0)) return commonMissing;
  const nearest = [...alternativeChecks].sort((a, b) =>
    a.missing.length - b.missing.length || b.matched - a.matched
  )[0]?.missing ?? [];
  return [...new Set([...commonMissing, ...nearest])];
}

export function modelRouteCredentialsSatisfied(
  route: Pick<ModelUpstreamRoute, "requiredCredentials" | "credentialRequirements">,
  config: ProviderAccountAvailability | UpstreamAvailability | undefined,
): boolean {
  if (!route.requiredCredentials?.length && !route.credentialRequirements) return true;
  if (!config) return true;
  if (missingModelRouteCredentials(route, config).length > 0) return false;
  const alternatives = route.credentialRequirements?.anyOf;
  if (!alternatives?.length) return true;
  const configured = new Set(config.configuredCredentials ?? []);
  const satisfied = alternatives.filter((credentials) =>
    credentials.every((credential) => configured.has(credential))
  );
  return route.credentialRequirements?.exclusive ? satisfied.length === 1 : satisfied.length > 0;
}

function missingRequiredOAuth(
  route: ModelUpstreamRoute,
  config: ProviderAccountAvailability | UpstreamAvailability | undefined,
): ProviderOAuthId[] {
  if (!route.requiredOAuth?.length) return [];
  if (!config) return [];
  if (config.availableOAuth === undefined) return [...route.requiredOAuth];
  return route.requiredOAuth.filter((provider) => !config.availableOAuth?.includes(provider));
}

function hasRequiredOAuth(
  route: ModelUpstreamRoute,
  config: ProviderAccountAvailability | UpstreamAvailability | undefined,
): boolean {
  if (!route.requiredOAuth?.length) return true;
  if (!config) return true;
  return missingRequiredOAuth(route, config).length === 0;
}

function isEnabled(route: ModelUpstreamRoute, query: ModelUpstreamRouteQuery): boolean {
  if (query.isRouteExecutable && !query.isRouteExecutable(route)) return false;
  if (route.upstreamId === "local") return true;
  if (route.upstreamId === "mock" && !query.allowMock) return false;
  if (!query.configuredUpstreams && !query.configuredProviders) return true;
  const config = configForRoute(query, route);
  if (!config || config.enabled === false) return false;
  return modelRouteCredentialsSatisfied(route, config) && hasRequiredOAuth(route, config);
}

function candidateRoutes(query: ModelUpstreamRouteQuery): ModelUpstreamRoute[] {
  const modelCode = normalizeModelId(query.modelCode) ?? query.modelCode.trim();
  const routes = query.models
    ? [
        ...routesFromModelCards(query.models),
        ...(query.allowMock ? MOCK_ROUTES : []),
      ]
    : MODEL_UPSTREAM_ROUTES;
  return routes.filter(
    (route) =>
      route.modelCode === modelCode &&
      (!query.kind || route.kind === query.kind) &&
      modelRouteSupportsParameters(route, query.requestedParameterIds ?? []),
  );
}

export function activeModelParameterIds(
  modelParams: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(modelParams ?? {}).flatMap(([parameterId, value]) => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string" && value.trim().length === 0) return [];
    return [parameterId];
  });
}

export function modelRouteSupportsParameters(
  route: Pick<ModelUpstreamRoute, "excludedParameterIds">,
  requestedParameterIds: readonly string[],
): boolean {
  if (!route.excludedParameterIds?.length || requestedParameterIds.length === 0) return true;
  const excluded = new Set(route.excludedParameterIds);
  return requestedParameterIds.every((parameterId) => !excluded.has(parameterId));
}

export function listModelUpstreamRoutes(query: ModelUpstreamRouteQuery): ModelUpstreamRoute[] {
  const candidates = candidateRoutes(query);
  const modelCode = normalizeModelId(query.modelCode) ?? query.modelCode.trim();

  const sorted = candidates
    .filter((route) => isEnabled(route, query))
    .sort((a, b) => {
      const aConfig = configForRoute(query, a);
      const bConfig = configForRoute(query, b);
      const aModelPriority = modelPriorityForRoute(query, a, modelCode);
      const bModelPriority = modelPriorityForRoute(query, b, modelCode);
      if (aModelPriority !== undefined || bModelPriority !== undefined) {
        const priority = (aModelPriority ?? Number.POSITIVE_INFINITY) - (bModelPriority ?? Number.POSITIVE_INFINITY);
        if (priority !== 0) return priority;
      }
      const aWeight = (aConfig?.weight ?? 0) + (a.weight ?? 0);
      const bWeight = (bConfig?.weight ?? 0) + (b.weight ?? 0);
      if (aWeight !== bWeight) return bWeight - aWeight;
      if (aConfig?.priority !== undefined || bConfig?.priority !== undefined) {
        const priority =
          (aConfig?.priority ?? Number.POSITIVE_INFINITY) -
          (bConfig?.priority ?? Number.POSITIVE_INFINITY);
        if (priority !== 0) return priority;
      }
      const aIndex = query.configuredProviders
        ? providerIndex(query.configuredProviders, a)
        : upstreamIndex(query.configuredUpstreams, a.upstreamId);
      const bIndex = query.configuredProviders
        ? providerIndex(query.configuredProviders, b)
        : upstreamIndex(query.configuredUpstreams, b.upstreamId);
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.priority - b.priority;
    });
  if (!query.configuredProviders) return sorted;
  return sorted.map((route) => {
    const account = providerConfig(query.configuredProviders, route);
    return account?.id && !route.accountId
      ? { ...route, accountId: account.id }
      : route;
  });
}

export function resolveModelUpstreamRoute(query: ModelUpstreamRouteQuery): ModelUpstreamRoute | null {
  return listModelUpstreamRoutes(query)[0] ?? null;
}

/**
 * Identity of one exact Provider implementation frozen at selection time.
 * A Card keeps all of its 1:N providerImplementations; a pin only names which
 * one a specific Run must execute so validation and lineage cannot diverge.
 */
export interface FrozenModelRoutePin {
  providerId?: string;
  accountId?: string;
  region?: string;
  upstreamId: string;
  upstreamModel: string;
  apiShape: string;
  executorPluginId?: string;
  executorExportId?: string;
}

/** True when a currently listable route is the exact frozen implementation. */
export function matchesFrozenModelRoutePin(
  route: ModelUpstreamRoute,
  pin: FrozenModelRoutePin,
): boolean {
  const optionalMatches = (
    pinned: string | undefined,
    current: string | undefined,
  ) => pinned === undefined || pinned === current;
  return (
    route.upstreamId === pin.upstreamId &&
    route.upstreamModel === pin.upstreamModel &&
    route.apiShape === pin.apiShape &&
    optionalMatches(pin.providerId, route.providerId) &&
    optionalMatches(pin.accountId, route.accountId) &&
    optionalMatches(pin.region, route.region) &&
    optionalMatches(pin.executorPluginId, route.executorPluginId) &&
    optionalMatches(pin.executorExportId, route.executorExportId)
  );
}

/** Resolve one exact frozen implementation among the currently available routes. */
export function resolvePinnedModelUpstreamRoute(
  query: ModelUpstreamRouteQuery,
  pin: FrozenModelRoutePin,
): ModelUpstreamRoute | null {
  return (
    listModelUpstreamRoutes(query).find((route) =>
      matchesFrozenModelRoutePin(route, pin),
    ) ?? null
  );
}

/** Compose the public model contract with the selected provider's deltas.
 * This keeps common fields shared while ensuring the UI and backend validate
 * the exact candidates the selected provider can receive. */
export function applyModelProviderImplementation(
  model: ModelCard,
  route: ModelUpstreamRoute | null | undefined,
): ModelCard {
  if (!route) return model;
  const { providerImplementations: _providerImplementations, ...canonicalCard } = model;
  const excludedParameterIds = new Set(route.excludedParameterIds ?? []);
  const overrides = new Map((route.parameterOverrides ?? []).map((parameter) => [parameter.id, parameter]));
  const parameterIds = new Set(model.parameters.map((parameter) => parameter.id));
  const parameters = model.parameters
    .filter((parameter) => !excludedParameterIds.has(parameter.id))
    .map((parameter) => overrides.get(parameter.id) ?? parameter);
  for (const parameter of route.parameterOverrides ?? []) {
    if (!parameterIds.has(parameter.id) && !excludedParameterIds.has(parameter.id)) parameters.push(parameter);
  }
  const defaultParams = Object.fromEntries(
    Object.entries(model.defaultParams).filter(([parameterId]) => !excludedParameterIds.has(parameterId)),
  );
  return ModelCardSchema.parse({
    ...canonicalCard,
    parameters,
    defaultParams: { ...defaultParams, ...(route.defaultParamOverrides ?? {}) },
    input: route.referenceBinding
      ? { ...model.input, referenceBinding: route.referenceBinding }
      : model.input,
  });
}

/** Apply provider-specific candidates/defaults without shrinking the canonical product Card. */
function applyModelProviderPresentation(
  model: ModelCard,
  route: ModelUpstreamRoute | null | undefined,
): ModelCard {
  if (!route) return model;
  const overrides = new Map((route.parameterOverrides ?? []).map((parameter) => [parameter.id, parameter]));
  return ModelCardSchema.parse({
    ...model,
    parameters: model.parameters.map((parameter) => overrides.get(parameter.id) ?? parameter),
    defaultParams: { ...model.defaultParams, ...(route.defaultParamOverrides ?? {}) },
    input: route.referenceBinding
      ? { ...model.input, referenceBinding: route.referenceBinding }
      : model.input,
  });
}

function uniqueProviderIds(routes: ModelUpstreamRoute[]): ProviderAccountId[] {
  return [...new Set(routes.map(providerIdForRoute))];
}

function shouldAllowMockCatalogRoutes(options: {
  configuredProviders?: ProviderAccountAvailability[];
  configuredUpstreams?: UpstreamAvailability[];
  allowMock?: boolean;
}): boolean {
  if (options.allowMock) return true;
  if (options.configuredProviders?.some((provider) => provider.providerId === "mock" && provider.enabled !== false)) return true;
  return !!options.configuredUpstreams?.some((upstream) => upstream.upstreamId === "mock" && upstream.enabled !== false);
}

export function listModelCatalogEntries(options: {
  models?: readonly ModelCard[];
  configuredProviders?: ProviderAccountAvailability[];
  configuredUpstreams?: UpstreamAvailability[];
  isRouteExecutable?: (route: ModelUpstreamRoute) => boolean;
  allowMock?: boolean;
} = {}): ModelCatalogEntry[] {
  const allowMock = shouldAllowMockCatalogRoutes(options);
  const models = options.models ?? (allowMock ? [...MODEL_CARDS, ...MOCK_MODEL_CARDS] : MODEL_CARDS);
  return models.map((model) => {
    const query: ModelUpstreamRouteQuery = {
      modelCode: model.id,
      kind: model.kind,
      models,
      configuredProviders: options.configuredProviders,
      configuredUpstreams: options.configuredUpstreams,
      isRouteExecutable: options.isRouteExecutable,
      allowMock,
    };
    const allRoutes = candidateRoutes({ modelCode: model.id, kind: model.kind, models, allowMock });
    const routes = listModelUpstreamRoutes(query);
    const selectedRoute = routes[0] ?? null;
    const configuredCandidates = allRoutes.filter((route) => {
      const config = configForRoute(query, route);
      return !!config && config.enabled !== false;
    });
    const missingCredentials = [
      ...new Set(configuredCandidates.flatMap((route) => missingModelRouteCredentials(route, configForRoute(query, route)))),
    ];
    const missingOAuth = [
      ...new Set(configuredCandidates.flatMap((route) => missingRequiredOAuth(route, configForRoute(query, route)))),
    ];
    const unavailableParameterIds = configuredCandidates.length === 0
      ? []
      : model.parameters
          .filter((parameter) => configuredCandidates.every((route) =>
            route.excludedParameterIds?.includes(parameter.id) === true))
          .map((parameter) => parameter.id);
    const tier: ModelCatalogTier = selectedRoute
      ? "available"
      : configuredCandidates.length > 0
        ? "configured-provider"
        : "all";
    return {
      model: applyModelProviderPresentation(model, selectedRoute),
      tier,
      routes,
      selectedRoute,
      candidateProviders: uniqueProviderIds(configuredCandidates.length ? configuredCandidates : allRoutes),
      unavailableParameterIds,
      missingCredentials,
      missingOAuth,
    };
  });
}

export interface UserEnabledCanvasModelIdsQuery {
  models?: readonly ModelCard[];
  configuredProviders?: ProviderAccountAvailability[];
  allowMock?: boolean;
}

/**
 * Models the user has enabled for canvas authoring.
 *
 * This intentionally ignores credentials/OAuth readiness: those gate Run,
 * while canvas model visibility follows provider-account enablement and its
 * `supportedModelIds` selection.
 */
export function listUserEnabledCanvasModelIds(
  options: UserEnabledCanvasModelIdsQuery = {},
): string[] {
  const models = options.models ?? MODEL_CARDS;
  const providers = (options.configuredProviders ?? []).filter((provider) => provider.enabled !== false);
  if (providers.length === 0) {
    return models.map((model) => model.id);
  }

  const allowMock = options.allowMock ?? shouldAllowMockCatalogRoutes({
    configuredProviders: options.configuredProviders,
  });
  const declaredRoutes = routesFromModelCards(models);
  const routes = allowMock ? [...declaredRoutes, ...MOCK_ROUTES] : declaredRoutes;
  const enabledModelIds = new Set(routes
    .filter((route) => providers.some((provider) => matchesProviderAccount(route, provider)))
    .map((route) => route.modelCode));

  return models.filter((model) => enabledModelIds.has(model.id)).map((model) => model.id);
}

export interface CompatibleModelCatalogQuery {
  outputKind: ModelKind;
  sourceKind?: Modality | string;
  referenceCounts?: Partial<Record<Modality, number>>;
  enforceMinimums?: boolean;
  models?: readonly ModelCard[];
  configuredProviders?: ProviderAccountAvailability[];
  configuredUpstreams?: UpstreamAvailability[];
  isRouteExecutable?: (route: ModelUpstreamRoute) => boolean;
  allowMock?: boolean;
}

export interface ConsumerModelCatalogQuery extends CompatibleModelCatalogQuery {
  consumer?: ModelCardConsumer;
  semanticShape: string;
}

export function modelCardVisibleToConsumer(
  model: ModelCard,
  consumer: ModelCardConsumer | undefined,
): boolean {
  if (!model.visibility || model.visibility.scope === "public") return true;
  if (!consumer) return false;
  return model.visibility.consumers.some(
    (candidate) =>
      candidate.pluginId === consumer.pluginId &&
      (candidate.definitionId === undefined ||
        candidate.definitionId === consumer.definitionId) &&
      (candidate.actionId === undefined || candidate.actionId === consumer.actionId),
  );
}

/**
 * Generic discovery for a declared model-consumption shape. It preserves every
 * implementation on the Card while requiring the selected route to be enabled,
 * configured, credential-ready, capability-compatible, and executable.
 */
export function listConsumerModelCatalogEntries(
  options: ConsumerModelCatalogQuery,
): ModelCatalogEntry[] {
  const visibleModels = (options.models ?? MODEL_CARDS).filter(
    (model) =>
      model.semanticShape === options.semanticShape &&
      modelCardVisibleToConsumer(model, options.consumer),
  );
  return listCompatibleModelCatalogEntries({
    ...options,
    models: visibleModels,
  }).filter((entry) => entry.selectedRoute !== null);
}

/** Capability filter on the existing model catalog anti-corruption layer. */
export function listCompatibleModelCatalogEntries(
  options: CompatibleModelCatalogQuery,
): ModelCatalogEntry[] {
  const entries = listModelCatalogEntries(options);
  const compatibleIds = new Set(findCompatibleModels({
    outputKind: options.outputKind,
    sourceKind: options.sourceKind,
    referenceCounts: options.referenceCounts,
    enforceMinimums: options.enforceMinimums,
    cards: entries.map((entry) => entry.model),
  }).map((model) => model.id));
  return entries.filter((entry) => compatibleIds.has(entry.model.id));
}

export const listModelProviderRoutes = listModelUpstreamRoutes;
export const resolveModelProviderRoute = resolveModelUpstreamRoute;
