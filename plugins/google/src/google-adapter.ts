import type {
  PluginAuthDeclaration,
  PluginAuthFormItem,
} from "@clash/shared-types";
import { googleBaseUrl } from "./base-url.js";
import { googleModelPath } from "./model-path.js";
import {
  valueOutput,
  type ExecutorContext,
  type ExecutorStep,
  type ProviderExecutor,
} from "./executor-contract";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginReference,
} from "@clash/shared-types/executable-plugin";
import { aspectRatioLabel } from "@clash/shared-types/executable-plugin";
import { ProviderExecutionError, providerHttpError } from "@clash/action-sdk";

/**
 * Google's generateContent surface, for both hosts.
 *
 * Verified against Google with a real key: `generativelanguage.googleapis.com/v1beta` and
 * `aiplatform.googleapis.com/v1` both answer `:generateContent` authenticated by `x-goog-api-key`,
 * and neither needs a project, a location, a service account or a signed JWT. The paths differ —
 * `/models/{model}` against one, `/publishers/google/models/{model}` against the other — and that
 * is the whole of the difference.
 *
 * Synchronous, so `submit` returns the finished arm and `poll` never runs. The contract allows that
 * and it is worth stating: an executor is not required to be asynchronous, only to be honest about
 * which it is.
 */

interface FetchLike {
  (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
  }>;
}

type GoogleCredentials = {
  accessToken?: string;
  apiKey?: string;
  endpoint?: string;
  service?: string;
  region?: string;
  projectId?: string;
};

type GooglePollState =
  | { family: "veo"; model: string; operationName: string }
  | { family: "interaction"; interactionId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(
  values: Record<string, unknown>,
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key] ?? values[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function credentialsFor(
  context: ExecutorContext,
): Promise<GoogleCredentials> {
  const accessToken = await context.store?.get("accessToken");
  const apiKey = accessToken ? undefined : await context.store?.get("apiKey");
  if (!accessToken && !apiKey) return {};
  const keys = ["endpoint", "service", "region", "projectId"] as const;
  const stored = await Promise.all(
    keys.map(async (key) => [key, await context.store?.get(key)] as const),
  );
  return {
    ...(accessToken ? { accessToken } : { apiKey: apiKey! }),
    ...Object.fromEntries(
      stored.filter(
        (entry): entry is readonly [(typeof keys)[number], string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
      ),
    ),
  };
}

/** Which path shape this host uses. Decided by the host, which the account chose. */
/** A stored key, shaped for spreading: absent stays absent rather than becoming `undefined`. */
async function storedField(
  context: { store?: { get(key: string): Promise<string | undefined> } },
  key: string,
): Promise<Record<string, string>> {
  const value = await context.store?.get(key);
  return value ? { [key]: value } : {};
}

async function readJson(
  response: {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
  },
  operation: "submit" | "poll",
): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A proxy or a quota page answers with HTML, and folding that into an empty object loses the
    // only explanation there was.
    const message = `Google returned a non-JSON response (${response.status}): ${raw.slice(0, 200)}`;
    if (!response.ok) {
      throw providerHttpError({
        status: response.status,
        message,
        operation,
      });
    }
    throw new ProviderExecutionError({
      code: "invalid_response",
      message,
      retryable: false,
      requestState: operation === "submit" ? "unknown" : "accepted",
    });
  }
}

function googleBaseUrlFor(
  credentials: GoogleCredentials,
  requestState: "rejected" | "accepted",
): string {
  try {
    return googleBaseUrl({
      ...(credentials.endpoint ? { endpoint: credentials.endpoint } : {}),
      ...(credentials.service ? { service: credentials.service } : {}),
      ...(credentials.region ? { region: credentials.region } : {}),
      hasServiceAccount: Boolean(credentials.projectId),
    });
  } catch (error) {
    throw new ProviderExecutionError({
      code: "invalid_request",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      requestState,
    });
  }
}

interface InlinePart {
  inlineData?: { mimeType?: unknown; data?: unknown };
  inline_data?: { mimeType?: unknown; mime_type?: unknown; data?: unknown };
  text?: unknown;
}

/**
 * Finds the generated bytes.
 *
 * Both spellings occur — `inlineData` on one surface and `inline_data` on the other — so this reads
 * either rather than trusting one.
 */
function firstInlineMedia(
  body: Record<string, unknown>,
): { data: string; mimeType: string } | undefined {
  const candidates = body.candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    const content = (candidate as { content?: { parts?: unknown } }).content;
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as InlinePart[]) {
      const inline = part.inlineData ?? part.inline_data;
      if (!inline) continue;
      const data = inline.data;
      const mime =
        (inline as { mimeType?: unknown }).mimeType ??
        (inline as { mime_type?: unknown }).mime_type;
      if (typeof data === "string" && data) {
        return {
          data,
          mimeType: typeof mime === "string" && mime ? mime : "image/png",
        };
      }
    }
  }
  return undefined;
}

function invalidL16Response(message: string): never {
  throw new ProviderExecutionError({
    code: "invalid_response",
    message: `Google returned invalid L16 audio: ${message}`,
    retryable: false,
    requestState: "accepted",
  });
}

function selfDescribingInlineMedia(media: { data: string; mimeType: string }): {
  data: string;
  mimeType: string;
} {
  const [rawEssence = "", ...rawParameters] = media.mimeType.split(";");
  if (rawEssence.trim().toLowerCase() !== "audio/l16") return media;

  const parameters = new Map<string, string>();
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf("=");
    if (separator <= 0) continue;
    parameters.set(
      rawParameter.slice(0, separator).trim().toLowerCase(),
      rawParameter.slice(separator + 1).trim(),
    );
  }
  const rawRate = parameters.get("rate");
  const rawChannels = parameters.get("channels");
  if (!rawRate || !/^\d+$/.test(rawRate)) {
    return invalidL16Response(
      "the required sample rate is missing or invalid.",
    );
  }
  if (rawChannels !== undefined && !/^\d+$/.test(rawChannels)) {
    return invalidL16Response("the channel count is invalid.");
  }
  const sampleRate = Number(rawRate);
  const channels = rawChannels === undefined ? 1 : Number(rawChannels);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0 ||
    channels > 0xffff ||
    blockAlign > 0xffff ||
    byteRate > 0xffffffff
  ) {
    return invalidL16Response("the sample rate or channel count is invalid.");
  }

  const pcm = Buffer.from(media.data, "base64");
  if (pcm.byteLength === 0 || pcm.byteLength % blockAlign !== 0) {
    return invalidL16Response(
      "the payload does not contain a whole number of sample frames.",
    );
  }
  if (pcm.byteLength > 0xffffffff - 36) {
    return invalidL16Response("the payload is too large for a RIFF/WAVE file.");
  }

  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  // Gemini TTS documents its returned PCM as 16-bit little-endian, despite
  // the response MIME spelling. WAVE PCM uses the same byte order.
  pcm.copy(wav, 44);
  return { data: wav.toString("base64"), mimeType: "audio/wav" };
}

/** The model's words, for a text generation. */
function firstText(body: Record<string, unknown>): string | undefined {
  const candidates = body.candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } }).content
      ?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as InlinePart[]) {
      if (typeof part.text === "string" && part.text) return part.text;
    }
  }
  return undefined;
}

/**
 * The ratio to send. Two kinds arrive here, not three.
 *
 * `custom` is a declaration -- it says the model accepts shapes outside its listed menu -- and never
 * arrives as a value. What arrives is either `auto`, meaning the model decides, or a concrete ratio.
 * Sending the literal word would earn a proto-enum error that explains nothing to whoever chose it.
 *
 * A concrete ratio is sent as asked. Google keeps a closed set and refuses the rest -- measured: 16:9
 * returns 1376x768, while 7:3 and 5:7 are both "Request contains an invalid argument" -- and that
 * refusal is the honest answer. Rounding to the nearest listed shape would bill the caller for a
 * picture they did not choose.
 */
function resolveRatio(
  ratio: string | undefined,
  values: Record<string, unknown>,
): string | undefined {
  const width = Number(values.aspectRatioWidth);
  const height = Number(values.aspectRatioHeight);
  const hasPair =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0;
  if (hasPair) return aspectRatioLabel({ width, height });
  if (!ratio || ratio === "auto" || ratio === "adaptive" || ratio === "custom")
    return undefined;
  return ratio;
}

/**
 * Google's request body, built here because the envelope is the per-vendor part.
 *
 * The catalogue's ratio arrives as written -- "16:9", "1:1", and also "adaptive"/"auto", which are
 * not ratios but "you decide". Google has no spelling for that, so the field is left out instead of
 * being filled with a shape the caller did not choose.
 */
function dataPart(
  url: string,
  fallbackMimeType: string,
): Record<string, unknown> {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(url);
  if (match) {
    return {
      inlineData: { mimeType: match[1] || fallbackMimeType, data: match[2] },
    };
  }
  return { fileData: { mimeType: fallbackMimeType, fileUri: url } };
}

type ResolvedReference = Awaited<ReturnType<ExecutorContext["reference"]>>;
type GoogleMediaKind = "image" | "video" | "audio";
type GoogleMediaReference =
  | {
      form: "url";
      url: string;
      kind: GoogleMediaKind;
      mediaType: string;
    }
  | {
      form: "bytes";
      bytes: Uint8Array;
      kind: GoogleMediaKind;
      mediaType: string;
    };
type GoogleContentReference =
  { form: "text"; text: string } | GoogleMediaReference;

interface GoogleInputReferences {
  content: GoogleContentReference[];
  images: GoogleMediaReference[];
  videos: GoogleMediaReference[];
  audios: GoogleMediaReference[];
  startFrame?: GoogleMediaReference;
  endFrame?: GoogleMediaReference;
}

function referenceFailure(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_request",
    message,
    retryable: false,
    requestState: "rejected",
  });
}

function defaultMediaType(kind: GoogleMediaKind): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/wav";
}

function mediaReference(
  reference: ExecutablePluginReference,
  resolved: ResolvedReference,
  expectedKind?: GoogleMediaKind,
): GoogleMediaReference {
  if (resolved.form === "text") {
    throw referenceFailure(
      `Google ${reference.slot} reference resolved to text instead of media.`,
    );
  }
  if (resolved.form === "document") {
    throw referenceFailure(
      `Google ${reference.slot} reference resolved to a document instead of media.`,
    );
  }
  const declaredKind = "asset" in reference ? reference.asset.kind : undefined;
  const kind = expectedKind ?? resolved.kind ?? declaredKind;
  if (kind !== "image" && kind !== "video" && kind !== "audio") {
    throw referenceFailure(
      `Google ${reference.slot} reference has unsupported kind ${kind ?? "(missing)"}.`,
    );
  }
  if (
    expectedKind &&
    ((resolved.kind && resolved.kind !== expectedKind) ||
      (declaredKind && declaredKind !== expectedKind))
  ) {
    throw referenceFailure(
      `Google ${reference.slot} reference must be ${expectedKind}.`,
    );
  }
  const mediaType = resolved.mediaType ?? defaultMediaType(kind);
  if (resolved.form === "provider-url") {
    return { form: "url", url: resolved.providerUrl, kind, mediaType };
  }
  if (resolved.form === "executor-url") {
    return { form: "url", url: resolved.executorUrl, kind, mediaType };
  }
  return { form: "bytes", bytes: resolved.bytes, kind, mediaType };
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

async function resolveInputReferences(
  invocation: ExecutablePluginInvocation,
  context: ExecutorContext,
): Promise<GoogleInputReferences> {
  const collected: GoogleInputReferences = {
    content: [],
    images: [],
    videos: [],
    audios: [],
  };

  for (const reference of sortedReferences(invocation.input.references)) {
    const slot = reference.slot;
    if (
      slot !== "content" &&
      slot !== "image" &&
      slot !== "video" &&
      slot !== "audio" &&
      slot !== "startFrame" &&
      slot !== "endFrame"
    ) {
      continue;
    }
    const resolved = await context.reference(reference);
    if (slot === "content") {
      collected.content.push(
        resolved.form === "text"
          ? { form: "text", text: resolved.text }
          : mediaReference(reference, resolved),
      );
      continue;
    }
    const expectedKind =
      slot === "startFrame" || slot === "endFrame" ? "image" : slot;
    const media = mediaReference(reference, resolved, expectedKind);
    if (slot === "image") collected.images.push(media);
    else if (slot === "video") collected.videos.push(media);
    else if (slot === "audio") collected.audios.push(media);
    else if (slot === "startFrame") {
      if (collected.startFrame)
        throw referenceFailure(
          "Google received more than one startFrame reference.",
        );
      collected.startFrame = media;
    } else {
      if (collected.endFrame)
        throw referenceFailure(
          "Google received more than one endFrame reference.",
        );
      collected.endFrame = media;
    }
  }
  return collected;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function videoMetadata(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const fps = finiteNumber(params.video_fps);
  const start = finiteNumber(params.video_start_seconds);
  const end = finiteNumber(params.video_end_seconds);
  if (fps === undefined && start === undefined && end === undefined) return undefined;
  return {
    ...(fps !== undefined ? { fps } : {}),
    ...(start !== undefined ? { startOffset: `${start}s` } : {}),
    ...(end !== undefined ? { endOffset: `${end}s` } : {}),
  };
}

// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding
const agenticVideoModels = new Set([
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
]);

function useAgenticVideo(
  values: Record<string, unknown>,
  references: GoogleInputReferences,
  model: string,
): boolean {
  const params = record(values.modelParams);
  return (
    values.kind === "text" &&
    !values.body &&
    (params.video_processing === "auto" ||
      (params.video_processing === undefined && params.video_fps === undefined)) &&
    agenticVideoModels.has(model) &&
    // Clipping and custom frame sampling are static-only. A clipped review must
    // retain its window even if a caller accidentally requests automatic mode.
    params.video_start_seconds === undefined &&
    params.video_end_seconds === undefined &&
    (references.content.length > 0
      ? references.content.some(
          (reference) => reference.form !== "text" && reference.kind === "video",
        )
      : references.videos.length > 0)
  );
}

function googleMediaPart(
  media: GoogleMediaReference,
  params: Record<string, unknown> = {},
  agentic = false,
): Record<string, unknown> {
  const data = media.form === "url" ? dataPart(media.url, media.mediaType) : {
    inlineData: {
      mimeType: media.mediaType,
      data: Buffer.from(media.bytes).toString("base64"),
    },
  };
  if (media.kind === "video" && agentic) {
    return { ...data, mediaProcessing: "AGENTIC" };
  }
  const metadata = media.kind === "video" ? videoMetadata(params) : undefined;
  return { ...data, ...(metadata ? { videoMetadata: metadata } : {}) };
}

function orderedParts(
  values: Record<string, unknown>,
  references: GoogleInputReferences,
  agentic = false,
): Record<string, unknown>[] {
  const params = record(values.modelParams);
  if (references.content.length > 0) {
    return references.content.map((reference) =>
      reference.form === "text"
        ? { text: reference.text }
        : googleMediaPart(reference, params, agentic),
    );
  }
  const prompt = typeof values.prompt === "string" ? values.prompt : "";
  return [
    ...(prompt ? [{ text: prompt }] : []),
    ...references.images.map((reference) => googleMediaPart(reference, params)),
    ...references.videos.map((reference) => googleMediaPart(reference, params, agentic)),
    ...references.audios.map((reference) => googleMediaPart(reference, params)),
  ];
}

function generateContentBody(
  values: Record<string, unknown>,
  references: GoogleInputReferences,
  agentic = false,
): Record<string, unknown> {
  const explicit = values.body;
  if (explicit && typeof explicit === "object")
    return explicit as Record<string, unknown>;

  const kind = typeof values.kind === "string" ? values.kind : "image";
  const params = record(values.modelParams);
  const ratio =
    typeof values.aspectRatio === "string" ? values.aspectRatio : undefined;
  const size = stringValue(values, params, "resolution");
  const chosenRatio = resolveRatio(ratio, values);

  const imageConfig: Record<string, unknown> = {
    ...(chosenRatio ? { aspectRatio: chosenRatio } : {}),
    ...(size ? { imageSize: size } : {}),
  };
  const responseModalities =
    kind === "audio"
      ? ["AUDIO"]
      : kind === "text"
        ? ["TEXT"]
        : ["TEXT", "IMAGE"];
  const voiceName = stringValue(values, params, "voice_name") ?? "Kore";
  const systemPrompt = stringValue(values, params, "system_prompt");
  const requestedMediaResolution = stringValue(values, params, "video_media_resolution");
  const mediaResolution =
    requestedMediaResolution === "low" ||
    requestedMediaResolution === "medium" ||
    requestedMediaResolution === "high"
      ? `MEDIA_RESOLUTION_${requestedMediaResolution.toUpperCase()}`
      : undefined;
  return {
    // Agent Platform rejects a content without a role; the Developer API defaults it. One provider
    // serves both, so the stricter of the two sets the shape.
    ...(systemPrompt
      ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
      : {}),
    contents: [{ role: "user", parts: orderedParts(values, references, agentic) }],
    generationConfig: {
      responseModalities,
      ...(!agentic && mediaResolution ? { mediaResolution } : {}),
      ...(kind === "image" && Object.keys(imageConfig).length
        ? { imageConfig }
        : {}),
      ...(kind === "audio"
        ? {
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          }
        : {}),
    },
  };
}

function veoImage(media: GoogleMediaReference): Record<string, unknown> {
  const part = googleMediaPart(media);
  const inline = record(part.inlineData);
  if (typeof inline.data === "string") {
    return {
      bytesBase64Encoded: inline.data,
      mimeType:
        typeof inline.mimeType === "string" ? inline.mimeType : "image/png",
    };
  }
  const file = record(part.fileData);
  return {
    gcsUri: file.fileUri,
    mimeType: typeof file.mimeType === "string" ? file.mimeType : "image/png",
  };
}

function veoBody(
  values: Record<string, unknown>,
  references: GoogleInputReferences,
): Record<string, unknown> {
  const params = record(values.modelParams);
  const prompt = typeof values.prompt === "string" ? values.prompt : "";
  const start = references.startFrame;
  const end = references.endFrame;
  const duration = Number(params.duration ?? values.duration ?? 4);
  return {
    instances: [
      {
        prompt,
        ...(start ? { image: veoImage(start) } : {}),
        ...(end ? { lastFrame: veoImage(end) } : {}),
        ...(references.images.length
          ? {
              referenceImages: references.images.map((reference) => ({
                image: veoImage(reference),
                referenceType: "asset",
              })),
            }
          : {}),
      },
    ],
    parameters: {
      aspectRatio: String(params.aspect_ratio ?? values.aspectRatio ?? "16:9"),
      durationSeconds: Number.isFinite(duration) ? duration : 4,
      generateAudio: params.generate_audio !== false,
      sampleCount: 1,
    },
  };
}

function interactionBody(
  values: Record<string, unknown>,
  model: string,
  references: GoogleInputReferences,
): Record<string, unknown> {
  const params = record(values.modelParams);
  const duration = Number(params.duration ?? values.duration ?? 5);
  const mediaContent = references.content.some(
    (reference) => reference.form !== "text",
  );
  if (
    mediaContent ||
    references.images.length > 0 ||
    references.videos.length > 0 ||
    references.audios.length > 0 ||
    references.startFrame ||
    references.endFrame
  ) {
    const received = [
      ...references.content.map((reference) =>
        reference.form === "text"
          ? "content:text"
          : `content:${reference.kind}`,
      ),
      ...references.images.map(() => "image"),
      ...references.videos.map(() => "video"),
      ...references.audios.map(() => "audio"),
      ...(references.startFrame ? ["startFrame"] : []),
      ...(references.endFrame ? ["endFrame"] : []),
    ];
    throw referenceFailure(
      `Google Interactions does not expose reference media through this adapter; received ${received.join(", ")}.`,
    );
  }
  const authoredText = references.content
    .map((reference) => (reference.form === "text" ? reference.text : ""))
    .join("");
  return {
    model,
    input:
      authoredText || (typeof values.prompt === "string" ? values.prompt : ""),
    response_format: {
      type: "video",
      aspect_ratio: String(params.aspect_ratio ?? values.aspectRatio ?? "16:9"),
      duration: `${Number.isFinite(duration) ? duration : 5}s`,
    },
    background: true,
    store: true,
    stream: false,
  };
}

function googleAuthHeaders(
  credentials: GoogleCredentials,
  requestState: "rejected" | "accepted",
): Record<string, string> {
  if (credentials.accessToken) {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
    };
  }
  if (credentials.apiKey) {
    return {
      "x-goog-api-key": credentials.apiKey,
      "content-type": "application/json",
    };
  }
  throw new ProviderExecutionError({
    code: "authentication_failed",
    message:
      "This Google account has neither an accessToken nor an apiKey stored.",
    retryable: false,
    requestState,
  });
}

function agentPlatformPrefix(
  baseUrl: string,
  credentials: GoogleCredentials,
  requestState: "rejected" | "accepted",
  version = "v1",
): string {
  if (!credentials.projectId) {
    throw new ProviderExecutionError({
      code: "invalid_request",
      message:
        "This Agent Platform account has no project id; it comes from the service account key.",
      retryable: false,
      requestState,
    });
  }
  const location = credentials.region || "global";
  const origin = baseUrl.replace(/\/v1(?:beta1)?\/?$/, "");
  return `${origin}/${version}/projects/${credentials.projectId}/locations/${location}`;
}

function veoPath(
  baseUrl: string,
  credentials: GoogleCredentials,
  model: string,
  apiMethod: string,
  requestState: "rejected" | "accepted",
): string {
  return `${agentPlatformPrefix(baseUrl, credentials, requestState)}/publishers/google/models/${encodeURIComponent(model)}:${apiMethod}`;
}

function interactionPath(
  baseUrl: string,
  credentials: GoogleCredentials,
  requestState: "rejected" | "accepted",
  interactionId?: string,
): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!/aiplatform\.googleapis\.com/.test(trimmed)) {
    if (!interactionId) return `${trimmed}/interactions`;
    const path = interactionId.replace(/^\/+/, "");
    return `${trimmed}/${path.startsWith("interactions/") ? path : `interactions/${path}`}`;
  }
  if (interactionId?.startsWith("projects/")) {
    const origin = trimmed.replace(/\/v1(?:beta1)?\/?$/, "");
    return `${origin}/v1beta1/${interactionId}`;
  }
  const prefix = agentPlatformPrefix(
    baseUrl,
    credentials,
    requestState,
    "v1beta1",
  );
  return `${prefix}/interactions${interactionId ? `/${interactionId.replace(/^interactions\//, "")}` : ""}`;
}

function pollState(value: unknown): GooglePollState {
  const state = record(value);
  if (
    state.family === "veo" &&
    typeof state.model === "string" &&
    typeof state.operationName === "string"
  ) {
    return {
      family: "veo",
      model: state.model,
      operationName: state.operationName,
    };
  }
  if (
    state.family === "interaction" &&
    typeof state.interactionId === "string"
  ) {
    return { family: "interaction", interactionId: state.interactionId };
  }
  throw new ProviderExecutionError({
    code: "contract_violation",
    message: "Google poll state is missing or invalid.",
    retryable: false,
    requestState: "accepted",
  });
}

function mediaFromUnknown(
  value: unknown,
): { data?: string; url?: string; mimeType: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const media = mediaFromUnknown(entry);
      if (media) return media;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const inline = record(object.inlineData ?? object.inline_data);
  const inlineData = inline.data;
  if (typeof inlineData === "string" && inlineData) {
    const mime = inline.mimeType ?? inline.mime_type;
    return {
      data: inlineData,
      mimeType: typeof mime === "string" ? mime : "application/octet-stream",
    };
  }
  const data = object.bytesBase64Encoded ?? object.bytesBase64 ?? object.data;
  const mime = object.mimeType ?? object.mime_type;
  if (typeof data === "string" && data && typeof mime === "string") {
    return { data, mimeType: mime };
  }
  const url = object.gcsUri ?? object.uri ?? object.url;
  if (
    typeof url === "string" &&
    url &&
    (typeof mime === "string" || /^gs:|^https?:/.test(url))
  ) {
    return { url, mimeType: typeof mime === "string" ? mime : "video/mp4" };
  }
  for (const child of Object.values(object)) {
    const media = mediaFromUnknown(child);
    if (media) return media;
  }
  return undefined;
}

function mediaStep(media: {
  data?: string;
  url?: string;
  mimeType: string;
}): ExecutorStep {
  const output: { data?: string; url?: string; mimeType: string } = media.data
    ? selfDescribingInlineMedia({ data: media.data, mimeType: media.mimeType })
    : media;
  return {
    status: "completed",
    media: {
      media: output.data
        ? { base64: output.data, mediaType: output.mimeType }
        : { url: output.url!, mediaType: output.mimeType },
    },
  };
}

/**
 * What a Google account needs, declared for the host to render.
 *
 * Four credentials across two surfaces, and which one works depends on the surface -- measured, not
 * guessed. An api key answers on the Developer API and returns 401 "API keys are not supported by
 * this API" on Agent Platform, so `service` is not cosmetic: it decides which host is addressed and
 * therefore which credential is the right one.
 *
 * `region` has a default because one exists that works; `apiKey` does not, because an account
 * without a credential does not work at all.
 */
// `satisfies`, so the declaration is checked against the schema's type while keeping the literal
// shape the schema wants: `options` is declared non-empty, which is a tuple, and a plain array
// annotation widens it back to something the schema rejects.
const REGION_FIELD = {
  kind: "choice",
  key: "region",
  label: "Region",
  options: [
    { value: "global", label: "Global" },
    { value: "us-central1", label: "us-central1" },
  ],
  // Measured: gemini-3.1-flash-image answers on global and 404s on us-central1.
  default: "global",
} satisfies PluginAuthFormItem;

export const GOOGLE_AUTH: PluginAuthDeclaration = {
  /**
   * Three coherent configurations, each complete on its own.
   *
   * Google has two surfaces and two credentials, and they do not pair off evenly. A service account
   * signs an RFC 7523 assertion that only Agent Platform accepts. An API key works on both: AI
   * Studio directly, Agent Platform in Express mode. And a region is an Agent Platform concept --
   * AI Studio has none.
   *
   * As a single form this needed a `service` choice plus a condition hiding it once a service
   * account was pasted, and before that a notice claiming Agent Platform refuses API keys, which is
   * simply false. As methods, each carries exactly the fields its configuration needs: `region` is
   * absent from the AI Studio method rather than present and ignored, because a field that is
   * present and ignored teaches the reader that fields can be ignored.
   */
  methods: [
    {
      id: "ai-studio",
      label: "Google AI Studio (Developer API)",
      form: [
        {
          kind: "notice" as const,
          text: "Create a key at aistudio.google.com/apikey.",
        },
        {
          kind: "field" as const,
          key: "apiKey",
          label: "API key",
          secret: true,
        },
      ],
    },
    {
      id: "agent-platform-key",
      label: "Google Cloud Agent Platform (API key)",
      form: [
        {
          kind: "notice" as const,
          text: "Agent Platform accepts an API key in Express mode.",
        },
        {
          kind: "field" as const,
          key: "apiKey",
          label: "API key",
          secret: true,
        },
        REGION_FIELD,
      ],
    },
    {
      id: "service-account",
      label: "Google Cloud Agent Platform (service account)",
      form: [
        {
          kind: "notice" as const,
          text:
            "Paste the JSON key file. It is exchanged for an access token via RFC 7523; the " +
            "assertion is signed locally and the key itself is never sent.",
        },
        {
          kind: "field" as const,
          key: "serviceAccountKey",
          label: "Service account JSON",
          secret: true,
        },
        REGION_FIELD,
      ],
    },
  ],
};

/**
 * Which Google surface this account addresses.
 *
 * Asymmetric, because the two credentials are. A service account signs an RFC 7523 assertion that
 * only Agent Platform accepts, so holding one settles the question whatever the stored choice says
 * -- and a store can hold a stale `service` from before the key was pasted. An API key works on
 * both surfaces, AI Studio directly and Agent Platform in Express mode, so it settles nothing and
 * the account's own choice decides.
 */
export function googleServiceFor(stored: {
  apiKey?: string;
  serviceAccountKey?: string;
  service?: string;
}): "ai-studio" | "agent-platform" {
  if (stored.serviceAccountKey?.trim()) return "agent-platform";
  if (!stored.apiKey?.trim()) {
    throw new Error(
      "This Google account holds neither apiKey nor serviceAccountKey, so there is no surface to address.",
    );
  }
  return stored.service === "agent-platform" ? "agent-platform" : "ai-studio";
}

export const googleAdapter: ProviderExecutor = {
  async submit(
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ): Promise<ExecutorStep> {
    const credentials = await credentialsFor(context);
    const headers = googleAuthHeaders(credentials, "rejected");
    const fetchImpl = globalThis.fetch as unknown as FetchLike;
    const baseUrl = googleBaseUrlFor(credentials, "rejected");
    const values = invocation.input.values;
    const model = String(values.upstreamModel ?? values.model ?? "");
    if (!model) {
      throw new ProviderExecutionError({
        code: "invalid_request",
        message: "Google executor needs a model.",
        retryable: false,
        requestState: "rejected",
      });
    }

    const modelId = String(values.modelId ?? "");
    const kind = String(values.kind ?? "image");
    const interaction =
      values.apiShape === "google-ai-studio-interactions" ||
      modelId === "gemini-omni-flash";
    const veo =
      kind === "video" &&
      (modelId.startsWith("veo-") || model.startsWith("veo-"));
    const references = await resolveInputReferences(invocation, context);
    const agentic = !interaction && !veo && useAgenticVideo(values, references, model);
    // Agentic video is preview-only on Agent Platform; AI Studio already uses v1beta.
    const contentBaseUrl =
      agentic && (credentials.service === "agent-platform" || credentials.accessToken)
        ? baseUrl.replace(/\/v1\/?$/, "/v1beta1")
        : baseUrl;
    const url = interaction
      ? interactionPath(baseUrl, credentials, "rejected")
      : veo
        ? veoPath(baseUrl, credentials, model, "predictLongRunning", "rejected")
        : googleModelPath({
            baseUrl: contentBaseUrl,
            model,
            ...(credentials.projectId
              ? { projectId: credentials.projectId }
              : {}),
            ...(credentials.region ? { location: credentials.region } : {}),
          });
    const request = interaction
      ? interactionBody(values, model, references)
      : veo
        ? veoBody(values, references)
        : generateContentBody(values, references, agentic);
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const body = await readJson(response, "submit");
    if (!response.ok) {
      const error = (body.error as { message?: unknown } | undefined)?.message;
      throw providerHttpError({
        status: response.status,
        message:
          `Google ${interaction ? "Interactions" : veo ? "Veo" : "generateContent"} failed: ` +
          `${typeof error === "string" ? error : response.statusText}`,
        operation: invocation.operation,
      });
    }

    if (veo) {
      const operationName = body.name;
      if (typeof operationName !== "string" || !operationName) {
        throw new ProviderExecutionError({
          code: "invalid_response",
          message: `Google Veo returned no operation name for ${model}.`,
          retryable: false,
          requestState: "unknown",
        });
      }
      return {
        status: "accepted",
        pollState: { family: "veo", model, operationName },
      };
    }

    if (interaction) {
      const media = mediaFromUnknown(body.outputs ?? body.output ?? body);
      if (media) return mediaStep(media);
      const status = body.status;
      const interactionId = body.id ?? body.name;
      if (
        (status === "pending" ||
          status === "in_progress" ||
          status === "running") &&
        typeof interactionId === "string"
      ) {
        return {
          status: "accepted",
          pollState: { family: "interaction", interactionId },
        };
      }
      throw new ProviderExecutionError({
        code: "invalid_response",
        message: `Google Interactions returned no media for ${model}.`,
        retryable: false,
        requestState: "accepted",
      });
    }

    const media = firstInlineMedia(body);
    if (media) {
      // Returned as data, not uploaded here. Google answers with base64, so that is what this
      // hands back; the SDK decodes and stores it.
      return mediaStep(media);
    }
    const text = firstText(body);
    if (text)
      return { status: "completed", outputs: valueOutput(text, "text") };

    // Finished with nothing in it is not a result. Reporting completion here would attach an empty
    // asset and close the task as though it had worked.
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: `Google returned no media or text for ${model}.`,
      retryable: false,
      requestState: "accepted",
    });
  },

  async poll(
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ): Promise<ExecutorStep> {
    const state = pollState(invocation.pollState);
    const credentials = await credentialsFor(context);
    const headers = googleAuthHeaders(credentials, "accepted");
    const baseUrl = googleBaseUrlFor(credentials, "accepted");
    const fetchImpl = globalThis.fetch as unknown as FetchLike;
    const response =
      state.family === "veo"
        ? await fetchImpl(
            veoPath(
              baseUrl,
              credentials,
              state.model,
              "fetchPredictOperation",
              "accepted",
            ),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ operationName: state.operationName }),
            },
          )
        : await fetchImpl(
            interactionPath(
              baseUrl,
              credentials,
              "accepted",
              state.interactionId,
            ),
            {
              method: "GET",
              headers,
            },
          );
    const body = await readJson(response, "poll");
    if (!response.ok) {
      const error = (body.error as { message?: unknown } | undefined)?.message;
      throw providerHttpError({
        status: response.status,
        message: `Google poll failed: ${typeof error === "string" ? error : response.statusText}`,
        operation: invocation.operation,
      });
    }
    const media = mediaFromUnknown(
      body.response ?? body.outputs ?? body.output ?? body,
    );
    if (media) return mediaStep(media);
    if (
      body.done === true ||
      body.status === "failed" ||
      body.status === "cancelled"
    ) {
      const error = record(body.error).message;
      throw new ProviderExecutionError({
        code: body.status === "cancelled" ? "cancelled" : "provider_failed",
        message: `Google generation finished without media${typeof error === "string" ? `: ${error}` : "."}`,
        retryable: false,
        requestState: "accepted",
        ...(typeof body.status === "string"
          ? { providerCode: body.status }
          : {}),
      });
    }
    return { status: "accepted", pollState: state };
  },
};
