import {
  buildPikaMediaRequest,
  createPikaMediaJob,
  generatePikaChat,
  getPikaMediaContent,
  getPikaMediaJob,
  uploadPikaMedia,
} from "@clash/shared-runtime/pika";
import {
  ProviderExecutionError,
  type Executor,
  type ExecutorContext,
  type ExecutorStep,
  type ExecutablePluginInvocation,
  type ExecutablePluginReference,
} from "@clash/action-sdk";

type MediaKind = "image" | "video" | "audio";

interface PikaPollState {
  jobId: string;
  phase?: "content";
}

interface PikaReferences {
  images: string[];
  videos: string[];
  audios: string[];
  startFrame?: string;
  endFrame?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderExecutionError({
      code: "invalid_request",
      message: `Pika request is missing ${key}.`,
      retryable: false,
      requestState: "rejected",
    });
  }
  return value;
}

function mediaKind(value: unknown): MediaKind {
  if (value === "image" || value === "video" || value === "audio") {
    return value;
  }
  throw new ProviderExecutionError({
    code: "invalid_request",
    message: `Pika does not support output kind ${String(value)}.`,
    retryable: false,
    requestState: "rejected",
  });
}

function pollState(value: unknown): PikaPollState {
  const state = record(value);
  if (typeof state.jobId !== "string" || !state.jobId) {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: "Pika poll state is missing its jobId.",
      retryable: false,
      requestState: "accepted",
    });
  }
  if (state.phase !== undefined && state.phase !== "content") {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: `Pika poll state has an unsupported phase: ${String(state.phase)}.`,
      retryable: false,
      requestState: "accepted",
    });
  }
  return {
    jobId: state.jobId,
    ...(state.phase === "content" ? { phase: state.phase } : {}),
  };
}

async function apiKey(
  context: ExecutorContext,
  requestState: "rejected" | "accepted",
): Promise<string> {
  const value = (await context.store.get("apiKey"))?.trim();
  if (!value) {
    throw new ProviderExecutionError({
      code: "authentication_failed",
      message: "This Pika account has no apiKey stored.",
      retryable: false,
      requestState,
    });
  }
  return value;
}

function sortedReferences(
  references: readonly ExecutablePluginReference[],
): ExecutablePluginReference[] {
  return references
    .map((reference, position) => ({ reference, position }))
    .sort(
      (left, right) =>
        left.reference.index - right.reference.index ||
        left.position - right.position,
    )
    .map(({ reference }) => reference);
}

function defaultMediaType(kind: MediaKind): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/wav";
}

async function referenceUrl(options: {
  reference: ExecutablePluginReference;
  kind: MediaKind;
  apiKey: string;
  context: ExecutorContext;
}): Promise<string> {
  const resolved = await options.context.reference(options.reference);
  if (resolved.form !== "provider-url" && resolved.form !== "bytes") {
    throw new ProviderExecutionError({
      code: "invalid_request",
      message: `Pika ${options.reference.slot} reference requires Provider-accessible media; ${resolved.form} is unsupported.`,
      retryable: false,
      requestState: "rejected",
    });
  }
  if (resolved.kind && resolved.kind !== options.kind) {
    throw new ProviderExecutionError({
      code: "invalid_request",
      message: `Pika ${options.reference.slot} reference must be ${options.kind}.`,
      retryable: false,
      requestState: "rejected",
    });
  }
  if (resolved.form === "provider-url") return resolved.providerUrl;
  return uploadPikaMedia({
    apiKey: options.apiKey,
    bytes: resolved.bytes,
    contentType: resolved.mediaType ?? defaultMediaType(options.kind),
    fetch: globalThis.fetch,
  });
}

async function resolveReferences(
  invocation: ExecutablePluginInvocation,
  context: ExecutorContext,
  key: string,
): Promise<PikaReferences> {
  const result: PikaReferences = { images: [], videos: [], audios: [] };
  for (const reference of sortedReferences(invocation.input.references)) {
    if (!("asset" in reference)) continue;
    const declaredKind = reference.asset.kind;
    const kind =
      reference.slot === "startFrame" || reference.slot === "endFrame"
        ? "image"
        : reference.slot === "image" ||
            reference.slot === "video" ||
            reference.slot === "audio"
          ? reference.slot
          : declaredKind;
    if (kind !== "image" && kind !== "video" && kind !== "audio") continue;
    const url = await referenceUrl({ reference, kind, apiKey: key, context });
    if (reference.slot === "startFrame") {
      if (result.startFrame) {
        throw new ProviderExecutionError({
          code: "invalid_request",
          message: "Pika received more than one startFrame reference.",
          retryable: false,
          requestState: "rejected",
        });
      }
      result.startFrame = url;
    } else if (reference.slot === "endFrame") {
      if (result.endFrame) {
        throw new ProviderExecutionError({
          code: "invalid_request",
          message: "Pika received more than one endFrame reference.",
          retryable: false,
          requestState: "rejected",
        });
      }
      result.endFrame = url;
    } else if (kind === "image") result.images.push(url);
    else if (kind === "video") result.videos.push(url);
    else result.audios.push(url);
  }
  return result;
}

async function submit(
  invocation: ExecutablePluginInvocation,
  context: ExecutorContext,
): Promise<ExecutorStep> {
  const values = invocation.input.values;
  const key = await apiKey(context, "rejected");
  const modelId = requiredString(values, "modelId");
  const upstreamModel = requiredString(values, "upstreamModel");
  const prompt = requiredString(values, "prompt");
  if (values.kind === "text") {
    const params = record(values.modelParams);
    const generated = await generatePikaChat({
      apiKey: key,
      model: upstreamModel,
      prompt,
      ...(typeof params.system_prompt === "string"
        ? { systemPrompt: params.system_prompt }
        : {}),
      fetch: globalThis.fetch,
    });
    return {
      status: "completed",
      outputs: [{ slot: "text", kind: "value", value: generated.text }],
    };
  }

  const kind = mediaKind(values.kind);
  const references = await resolveReferences(invocation, context, key);
  const request = buildPikaMediaRequest({
    modelId,
    kind,
    upstreamModel,
    prompt,
    ...(typeof values.aspectRatio === "string"
      ? { aspectRatio: values.aspectRatio }
      : {}),
    ...(typeof values.duration === "string" ||
    typeof values.duration === "number"
      ? { duration: values.duration }
      : {}),
    modelParams: record(values.modelParams),
    startFrameUrl: references.startFrame,
    endFrameUrl: references.endFrame,
    referenceImageUrls: references.images,
    referenceVideoUrls: references.videos,
    referenceAudioUrls: references.audios,
  });
  const created = await createPikaMediaJob({
    apiKey: key,
    operation: request.operation,
    input: request.body,
    idempotencyKey: invocation.taskId,
    fetch: globalThis.fetch,
  });
  return {
    status: "accepted",
    pollState: {
      jobId: created.id,
      ...(created.status === "completed" ? { phase: "content" } : {}),
    },
    retryAfterMs: created.status === "completed" ? 0 : 1_000,
  };
}

async function poll(
  invocation: ExecutablePluginInvocation,
  context: ExecutorContext,
): Promise<ExecutorStep> {
  // Durable state is provider-owned evidence that submission already happened. Validate it before
  // reading credentials so a corrupt journal entry fails independently of account configuration.
  const state = pollState(invocation.pollState);
  const kind = mediaKind(invocation.input.values.kind);
  const key = await apiKey(context, "accepted");
  if (state.phase === "content") {
    const content = await getPikaMediaContent({
      apiKey: key,
      jobId: state.jobId,
      fetch: globalThis.fetch,
    });
    return {
      status: "completed",
      media: { media: { url: content.url, kind } },
    };
  }

  const job = await getPikaMediaJob({
    apiKey: key,
    jobId: state.jobId,
    fetch: globalThis.fetch,
  });
  if (job.status === "completed") {
    return {
      status: "accepted",
      pollState: { jobId: state.jobId, phase: "content" },
      retryAfterMs: 0,
    };
  }
  return {
    status: "accepted",
    pollState: { jobId: state.jobId },
    retryAfterMs: 1_000,
  };
}

export const pikaAdapter: Executor = { submit, poll };
