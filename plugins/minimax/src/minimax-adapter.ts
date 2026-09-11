import { minimaxBaseUrl } from "./base-url.js";
import {
  buildMiniMaxH3Content,
  type MiniMaxH3OrderedContentPart,
} from "@clash/shared-runtime/minimax-h3";
import type { PluginAuthDeclaration } from "@clash/shared-types";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginReference,
} from "@clash/shared-types/executable-plugin";
import {
  minimaxSubmit,
  minimaxPoll,
  type MinimaxPollState,
} from "@clash/shared-runtime/minimax-executor";
import {
  valueOutput,
  type ExecutorContext,
  type ExecutorStep,
  type ProviderExecutor,
} from "./executor-contract";
import { ProviderExecutionError, providerHttpError } from "@clash/action-sdk";

function rejectedInvalidRequest(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_request",
    message,
    retryable: false,
    requestState: "rejected",
  });
}

function rejectedInvalidResponse(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_response",
    message,
    retryable: false,
    requestState: "rejected",
  });
}

function readPollState(value: unknown): MinimaxPollState {
  if (!value || typeof value !== "object") {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: "MiniMax poll state is missing.",
      retryable: false,
      requestState: "accepted",
    });
  }
  const taskId = (value as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: "MiniMax poll state is missing its taskId.",
      retryable: false,
      requestState: "accepted",
    });
  }
  return { taskId };
}

/**
 * What a MiniMax account needs.
 *
 * Two keys, and the region is one of them rather than a host column. Which MiniMax answers is the
 * account's fact: an international key is unknown to the domestic host, and the refusal arrives as
 * an authentication error rather than a routing one -- so the choice has to be made before the
 * request, by the person who holds the key.
 */
export const MINIMAX_AUTH: PluginAuthDeclaration = {
  /**
   * One method, because MiniMax has one way in.
   *
   * The region is not a second way of authenticating: the same key is presented the same way to
   * either host. Splitting them would ask the user to choose an authentication method in order to
   * express a deployment, and would duplicate `apiKey` across both.
   */
  methods: [
    {
      id: "api-key",
      label: "API key",
      form: [
        {
          kind: "field" as const,
          key: "apiKey",
          label: "API key",
          secret: true,
        },
        {
          kind: "choice" as const,
          key: "service",
          label: "Region",
          options: [
            { value: "international", label: "International (api.minimax.io)" },
            { value: "domestic", label: "China (api.minimaxi.com)" },
          ],
          default: "international",
        },
      ],
    },
  ],
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** State resolved by the host for the exact account selected for this route. */
async function accountState(
  context: ExecutorContext,
): Promise<Record<string, string>> {
  const keys = ["apiKey", "service", "baseUrl"] as const;
  const values = await Promise.all(
    keys.map(async (key) => [key, await context.store?.get(key)] as const),
  );
  return Object.fromEntries(
    values.filter(
      (entry): entry is readonly [(typeof keys)[number], string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
}

function requireApiKey(
  credentials: Record<string, string>,
  requestState: "rejected" | "accepted",
): string {
  const apiKey = credentials.apiKey;
  // An empty string reaches MiniMax as an empty Authorization header, and comes back as an
  // authentication failure that names the key rather than its absence.
  if (!apiKey) {
    throw new ProviderExecutionError({
      code: "authentication_failed",
      message: "This MiniMax account has no apiKey stored.",
      retryable: false,
      requestState,
    });
  }
  return apiKey;
}

function value(
  values: Record<string, unknown>,
  params: Record<string, unknown>,
  key: string,
): unknown {
  return params[key] ?? values[key];
}

/**
 * The shared card exposes stable product labels while MiniMax requires its
 * published built-in voice IDs on the wire. Keep that translation at the
 * provider boundary, just like upstream model names.
 *
 * Source: https://platform.minimax.io/docs/api-reference/speech-t2a-http
 */
const MINIMAX_TTS_VOICE_IDS: Readonly<Record<string, string>> = {
  "female-warm": "English_Graceful_Lady",
  "female-energetic": "English_radiant_girl",
  "male-calm": "English_Insightful_Speaker",
  "male-storyteller": "English_expressive_narrator",
};

function minimaxTtsVoiceId(value: unknown): string {
  const requested = String(value ?? "female-warm");
  return MINIMAX_TTS_VOICE_IDS[requested] ?? requested;
}

type ResolvedReference = Awaited<ReturnType<ExecutorContext["reference"]>>;
type MiniMaxMediaKind = "image" | "video" | "audio";

interface MiniMaxInputReferences {
  content: MiniMaxH3OrderedContentPart[];
  images: string[];
  videos: string[];
  audios: string[];
  startFrame?: string;
  endFrame?: string;
}

function defaultReferenceMediaType(kind: MiniMaxMediaKind): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/wav";
}

function mediaReferenceUrl(
  reference: ExecutablePluginReference,
  resolved: ResolvedReference,
  expectedKind?: MiniMaxMediaKind,
): { kind: MiniMaxMediaKind; url: string } {
  if (resolved.form !== "provider-url" && resolved.form !== "bytes") {
    throw rejectedInvalidRequest(
      `MiniMax H3 ${reference.slot} reference requires Provider-accessible media; ${resolved.form} is unsupported.`,
    );
  }
  const declaredKind = "asset" in reference ? reference.asset.kind : undefined;
  const kind = expectedKind ?? resolved.kind ?? declaredKind;
  if (kind !== "image" && kind !== "video" && kind !== "audio") {
    throw rejectedInvalidRequest(
      `MiniMax H3 ${reference.slot} reference has unsupported kind ${kind ?? "(missing)"}.`,
    );
  }
  if (
    expectedKind &&
    ((resolved.kind && resolved.kind !== expectedKind) ||
      (declaredKind && declaredKind !== expectedKind))
  ) {
    throw rejectedInvalidRequest(
      `MiniMax H3 ${reference.slot} reference must be ${expectedKind}.`,
    );
  }
  if (resolved.form === "provider-url") {
    return { kind, url: resolved.providerUrl };
  }
  const mediaType = resolved.mediaType ?? defaultReferenceMediaType(kind);
  return {
    kind,
    url: `data:${mediaType};base64,${Buffer.from(resolved.bytes).toString("base64")}`,
  };
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
): Promise<MiniMaxInputReferences> {
  const collected: MiniMaxInputReferences = {
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
      if (resolved.form === "text") {
        collected.content.push({ type: "text", text: resolved.text });
      } else {
        const media = mediaReferenceUrl(reference, resolved);
        collected.content.push({ type: media.kind, url: media.url });
      }
      continue;
    }
    const expectedKind =
      slot === "startFrame" || slot === "endFrame" ? "image" : slot;
    const media = mediaReferenceUrl(reference, resolved, expectedKind);
    if (slot === "image") collected.images.push(media.url);
    else if (slot === "video") collected.videos.push(media.url);
    else if (slot === "audio") collected.audios.push(media.url);
    else if (slot === "startFrame") {
      if (collected.startFrame) {
        throw rejectedInvalidRequest(
          "MiniMax H3 received more than one startFrame reference.",
        );
      }
      collected.startFrame = media.url;
    } else {
      if (collected.endFrame) {
        throw rejectedInvalidRequest(
          "MiniMax H3 received more than one endFrame reference.",
        );
      }
      collected.endFrame = media.url;
    }
  }
  return collected;
}

function requestBody(
  values: Record<string, unknown>,
  references: MiniMaxInputReferences,
): {
  body: Record<string, unknown>;
  musicEndpoint: boolean;
} {
  const explicit = record(values.body);
  if (Object.keys(explicit).length > 0) {
    return { body: explicit, musicEndpoint: values.musicEndpoint === true };
  }

  const modelId = typeof values.modelId === "string" ? values.modelId : "";
  const upstreamModel =
    typeof values.upstreamModel === "string"
      ? values.upstreamModel
      : typeof values.model === "string"
        ? values.model
        : "";
  if (!upstreamModel) {
    throw rejectedInvalidRequest("MiniMax executor needs an upstreamModel.");
  }
  const prompt = typeof values.prompt === "string" ? values.prompt : "";
  const params = record(values.modelParams);
  if (values.kind === "text") {
    const systemPrompt = value(values, params, "system_prompt");
    return {
      musicEndpoint: false,
      body: {
        model: upstreamModel,
        messages: [
          ...(typeof systemPrompt === "string" && systemPrompt.trim()
            ? [{ role: "system", content: systemPrompt.trim() }]
            : []),
          { role: "user", content: prompt },
        ],
        stream: false,
      },
    };
  }
  const audio = values.kind === "audio";
  const music =
    audio &&
    (modelId === "minimax-music-3" || upstreamModel.startsWith("music-"));

  if (audio) {
    const format = String(
      value(values, params, "format") ?? (music ? "mp3" : "wav"),
    );
    return {
      musicEndpoint: music,
      body: music
        ? {
            model: upstreamModel,
            prompt,
            lyrics: String(value(values, params, "lyrics") ?? ""),
            stream: false,
            output_format: "hex",
            lyrics_optimizer:
              value(values, params, "lyrics_optimizer") === true,
            is_instrumental: value(values, params, "is_instrumental") === true,
            aigc_watermark: value(values, params, "aigc_watermark") === true,
            audio_setting: {
              sample_rate: Number(
                value(values, params, "sample_rate") ?? 44100,
              ),
              bitrate: Number(value(values, params, "bitrate") ?? 256000),
              format,
            },
          }
        : {
            model: upstreamModel,
            text: prompt,
            stream: false,
            output_format: "hex",
            voice_setting: {
              voice_id: minimaxTtsVoiceId(value(values, params, "voice_id")),
              speed: Number(value(values, params, "speed") ?? 1),
              vol: Number(value(values, params, "vol") ?? 1),
              pitch: Number(value(values, params, "pitch") ?? 0),
            },
            audio_setting: {
              sample_rate: Number(
                value(values, params, "sample_rate") ?? 32000,
              ),
              bitrate: Number(value(values, params, "bitrate") ?? 128000),
              format,
              channel: Number(value(values, params, "channel") ?? 1),
            },
          },
    };
  }

  const startFrame = references.startFrame;
  const endFrame = references.endFrame;
  const ordered = references.content;
  return {
    musicEndpoint: false,
    body: {
      model: upstreamModel,
      content: buildMiniMaxH3Content({
        prompt,
        ...(ordered.length ? { orderedContentParts: ordered } : {}),
        ...(startFrame ? { startFrame } : {}),
        ...(endFrame ? { endFrame } : {}),
        ...(references.images.length
          ? { referenceImages: references.images }
          : {}),
        ...(references.videos.length
          ? { referenceVideos: references.videos }
          : {}),
        ...(references.audios.length
          ? { referenceAudios: references.audios }
          : {}),
      }),
      resolution: String(value(values, params, "resolution") ?? "2K"),
      duration: Number(value(values, params, "duration") ?? 5),
      ratio: startFrame
        ? "adaptive"
        : String(
            values.aspectRatio ??
              value(values, params, "aspect_ratio") ??
              "16:9",
          ),
    },
  };
}

type MiniMaxFetch = typeof globalThis.fetch;

const REFERENCE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
};

function cleanMediaType(value: string | undefined): string | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

function responseHeader(
  response: Awaited<ReturnType<MiniMaxFetch>>,
  name: string,
): string | undefined {
  return response.headers?.get(name) ?? undefined;
}

function decodeDataUri(uri: string): { bytes: Uint8Array; mediaType: string } {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) {
    throw rejectedInvalidRequest(
      "MiniMax H3 reference is not a valid data URI.",
    );
  }
  const metadata = uri.slice(5, comma).split(";");
  const mediaType = cleanMediaType(metadata[0]);
  if (!mediaType) {
    throw rejectedInvalidRequest("MiniMax H3 data URI has no media type.");
  }
  const payload = uri.slice(comma + 1);
  const bytes = metadata.some((entry) => entry.toLowerCase() === "base64")
    ? Uint8Array.from(Buffer.from(payload, "base64"))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { bytes, mediaType };
}

async function responseBytes(
  response: Awaited<ReturnType<MiniMaxFetch>>,
): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadReference(
  initialUrl: string,
  fetch: MiniMaxFetch,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeader(response, "location");
      if (!location) {
        throw rejectedInvalidRequest(
          `MiniMax H3 reference download redirected without a location: ${url}`,
        );
      }
      if (redirects === 5) {
        throw rejectedInvalidRequest(
          `MiniMax H3 reference download exceeded five redirects: ${initialUrl}`,
        );
      }
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw providerHttpError({
        status: response.status,
        message: `MiniMax H3 reference download failed with HTTP ${response.status}: ${url}`,
        operation: "submit",
      });
    }
    const mediaType = cleanMediaType(responseHeader(response, "content-type"));
    if (!mediaType || !REFERENCE_EXTENSIONS[mediaType]) {
      throw rejectedInvalidRequest(
        `MiniMax H3 reference download returned unsupported content type ${mediaType ?? "(missing)"}: ${url}`,
      );
    }
    return { bytes: await responseBytes(response), mediaType };
  }
  throw rejectedInvalidRequest(
    `MiniMax H3 reference download failed: ${initialUrl}`,
  );
}

async function materializeReference(
  url: string,
  fetch: MiniMaxFetch,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (url.startsWith("data:")) return decodeDataUri(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw rejectedInvalidRequest(
      `MiniMax H3 cannot upload reference URL scheme ${parsed.protocol}`,
    );
  }
  return downloadReference(url, fetch);
}

function multipartUpload(
  reference: { bytes: Uint8Array; mediaType: string },
  index: number,
): FormData {
  const extension = REFERENCE_EXTENSIONS[reference.mediaType];
  if (!extension) {
    throw rejectedInvalidRequest(
      `MiniMax H3 cannot upload reference content type ${reference.mediaType}.`,
    );
  }
  const filename = `reference-${index}.${extension}`;
  const bytes = reference.bytes.buffer.slice(
    reference.bytes.byteOffset,
    reference.bytes.byteOffset + reference.bytes.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.append("purpose", "video_generation_input");
  form.append(
    "file",
    new Blob([bytes], { type: reference.mediaType }),
    filename,
  );
  return form;
}

function uploadedFileId(body: Record<string, unknown>): string | undefined {
  const file = record(body.file);
  const raw = file.file_id ?? body.file_id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
    return String(raw);
  return undefined;
}

async function uploadH3Reference(options: {
  url: string;
  index: number;
  apiKey: string;
  baseUrl: string;
  fetch: MiniMaxFetch;
  referenceFetch: MiniMaxFetch;
}): Promise<string> {
  if (options.url.startsWith("mm_file://")) return options.url;
  const reference = await materializeReference(
    options.url,
    options.referenceFetch,
  );
  const multipart = multipartUpload(reference, options.index);
  const response = await options.fetch(
    `${options.baseUrl.replace(/\/+$/, "")}/v1/files/upload`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
      },
      // Leave Content-Type unset: fetch adds the boundary matching this FormData.
      body: multipart,
    },
  );
  const raw = await response.text();
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(raw));
  } catch {
    const message = `MiniMax H3 file upload failed: ${raw || response.statusText}`;
    if (!response.ok) {
      throw providerHttpError({
        status: response.status,
        message,
        operation: "submit",
      });
    }
    throw rejectedInvalidResponse(message);
  }
  const baseResp = record(body.base_resp);
  const providerCode = baseResp.status_code;
  const detail =
    typeof baseResp.status_msg === "string" && baseResp.status_msg
      ? baseResp.status_msg
      : typeof body.message === "string" && body.message
        ? body.message
        : response.statusText;
  const message = `MiniMax H3 file upload failed: ${detail}`;
  if (!response.ok) {
    throw providerHttpError({
      status: response.status,
      message,
      operation: "submit",
      ...(providerCode === undefined
        ? {}
        : { providerCode: String(providerCode) }),
    });
  }
  if (providerCode !== undefined && providerCode !== 0) {
    throw new ProviderExecutionError({
      code: providerCode === 1004 ? "authentication_failed" : "provider_failed",
      message,
      retryable: false,
      requestState: "rejected",
      providerCode: String(providerCode),
    });
  }
  const fileId = uploadedFileId(body);
  if (!fileId) {
    throw rejectedInvalidResponse(
      "MiniMax H3 file upload returned no file_id.",
    );
  }
  return `mm_file://${fileId}`;
}

async function uploadH3Content(options: {
  body: Record<string, unknown>;
  apiKey: string;
  baseUrl: string;
  fetch: MiniMaxFetch;
  referenceFetch: MiniMaxFetch;
}): Promise<Record<string, unknown>> {
  if (
    options.body.model !== "MiniMax-H3" ||
    !Array.isArray(options.body.content)
  ) {
    return options.body;
  }
  let index = 0;
  const content: Array<Record<string, unknown>> = [];
  for (const rawPart of options.body.content) {
    const part = record(rawPart);
    const type = typeof part.type === "string" ? part.type : "";
    if (type !== "image_url" && type !== "video_url" && type !== "audio_url") {
      content.push(part);
      continue;
    }
    const field = record(part[type]);
    if (typeof field.url !== "string" || !field.url) {
      throw rejectedInvalidRequest(`MiniMax H3 ${type} content has no URL.`);
    }
    index += 1;
    const url = await uploadH3Reference({
      url: field.url,
      index,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      referenceFetch: options.referenceFetch,
    });
    content.push({ ...part, [type]: { ...field, url } });
  }
  return { ...options.body, content };
}

export const minimaxAdapter: ProviderExecutor = {
  async submit(invocation, context: ExecutorContext): Promise<ExecutorStep> {
    const credentials = await accountState(context);
    const references = await resolveInputReferences(invocation, context);
    const request = requestBody(invocation.input.values, references);
    const apiKey = requireApiKey(credentials, "rejected");
    const baseUrl = minimaxBaseUrl({
      ...(credentials.service ? { service: credentials.service } : {}),
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    });
    const fetch = globalThis.fetch;
    const body = await uploadH3Content({
      body: request.body,
      apiKey,
      baseUrl,
      fetch,
      referenceFetch: fetch,
    });
    const submitted = await minimaxSubmit({
      kind:
        invocation.input.values.kind === "audio"
          ? "audio"
          : invocation.input.values.kind === "text"
            ? "text"
            : "video",
      apiKey,
      body,
      fetch: fetch as never,
      // Which MiniMax answers is the account's own fact, selected and injected by the host: an international
      // key is unknown to the domestic host, and the refusal arrives as an authentication error.
      baseUrl,
      ...(request.musicEndpoint ? { musicEndpoint: true } : {}),
    });
    // One provider, two lifecycles: video queues and is polled, speech hands back bytes on the
    // first call. Returning the finished arm rather than inventing a task id for the audio path is
    // what keeps the poll contract describing something real.
    if (submitted.status === "completed") {
      if ("text" in submitted) {
        return {
          status: "completed",
          outputs: valueOutput(submitted.text, "text"),
        };
      }
      return {
        status: "completed",
        media: {
          media: {
            bytes: submitted.media.bytes,
            mediaType: submitted.media.contentType,
          },
        },
      };
    }
    return {
      status: "accepted",
      pollState: { taskId: submitted.pollState.taskId },
    };
  },
  async poll(invocation, context: ExecutorContext): Promise<ExecutorStep> {
    const state = readPollState(invocation.pollState);
    // Reject unusable persisted state before touching the selected account. A
    // malformed poll can never make a provider request, so asking the broker
    // for credentials first only hides the actionable recovery error.
    const credentials = await accountState(context);
    const result = await minimaxPoll({
      state,
      apiKey: requireApiKey(credentials, "accepted"),
      fetch: globalThis.fetch as never,
      baseUrl: minimaxBaseUrl({
        ...(credentials.service ? { service: credentials.service } : {}),
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      }),
    });
    if (result.status === "accepted") {
      return {
        status: "accepted",
        pollState: { taskId: result.pollState.taskId },
      };
    }
    return {
      status: "completed",
      media: {
        media: {
          url: result.media.url,
          mediaType: "video/mp4",
        },
      },
    };
  },
};
