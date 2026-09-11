import {
  gptImageSizeForRatio,
  parseAspectRatio,
  resolveGptImageSize,
} from "@clash/shared-types/gpt-image-size";
import type { ExecutablePluginReference } from "@clash/shared-types/executable-plugin";
import {
  ProviderExecutionError,
  type ExecutorContext,
  type ExecutorStep,
  type Executor as ProviderExecutor,
} from "@clash/action-sdk";

import {
  HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
  falPoll,
  falSubmit,
  invalidRequest,
  uploadFalBytes,
  type FalDirectorModelInput,
  type FalDirectorModelQuality,
  type FalMediaKind,
  type FalPollState,
} from "./fal-executor.js";

interface FalReferences {
  images: string[];
  videos: string[];
  audios: string[];
  startFrame?: string;
  endFrame?: string;
}

interface FalRequest {
  endpoint: string;
  input: Record<string, unknown> | FalDirectorModelInput;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function modelParam(values: Record<string, unknown>, key: string): unknown {
  const params = record(values.modelParams);
  return key in params ? params[key] : values[key];
}

function stringParam(
  values: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = modelParam(values, key);
  return typeof value === "string" ? value : fallback;
}

function numberParam(
  values: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = modelParam(values, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function booleanParam(
  values: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = modelParam(values, key);
  return typeof value === "boolean" ? value : fallback;
}

function requiredString(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`fal request is missing ${key}.`);
  }
  return value;
}

function mediaKind(value: unknown): FalMediaKind {
  if (
    value === "image" ||
    value === "video" ||
    value === "audio" ||
    value === "model"
  ) {
    return value;
  }
  throw invalidRequest(`fal does not support output kind ${String(value)}.`);
}

function pollState(value: unknown): FalPollState {
  const state = record(value);
  if (typeof state.requestId !== "string" || !state.requestId) {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: "fal poll state is missing its requestId.",
      retryable: false,
      requestState: "accepted",
    });
  }
  if (
    state.phase !== undefined &&
    state.phase !== "status" &&
    state.phase !== "result"
  ) {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: `fal poll state has an unsupported phase: ${String(state.phase)}.`,
      retryable: false,
      requestState: "accepted",
    });
  }
  if (
    state.endpoint !== undefined &&
    (typeof state.endpoint !== "string" || !state.endpoint)
  ) {
    throw new ProviderExecutionError({
      code: "contract_violation",
      message: "fal poll state has an invalid endpoint.",
      retryable: false,
      requestState: "accepted",
    });
  }
  return {
    requestId: state.requestId,
    ...(state.phase === undefined ? {} : { phase: state.phase }),
    ...(typeof state.endpoint === "string" ? { endpoint: state.endpoint } : {}),
  };
}

function durablePollState(state: FalPollState): Record<string, string> {
  return {
    requestId: state.requestId,
    ...(state.phase ? { phase: state.phase } : {}),
    ...(state.endpoint ? { endpoint: state.endpoint } : {}),
  };
}

async function accountState(context: ExecutorContext): Promise<{
  apiKey: string;
  queueBaseUrl?: string;
  storageBaseUrl?: string;
}> {
  const apiKey = (await context.store.get("apiKey")) ?? "";
  const storedQueueBaseUrl = await context.store.get("queueBaseUrl");
  const storedStorageBaseUrl = await context.store.get("storageBaseUrl");
  const queueBaseUrl =
    storedQueueBaseUrl?.trim() || process.env.CLASH_FAL_QUEUE_URL?.trim();
  const storageBaseUrl =
    storedStorageBaseUrl?.trim() || process.env.CLASH_FAL_STORAGE_URL?.trim();
  return {
    apiKey,
    ...(queueBaseUrl ? { queueBaseUrl } : {}),
    ...(storageBaseUrl ? { storageBaseUrl } : {}),
  };
}

function directorInput(values: Record<string, unknown>): FalDirectorModelInput {
  const quality = modelParam(values, "quality");
  const faceCount = modelParam(values, "faceCount");
  return {
    prompt: typeof values.prompt === "string" ? values.prompt : "",
    quality:
      quality === "low-poly" || quality === "geometry"
        ? (quality as FalDirectorModelQuality)
        : "normal",
    pbr: modelParam(values, "pbr") !== false,
    ...(typeof faceCount === "number" ? { faceCount } : {}),
  };
}

function defaultReferenceMediaType(kind: "image" | "video" | "audio"): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/wav";
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

async function resolveReferences(
  references: readonly ExecutablePluginReference[],
  context: ExecutorContext,
  credentials: { apiKey: string; storageBaseUrl?: string },
  taskId: string,
): Promise<FalReferences> {
  const result: FalReferences = { images: [], videos: [], audios: [] };
  for (const reference of sortedReferences(references)) {
    if (!("asset" in reference)) continue;
    const expectedKind =
      reference.slot === "startFrame" || reference.slot === "endFrame"
        ? "image"
        : reference.asset.kind;
    if (
      expectedKind !== "image" &&
      expectedKind !== "video" &&
      expectedKind !== "audio"
    ) {
      continue;
    }
    const resolved = await context.reference(reference);
    if (resolved.form !== "provider-url" && resolved.form !== "bytes") {
      throw invalidRequest(
        `fal ${reference.slot} reference must resolve to a provider URL or bytes, not ${resolved.form}.`,
      );
    }
    if (resolved.kind && resolved.kind !== expectedKind) {
      throw invalidRequest(
        `fal ${reference.slot} reference must be ${expectedKind}.`,
      );
    }
    const url =
      resolved.form === "provider-url"
        ? resolved.providerUrl
        : await uploadFalBytes({
            apiKey: credentials.apiKey,
            bytes: resolved.bytes,
            contentType:
              resolved.mediaType ?? defaultReferenceMediaType(expectedKind),
            fileName: `${taskId.replace(/[^a-zA-Z0-9._-]/g, "-")}-${reference.slot}-${reference.index}`,
            fetch: globalThis.fetch,
            ...(credentials.storageBaseUrl
              ? { storageBaseUrl: credentials.storageBaseUrl }
              : {}),
          });
    if (reference.slot === "startFrame") {
      if (result.startFrame) {
        throw invalidRequest("fal received multiple start frames.");
      }
      result.startFrame = url;
    } else if (reference.slot === "endFrame") {
      if (result.endFrame)
        throw invalidRequest("fal received multiple end frames.");
      result.endFrame = url;
    } else if (expectedKind === "image") result.images.push(url);
    else if (expectedKind === "video") result.videos.push(url);
    else result.audios.push(url);
  }
  return result;
}

function aspectRatioToImageSize(
  aspectRatio: string,
): string | { width: number; height: number } {
  const named: Record<string, string> = {
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "1:1": "square_hd",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
    "2:3": "portrait_4_3",
    "3:2": "landscape_4_3",
    "4:5": "portrait_4_3",
    "5:4": "landscape_4_3",
  };
  if (named[aspectRatio]) return named[aspectRatio]!;
  return parseAspectRatio(aspectRatio) === undefined
    ? "landscape_16_9"
    : gptImageSizeForRatio(aspectRatio, "2K");
}

function falImageSize(
  values: Record<string, unknown>,
  fallbackRatio: string,
): string | { width: number; height: number } {
  const explicit = modelParam(values, "image_size");
  if (
    typeof explicit === "string" ||
    (explicit && typeof explicit === "object" && !Array.isArray(explicit))
  ) {
    return explicit as string | { width: number; height: number };
  }
  const aspectRatio =
    typeof values.aspectRatio === "string"
      ? values.aspectRatio
      : stringParam(values, "aspect_ratio", fallbackRatio);
  return aspectRatioToImageSize(
    !aspectRatio || aspectRatio === "auto" ? fallbackRatio : aspectRatio,
  );
}

function imageRequest(
  values: Record<string, unknown>,
  references: FalReferences,
): FalRequest {
  const modelId = requiredString(values, "modelId");
  const upstreamModel = requiredString(values, "upstreamModel");
  const prompt = requiredString(values, "prompt");
  const images = references.images;
  const editEndpoints: Record<string, string> = {
    "gpt-image-2": "openai/gpt-image-2/edit",
    "gpt-image-2.5-flare": "openai/gpt-image-2.5/flare/edit",
    "gpt-image-2.5-sunburst": "openai/gpt-image-2.5/sunburst/edit",
    "nano-banana-2": "fal-ai/nano-banana-2/edit",
    "seedream-4.5": "fal-ai/bytedance/seedream/v4.5/edit",
    "flux-2-pro": "fal-ai/flux-2-pro/edit",
  };
  const endpoint = images.length ? editEndpoints[modelId] : upstreamModel;
  if (!endpoint) {
    throw invalidRequest(
      `fal image model ${modelId} does not accept references.`,
    );
  }

  if (
    ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(
      modelId,
    )
  ) {
    const params = record(values.modelParams);
    return {
      endpoint,
      input: {
        prompt,
        image_size:
          params.image_size &&
          (typeof params.image_size === "string" ||
            (typeof params.image_size === "object" &&
              !Array.isArray(params.image_size)))
            ? params.image_size
            : resolveGptImageSize(
                params,
                typeof values.aspectRatio === "string"
                  ? values.aspectRatio
                  : undefined,
              ),
        quality: stringParam(values, "quality", "high"),
        ...(modelId !== "gpt-image-2"
          ? { background: stringParam(values, "background", "auto") }
          : {}),
        num_images: numberParam(values, "count", 1),
        output_format: stringParam(values, "output_format", "png"),
        ...(images.length ? { image_urls: images } : {}),
      },
    };
  }
  if (modelId === "seedream-4.5") {
    const aspectRatio =
      typeof values.aspectRatio === "string" ? values.aspectRatio : undefined;
    return {
      endpoint,
      input: {
        prompt,
        image_size:
          aspectRatio && aspectRatio !== "auto"
            ? falImageSize(values, "1:1")
            : stringParam(
                values,
                "image_size",
                `auto_${stringParam(values, "resolution", "2K")}`,
              ),
        num_images: numberParam(values, "count", 1),
        max_images: numberParam(values, "max_images", 1),
        enable_safety_checker: booleanParam(
          values,
          "enable_safety_checker",
          true,
        ),
        ...(images.length ? { image_urls: images } : {}),
      },
    };
  }
  if (modelId === "recraft-v4") {
    return {
      endpoint,
      input: {
        prompt,
        image_size: falImageSize(values, "1:1"),
        enable_safety_checker: false,
      },
    };
  }
  if (modelId === "flux-2-pro") {
    return {
      endpoint,
      input: {
        prompt,
        image_size: falImageSize(values, "4:3"),
        output_format: "png",
        safety_tolerance: stringParam(values, "safety_tolerance", "2"),
        enable_safety_checker: false,
        ...(images.length ? { image_urls: images } : {}),
      },
    };
  }
  if (modelId === "flux-schnell" || modelId === "flux-dev") {
    const input: Record<string, unknown> = {
      prompt,
      image_size: falImageSize(values, "16:9"),
      num_images: numberParam(values, "count", 1),
      output_format: "png",
      enable_safety_checker: false,
    };
    const steps = modelParam(values, "num_inference_steps");
    if (steps !== undefined) input.num_inference_steps = steps;
    const guidance = modelParam(values, "guidance_scale");
    if (modelId === "flux-dev" && guidance !== undefined) {
      input.guidance_scale = guidance;
    }
    return { endpoint, input };
  }
  if (modelId === "nano-banana-2") {
    return {
      endpoint,
      input: {
        prompt,
        aspect_ratio:
          typeof values.aspectRatio === "string" ? values.aspectRatio : "1:1",
        num_images: 1,
        output_format: "png",
        ...(images.length ? { image_urls: images } : {}),
      },
    };
  }
  throw invalidRequest(`Unsupported fal image model: ${modelId}.`);
}

function durationValue(
  values: Record<string, unknown>,
  fallback: number | string,
) {
  return values.duration ?? modelParam(values, "duration") ?? fallback;
}

function resolution(
  values: Record<string, unknown>,
  supported: readonly string[],
  fallback: string,
): string {
  const raw = stringParam(values, "resolution");
  return (
    supported.find((value) => value.toLowerCase() === raw.toLowerCase()) ??
    fallback
  );
}

function finiteModelParam(
  values: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = modelParam(values, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function resolveFlux3KeyframeIndices(
  params: Record<string, unknown>,
  keyframeCount: number,
  duration: unknown,
): number[] {
  const numericDuration =
    typeof duration === "number"
      ? duration
      : Number.parseInt(String(duration ?? ""), 10);
  if (
    !Number.isInteger(numericDuration) ||
    numericDuration < 5 ||
    numericDuration > 20
  ) {
    throw new Error(
      "FLUX 3 keyframes require an explicit whole-number duration from 5 to 20 seconds.",
    );
  }
  const lastFrame = numericDuration * 24;
  const raw = params.keyframe_frame_indices;
  if (raw == null || raw === "") {
    return Array.from({ length: keyframeCount }, (_, index) =>
      Math.round((index * lastFrame) / (keyframeCount - 1)),
    );
  }
  if (typeof raw !== "string") {
    throw new Error(
      "FLUX 3 keyframe_frame_indices must be a JSON array string.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FLUX 3 keyframe_frame_indices must contain valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== keyframeCount) {
    throw new Error(
      `FLUX 3 keyframe_frame_indices must contain exactly ${keyframeCount} entries.`,
    );
  }
  const indices = parsed.map(Number);
  const valid = indices.every(
    (value, index) =>
      Number.isInteger(value) &&
      value >= 0 &&
      value <= lastFrame &&
      (index === 0 || value > indices[index - 1]!),
  );
  if (!valid) {
    throw new Error(
      `FLUX 3 keyframe indices must be unique, increasing integers between 0 and ${lastFrame}.`,
    );
  }
  return indices;
}

function videoRequest(
  values: Record<string, unknown>,
  references: FalReferences,
): FalRequest {
  const modelId = requiredString(values, "modelId");
  const prompt = requiredString(values, "prompt");
  const aspectRatio =
    typeof values.aspectRatio === "string" ? values.aspectRatio : "auto";
  if (modelId === "sora-2") {
    const image = references.images[0];
    const duration = Number(durationValue(values, 4));
    return {
      endpoint: image
        ? "fal-ai/sora-2/image-to-video/pro"
        : "fal-ai/sora-2/text-to-video",
      input: {
        prompt,
        duration: Number.isFinite(duration) ? duration : 4,
        aspect_ratio: aspectRatio === "auto" ? "16:9" : aspectRatio,
        resolution: "720p",
        delete_video: false,
        ...(image ? { image_url: image } : {}),
      },
    };
  }
  if (modelId === "kling-3") {
    if (!references.startFrame) {
      throw invalidRequest("Kling 3 requires a start frame.");
    }
    const duration = Math.min(
      15,
      Math.max(3, Number(durationValue(values, 5)) || 5),
    );
    return {
      endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
      input: {
        prompt,
        duration: String(duration),
        start_image_url: references.startFrame,
        generate_audio: booleanParam(values, "generate_audio", true),
        ...(references.endFrame ? { end_image_url: references.endFrame } : {}),
      },
    };
  }
  if (modelId.startsWith("flux-3-video")) {
    const duration = durationValue(values, "auto");
    const common = {
      prompt,
      duration,
      aspect_ratio: aspectRatio,
      resolution: resolution(values, ["720p", "1080p"], "720p"),
      generate_audio: booleanParam(values, "generate_audio", true),
      safety_tolerance: numberParam(values, "safety_tolerance", 2),
    };
    if (modelId === "flux-3-video-continue") {
      if (!references.videos[0]) {
        throw invalidRequest("FLUX 3 continuation requires one source video.");
      }
      return {
        endpoint: "blackforestlabs/flux-3/extend-video",
        input: { ...common, video_url: references.videos[0] },
      };
    }
    if (modelId === "flux-3-video-keyframes") {
      const images = references.images;
      if (images.length === 0) {
        throw invalidRequest("FLUX 3 keyframes require at least one image.");
      }
      if (images.length > 10) {
        throw invalidRequest("FLUX 3 accepts at most 10 keyframes.");
      }
      if (images.length === 1) {
        return {
          endpoint: "blackforestlabs/flux-3/image-to-video",
          input: { ...common, image_url: images[0] },
        };
      }
      if (images.length === 2) {
        return {
          endpoint: "blackforestlabs/flux-3/first-last-frame-to-video",
          input: {
            ...common,
            start_image_url: images[0],
            end_image_url: images[1],
          },
        };
      }
      let frameIndices: number[];
      try {
        frameIndices = resolveFlux3KeyframeIndices(
          record(values.modelParams),
          images.length,
          duration,
        );
      } catch (error) {
        throw invalidRequest(
          error instanceof Error ? error.message : String(error),
        );
      }
      return {
        endpoint: "blackforestlabs/flux-3/keyframes-to-video",
        input: {
          ...common,
          keyframes: images.map((imageUrl, index) => ({
            image_url: imageUrl,
            frame_index: frameIndices[index],
          })),
        },
      };
    }
    return {
      endpoint: "blackforestlabs/flux-3/text-to-video",
      input: common,
    };
  }
  if (modelId === "seedance-2-startend") {
    if (!references.startFrame) {
      throw invalidRequest("Seedance 2 start/end requires a start frame.");
    }
    const duration = durationValue(values, "auto");
    const seed = finiteModelParam(values, "seed");
    return {
      endpoint: "bytedance/seedance-2.0/image-to-video",
      input: {
        prompt,
        duration: duration === "auto" ? duration : Number(duration),
        resolution: resolution(values, ["480p", "720p"], "720p"),
        generate_audio: booleanParam(values, "generate_audio", true),
        image_url: references.startFrame,
        ...(references.endFrame ? { end_image_url: references.endFrame } : {}),
        ...(seed === undefined ? {} : { seed }),
      },
    };
  }
  if (modelId === "seedance-2-ref") {
    const duration = durationValue(values, "auto");
    const seed = finiteModelParam(values, "seed");
    return {
      endpoint: "bytedance/seedance-2.0/reference-to-video",
      input: {
        prompt,
        duration: duration === "auto" ? duration : Number(duration),
        resolution: resolution(values, ["480p", "720p"], "720p"),
        aspect_ratio: aspectRatio,
        generate_audio: booleanParam(values, "generate_audio", true),
        ...(seed === undefined ? {} : { seed }),
        ...(references.images.length ? { image_urls: references.images } : {}),
        ...(references.videos.length ? { video_urls: references.videos } : {}),
        ...(references.audios.length ? { audio_urls: references.audios } : {}),
      },
    };
  }
  if (modelId === "minimax-h3-startend") {
    if (!references.startFrame) {
      throw invalidRequest("MiniMax H3 start/end requires a start frame.");
    }
    return {
      endpoint: "minimax/h3/image-to-video",
      input: {
        prompt,
        duration: Number(durationValue(values, 5)),
        resolution: resolution(values, ["768P", "2K"], "768P"),
        image_url: references.startFrame,
        ...(references.endFrame ? { end_image_url: references.endFrame } : {}),
      },
    };
  }
  if (modelId === "minimax-h3") {
    const hasReferences =
      references.images.length +
        references.videos.length +
        references.audios.length >
      0;
    if (!hasReferences && aspectRatio === "adaptive") {
      throw invalidRequest(
        "MiniMax H3 Auto aspect ratio requires at least one reference.",
      );
    }
    return {
      endpoint: hasReferences
        ? "minimax/h3/reference-to-video"
        : "minimax/h3/text-to-video",
      input: {
        prompt,
        duration: Number(durationValue(values, 5)),
        resolution: resolution(values, ["768P", "2K"], "768P"),
        aspect_ratio: aspectRatio === "auto" ? "16:9" : aspectRatio,
        ...(references.images.length
          ? { reference_image_urls: references.images }
          : {}),
        ...(references.videos.length
          ? { reference_video_urls: references.videos }
          : {}),
        ...(references.audios.length
          ? { reference_audio_urls: references.audios }
          : {}),
      },
    };
  }
  throw invalidRequest(`Unsupported fal video model: ${modelId}.`);
}

const MINIMAX_TTS_VOICE_IDS: Readonly<Record<string, string>> = {
  "female-warm": "English_Graceful_Lady",
  "female-energetic": "English_radiant_girl",
  "male-calm": "English_Insightful_Speaker",
  "male-storyteller": "English_expressive_narrator",
};

function audioRequest(values: Record<string, unknown>): FalRequest {
  const modelId = requiredString(values, "modelId");
  const endpoint = requiredString(values, "upstreamModel");
  const prompt = typeof values.prompt === "string" ? values.prompt : "";
  if (modelId === "minimax-tts") {
    const requestedVoice = stringParam(values, "voice_id", "female-warm");
    return {
      endpoint,
      input: {
        text: prompt,
        voice_setting: {
          voice_id: MINIMAX_TTS_VOICE_IDS[requestedVoice] ?? requestedVoice,
          speed: numberParam(values, "speed", 1),
          pitch: numberParam(values, "pitch", 0),
        },
        audio_setting: { format: stringParam(values, "format", "mp3") },
      },
    };
  }
  if (modelId === "minimax-music-3") {
    return {
      endpoint,
      input: {
        prompt,
        lyrics: stringParam(values, "lyrics"),
        lyrics_optimizer: booleanParam(values, "lyrics_optimizer"),
        is_instrumental: booleanParam(values, "is_instrumental"),
        audio_setting: {
          sample_rate: numberParam(values, "sample_rate", 44_100),
          bitrate: numberParam(values, "bitrate", 256_000),
          format: stringParam(values, "format", "mp3"),
        },
      },
    };
  }
  throw invalidRequest(`Unsupported fal audio model: ${modelId}.`);
}

function requestFor(
  values: Record<string, unknown>,
  references: FalReferences,
): FalRequest {
  const endpoint =
    typeof values.upstreamModel === "string"
      ? values.upstreamModel
      : typeof values.modelEndpoint === "string"
        ? values.modelEndpoint
        : HUNYUAN3D_TEXT_TO_3D_ENDPOINT;
  if (endpoint === HUNYUAN3D_TEXT_TO_3D_ENDPOINT) {
    return { endpoint, input: directorInput(values) };
  }
  const kind = mediaKind(values.kind);
  if (kind === "image") return imageRequest(values, references);
  if (kind === "video") return videoRequest(values, references);
  if (kind === "audio") return audioRequest(values);
  throw invalidRequest(`Unsupported fal model endpoint: ${endpoint}.`);
}

export const falAdapter: ProviderExecutor = {
  async submit(invocation, context): Promise<ExecutorStep> {
    const credentials = await accountState(context);
    const references = await resolveReferences(
      invocation.input.references,
      context,
      credentials,
      invocation.taskId,
    );
    const request = requestFor(invocation.input.values, references);
    const submitted = await falSubmit({
      apiKey: credentials.apiKey,
      endpoint: request.endpoint,
      input: request.input,
      fetch: globalThis.fetch,
      ...(credentials.queueBaseUrl
        ? { queueBaseUrl: credentials.queueBaseUrl }
        : {}),
    });
    return {
      status: "accepted",
      pollState: durablePollState(submitted.pollState),
    };
  },

  async poll(invocation, context): Promise<ExecutorStep> {
    const state = pollState(invocation.pollState);
    const credentials = await accountState(context);
    const kind =
      typeof invocation.input.values.upstreamModel === "string" &&
      invocation.input.values.upstreamModel === HUNYUAN3D_TEXT_TO_3D_ENDPOINT
        ? "model"
        : mediaKind(invocation.input.values.kind);
    const endpoint =
      state.endpoint ??
      (typeof invocation.input.values.upstreamModel === "string"
        ? invocation.input.values.upstreamModel
        : HUNYUAN3D_TEXT_TO_3D_ENDPOINT);
    const result = await falPoll({
      apiKey: credentials.apiKey,
      endpoint,
      kind,
      state,
      fetch: globalThis.fetch,
      ...(credentials.queueBaseUrl
        ? { queueBaseUrl: credentials.queueBaseUrl }
        : {}),
    });
    if (result.status === "accepted") {
      return {
        status: "accepted",
        pollState: durablePollState(result.pollState),
        ...(result.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: result.retryAfterMs }),
      };
    }
    return {
      status: "completed",
      media: {
        media: {
          url: result.media.url,
          mediaType: result.media.contentType,
          kind,
        },
      },
    };
  },
};
