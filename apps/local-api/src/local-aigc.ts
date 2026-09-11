import {
  normalizeModelId,
  activeModelParameterIds,
  applyModelProviderImplementation,
  MODEL_CARDS,
  resolveModelUpstreamRoute,
  resolvePinnedModelUpstreamRoute,
  validateModelCardConfiguration,
  coerceModelParameterInput,
  type FrozenModelRoutePin,
  type ModelCard,
  type ModelKind,
  type ModelUpstreamRoute,
  type ProviderAccountAvailability,
  type ProviderAssetInput,
  type ExecutablePluginAssetHandle,
  type ExecutablePluginBinding,
  type ExecutablePluginReference,
  type ExecutablePluginResult,
  type AssetKind,
} from "@clash/shared-types";

import {
  createMockFalQueueService,
  type FalAudioResult,
  type FalImageResult,
  type FalMockQueueService,
  type FalMockResult,
  type FalVideoResult,
} from "./fal-mock.js";
export function localExecutableModelCards(
  models: readonly ModelCard[],
): ModelCard[] {
  return models.map((model) => ({
    ...model,
    providerImplementations: (model.providerImplementations ?? []).filter(
      (implementation) =>
        implementation.apiShape === "local-tts" ||
        (!!implementation.executorPluginId &&
          !!implementation.executorExportId),
    ),
  }));
}

export interface MockMediaGenerationInput {
  /** Set when asking about work already accepted; forwarded to the plugin untouched. */
  pollState?: unknown;
  taskId: string;
  projectId?: string;
  nodeId?: string;
  actorType?: "user" | "agent";
  actorUserId?: string;
  actorAgentId?: string;
  prompt: string;
  model: string;
  /** Consumer context controls declarative plugin-private Card visibility. */
  modelConsumer?: {
    pluginId: string;
    definitionId?: string;
    actionId?: string;
  };
  aspectRatio?: string;
  /**
   * Seconds, or a sentinel the Card offers.
   *
   * Several models let the provider choose the length, and they spell that `auto` on the
   * menu next to the numbers. Typing this as `number` forced a number to be invented for
   * them, and a model whose menu omitted it -- `seedance-2-fast-startend` offers
   * [auto, 4, 6, 8, 10, 15] -- failed validation on a value no one had asked for.
   */
  duration?: number | string;
  modelParams?: Record<string, unknown>;
  /** Host-private account selection. It is never copied into plugin-visible modelParams. */
  providerAccountId?: string;
  /**
   * Exact Provider implementation frozen with the Run authority. Execution must
   * use this implementation or fail; it never falls back to another route.
   */
  providerRoute?: FrozenModelRoutePin;
  /** Frozen typed inputs. Media bytes/URLs are resolved only through context.reference. */
  references?: ExecutablePluginReference[];
  /** Exact plugin contract selected when the node was authored. */
  pluginBinding?: ExecutablePluginBinding;
}

function promptForRoute(
  input: MockMediaGenerationInput,
  route: ModelUpstreamRoute,
): string {
  const binding = route.referenceBinding;
  const content = (input.references ?? [])
    .filter((reference) => reference.slot === "content")
    .sort((left, right) => left.index - right.index);
  if (binding?.type !== "positional-tokens" || !content.some((part) => "asset" in part)) {
    return input.prompt;
  }
  // Token numbers follow occurrences, not Asset identity. The same immutable Asset can be placed
  // more than once in mixed content and every placement still has its own Provider position.
  const occurrence = { image: 0, video: 0, audio: 0 };
  return content
    .map((part) => {
      if ("text" in part) return part.text.value;
      if ("document" in part) return "";
      const modality = part.asset.kind;
      if (modality !== "image" && modality !== "video" && modality !== "audio") {
        return "";
      }
      const template = binding.tokens?.[modality];
      if (!template) return "";
      occurrence[modality] += 1;
      return template.split("{n}").join(String(occurrence[modality]));
    })
    .join("");
}

/** Provider-neutral MIME normalization performed before route selection. */
const REFERENCE_MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
};

export function normalizeProviderReferenceMediaType(contentType: string): string {
  return REFERENCE_MIME_ALIASES[contentType] ?? contentType;
}

/**
 * A generation that has not finished yet.
 *
 * The provider holds the work and the host holds the way back to it. Kept beside the completed
 * shape rather than signalled by an exception, because a caller that catches an acceptance treats
 * it as a failure -- and a failure is retried, which buys the same generation twice.
 */
export interface MediaGenerationAccepted {
  status: "accepted";
  /**
   * Opaque to the host; persisted in the owner-private durable journal and returned on the next
   * poll.
   */
  pollState: unknown;
  retryAfterMs?: number;
  provider?: string;
  modelEndpoint?: string;
  pluginBinding?: ExecutablePluginBinding;
}

export interface MockMediaGenerationCompleted {
  status?: "completed";
  bytes: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
  transcript?: string;
  requestId?: string;
  provider?: string;
  modelEndpoint?: string;
  remoteUrl?: string;
  pluginBinding?: ExecutablePluginBinding;
}

export type ProviderPluginFailure = Extract<
  ExecutablePluginResult,
  { status: "failed" }
>["error"];

export interface MediaGenerationFailed {
  status: "failed";
  error: ProviderPluginFailure;
  provider?: string;
  modelEndpoint?: string;
  pluginBinding?: ExecutablePluginBinding;
}

export type MockMediaGenerationResult =
  | MockMediaGenerationCompleted
  | MediaGenerationAccepted
  | MediaGenerationFailed;

export interface MockTextGenerationResult {
  text: string;
  provider?: string;
  modelEndpoint?: string;
}

/** A Provider Plugin invocation fully resolved before any Provider HTTP request is made. */
export interface ProviderPluginExecutionPlan {
  /** The resolved route is available to native Model Run admission. Legacy callers may omit it. */
  route?: ModelUpstreamRoute;
  binding: ExecutablePluginBinding;
  accountId?: string;
  assetInputs: ProviderAssetInput[];
  kind: ModelKind;
  projectId: string;
  nodeId?: string;
  provider: string;
  modelEndpoint: string;
  input: {
    values: Record<string, unknown>;
    references: ExecutablePluginReference[];
  };
}

export interface ExternalAigcService {
  /** Returns null for built-in and mock routes. Planning never submits work to a Provider. */
  planProviderPlugin?(
    input: MockMediaGenerationInput,
    kind: ModelKind,
  ): Promise<ProviderPluginExecutionPlan | null>;
  generateImage(
    input: MockMediaGenerationInput,
  ): Promise<MockMediaGenerationResult>;
  generateVideo(
    input: MockMediaGenerationInput,
  ): Promise<MockMediaGenerationResult>;
  generateAudio(
    input: MockMediaGenerationInput,
  ): Promise<MockMediaGenerationResult>;
  generateText(
    input: MockMediaGenerationInput,
  ): Promise<MockTextGenerationResult>;
}

export interface MockFalExternalAigcServiceOptions {
  fal?: FalMockQueueService;
  origin?: string;
  providerAccounts?: () => Promise<RuntimeProviderAccountAvailability[]>;
  modelCards?: (consumer?: MockMediaGenerationInput["modelConsumer"]) => Promise<ModelCard[]>;
  localTts?: (
    input: MockMediaGenerationInput,
  ) => Promise<MockMediaGenerationResult>;
  /** Kernel-owned adapter for the executable-plugin host. */
  providerPluginProjector?: ProviderPluginProjector;
  /** Kernel-owned adapter for a plugin-defined provider's full lifecycle. */
  providerPluginExecutor?: ProviderPluginExecutor;
  /** Resolves a Host-private CAS staging receipt without routing local bytes through HTTP. */
  resolveProviderPluginStagedAsset?: (input: {
    projectId: string;
    projectAssetId: string;
  }) => Promise<
    | {
        bytes: Uint8Array;
        kind: AssetKind;
        contentType?: string;
      }
    | undefined
  >;
  /** Resolves the immutable executable binding while the durable run is still being planned. */
  resolveProviderPluginBinding?: (
    pluginId: string,
    exportId: string,
    kind: "provider-executor",
  ) => Promise<ExecutablePluginBinding>;
}

export interface ProviderPluginProjectorRequest {
  pluginId: string;
  exportId: string;
  kind: ModelKind;
  taskId: string;
  projectId: string;
  nodeId?: string;
  binding?: ExecutablePluginBinding;
  input: {
    values: Record<string, unknown>;
    references: ExecutablePluginReference[];
  };
}

export interface ProviderPluginProjection {
  endpoint: string;
  input: Record<string, unknown>;
}

export interface ProviderPluginProjectorResponse {
  binding: ExecutablePluginBinding;
  projection: ProviderPluginProjection;
}

export type ProviderPluginProjector = (
  request: ProviderPluginProjectorRequest,
) => Promise<ProviderPluginProjectorResponse>;

/** Provider outputs include 3D Project Assets even though the generic AIGC card catalog does not. */
export type ProviderPluginExecutorKind = ModelKind | Extract<AssetKind, "model">;

export interface ProviderPluginExecutorRequest {
  pluginId: string;
  exportId: string;
  kind: ProviderPluginExecutorKind;
  taskId: string;
  projectId: string;
  nodeId?: string;
  binding?: ExecutablePluginBinding;
  /** Delivery declaration copied from the exact selected Provider route. */
  assetInputs?: ProviderAssetInput[];
  input: {
    values: Record<string, unknown>;
    references: ExecutablePluginReference[];
  };
  /**
   * Set when asking about work already accepted, carrying exactly what the plugin returned.
   *
   * Opaque on purpose: an id, a status URL, a job name with its region, or anything else a provider
   * needs. The host persists it and hands it back without reading it, so a provider that has no
   * task id is not forced to invent one.
   */
  pollState?: unknown;
  /** The account this work is charged to; credentials stay in its Host-scoped plugin store. */
  accountId?: string;
  /**
   * Host-owned remaining attempt budget. It is transport metadata for the plugin process and is
   * never exposed as a model value or reset by an individual submit/poll call.
   */
  timeoutMs?: number;
}

/** Media crosses the Provider boundary only as the Host-issued canonical Asset handle. */
export type ProviderPluginExecutorMedia = ExecutablePluginAssetHandle;

/** The protocol's canonical synchronous text envelope. */
export interface ProviderPluginExecutorTextOutput {
  slot: "text";
  kind: "value";
  value: string;
}

/**
 * The provider either finished, took the work and told us how to ask again, or reported failure.
 *
 * Typed as a union rather than as media-with-exceptions, because an acceptance thrown as an error
 * cannot be told apart from a failure by the code that catches it -- and the difference is that one
 * of them has already been paid for.
 */
export type ProviderPluginExecutorResponse =
  | {
      status: "completed";
      binding: ExecutablePluginBinding;
      media: ProviderPluginExecutorMedia;
    }
  | {
      status: "completed";
      binding: ExecutablePluginBinding;
      output: ProviderPluginExecutorTextOutput;
    }
  | {
      status: "accepted";
      binding: ExecutablePluginBinding;
      /**
       * Opaque; stored in the owner-private durable journal and handed back on the next poll.
       */
      pollState: unknown;
      retryAfterMs?: number;
    }
  | {
      status: "failed";
      binding: ExecutablePluginBinding;
      error: ProviderPluginFailure;
    };

export type ProviderPluginExecutor = (
  request: ProviderPluginExecutorRequest,
) => Promise<ProviderPluginExecutorResponse>;

/** The selected executable Provider cannot be resolved or invoked by the plugin Host. */
export class ProviderPluginHostUnavailableError extends Error {
  override name = "ProviderPluginHostUnavailableError";
}

/**
 * A compatibility caller cannot return a failed result, so it throws without discarding its facts.
 */
export class ProviderGenerationError extends Error {
  override name = "ProviderGenerationError";

  constructor(readonly failure: ProviderPluginFailure) {
    super(`Provider generation failed (${failure.code}): ${failure.message}`);
  }
}

type RuntimeProviderAccountAvailability = ProviderAccountAvailability & {
  credentials?: Record<string, string>;
};

function resolveMockFalModelId(
  model: string,
  kind: ModelKind,
  fallback: string,
): string {
  const route = resolveModelUpstreamRoute({
    modelCode: model,
    kind,
    allowMock: true,
    configuredUpstreams: [{ upstreamId: "mock", enabled: true }],
  });
  return route?.upstreamModel ?? fallback;
}

function resolvePinnedLocalRoute(
  model: string,
  kind: ModelKind,
  pin: FrozenModelRoutePin,
  providerAccounts?: RuntimeProviderAccountAvailability[],
  models?: ModelCard[],
  requestedParameterIds: readonly string[] = [],
): ModelUpstreamRoute {
  const pinned = resolvePinnedModelUpstreamRoute(
    providerAccounts
      ? {
          modelCode: model,
          kind,
          allowMock: providerAccounts.some(
            (account) =>
              account.providerId === "mock" && account.enabled !== false,
          ),
          configuredProviders: providerAccounts,
          requestedParameterIds,
          ...(models ? { models } : {}),
        }
      : {
          modelCode: model,
          kind,
          allowMock: true,
          configuredUpstreams: [{ upstreamId: "mock", enabled: true }],
          requestedParameterIds,
          ...(models ? { models } : {}),
        },
    pin,
  );
  if (!pinned) {
    throw new Error(
      `The Provider route frozen for ${model} ` +
        `(${pin.providerId ?? pin.upstreamId}, ${pin.apiShape}) is no longer available. ` +
        "Reconnect that provider or select the model again; the run will not fall back to another implementation.",
    );
  }
  return pinned;
}

function resolveLocalRoute(
  model: string,
  kind: ModelKind,
  providerAccounts?: RuntimeProviderAccountAvailability[],
  preferredProviderId?: string,
  models?: ModelCard[],
  requestedParameterIds: readonly string[] = [],
): ModelUpstreamRoute | null {
  if (providerAccounts) {
    // A named account or provider narrows the candidates rather than reordering them: naming one is
    // how you find out whether that one works, and a silent fall-through to the next answers a
    // different question while looking like success.
    const eligibleProviderAccounts = preferredProviderId
      ? providerAccounts.filter(
          (account) =>
            account.providerId === preferredProviderId ||
            account.id === preferredProviderId,
        )
      : providerAccounts;
    if (preferredProviderId && eligibleProviderAccounts.length === 0) {
      throw new Error(
        `No configured provider account matches "${preferredProviderId}". ` +
          `Configured: ${providerAccounts.map((account) => account.id ?? account.providerId).join(", ") || "none"}.`,
      );
    }
    return resolveModelUpstreamRoute({
      modelCode: model,
      kind,
      allowMock: eligibleProviderAccounts.some(
        (account) => account.providerId === "mock" && account.enabled !== false,
      ),
      configuredProviders: eligibleProviderAccounts,
      requestedParameterIds,
      ...(models ? { models } : {}),
    });
  }
  return resolveModelUpstreamRoute({
    modelCode: model,
    kind,
    allowMock: true,
    configuredUpstreams: [{ upstreamId: "mock", enabled: true }],
    requestedParameterIds,
  });
}

function aspectRatioToFalImageSize(aspectRatio: string | undefined): string {
  const map: Record<string, string> = {
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "1:1": "square_hd",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
  };
  return map[aspectRatio ?? "16:9"] ?? "landscape_16_9";
}

function hasImages(result: FalMockResult): result is FalImageResult {
  return "images" in result;
}

function hasVideo(result: FalMockResult): result is FalVideoResult {
  return "video" in result;
}

function hasAudio(result: FalMockResult): result is FalAudioResult {
  return "audio" in result;
}

function stringParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerVisibleModelParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const visible = { ...(params ?? {}) };
  delete visible.provider_id;
  delete visible.accountId;
  delete visible.credentials;
  delete visible.require_real_provider;
  return visible;
}

function providerPluginExecutorRequest(
  input: MockMediaGenerationInput,
  kind: ModelKind,
  route: ModelUpstreamRoute,
): ProviderPluginExecutorRequest {
  if (!route.executorPluginId || !route.executorExportId) {
    throw new Error(
      `Route ${route.modelCode} has no executable provider executor.`,
    );
  }
  if (
    input.pluginBinding &&
    (input.pluginBinding.pluginId !== route.executorPluginId ||
      input.pluginBinding.exportId !== route.executorExportId)
  ) {
    throw new Error(
      `Pinned plugin ${input.pluginBinding.pluginId}/${input.pluginBinding.exportId} does not match ` +
        `route executor ${route.executorPluginId}/${route.executorExportId}.`,
    );
  }
  return {
    pluginId: route.executorPluginId,
    exportId: route.executorExportId,
    ...(route.accountId ? { accountId: route.accountId } : {}),
    kind,
    taskId: input.taskId,
    projectId: input.projectId ?? "local",
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.pluginBinding ? { binding: input.pluginBinding } : {}),
    assetInputs: route.assetInputs ?? [],
    // Carried through untouched. Dropping it here silently turns every resume into a fresh
    // submission: the node keeps its record, the plugin never sees it, and the same generation is
    // bought again on every restart.
    ...(input.pollState === undefined ? {} : { pollState: input.pollState }),
    input: {
      values: {
        modelId: route.modelCode,
        upstreamModel: route.upstreamModel,
        apiShape: route.apiShape,
        prompt: promptForRoute(input, route),
        ...(input.aspectRatio !== undefined
          ? { aspectRatio: input.aspectRatio }
          : {}),
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        modelParams: providerVisibleModelParams(input.modelParams),
      },
      references: [...(input.references ?? [])],
    },
  };
}

/** Fail closed when a compatibility caller has no durable state in which to resume acceptance. */
export function requireCompletedGeneration(
  first: MockMediaGenerationResult,
): MockMediaGenerationCompleted {
  if (first.status === "accepted") {
    throw new Error(
      "Provider accepted the request; resume it through the Host durable coordinator.",
    );
  }
  if (first.status === "failed") {
    throw new ProviderGenerationError(first.error);
  }
  return first;
}

async function materializedProviderPluginExecutorRequest(
  input: MockMediaGenerationInput,
  kind: ModelKind,
  route: ModelUpstreamRoute,
): Promise<ProviderPluginExecutorRequest> {
  return providerPluginExecutorRequest(input, kind, route);
}

async function generatePluginProviderMedia(
  input: MockMediaGenerationInput,
  kind: ModelKind,
  route: ModelUpstreamRoute,
  options: Required<
    Pick<MockFalExternalAigcServiceOptions, "providerPluginExecutor">
  > &
    Pick<MockFalExternalAigcServiceOptions, "resolveProviderPluginStagedAsset">,
  // The one path that can come back unfinished: a plugin may hand the work to a provider that
  // takes minutes, and say so instead of holding the call open.
): Promise<MockMediaGenerationResult> {
  const response = await options.providerPluginExecutor(
    await materializedProviderPluginExecutorRequest(
      input,
      kind,
      route,
    ),
  );
  if (
    response.binding.pluginId !== route.executorPluginId ||
    response.binding.exportId !== route.executorExportId
  ) {
    throw new Error(
      `Provider plugin resolved ${response.binding.pluginId}/${response.binding.exportId}, expected ` +
        `${route.executorPluginId}/${route.executorExportId}.`,
    );
  }
  if (
    input.pluginBinding &&
    (response.binding.version !== input.pluginBinding.version ||
      response.binding.schemaHash !== input.pluginBinding.schemaHash)
  ) {
    throw new Error(
      `Provider plugin binding drifted from ${input.pluginBinding.version}/${input.pluginBinding.schemaHash}.`,
    );
  }
  if (response.status === "failed") {
    return {
      status: "failed",
      error: response.error,
      pluginBinding: response.binding,
      provider: route.providerId ?? route.upstreamId,
      modelEndpoint: route.upstreamModel,
    };
  }
  if (response.status === "accepted") {
    // Not an error and not a result: the provider holds the work. Carrying it out as a value lets
    // the caller persist the poll state; throwing here would make an acceptance look like a failure
    // to every catch on the way up, and this one has already been billed.
    return {
      status: "accepted",
      pollState: response.pollState,
      ...(response.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: response.retryAfterMs }),
      pluginBinding: response.binding,
      provider: route.providerId ?? route.upstreamId,
      modelEndpoint: route.upstreamModel,
    };
  }
  if ("output" in response) {
    if (kind !== "text") {
      throw new Error(
        `Provider plugin returned slot "text" for a ${kind} route.`,
      );
    }
    const output = response.output as Partial<ProviderPluginExecutorTextOutput>;
    if (
      output.slot !== "text" ||
      output.kind !== "value" ||
      typeof output.value !== "string" ||
      !output.value.trim()
    ) {
      throw new Error(
        `Provider plugin ${route.executorPluginId}/${route.executorExportId} returned an invalid ` +
          'slot "text"; expected a non-empty string value.',
      );
    }
    return {
      status: "completed",
      bytes: new TextEncoder().encode(output.value),
      contentType: "text/plain; charset=utf-8",
      requestId: input.taskId,
      provider: route.providerId ?? route.upstreamId,
      modelEndpoint: route.upstreamModel,
      pluginBinding: response.binding,
    };
  }
  if (kind === "text") {
    throw new Error(
      "Provider plugin returned media for text generation; expected a text value.",
    );
  }
  if (response.media.kind !== kind) {
    throw new Error(
      `Provider plugin returned ${response.media.kind} output for a ${kind} route.`,
    );
  }
  const staged =
    typeof input.projectId === "string" &&
    input.projectId &&
    options.resolveProviderPluginStagedAsset
      ? await options.resolveProviderPluginStagedAsset({
          projectId: input.projectId,
          projectAssetId: response.media.assetId,
        })
      : undefined;
  if (staged && staged.kind !== kind) {
    throw new Error(
      `Provider plugin staged ${staged.kind} output for a ${kind} route.`,
    );
  }
  if (!staged) {
    throw new Error(
      `Provider plugin media asset ${response.media.assetId} has no Host staging receipt.`,
    );
  }
  return {
    bytes: staged.bytes,
    contentType:
      staged.contentType ??
      response.media.mediaType ??
      (kind === "video"
        ? "video/mp4"
        : kind === "audio"
          ? "audio/mpeg"
          : "image/png"),
    status: "completed" as const,
    requestId: input.taskId,
    provider: route.providerId ?? route.upstreamId,
    modelEndpoint: route.upstreamModel,
    pluginBinding: response.binding,
  };
}

function missingAdapter(route: ModelUpstreamRoute): Error {
  return new Error(
    `Local built-in adapter is not implemented for ${route.upstreamId} (${route.apiShape}).`,
  );
}

function requiresExecutableProviderContract(
  route: ModelUpstreamRoute,
): boolean {
  return route.apiShape !== "local-tts";
}

/** Drains only the deterministic in-memory test fake; no Provider HTTP is performed here. */
async function waitForMockFalResult(
  fal: FalMockQueueService,
  modelEndpoint: string,
  requestId: string,
  origin: string | undefined,
): Promise<FalMockResult> {
  let status = fal.status(modelEndpoint, requestId, { logs: true, origin });
  for (
    let attempt = 0;
    attempt < 8 && status?.status !== "COMPLETED";
    attempt += 1
  ) {
    status = fal.status(modelEndpoint, requestId, { logs: true, origin });
  }
  if (status?.status !== "COMPLETED") {
    throw new Error(`Mock fal request did not complete: ${requestId}`);
  }

  const result = fal.result(modelEndpoint, requestId, { origin });
  if (!result) throw new Error(`Mock fal result missing: ${requestId}`);
  return result;
}

function mediaForRequest(fal: FalMockQueueService, requestId: string) {
  const media = fal.media(requestId);
  if (!media) throw new Error(`Mock fal media missing: ${requestId}`);
  return media;
}

export function createMockExternalAigcService(
  options: MockFalExternalAigcServiceOptions = {},
): ExternalAigcService {
  const fal = options.fal ?? createMockFalQueueService();
  const loadProviderAccounts = options.providerAccounts;
  const loadModelCards = options.modelCards;
  async function resolveGenerationRoute(
    input: MockMediaGenerationInput,
    kind: ModelKind,
  ): Promise<{
    route: ModelUpstreamRoute;
  } | null> {
    const providerAccounts = loadProviderAccounts
      ? await loadProviderAccounts()
      : undefined;
    const modelCards = loadModelCards
      ? await loadModelCards(input.modelConsumer)
      : undefined;
    const preferredProviderId =
      input.providerAccountId ?? stringParam(input.modelParams, "provider_id");
    const requireRealProvider =
      input.modelParams?.require_real_provider === true;
    /**
     * Whether the mock was chosen -- not whether one exists.
     *
     * Every machine that has run the mock tests has an enabled mock account, so the old presence
     * check meant any unresolved route on any of those machines quietly produced a placeholder and
     * reported success. Naming a provider excludes the mock outright unless the mock is what was
     * named.
     */
    const explicitMockProvider = preferredProviderId
      ? preferredProviderId === "mock" ||
        providerAccounts?.some(
          (account) =>
            account.id === preferredProviderId && account.providerId === "mock",
        ) === true
      : providerAccounts?.every(
          (account) =>
            account.providerId === "mock" || account.enabled === false,
        ) === true &&
        providerAccounts.some(
          (account) =>
            account.providerId === "mock" && account.enabled !== false,
        );
    /**
     * Reaching no provider is a failure.
     *
     * This used to return a placeholder, and the node then reported `completed` with an asset
     * attached -- indistinguishable from a real generation until someone opened the 1278-byte SVG.
     * The mock is still reachable by choosing it; what is gone is arriving there by accident.
     */
    const mockOrThrow = (): null => {
      if (explicitMockProvider && !requireRealProvider) return null;
      throw new Error(
        `${input.model} reached no provider` +
          (preferredProviderId
            ? ` for the requested account "${preferredProviderId}"`
            : "") +
          ". Connect one with `clash providers add`, or select the mock explicitly.",
      );
    };
    const baseCard = (modelCards ?? MODEL_CARDS).find(
      (card) => card.id === (normalizeModelId(input.model) ?? input.model),
    );
    const declaredParameterIds = new Set(
      baseCard?.parameters.map((parameter) => parameter.id) ?? [],
    );
    const requestedParameterIds = activeModelParameterIds({
      ...input.modelParams,
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    }).filter((parameterId) => declaredParameterIds.has(parameterId));
    const route = input.providerRoute
      ? resolvePinnedLocalRoute(
          input.model,
          kind,
          input.providerRoute,
          providerAccounts,
          modelCards,
          requestedParameterIds,
        )
      : resolveLocalRoute(
          input.model,
          kind,
          providerAccounts,
          preferredProviderId,
          modelCards,
          requestedParameterIds,
        );
    if (process.env.CLASH_TRACE_ROUTE) {
      console.log(
        `[route] ${input.model} -> provider=${route?.providerId} upstream=${route?.upstreamId} shape=${route?.apiShape} account=${route?.accountId}`,
      );
    }
    if (!route || route.upstreamId === "mock") return mockOrThrow();
    if (baseCard) {
      const effectiveCard = applyModelProviderImplementation(baseCard, route);
      const lyricsParam = effectiveCard.musicInput?.lyricsParam;
      // Only forward a duration the Card actually declares. Speech models take a
      // voice and a script; their length follows from the text, so a `duration` on the
      // request is not a shorter clip but an undeclared parameter, and the validator
      // rejected the whole generation for it.
      const cardTakesDuration =
        effectiveCard.parameters.some(
          (parameter) => parameter.id === "duration",
        ) || effectiveCard.defaultParams.duration !== undefined;
      const durationParam =
        input.duration !== undefined && cardTakesDuration
          ? coerceModelParameterInput(effectiveCard, "duration", input.duration)
          : undefined;
      const effectiveModelParams: Record<
        string,
        string | number | boolean | undefined
      > = {
        ...(input.modelParams as
          Record<string, string | number | boolean | undefined> | undefined),
        ...(durationParam !== undefined ? { duration: durationParam } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      };
      const validationError = validateModelCardConfiguration(
        effectiveCard,
        {
          prompt: input.prompt,
          lyrics:
            lyricsParam && typeof effectiveModelParams[lyricsParam] === "string"
              ? (effectiveModelParams[lyricsParam] as string)
              : undefined,
          modelParams: effectiveModelParams,
        },
        {
          rejectUnknownParameters: true,
          allowedParameterIds: [
            "aspect_ratio",
            "count",
            "height",
            "keyframe_frame_indices",
            "keyframe_timing_customized",
            "provider_id",
            "require_real_provider",
            "width",
            ...(lyricsParam ? [lyricsParam] : []),
          ],
        },
      );
      if (validationError) throw new Error(validationError);
    }

    return { route };
  }

  async function generateWithRoute(
    input: MockMediaGenerationInput,
    kind: ModelKind,
    fallback: () => Promise<MockMediaGenerationResult>,
    // Unfinished when a plugin hands the work to a provider that takes minutes and says so rather
    // than holding the call open.
  ): Promise<MockMediaGenerationResult> {
    const resolved = await resolveGenerationRoute(input, kind);
    if (!resolved) return fallback();
    const { route } = resolved;

    if (route.executorPluginId && route.executorExportId) {
      if (!options.providerPluginExecutor) {
        throw new ProviderPluginHostUnavailableError(
          `Provider executor ${route.executorPluginId}/${route.executorExportId} is unavailable.`,
        );
      }
      return generatePluginProviderMedia(input, kind, route, {
        providerPluginExecutor: options.providerPluginExecutor,
        ...(options.resolveProviderPluginStagedAsset
          ? {
              resolveProviderPluginStagedAsset:
                options.resolveProviderPluginStagedAsset,
            }
          : {}),
      });
    }

    if (requiresExecutableProviderContract(route)) {
      throw new Error(
        `${input.model} resolved to ${route.providerId ?? route.upstreamId} ` +
          `(${route.apiShape}), which does not declare an executable submit/poll contract. ` +
          "Install or upgrade its Provider plugin before generating.",
      );
    }

    if (route.apiShape === "local-tts" && kind === "audio") {
      if (!options.localTts) throw missingAdapter(route);
      return options.localTts({
        ...input,
        model: route.upstreamModel,
      });
    }

    throw missingAdapter(route);
  }

  return {
    async planProviderPlugin(input, kind) {
      const resolved = await resolveGenerationRoute(input, kind);
      if (!resolved) return null;
      const { route } = resolved;
      if (!route.executorPluginId || !route.executorExportId) return null;
      const request = await materializedProviderPluginExecutorRequest(
        input,
        kind,
        route,
      );
      const binding =
        request.binding ??
        (await options.resolveProviderPluginBinding?.(
          request.pluginId,
          request.exportId,
          "provider-executor",
        ));
      if (!binding) {
        throw new ProviderPluginHostUnavailableError(
          `Provider executor ${request.pluginId}/${request.exportId} cannot be frozen before submit.`,
        );
      }
      if (
        binding.pluginId !== request.pluginId ||
        binding.exportId !== request.exportId
      ) {
        throw new Error(
          `Plugin host resolved ${binding.pluginId}/${binding.exportId}, expected ` +
            `${request.pluginId}/${request.exportId}.`,
        );
      }
      return {
        binding,
        route,
        ...(request.accountId ? { accountId: request.accountId } : {}),
        assetInputs: request.assetInputs ?? [],
        kind,
        projectId: request.projectId,
        ...(request.nodeId ? { nodeId: request.nodeId } : {}),
        provider: route.providerId ?? route.upstreamId,
        modelEndpoint: route.upstreamModel,
        input: request.input,
      };
    },

    async generateImage(input) {
      return generateWithRoute(input, "image", async () => {
        const modelEndpoint = resolveMockFalModelId(
          input.model,
          "image",
          "fal-ai/nano-banana-2",
        );
        const submitted = await fal.submit(
          modelEndpoint,
          {
            prompt: input.prompt || "Mock fal image",
            aspect_ratio: input.aspectRatio,
            image_size: aspectRatioToFalImageSize(input.aspectRatio),
            output_format: "png",
            output_type: "image",
          },
          { origin: options.origin },
        );
        const result = await waitForMockFalResult(
          fal,
          modelEndpoint,
          submitted.request_id,
          options.origin,
        );
        if (!hasImages(result) || !result.images[0])
          throw new Error("No images in mock fal response");
        const media = mediaForRequest(fal, submitted.request_id);
        return {
          bytes: media.bytes,
          contentType: media.contentType,
          width: result.images[0].width,
          height: result.images[0].height,
          requestId: submitted.request_id,
          provider: "fal-mock",
          modelEndpoint,
          remoteUrl: result.images[0].url,
        };
      });
    },

    async generateVideo(input) {
      return generateWithRoute(input, "video", async () => {
        const modelEndpoint = resolveMockFalModelId(
          input.model,
          "video",
          "fal-ai/sora-2/text-to-video",
        );
        const submitted = await fal.submit(
          modelEndpoint,
          {
            prompt: input.prompt || "Mock fal video",
            aspect_ratio: input.aspectRatio || "16:9",
            duration: input.duration ?? 4,
            output_type: "video",
          },
          { origin: options.origin },
        );
        const result = await waitForMockFalResult(
          fal,
          modelEndpoint,
          submitted.request_id,
          options.origin,
        );
        if (!hasVideo(result)) throw new Error("No video in mock fal response");
        const media = mediaForRequest(fal, submitted.request_id);
        return {
          bytes: media.bytes,
          contentType: media.contentType,
          width: result.video.width,
          height: result.video.height,
          durationMs: Math.round(result.video.duration * 1000),
          transcript: result.prompt,
          requestId: submitted.request_id,
          provider: "fal-mock",
          modelEndpoint,
          remoteUrl: result.video.url,
        };
      });
    },

    async generateAudio(input) {
      return generateWithRoute(input, "audio", async () => {
        const modelEndpoint = resolveMockFalModelId(
          input.model,
          "audio",
          "fal-ai/minimax/speech-02-hd",
        );
        const submitted = await fal.submit(
          modelEndpoint,
          {
            prompt: input.prompt || "Mock fal audio",
            duration: input.duration ?? 5,
            output_type: "audio",
          },
          { origin: options.origin },
        );
        const result = await waitForMockFalResult(
          fal,
          modelEndpoint,
          submitted.request_id,
          options.origin,
        );
        if (!hasAudio(result)) throw new Error("No audio in mock fal response");
        const media = mediaForRequest(fal, submitted.request_id);
        return {
          bytes: media.bytes,
          contentType: media.contentType,
          durationMs: Math.round(result.audio.duration * 1000),
          waveform: result.waveform,
          transcript: result.transcript,
          requestId: submitted.request_id,
          provider: "fal-mock",
          modelEndpoint,
          remoteUrl: result.audio.url,
        };
      });
    },

    async generateText(input) {
      const textFallback = async () => ({
        bytes: new TextEncoder().encode(
          `Generated text (${input.model})\n\n${input.prompt || "Mock text"}`,
        ),
        contentType: "text/plain; charset=utf-8",
        requestId: input.taskId,
        provider: "mock",
        modelEndpoint: resolveMockFalModelId(input.model, "text", "mock-text"),
      });
      // `MockTextGenerationResult` has no unfinished arm and direct calls own no durable journal.
      const result = requireCompletedGeneration(
        await generateWithRoute(input, "text", textFallback),
      );
      return {
        text: new TextDecoder().decode(result.bytes),
        provider: result.provider,
        modelEndpoint: result.modelEndpoint,
      };
    },
  };
}
