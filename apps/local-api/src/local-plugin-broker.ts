import { isDeepStrictEqual } from "node:util";

import {
  executablePluginDependencyError,
  type PluginBroker,
} from "./runtime/host/lib/actions-loader.js";
import {
  ActionRunModelRouteSchema,
  ExecutablePluginBrokerResolvedReferenceSchema,
  ExecutableMediaAnalysisResultSchema,
  ExecutableSpeechTranscriptionResultSchema,
  ExecutableVideoEnhanceResultSchema,
} from "@clash/shared-types";
import type {
  ActionRunModelRoute,
  AssetKind,
  ExecutablePluginAssetHandle,
  ExecutablePluginJsonValue,
  ExecutableMediaAnalysisReference,
  ExecutableMediaAnalysisResult,
  ExecutableSpeechTranscriptionReference,
  ExecutableSpeechTranscriptionResult,
  ExecutableVideoEnhanceReference,
  ExecutableVideoEnhanceResult,
} from "@clash/shared-types";

import type { RuntimeProviderAccountAvailability } from "./provider-accounts.js";

export interface LocalPluginBrokerAuditRecord {
  pluginId: string;
  pluginVersion: string;
  projectId: string;
  invocationId: string;
  requestId: string;
  operation:
    | "asset.resolve"
    | "asset.write"
    | "asset.upload-slot"
    | "store.get"
    | "store.put"
    | "codex.image.generate"
    | "media.analyze"
    | "speech.transcribe"
    | "video.enhance"
    | "director.stage.capture-frame";
  target: string;
  status: "ok" | "error";
  error?: string;
  occurredAt: string;
}

export interface LocalPluginBrokerResolvedAsset {
  kind: AssetKind;
  mediaType?: string;
  bytes: Uint8Array;
  providerUrl?: { providerUrl: string; expiresAt: string };
}

export interface LocalExecutorAssetCapability {
  executorUrl: string;
  expiresAt: string;
  kind: AssetKind;
  mediaType?: string;
  /** Revokes the opaque URL. The broker binds this to the outer invocation terminal event. */
  release: () => Promise<void> | void;
}

export class LocalPluginBrokerAuthorizationError extends Error {
  readonly code = "PLUGIN_REFERENCE_NOT_AUTHORIZED" as const;

  constructor(slot: string, index: number) {
    super(
      `Asset reference ${slot}:${index} is not authorized for the active invocation.`,
    );
    this.name = "LocalPluginBrokerAuthorizationError";
  }
}

export interface LocalExecutablePluginBrokerOptions {
  loadProviderAccounts: () => Promise<RuntimeProviderAccountAvailability[]>;
  readAsset?: (input: {
    assetId: string;
    projectId: string;
  }) => Promise<LocalPluginBrokerResolvedAsset>;
  /**
   * Open a read-only URL reachable from the active plugin execution realm.
   *
   * Asset identity is already authorized against the frozen invocation before this is called.
   * The issuer resolves immutable Resource bytes privately; neither paths nor storage keys cross
   * this interface.
   */
  openExecutorAsset?: (input: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    assetId: string;
    kind: AssetKind;
    mediaType?: string;
  }) => Promise<LocalExecutorAssetCapability>;
  readDocument?: (input: {
    documentAssetId: string;
    revisionId: string;
    projectId: string;
  }) => Promise<{
    documentKind: string;
    schemaVersion: number;
    body: ExecutablePluginJsonValue;
  }>;
  /** Publish one immutable Resource when the binding requires a URL and no reusable one exists. */
  publishAsset?: (input: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    assetId: string;
    kind: AssetKind;
    mediaType?: string;
    bytes: Uint8Array;
  }) => Promise<{ url: string; expiresAt: string } | undefined>;
  writeAsset?: (input: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    taskId: string;
    slot: string;
    kind: AssetKind;
    mediaType?: string;
    /** Host-selected Provider account this invocation ran under, when it had one. */
    accountId?: string;
    bytes: Uint8Array;
  }) => Promise<ExecutablePluginAssetHandle>;
  /**
   * Hand out somewhere to stream bytes, and collect them afterwards.
   *
   * The alternative is `dataBase64` inside the broker frame, which for one 30-second video is
   * 3,470,456 characters held at once by the plugin, the pipe and this process.
   */
  openUploadSlot?: (input: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    taskId: string;
    slot: string;
    kind: AssetKind;
    mediaType?: string;
    /** Host-selected Provider account this invocation ran under, when it had one. */
    accountId?: string;
    /** How many bytes are coming, when the plugin holds them. */
    byteLength?: number;
    /** Where they are, when the vendor answered with a link and there is nothing to count yet. */
    url?: string;
  }) => Promise<{
    /** Where to PUT the bytes. Absent when the host already holds them -- a vendor link is fetched
     * by the host, and there is nobody left to upload. */
    uploadUrl?: string;
    assetId: string;
  }>;
  finishUpload?: (input: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    taskId: string;
    slot: string;
    kind: AssetKind;
    mediaType?: string;
    /** Host-selected Provider account this invocation ran under, when it had one. */
    accountId?: string;
    assetId: string;
  }) => Promise<ExecutablePluginAssetHandle>;
  /**
   * This plugin's own stored values, for this account.
   *
   * Bound to the active invocation. The request carries a key and nothing else, so a plugin cannot
   * reach another plugin's credentials or another account's by asking -- the pair is decided before
   * the key is read.
   */
  storeGet?: (input: {
    pluginId: string;
    accountId: string;
    key: string;
  }) => Promise<string | undefined>;
  storePut?: (input: {
    pluginId: string;
    accountId: string;
    key: string;
    value: string;
    secret?: boolean;
    expiresAt?: string;
  }) => Promise<void>;
  generateCodexImage?: (input: {
    prompt: string;
    aspectRatio: string;
    references: Array<{
      asset: ExecutablePluginAssetHandle;
      mediaType?: string;
      bytes: Uint8Array;
    }>;
  }) => Promise<{ mediaType: string; bytes: Uint8Array }>;
  captureDirectorStageFrame?: (input: {
    projectId: string;
    invocationId: string;
    taskId: string;
    stage: { name: string; owner: unknown; state: unknown };
    label: string;
    timeSeconds: number;
    aspectRatio: "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
    longEdge: number;
  }) => Promise<{ mediaType: "image/png"; width: number; height: number; bytesBase64: string }>;
  analyzeMedia?: (input: {
    projectId: string;
    invocationId: string;
    taskId: string;
    reference: ExecutableMediaAnalysisReference;
    modelId: string;
    route: ActionRunModelRoute;
    category: string;
    prompt: string;
    promptVersion: string;
    responseFormat?: "json" | "text";
  }) => Promise<ExecutableMediaAnalysisResult>;
  transcribeSpeech?: (input: {
    projectId: string;
    invocationId: string;
    taskId: string;
    reference: ExecutableSpeechTranscriptionReference;
    modelId: string;
    language?: string;
    poll?: ExecutablePluginJsonValue;
  }) => Promise<ExecutableSpeechTranscriptionResult>;
  /**
   * Generic dispatch to whichever Provider implementation the Host froze with the Run authority.
   * This callback never recognizes a Provider by name; it forwards `route` and `accountId`
   * verbatim to the Host's provider-executor invocation.
   */
  enhanceVideo?: (input: {
    projectId: string;
    invocationId: string;
    taskId: string;
    reference: ExecutableVideoEnhanceReference;
    modelId: string;
    route: ActionRunModelRoute;
    params: ExecutablePluginJsonValue;
    poll?: ExecutablePluginJsonValue;
  }) => Promise<ExecutableVideoEnhanceResult>;
  audit?: (record: LocalPluginBrokerAuditRecord) => Promise<void> | void;
  now?: () => number;
}

function requestTarget(
  operation: Parameters<PluginBroker>[0]["operation"],
): string {
  if (operation.kind === "store.get" || operation.kind === "store.put")
    return operation.key;
  if (operation.kind === "asset.resolve") {
    if ("asset" in operation.reference) {
      return operation.reference.asset.assetId;
    }
    if ("document" in operation.reference) {
      return `${operation.reference.document.documentAssetId}/${operation.reference.document.revisionId}`;
    }
    return `${operation.reference.slot}:${operation.reference.index}`;
  }
  if (
    operation.kind === "asset.write" ||
    operation.kind === "asset.upload-slot"
  )
    return operation.slot;
  if (operation.kind === "codex.image.generate") return "codex.imagegen";
  if (operation.kind === "director.stage.capture-frame") return operation.label;
  if (operation.kind === "media.analyze") {
    return operation.reference.asset.assetId;
  }
  if (operation.kind === "speech.transcribe") {
    return operation.reference.asset.assetId;
  }
  if (operation.kind === "video.enhance") {
    return operation.reference.asset.assetId;
  }
  throw new Error(
    `Unsupported plugin broker operation ${String(
      (operation as unknown as { kind?: unknown }).kind,
    )}.`,
  );
}

export function createLocalExecutablePluginBroker(
  options: LocalExecutablePluginBrokerOptions,
): PluginBroker {
  const now = options.now ?? Date.now;

  interface InvocationLeases {
    opening: number;
    terminal: boolean;
    releases: Set<() => Promise<void>>;
  }
  const invocationLeases = new Map<string, InvocationLeases>();

  const leaseState = (invocationId: string): InvocationLeases => {
    const existing = invocationLeases.get(invocationId);
    if (existing) return existing;
    const created: InvocationLeases = {
      opening: 0,
      terminal: false,
      releases: new Set(),
    };
    invocationLeases.set(invocationId, created);
    return created;
  };

  const once = (release: () => Promise<void> | void): (() => Promise<void>) => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await release();
    };
  };

  const registerCapability = async (
    invocationId: string,
    state: InvocationLeases,
    release: () => Promise<void> | void,
  ): Promise<() => Promise<void>> => {
    const releaseOnce = once(release);
    if (state.terminal) {
      await releaseOnce().catch(() => undefined);
    } else {
      state.releases.add(releaseOnce);
    }
    return releaseOnce;
  };

  const finishOpening = (invocationId: string, state: InvocationLeases) => {
    state.opening -= 1;
    if (state.terminal && state.opening === 0 && state.releases.size === 0) {
      invocationLeases.delete(invocationId);
    }
  };

  const broker: PluginBroker = async (request, context) => {
    const target = requestTarget(request.operation);
    const dependencyError = executablePluginDependencyError(
      context.manifest,
      request,
    );
    const audit = async (status: "ok" | "error", error?: string) => {
      await options.audit?.({
        pluginId: context.manifest.id,
        pluginVersion: context.manifest.version,
        projectId: context.invocation.projectId,
        invocationId: request.invocationId,
        requestId: request.requestId,
        operation: request.operation
          .kind as LocalPluginBrokerAuditRecord["operation"],
        target,
        status,
        ...(error ? { error } : {}),
        occurredAt: new Date(now()).toISOString(),
      });
    };

    try {
      if (dependencyError) throw new Error(dependencyError);
      if (request.invocationId !== context.invocation.invocationId) {
        throw new Error(
          "Broker request invocation does not match the active invocation.",
        );
      }
      let result: ExecutablePluginJsonValue;
      const operation = request.operation;
      if (operation.kind === "asset.resolve") {
        if ("text" in operation.reference) {
          result = ExecutablePluginBrokerResolvedReferenceSchema.parse({
            form: "text",
            text: operation.reference.text.value,
          });
          await audit("ok");
          return result;
        }
        if ("document" in operation.reference) {
          const reference = operation.reference;
          const authorized = context.invocation.input.references.some(
            (candidate) =>
              "document" in candidate &&
              candidate.slot === reference.slot &&
              candidate.index === reference.index &&
              candidate.document.documentAssetId ===
                reference.document.documentAssetId &&
              candidate.document.revisionId === reference.document.revisionId &&
              candidate.document.documentKind ===
                reference.document.documentKind &&
              candidate.document.schemaVersion ===
                reference.document.schemaVersion,
          );
          if (!authorized) {
            throw new LocalPluginBrokerAuthorizationError(
              reference.slot,
              reference.index,
            );
          }
          if (!options.readDocument) {
            throw new Error("Local Document broker is unavailable.");
          }
          const document = await options.readDocument({
            projectId: context.invocation.projectId,
            documentAssetId: reference.document.documentAssetId,
            revisionId: reference.document.revisionId,
          });
          if (
            document.documentKind !== reference.document.documentKind ||
            document.schemaVersion !== reference.document.schemaVersion
          ) {
            throw new Error(
              `Document ${reference.document.documentAssetId}/${reference.document.revisionId} no longer matches its frozen kind contract.`,
            );
          }
          result = ExecutablePluginBrokerResolvedReferenceSchema.parse({
            form: "document",
            ...document,
          });
          await audit("ok");
          return result;
        }
        const reference = operation.reference;
        const authorized = context.invocation.input.references.some(
          (candidate) =>
            "asset" in candidate && isDeepStrictEqual(candidate, reference),
        );
        if (!authorized) {
          throw new LocalPluginBrokerAuthorizationError(
            reference.slot,
            reference.index,
          );
        }
        const executorDeliveries = context.invocation.assetInputs.filter(
          (entry) => {
            const kindMatches =
              !entry.match.kinds?.length ||
              entry.match.kinds.includes(reference.asset.kind);
            const slotMatches =
              !entry.match.slots?.length ||
              entry.match.slots.includes(reference.slot);
            const frozenMediaTypeMatches =
              !entry.mediaTypes?.length ||
              !reference.asset.mediaType ||
              entry.mediaTypes.includes(reference.asset.mediaType);
            return (
              kindMatches &&
              slotMatches &&
              frozenMediaTypeMatches &&
              entry.representations.includes("executor-url")
            );
          },
        );
        if (executorDeliveries.length > 0 && options.openExecutorAsset) {
          const state = leaseState(context.invocation.invocationId);
          state.opening += 1;
          let capability: LocalExecutorAssetCapability | undefined;
          let releaseCapability: (() => Promise<void>) | undefined;
          try {
            capability = await options.openExecutorAsset({
              pluginId: context.manifest.id,
              pluginVersion: context.manifest.version,
              projectId: context.invocation.projectId,
              invocationId: context.invocation.invocationId,
              assetId: reference.asset.assetId,
              kind: reference.asset.kind,
              ...(reference.asset.mediaType
                ? { mediaType: reference.asset.mediaType }
                : {}),
            });
            releaseCapability = await registerCapability(
              context.invocation.invocationId,
              state,
              capability.release,
            );
            if (capability.kind !== reference.asset.kind) {
              await releaseCapability().catch(() => undefined);
              state.releases.delete(releaseCapability);
              throw new Error(
                `Asset ${reference.asset.assetId} kind ${capability.kind} does not match ${reference.asset.kind}.`,
              );
            }
            if (
              reference.asset.mediaType &&
              capability.mediaType &&
              capability.mediaType !== reference.asset.mediaType
            ) {
              await releaseCapability().catch(() => undefined);
              state.releases.delete(releaseCapability);
              throw new Error(
                `Asset ${reference.asset.assetId} media type ${capability.mediaType} does not match ${reference.asset.mediaType}.`,
              );
            }
            const delivery = executorDeliveries.find(
              (entry) =>
                !entry.mediaTypes?.length ||
                (!!capability?.mediaType &&
                  entry.mediaTypes.includes(capability.mediaType)),
            );
            if (!delivery) {
              await releaseCapability().catch(() => undefined);
              state.releases.delete(releaseCapability);
              throw new Error(
                `Provider binding declares no delivery for ${reference.slot} ${capability.kind}` +
                  `${capability.mediaType ? ` (${capability.mediaType})` : ""}.`,
              );
            }
            result = ExecutablePluginBrokerResolvedReferenceSchema.parse({
              form: "executor-url",
              executorUrl: capability.executorUrl,
              expiresAt: capability.expiresAt,
              kind: capability.kind,
              ...(capability.mediaType
                ? { mediaType: capability.mediaType }
                : {}),
            });
            await audit("ok");
            return result;
          } catch (error) {
            if (capability && !releaseCapability) {
              await Promise.resolve(capability.release()).catch(
                () => undefined,
              );
            }
            throw error;
          } finally {
            finishOpening(context.invocation.invocationId, state);
          }
        }
        if (!options.readAsset)
          throw new Error("Local asset broker is unavailable.");
        const asset = await options.readAsset({
          assetId: reference.asset.assetId,
          projectId: context.invocation.projectId,
        });
        if (asset.kind !== reference.asset.kind) {
          throw new Error(
            `Asset ${reference.asset.assetId} kind ${asset.kind} does not match ${reference.asset.kind}.`,
          );
        }
        const delivery = context.invocation.assetInputs.find((entry) => {
          const kindMatches =
            !entry.match.kinds?.length ||
            entry.match.kinds.includes(asset.kind);
          const slotMatches =
            !entry.match.slots?.length ||
            entry.match.slots.includes(reference.slot);
          const mediaTypeMatches =
            !entry.mediaTypes?.length ||
            (!!asset.mediaType && entry.mediaTypes.includes(asset.mediaType));
          return kindMatches && slotMatches && mediaTypeMatches;
        });
        if (!delivery) {
          throw new Error(
            `Provider binding declares no delivery for ${reference.slot} ${asset.kind}` +
              `${asset.mediaType ? ` (${asset.mediaType})` : ""}.`,
          );
        }
        if (delivery.representations.includes("provider-url")) {
          // Accepting a URL does not authorise a new public copy. When bytes are also accepted,
          // reuse an existing projection or stay local and send bytes. Publishing is reserved for
          // URL-only bindings, where the Provider cannot execute without a fetchable projection.
          const requiresProviderUrl =
            !delivery.representations.includes("bytes");
          const published =
            asset.providerUrl ??
            (requiresProviderUrl && options.publishAsset
              ? await options.publishAsset({
                  pluginId: context.manifest.id,
                  pluginVersion: context.manifest.version,
                  projectId: context.invocation.projectId,
                  invocationId: context.invocation.invocationId,
                  assetId: reference.asset.assetId,
                  kind: asset.kind,
                  ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
                  bytes: asset.bytes,
                })
              : undefined);
          if (published) {
            result = ExecutablePluginBrokerResolvedReferenceSchema.parse({
              form: "provider-url",
              providerUrl:
                "providerUrl" in published
                  ? published.providerUrl
                  : published.url,
              expiresAt: published.expiresAt,
              kind: asset.kind,
              ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
            });
            await audit("ok");
            return result;
          }
        }
        if (delivery.representations.includes("bytes")) {
          result = ExecutablePluginBrokerResolvedReferenceSchema.parse({
            form: "bytes",
            bytesBase64: Buffer.from(asset.bytes).toString("base64"),
            kind: asset.kind,
            ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
          });
        } else {
          throw new Error(
            `Provider binding requires a public URL for ${reference.slot}, but the Host cannot provide one.`,
          );
        }
      } else if (operation.kind === "director.stage.capture-frame") {
        if (
          context.manifest.id !== "clash.director" ||
          context.invocation.target.pluginId !== "clash.director" ||
          context.invocation.target.kind !== "action" ||
          context.invocation.target.exportId !== "capture-frame"
        ) {
          throw new Error(
            "The Director Stage capture Host tool is reserved for clash.director/capture-frame.",
          );
        }
        const frozen = context.invocation.input.values;
        if (
          !isDeepStrictEqual(operation.stage, frozen.stage) ||
          !isDeepStrictEqual(operation.label, frozen.label) ||
          !isDeepStrictEqual(operation.timeSeconds, frozen.timeSeconds) ||
          !isDeepStrictEqual(operation.aspectRatio, frozen.aspectRatio) ||
          !isDeepStrictEqual(operation.longEdge, frozen.longEdge)
        ) {
          throw new Error(
            "Director Stage capture request does not match the frozen invocation input.",
          );
        }
        if (!options.captureDirectorStageFrame) throw new Error("Director Stage capture broker is unavailable.");
        result = await options.captureDirectorStageFrame({
          projectId: context.invocation.projectId,
          invocationId: context.invocation.invocationId,
          taskId: context.invocation.taskId,
          stage: operation.stage,
          label: operation.label,
          timeSeconds: operation.timeSeconds,
          aspectRatio: operation.aspectRatio,
          longEdge: operation.longEdge,
        });
      } else if (operation.kind === "media.analyze") {
        if (!context.manifest.contributes.hostTools.includes("media.analyze")) {
          throw new Error(
            `Plugin ${context.manifest.id} did not declare media.analyze.`,
          );
        }
        if (!options.analyzeMedia) {
          throw new Error("Media analysis is unavailable in this Clash runtime.");
        }
        const frozenValues = context.invocation.input.values;
        const frozenConsumer = frozenValues.modelConsumer;
        const frozenOutputs =
          frozenConsumer &&
          typeof frozenConsumer === "object" &&
          !Array.isArray(frozenConsumer) &&
          Array.isArray(frozenConsumer.outputs)
            ? frozenConsumer.outputs
            : [];
        const frozenOutput = frozenOutputs.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            candidate.slot === operation.category,
        );
        const frozenCategories = frozenValues.categories;
        if (
          frozenValues.modelId !== operation.modelId ||
          !Array.isArray(frozenCategories) ||
          frozenCategories.length !== 1 ||
          frozenCategories[0] !== operation.category ||
          !frozenOutput ||
          typeof frozenOutput !== "object" ||
          Array.isArray(frozenOutput) ||
          frozenOutput.prompt !== operation.prompt ||
          frozenOutput.promptVersion !== operation.promptVersion ||
          (frozenOutput.responseFormat ?? "json") !== (operation.responseFormat ?? "json")
        ) {
          throw new Error(
            "Media analysis request does not match the frozen invocation model, category, prompt, or prompt version.",
          );
        }
        const frozenRouteParse = ActionRunModelRouteSchema.safeParse(
          frozenValues.modelRoute,
        );
        if (!frozenRouteParse.success) {
          throw new Error(
            "Media analysis invocation is missing the Host-frozen Provider route.",
          );
        }
        const authorized = context.invocation.input.references.some(
          (candidate) => isDeepStrictEqual(candidate, operation.reference),
        );
        if (!authorized) {
          throw new LocalPluginBrokerAuthorizationError(
            operation.reference.slot,
            operation.reference.index,
          );
        }
        result = ExecutableMediaAnalysisResultSchema.parse(
          await options.analyzeMedia({
            projectId: context.invocation.projectId,
            invocationId: context.invocation.invocationId,
            taskId: context.invocation.taskId,
            reference: operation.reference,
            modelId: operation.modelId,
            route: frozenRouteParse.data,
            category: operation.category,
            prompt: operation.prompt,
            promptVersion: operation.promptVersion,
            ...(operation.responseFormat ? { responseFormat: operation.responseFormat } : {}),
          }),
        ) as ExecutablePluginJsonValue;
      } else if (operation.kind === "speech.transcribe") {
        if (context.manifest.id !== "clash.asr") {
          throw new Error(
            "The speech transcription Host tool is reserved for clash.asr.",
          );
        }
        if (!options.transcribeSpeech) {
          throw new Error(
            "Speech transcription is unavailable in this Clash runtime.",
          );
        }
        const authorized = context.invocation.input.references.some(
          (candidate) => isDeepStrictEqual(candidate, operation.reference),
        );
        if (!authorized) {
          throw new LocalPluginBrokerAuthorizationError(
            operation.reference.slot,
            operation.reference.index,
          );
        }
        const transcription = ExecutableSpeechTranscriptionResultSchema.parse(
          await options.transcribeSpeech({
            projectId: context.invocation.projectId,
            invocationId: context.invocation.invocationId,
            taskId: context.invocation.taskId,
            reference: operation.reference,
            modelId: operation.modelId,
            ...(operation.language === undefined
              ? {}
              : { language: operation.language }),
            ...(operation.poll === undefined ? {} : { poll: operation.poll }),
          }),
        );
        result = transcription as ExecutablePluginJsonValue;
      } else if (operation.kind === "video.enhance") {
        if (!context.manifest.contributes.hostTools.includes("video.enhance")) {
          throw new Error(
            `Plugin ${context.manifest.id} did not declare video.enhance.`,
          );
        }
        if (!options.enhanceVideo) {
          throw new Error("Video enhancement is unavailable in this Clash runtime.");
        }
        const frozenValues = context.invocation.input.values;
        if (frozenValues.modelId !== operation.modelId) {
          throw new Error(
            "Video enhancement request does not match the frozen invocation model.",
          );
        }
        const frozenRouteParse = ActionRunModelRouteSchema.safeParse(
          frozenValues.modelRoute,
        );
        if (!frozenRouteParse.success) {
          throw new Error(
            "Video enhancement invocation is missing the Host-frozen Provider route.",
          );
        }
        const authorized = context.invocation.input.references.some(
          (candidate) => isDeepStrictEqual(candidate, operation.reference),
        );
        if (!authorized) {
          throw new LocalPluginBrokerAuthorizationError(
            operation.reference.slot,
            operation.reference.index,
          );
        }
        result = ExecutableVideoEnhanceResultSchema.parse(
          await options.enhanceVideo({
            projectId: context.invocation.projectId,
            invocationId: context.invocation.invocationId,
            taskId: context.invocation.taskId,
            reference: operation.reference,
            modelId: operation.modelId,
            route: frozenRouteParse.data,
            params: operation.params,
            ...(operation.poll === undefined ? {} : { poll: operation.poll }),
          }),
        ) as ExecutablePluginJsonValue;
      } else if (operation.kind === "store.get") {
        if (!options.storeGet)
          throw new Error("Local plugin store is unavailable.");
        if (!context.accountId) {
          throw new Error(
            "Plugin store access requires a Host-selected provider account.",
          );
        }
        const stored = await options.storeGet({
          pluginId: context.manifest.id,
          accountId: context.accountId,
          key: operation.key,
        });
        const account =
          stored === undefined
            ? (await options.loadProviderAccounts()).find(
                (candidate) =>
                  candidate.enabled && candidate.id === context.accountId,
              )
            : undefined;
        if (stored === undefined && !account) {
          throw new Error(
            `Host-selected provider account ${context.accountId} is unavailable.`,
          );
        }
        const value = stored ?? account?.credentials?.[operation.key];
        result = {
          // `null`, not `undefined`. An unset key used to answer `{ value: undefined }`, which
          // serialises to `{}` -- the plugin then saw a value-shaped object with no value in it.
          // clash.google asks for `service` and `region`, and an account holding a service account
          // key has neither, so the first optional lookup any Google account made killed the
          // invocation with a wall of union errors about a key that was simply not set.
          value: value ?? null,
        } as never;
      } else if (operation.kind === "store.put") {
        if (!options.storePut)
          throw new Error("Local plugin store is unavailable.");
        if (!context.accountId) {
          throw new Error(
            "Plugin store access requires a Host-selected provider account.",
          );
        }
        await options.storePut({
          pluginId: context.manifest.id,
          accountId: context.accountId,
          key: operation.key,
          value: operation.value,
          ...(operation.secret === undefined
            ? {}
            : { secret: operation.secret }),
          ...(operation.expiresAt === undefined
            ? {}
            : { expiresAt: operation.expiresAt }),
        });
        result = { ok: true } as never;
      } else if (operation.kind === "asset.upload-slot") {
        if (!options.openUploadSlot)
          throw new Error("Local upload slots are unavailable.");
        result = (await options.openUploadSlot({
          pluginId: context.manifest.id,
          pluginVersion: context.manifest.version,
          projectId: context.invocation.projectId,
          invocationId: context.invocation.invocationId,
          taskId: context.invocation.taskId,
          slot: operation.slot,
          kind: operation.assetKind,
          ...(operation.mediaType ? { mediaType: operation.mediaType } : {}),
          ...(context.accountId ? { accountId: context.accountId } : {}),
          // Only what the plugin actually said. A url has no byte count until someone fetches it,
          // and inventing a zero here would announce a size the host would then enforce.
          ...(operation.byteLength === undefined
            ? {}
            : { byteLength: operation.byteLength }),
          ...(operation.url === undefined ? {} : { url: operation.url }),
        })) as never;
      } else if (operation.kind === "asset.write") {
        if (operation.assetId) {
          // The bytes are already stored; this only names them.
          if (!options.finishUpload)
            throw new Error("Local upload slots are unavailable.");
          result = (await options.finishUpload({
            pluginId: context.manifest.id,
            pluginVersion: context.manifest.version,
            projectId: context.invocation.projectId,
            invocationId: context.invocation.invocationId,
            taskId: context.invocation.taskId,
            slot: operation.slot,
            kind: operation.assetKind,
            ...(operation.mediaType ? { mediaType: operation.mediaType } : {}),
            ...(context.accountId ? { accountId: context.accountId } : {}),
            assetId: operation.assetId,
          })) as never;
          await audit("ok");
          return result;
        }
        if (operation.url) {
          if (!options.openUploadSlot)
            throw new Error("Local upload slots are unavailable.");
          result = (await options.openUploadSlot({
            pluginId: context.manifest.id,
            pluginVersion: context.manifest.version,
            projectId: context.invocation.projectId,
            invocationId: context.invocation.invocationId,
            taskId: context.invocation.taskId,
            slot: operation.slot,
            kind: operation.assetKind,
            ...(operation.mediaType ? { mediaType: operation.mediaType } : {}),
            ...(context.accountId ? { accountId: context.accountId } : {}),
            url: operation.url,
          })) as never;
          await audit("ok");
          return result;
        }
        if (!options.writeAsset)
          throw new Error("Local asset write broker is unavailable.");
        if (!operation.dataBase64) {
          throw new Error(
            "Local asset.write requires dataBase64, or an assetId from an upload slot.",
          );
        }
        const bytes = new Uint8Array(
          Buffer.from(operation.dataBase64, "base64"),
        );
        result = await options.writeAsset({
          pluginId: context.manifest.id,
          pluginVersion: context.manifest.version,
          projectId: context.invocation.projectId,
          invocationId: context.invocation.invocationId,
          taskId: context.invocation.taskId,
          slot: operation.slot,
          kind: operation.assetKind,
          ...(operation.mediaType ? { mediaType: operation.mediaType } : {}),
          ...(context.accountId ? { accountId: context.accountId } : {}),
          bytes,
        });
      } else if (operation.kind === "codex.image.generate") {
        if (!options.generateCodexImage) {
          throw new Error(
            "Codex ImageGen is unavailable in this Clash runtime.",
          );
        }
        if (!options.readAsset || !options.writeAsset) {
          throw new Error(
            "Codex ImageGen requires local asset read and write brokers.",
          );
        }
        for (const [index, reference] of operation.references.entries()) {
          const authorized = context.invocation.input.references.some(
            (candidate) =>
              "asset" in candidate &&
              candidate.asset.assetId === reference.assetId &&
              candidate.asset.kind === reference.kind,
          );
          if (!authorized) {
            throw new LocalPluginBrokerAuthorizationError(
              "codex.imagegen",
              index,
            );
          }
        }
        const references = await Promise.all(
          operation.references.map(async (asset) => {
            const resolved = await options.readAsset!({
              assetId: asset.assetId,
              projectId: context.invocation.projectId,
            });
            if (resolved.kind !== "image") {
              throw new Error(
                `Codex ImageGen reference ${asset.assetId} is not an image.`,
              );
            }
            return {
              asset,
              ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
              bytes: resolved.bytes,
            };
          }),
        );
        const generated = await options.generateCodexImage({
          prompt: operation.prompt,
          aspectRatio: operation.aspectRatio,
          references,
        });
        result = await options.writeAsset({
          pluginId: context.manifest.id,
          pluginVersion: context.manifest.version,
          projectId: context.invocation.projectId,
          invocationId: context.invocation.invocationId,
          taskId: context.invocation.taskId,
          slot: operation.slot,
          kind: "image",
          mediaType: generated.mediaType,
          bytes: generated.bytes,
        });
      } else {
        throw new Error(
          `Unsupported plugin broker operation ${String(
            (operation as unknown as { kind?: unknown }).kind,
          )}.`,
        );
      }
      await audit("ok");
      return result;
    } catch (error) {
      await audit("error", (error as Error).message);
      throw error;
    }
  };

  broker.releaseInvocation = async (invocationId) => {
    const state = invocationLeases.get(invocationId);
    if (!state || state.terminal) return;
    state.terminal = true;
    const releases = [...state.releases];
    state.releases.clear();
    await Promise.allSettled(releases.map((release) => release()));
    if (state.opening === 0) invocationLeases.delete(invocationId);
  };

  return broker;
}
