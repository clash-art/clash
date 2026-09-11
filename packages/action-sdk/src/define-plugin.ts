import type { Readable, Writable } from "node:stream";

import {
  ExecutablePluginBrokerResolvedReferenceSchema,
  ExecutablePluginAssetHandleSchema,
  ExecutablePluginOutputSchema,
  ExecutableMediaAnalysisResultSchema,
  ExecutableDirectorStageCaptureResultSchema,
  ExecutableSpeechTranscriptionResultSchema,
  ExecutableVideoEnhanceResultSchema,
  ExecutableAgentTextResultSchema,
  type ExecutableAgentTextOperation,
  type ExecutableAgentTextResult,
  type ExecutablePluginBrokerResolvedReference,
  type ExecutablePluginReference,
  type ExecutablePluginAssetHandle,
  type ExecutablePluginBrokerOperation,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type ExecutablePluginOutput,
  type ExecutablePluginResult,
  type ExecutableMediaAnalysisOperation,
  type ExecutableMediaAnalysisResult,
  type ExecutableDirectorStageCaptureOperation,
  type ExecutableDirectorStageCaptureResult,
  type ExecutableSpeechTranscriptionOperation,
  type ExecutableSpeechTranscriptionResult,
  type ExecutableVideoEnhanceOperation,
  type ExecutableVideoEnhanceResult,
} from "@clash/shared-types/executable-plugin";

import {
  defineStdioExecutablePlugin,
  type StdioExecutablePluginOptions,
} from "./stdio-plugin.js";
import { unsupportedAcceptedOperation } from "./executable-failure.js";

/**
 * What a plugin is: a set of executors, declared.
 *
 * The entry file used to read stdin, parse lines, match `target.exportId` against a table, split
 * submit from poll, normalise a step into a result, and write frames. first-party-media,
 * codex-imagegen and hilo-hub-media each carried a version of that, and they had already drifted --
 * one answered malformed input with a failure frame, another built a sentinel object and handed it
 * to the handler.
 *
 * None of that is the author's subject. What they know is which executors exist and how each one
 * talks to a vendor, so that is all this asks for.
 */

/**
 * One file a generation produced, in whichever form the vendor gave it.
 *
 * Three, because that is what vendors return: Google answers `:generateContent` with base64, fal
 * publishes a url, and an SDK client hands back bytes. Normalising them in the plugin would mean
 * downloading a url to produce bytes -- paying for a round trip to satisfy a shape.
 */
export type MediaData =
  | { bytes: Uint8Array; mediaType?: string; kind?: AssetKindName }
  | { base64: string; mediaType?: string; kind?: AssetKindName }
  | { url: string; mediaType?: string; kind?: AssetKindName };

export type AssetKindName = "image" | "video" | "audio" | "model";

/**
 * One reference resolved into the delivery form declared by its exact execution contract.
 *
 * A reference used to arrive as a handle the plugin resolved itself by sending a raw frame, so
 * one plugin had two idioms: return data, but fetch data. An executor that forgot to resolve
 * produced a request carrying `clash-asset://...` where a vendor expected an image.
 *
 * `provider-url` is handed back only when the upstream Provider can fetch it. `executor-url` is a
 * short-lived Host capability reachable by the current executor, such as a bundled renderer; it
 * must not be substituted for a Provider URL or persisted as Asset identity.
 */
export type ResolvedReference =
  | {
      form: "provider-url";
      providerUrl: string;
      expiresAt: string;
      mediaType?: string;
      kind?: AssetKindName;
    }
  | {
      form: "executor-url";
      executorUrl: string;
      expiresAt: string;
      mediaType?: string;
      kind?: AssetKindName;
    }
  | {
      form: "bytes";
      bytes: Uint8Array;
      mediaType?: string;
      kind?: AssetKindName;
    }
  | { form: "text"; text: string }
  | {
      form: "document";
      documentKind: string;
      schemaVersion: number;
      body: ExecutablePluginJsonValue;
    };

/**
 * One step of work, as an executor reports it.
 *
 * `pollState` is whatever the executor needs to find this task again -- the host stores it opaquely
 * and hands it back unread. Typed loosely on purpose: a provider's task id, cursor and phase are
 * its own business, and narrowing this would make every plugin cast.
 *
 * `retryAfterMs` is the provider's own pacing when it states one. Without it the host polls on its
 * own schedule, which is either too eager for the provider or too slow for the user.
 */
export type ExecutorStep =
  | { status: "completed"; outputs: ExecutablePluginOutput[] }
  /** Files, named by the plugin. The SDK uploads them and builds the outputs. */
  | { status: "completed"; media: Record<string, MediaData> }
  | {
      status: "accepted";
      pollState: ExecutablePluginJsonValue;
      retryAfterMs?: number;
    }
  | {
      status: "failed";
      error: Extract<ExecutablePluginResult, { status: "failed" }>["error"];
    };

/**
 * What a plugin keeps, already bound to this plugin and this account.
 *
 * Injected rather than imported. An imported store would be ambient -- initialised somewhere,
 * addressed by an id from somewhere, reachable by any code in the process. This one takes a key and
 * nothing else, because the two components that decide whose data it is were fixed by the host when
 * it spawned the process. There is no argument through which an executor could name another plugin.
 */
export interface PluginStoreHandle {
  get(key: string): Promise<string | undefined>;
  put(
    key: string,
    value: string,
    options?: { secret?: boolean; expiresAt?: number },
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Bytes on their way to becoming an asset the protocol can carry. */
export interface AssetWriteRequest {
  slot: string;
  kind: "image" | "video" | "audio" | "model";
  mediaType?: string;
  /** The bytes, when the plugin holds them. */
  dataBase64?: string;
  /** Where they already live, when the upstream published a url the host can fetch itself. */
  url?: string;
}

/** Bytes too large to enclose, on their way to storage the host names. */
export interface AssetUploadRequest {
  slot: string;
  kind: "image" | "video" | "audio" | "model";
  mediaType?: string;
  bytes?: Uint8Array;
  /** A vendor-published result the Host should ingest directly. */
  url?: string;
}

export interface DocumentOutputRequest {
  slot: string;
  documentKind: string;
  schemaVersion: number;
  body: ExecutablePluginJsonValue;
}

export interface CodexImageGenerateRequest {
  prompt: string;
  aspectRatio: string;
  slot: string;
  references?: ExecutablePluginAssetHandle[];
}

export type MediaAnalyzeRequest = Omit<
  ExecutableMediaAnalysisOperation,
  "kind"
>;
export type MediaAnalyzeResult = ExecutableMediaAnalysisResult;

export type SpeechTranscribeRequest = Omit<
  ExecutableSpeechTranscriptionOperation,
  "kind"
>;
export type SpeechTranscribeResult = ExecutableSpeechTranscriptionResult;

/** Credential-free request to the generic video-enhance Host tool; never names a Provider. */
export type VideoEnhanceRequest = Omit<ExecutableVideoEnhanceOperation, "kind">;
export type VideoEnhanceResult = ExecutableVideoEnhanceResult;

export type DirectorStageCaptureRequest = Omit<
  ExecutableDirectorStageCaptureOperation,
  "kind"
>;
export type DirectorStageCaptureResult = ExecutableDirectorStageCaptureResult;

export interface PluginHostTools {
  agentText(request: Omit<ExecutableAgentTextOperation, "kind">): Promise<ExecutableAgentTextResult>;
  codexImagegen: {
    generate(
      request: CodexImageGenerateRequest,
    ): Promise<ExecutablePluginAssetHandle>;
  };
  directorStageCaptureFrame(
    request: DirectorStageCaptureRequest,
  ): Promise<DirectorStageCaptureResult>;
  mediaAnalyze(request: MediaAnalyzeRequest): Promise<MediaAnalyzeResult>;
  speechTranscribe(
    request: SpeechTranscribeRequest,
  ): Promise<SpeechTranscribeResult>;
  /** Host-frozen route dispatch: enhance one video through whichever Provider was selected. */
  videoEnhance(request: VideoEnhanceRequest): Promise<VideoEnhanceResult>;
}

/**
 * Host dependencies visible to plugin business code.
 *
 * The stdio request/response operation is deliberately absent. Authors receive the contribution
 * shapes they use; only the transport layer knows how those methods become protocol frames.
 */
export interface ExecutorContext {
  /**
   * Store large bytes without enclosing them.
   *
   * The host names a place, the plugin streams to it, and the frame carries only the handle. One
   * 30-second video is 3,470,456 characters as base64 inside a frame, held simultaneously by the
   * plugin, the pipe and the host while it is parsed.
   *
   * The same call is a presigned object-storage URL in a hosted deployment, so this is not a local
   * shortcut -- it is the shape that works in both.
   */
  upload(request: AssetUploadRequest): Promise<ExecutablePluginOutput>;
  /**
   * Store bytes and get back the handle an output is made of.
   *
   * The protocol's output is `{ assetId, uri: "clash-asset://…", kind, mediaType }`. Executors were
   * returning `{ kind: "inline", dataBase64 }`, which is not that shape, and only type-checked
   * because the plugin had declared a looser contract of its own.
   */
  asset(request: AssetWriteRequest): Promise<ExecutablePluginOutput>;
  /** Build one typed Document result. Publication and revision authority remain Host-owned. */
  document(request: DocumentOutputRequest): Promise<ExecutablePluginOutput>;
  /** Credentials and settings this account stored. Bound; see PluginStoreHandle. */
  store: PluginStoreHandle;
  /** Resolve one invocation reference using the pinned Provider binding's delivery declaration. */
  reference(reference: ExecutablePluginReference): Promise<ResolvedReference>;
  /** Host tools named by the plugin's contributions. */
  hostTools: PluginHostTools;
}

/** Invocation-scoped Host implementations may override only the tools they exercise. */
export type ExecutorContextOverrides = Omit<
  Partial<ExecutorContext>,
  "hostTools"
> & {
  hostTools?: Partial<PluginHostTools>;
};

export interface Executor {
  submit(
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ): Promise<ExecutorStep>;
  /** Only for providers that answer later. Omitting it says this one answers at once. */
  poll?(
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ): Promise<ExecutorStep>;
  /** Reserved future ABI: translate a Provider callback for already-accepted work. */
  callback?(
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ): Promise<ExecutorStep>;
}

export interface PluginDefinition {
  executors: Record<string, Executor>;
}

export interface DefinedPlugin {
  readonly executors: Record<string, Executor>;
  /** Begin reading invocations. Resolves when the input ends and everything in flight has answered. */
  start(options?: StdioExecutablePluginOptions): Promise<void>;
}

/** What kind of asset this is, from the media type when the plugin did not say. */
function assetKindOf(media: MediaData): AssetKindName {
  if (media.kind) return media.kind;
  const mediaType = media.mediaType ?? "";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "image";
}

/**
 * Exported because two assemblers reach the host.
 *
 * `assemblePlugin` had its own normalisation that read `"outputs" in step` and answered `[]` for
 * anything else, so a media step went up as a completed frame with nothing in it -- no upload
 * attempted, the generation already paid for, and the node left with no asset. One function now,
 * rather than a second copy free to disagree with this one.
 */
export async function outputsFor(
  media: Record<string, MediaData>,
  context: ExecutorContext,
): Promise<ExecutablePluginOutput[]> {
  const outputs: ExecutablePluginOutput[] = [];
  // Sequential, so the outputs arrive in the order the plugin named them. A generation's frames are
  // an ordered thing, and a caller that has to re-sort them needs a rule nobody wrote down.
  for (const [slot, file] of Object.entries(media)) {
    const request = {
      slot,
      kind: assetKindOf(file),
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
    };

    if ("url" in file && file.url) {
      outputs.push(
        await context.upload!({ ...request, url: file.url } as never),
      );
      continue;
    }
    if ("bytes" in file && file.bytes) {
      outputs.push(await context.upload!({ ...request, bytes: file.bytes }));
      continue;
    }
    if ("base64" in file && file.base64) {
      outputs.push(
        await context.upload!({
          ...request,
          bytes: Uint8Array.from(Buffer.from(file.base64, "base64")),
        }),
      );
      continue;
    }
    // A name with nothing behind it would upload an empty asset and report success.
    throw new Error(`${slot} declares no bytes, base64 or url.`);
  }
  return outputs;
}

async function resultFor(
  invocation: ExecutablePluginInvocation,
  step: ExecutorStep,
  context: ExecutorContext,
): Promise<ExecutablePluginResult> {
  if (step.status === "accepted") {
    return {
      protocol: "clash.plugin.result/v1",
      invocationId: invocation.invocationId,
      status: "accepted",
      pollState: step.pollState,
      ...(step.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: step.retryAfterMs }),
    } satisfies ExecutablePluginResult;
  }
  if (step.status === "failed") {
    return {
      protocol: "clash.plugin.result/v1",
      invocationId: invocation.invocationId,
      status: "failed",
      error: step.error,
    } satisfies ExecutablePluginResult;
  }
  return {
    protocol: "clash.plugin.result/v1",
    invocationId: invocation.invocationId,
    status: "completed",
    outputs:
      "media" in step ? await outputsFor(step.media, context) : step.outputs,
  } satisfies ExecutablePluginResult;
}

/**
 * Build the runtime context an executor sees, from whatever the host handed in.
 *
 * `store`, `reference` and the upload path are all derived from the private Host transport, so anything that hands
 * an executor a context has to build them the same way. It lives here rather than being written
 * twice because `assemblePlugin` wrote the second copy by omission -- it passed `options.context`
 * straight through and dropped the transport, leaving assembled executors with no `context.store` at
 * all, which surfaced as a message about an unconfigured account.
 */
export type HostDependencyRequest = (
  operation: ExecutablePluginBrokerOperation,
) => Promise<ExecutablePluginJsonValue>;

function assetHandleFromHost(input: unknown): ExecutablePluginAssetHandle {
  try {
    return ExecutablePluginAssetHandleSchema.parse(input);
  } catch (error) {
    throw new Error("The Host returned an invalid Asset handle.", {
      cause: error,
    });
  }
}

export function createExecutorContext(
  merged: ExecutorContextOverrides = {},
  requestHost?: HostDependencyRequest,
): ExecutorContext {
  const host =
    requestHost ??
    (async () => {
      throw new Error(
        "This invocation arrived without injected Host dependencies.",
      );
    });

  return {
    ...merged,
    document:
      merged.document ??
      (async (request) =>
        ExecutablePluginOutputSchema.parse({
          slot: request.slot,
          kind: "document",
          document: {
            documentKind: request.documentKind,
            schemaVersion: request.schemaVersion,
            body: request.body,
          },
        })),
    reference:
      merged.reference ??
      (async (reference) => {
        let resolved: ExecutablePluginBrokerResolvedReference;
        try {
          resolved = ExecutablePluginBrokerResolvedReferenceSchema.parse(
            await host({ kind: "asset.resolve", reference }),
          );
        } catch (error) {
          throw new Error("The Host returned an invalid resolved reference.", {
            cause: error,
          });
        }
        if (
          resolved.form === "provider-url" ||
          resolved.form === "executor-url" ||
          resolved.form === "text" ||
          resolved.form === "document"
        ) {
          return resolved;
        }
        return {
          form: "bytes",
          bytes: Uint8Array.from(Buffer.from(resolved.bytesBase64, "base64")),
          ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
          ...(resolved.kind ? { kind: resolved.kind } : {}),
        };
      }),
    // Two calls, keyed by nothing but a key. Which plugin and which account is decided by the
    // spawn, so there is no field here for one to name another's credentials.
    store: merged.store ?? {
      get: async (key) => {
        const answer = (await host({
          kind: "store.get",
          key,
        } as never)) as unknown as { value?: string };
        // Missing stays missing. Turning it into "" is how an unset credential used to reach a
        // vendor and come back as a 401 that named the wrong problem.
        return answer?.value;
      },
      remove: async (key) => {
        await host({ kind: "store.put", key, value: "" } as never);
      },
      put: async (key, value, options) => {
        await host({
          kind: "store.put",
          key,
          value,
          ...(options?.secret === undefined ? {} : { secret: options.secret }),
          ...(options?.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(options.expiresAt).toISOString() }),
        } as never);
      },
    },
    upload:
      merged.upload ??
      (async (request) => {
        // A vendor that answers with a link never hands over bytes, so there is nothing to count.
        // Announcing `request.bytes.byteLength` unconditionally is what made the url form die on
        // "Cannot read properties of undefined (reading 'byteLength')" -- after a real generation
        // had completed upstream, so the work was done and the result dropped on the way home.
        const bytes = (request as { bytes?: Uint8Array }).bytes;
        const url = (request as { url?: string }).url;

        const slot = (await host({
          kind: "asset.upload-slot",
          slot: request.slot,
          assetKind: request.kind,
          ...(request.mediaType ? { mediaType: request.mediaType } : {}),
          ...(bytes ? { byteLength: bytes.byteLength } : {}),
          // Passed through rather than fetched. Downloading it to hand the host something it can
          // fetch itself pays for the transfer twice, and the host is the side that knows whether
          // it wants a copy.
          ...(url ? { url } : {}),
        } as never)) as unknown as {
          uploadUrl?: string;
          assetId?: string;
          uri?: string;
          kind?: AssetKindName;
          mediaType?: string;
        };

        if (url && slot.assetId) {
          return {
            slot: request.slot,
            kind: "asset",
            asset: assetHandleFromHost(slot),
          };
        }

        if (!slot.uploadUrl || !slot.assetId) {
          throw new Error(
            "The host did not provide an upload slot for this asset.",
          );
        }

        if (!request.bytes) {
          throw new Error(
            `Uploading ${request.slot} requires bytes or a provider URL.`,
          );
        }
        const response = await globalThis.fetch(slot.uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": request.mediaType ?? "application/octet-stream",
            "content-length": String(request.bytes.byteLength),
          },
          body: request.bytes as unknown as BodyInit,
        });
        if (!response.ok) {
          // A refused upload reported as completed would attach an empty asset and close a task
          // the provider has already been paid for.
          throw new Error(
            `Uploading ${request.slot} failed: ${response.status} ${response.statusText}.`,
          );
        }

        const handle = assetHandleFromHost(
          await host({
            kind: "asset.write",
            slot: request.slot,
            assetKind: request.kind,
            ...(request.mediaType ? { mediaType: request.mediaType } : {}),
            assetId: slot.assetId,
          } as never),
        );
        return { slot: request.slot, kind: "asset", asset: handle };
      }),

    asset:
      merged.asset ??
      (async (request) => {
        const handle = assetHandleFromHost(
          await host({
            kind: "asset.write",
            slot: request.slot,
            assetKind: request.kind,
            ...(request.mediaType ? { mediaType: request.mediaType } : {}),
            ...(request.dataBase64 ? { dataBase64: request.dataBase64 } : {}),
            ...(request.url ? { url: request.url } : {}),
          } as never),
        );
        return { slot: request.slot, kind: "asset", asset: handle };
      }),

    hostTools: {
      ...merged.hostTools,
      agentText: merged.hostTools?.agentText ?? (async (request) => {
        const response = await host({ kind: "agent.text.generate", ...request });
        try {
          return ExecutableAgentTextResultSchema.parse(response);
        } catch (error) {
          throw new Error("The Host returned an invalid agent text result.", { cause: error });
        }
      }),
      codexImagegen: merged.hostTools?.codexImagegen ?? {
        generate: async (request) =>
          assetHandleFromHost(
            await host({
              kind: "codex.image.generate",
              prompt: request.prompt,
              aspectRatio: request.aspectRatio,
              slot: request.slot,
              references: request.references ?? [],
            } as never),
          ),
      },
      directorStageCaptureFrame:
        merged.hostTools?.directorStageCaptureFrame ??
        (async (request) => {
          try {
            return ExecutableDirectorStageCaptureResultSchema.parse(
              await host({ kind: "director.stage.capture-frame", ...request }),
            );
          } catch (error) {
            throw new Error("The Host returned an invalid Director Stage capture.", { cause: error });
          }
        }),
      mediaAnalyze:
        merged.hostTools?.mediaAnalyze ??
        (async (request) => {
          try {
            return ExecutableMediaAnalysisResultSchema.parse(
              await host({ kind: "media.analyze", ...request }),
            );
          } catch (error) {
            throw new Error("The Host returned an invalid media analysis result.", {
              cause: error,
            });
          }
        }),
      speechTranscribe:
        merged.hostTools?.speechTranscribe ??
        (async (request) => {
          try {
            return ExecutableSpeechTranscriptionResultSchema.parse(
              await host({ kind: "speech.transcribe", ...request }),
            );
          } catch (error) {
            throw new Error(
              "The Host returned an invalid speech transcription result.",
              { cause: error },
            );
          }
        }),
      videoEnhance:
        merged.hostTools?.videoEnhance ??
        (async (request) => {
          try {
            return ExecutableVideoEnhanceResultSchema.parse(
              await host({ kind: "video.enhance", ...request }),
            );
          } catch (error) {
            throw new Error("The Host returned an invalid video enhancement result.", {
              cause: error,
            });
          }
        }),
    },
  };
}

/** @deprecated Prefer the public `createExecutorContext` name. */
export const executorContextFrom = createExecutorContext;

export function definePlugin(definition: PluginDefinition): DefinedPlugin {
  const handlers: Record<
    string,
    (
      invocation: ExecutablePluginInvocation,
      ctx: ExecutorContext,
    ) => Promise<ExecutablePluginResult>
  > = {};

  for (const [exportId, executor] of Object.entries(definition.executors)) {
    handlers[exportId] = async (invocation, hostContext) => {
      // The Host supplies a fresh, account-scoped SDK implementation for every invocation. The
      // plugin contributes only executor logic and cannot shadow those capabilities statically.
      const context = executorContextFrom(hostContext);

      if (invocation.operation === "poll") {
        if (!executor.poll) {
          // Answering "still running" here would wait forever. The host has already recorded an
          // acceptance this executor never returned, and hiding that once left a paid-for
          // generation uncollectable.
          throw new Error(
            `${exportId} answers at once and has no poll operation, but the host asked it to poll.`,
          );
        }
        return resultFor(
          invocation,
          await executor.poll(invocation, context),
          context,
        );
      }

      if (invocation.operation === "callback") {
        const step = executor.callback
          ? await executor.callback(invocation, context)
          : {
              status: "failed" as const,
              error: unsupportedAcceptedOperation(exportId, "callback"),
            };
        return resultFor(invocation, step, context);
      }

      return resultFor(
        invocation,
        await executor.submit(invocation, context),
        context,
      );
    };
  }

  return {
    executors: definition.executors,
    start: (options) => defineStdioExecutablePlugin(handlers, options).done,
  };
}

export type { Readable, Writable };
