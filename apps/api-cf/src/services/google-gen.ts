import { providerHttpError } from "@clash/action-sdk/executable-failure";
/**
 * Image & video generation via Google Vertex AI (Vercel AI SDK).
 *
 * Uses @ai-sdk/google-vertex/edge with service account credentials
 * (clientEmail + privateKey from env vars).
 * Returns raw bytes (Uint8Array) — callers upload to R2.
 */
import { generateImage, generateText } from "ai";
import { createVertex } from "@ai-sdk/google-vertex/edge";
import { normalizeModelId } from "@clash/shared-types";
import { getVertexAccessTokenForCredentials } from "./vertex-auth";

// ─── Shared ─────────────────────────────────────────────

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  project: string;
  location?: string;
}

function makeVertex(creds: GoogleServiceAccount) {
  return createVertex({
    project: creds.project,
    location: creds.location ?? "global",
    googleCredentials: {
      clientEmail: creds.clientEmail,
      privateKey: creds.privateKey,
    },
  });
}

// ─── Audio Generation (Gemini TTS) ───────────────────────

export interface GoogleAudioParams {
  prompt: string;
  modelName?: string;
  modelParams?: Record<string, unknown>;
  baseUrl?: string;
  /** Cloudflare AI Gateway auth token (only required when baseUrl points at an
   *  authenticated gateway). Sent as `cf-aig-authorization: Bearer <token>`. */
  cfAigToken?: string;
}

export interface GoogleAudioResult {
  data: Uint8Array;
  mediaType: string;
  model: string;
}

export const GOOGLE_AUDIO_MODELS = new Set([
  "gemini-3.1-flash-tts",
  "gemini-2.5-pro-tts",
]);

const GOOGLE_AUDIO_MODEL_MAP: Record<string, string> = {
  "gemini-3.1-flash-tts": "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-tts": "gemini-2.5-pro-tts",
};

const GOOGLE_AUDIO_PROVIDER_MODELS = new Set(Object.values(GOOGLE_AUDIO_MODEL_MAP));

export function isGoogleAudioModel(modelName: string | undefined): boolean {
  return !!modelName && (GOOGLE_AUDIO_MODELS.has(modelName) || GOOGLE_AUDIO_PROVIDER_MODELS.has(modelName));
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function writeAscii(out: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) out[offset + i] = value.charCodeAt(i);
}

/** Gemini API TTS returns signed 16-bit little-endian PCM at 24 kHz. */
function pcm16ToWav(pcm: Uint8Array, sampleRate = 24_000, channels = 1): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(out, 36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function extractGeminiAudioBase64(response: unknown): string | null {
  const candidates = (response as any)?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inlineData = part?.inlineData ?? part?.inline_data;
      if (typeof inlineData?.data === "string" && inlineData.data) {
        return inlineData.data;
      }
    }
  }
  return null;
}

export async function generateGoogleAudio(
  apiKey: string | undefined,
  params: GoogleAudioParams,
): Promise<GoogleAudioResult> {
  if (!apiKey) throw new Error("Google AI Studio provider account is missing apiKey.");

  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("Prompt is required for Gemini TTS audio generation.");

  const modelId =
    GOOGLE_AUDIO_MODEL_MAP[params.modelName ?? "gemini-3.1-flash-tts"] ??
    params.modelName ??
    "gemini-3.1-flash-tts-preview";
  const voiceName =
    typeof params.modelParams?.voice_name === "string" && params.modelParams.voice_name.trim()
      ? params.modelParams.voice_name.trim()
      : "Kore";
  // baseUrl may omit `/v1beta` (common when the user pastes a CF AI Gateway
  // root like `.../google-ai-studio`) — append it so we always hit Google's
  // REST path. The default already ends with `/v1beta`.
  let baseUrl = (params.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  if (!/\/v1(beta|alpha)?$/.test(baseUrl)) baseUrl = `${baseUrl}/v1beta`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
  // Authenticated CF AI Gateways require this header — without it Google AI
  // Studio routes return 401 even with a valid upstream key.
  if (params.cfAigToken && /gateway\.ai\.cloudflare\.com/.test(baseUrl)) {
    headers["cf-aig-authorization"] = `Bearer ${params.cfAigToken}`;
  }

  const resp = await fetch(`${baseUrl}/models/${modelId}:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    }),
  });

  const raw = await resp.text();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { error: { message: raw } };
  }
  if (!resp.ok) {
    const message = (json as any)?.error?.message ?? `${resp.status} ${resp.statusText}`;
    throw new Error(`Gemini TTS request failed: ${message}`);
  }

  const audioBase64 = extractGeminiAudioBase64(json);
  if (!audioBase64) throw new Error(`Gemini TTS returned no audio for ${modelId}.`);

  return {
    data: pcm16ToWav(base64ToBytes(audioBase64)),
    mediaType: "audio/wav",
    model: modelId,
  };
}

// ─── Text Generation (Gemini multimodal) ────────────────

export interface GoogleTextParams {
  /** Pre-built Vercel AI SDK messages array. Caller assembles multimodal parts. */
  messages: any[];
  modelName?: string;
  systemPrompt?: string;
}

export interface GoogleTextResult {
  text: string;
  model: string;
}

export const GOOGLE_TEXT_MODELS = new Set([
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-3.1-flash-lite",
]);

export function isGoogleTextModel(modelName: string | undefined): boolean {
  return !!modelName && GOOGLE_TEXT_MODELS.has(modelName);
}

// Card ID → Vertex provider model ID. Both are public preview on global only
// (regional endpoints return 404). gemini-3-pro-preview was retired 2026-03-09;
// 3.1-pro-preview is the live successor. Flash never had a .1 minor — it's
// just gemini-3-flash-preview.
//   Docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro
//         https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-flash
const GOOGLE_TEXT_MODEL_MAP: Record<string, string> = {
  "gemini-3.5-flash": "gemini-3.5-flash",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
};

export async function generateGoogleText(
  creds: GoogleServiceAccount,
  params: GoogleTextParams,
): Promise<GoogleTextResult> {
  const modelId =
    GOOGLE_TEXT_MODEL_MAP[params.modelName ?? "gemini-3-flash"] ??
    params.modelName ??
    "gemini-3-flash-preview";
  const vertex = makeVertex(creds);
  const result = await generateText({
    model: vertex(modelId),
    ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
    messages: params.messages,
  });
  if (!result.text) throw new Error(`Gemini text returned empty for ${modelId}.`);
  return { text: result.text, model: modelId };
}

// ─── Image Generation (Imagen / Gemini Image) ───────────

export interface GoogleImageParams {
  prompt: string;
  aspectRatio?: string;
  modelName?: string;
  modelParams?: Record<string, unknown>;
  /** Reference / edit-source images to condition the generation on. When
   *  present, generation always goes through the Gemini `:generateContent`
   *  multimodal path (image-in + image-out) regardless of which model is
   *  selected — the Imagen-style `:predict` path doesn't accept image inputs. */
  referenceImages?: AgentPlatformInlineImage[];
}

export interface GoogleImageResult {
  data: Uint8Array;
  mediaType: string;
  model: string;
}

// Imagen 4 family (imagen-4 / -fast / -ultra) removed — the Imagen line is
// scheduled for shutdown on 2026-06-24; Google recommends the Gemini Image
// "nano-banana" models as the replacement.
export const GOOGLE_IMAGE_MODELS = new Set([
  "nano-banana-2",
  "nano-banana-2-lite",
  "nano-banana-pro",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
]);

export function isGoogleImageModel(modelName: string | undefined): boolean {
  if (!modelName) return false;
  return GOOGLE_IMAGE_MODELS.has(modelName) || GOOGLE_IMAGE_MODELS.has(normalizeModelId(modelName) ?? "");
}

const GOOGLE_IMAGE_MODEL_MAP: Record<string, string> = {
  "nano-banana-2": "gemini-3.1-flash-image",
  "gemini-3.1-flash-image": "gemini-3.1-flash-image",
  "nano-banana-2-lite": "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-lite-image": "gemini-3.1-flash-lite-image",
  "nano-banana-pro": "gemini-3-pro-image",
  "gemini-3-pro-image": "gemini-3-pro-image",
};

// Which Vertex model IDs must be called via the Gemini `generateContent`
// endpoint (through `generateText` with responseModalities=[TEXT,IMAGE])
// instead of Vertex's Imagen-style `:predict` (through `generateImage`).
//
// Keyed by the **provider model ID** (the string Vertex actually sees on the
// wire), not our internal card ID — card IDs are a UX convention that can
// rename/split/merge freely, but which endpoint a model exposes is a fact
// about Vertex's registration.
//
// - `gemini-2.5-flash-image` (GA) registers both predict and generateContent,
//   so it keeps the Imagen-style path with richer aspectRatio plumbing.
// - The 3.x Gemini Image models expose `:generateContent`; calling `:predict`
//   returns a misleading "model not found or your project does not have
//   access" 404 because there's no predict handler for them.
const GEMINI_GENERATE_CONTENT_MODELS = new Set([
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
]);

/**
 * Map model card params → Vertex image provider options.
 * Model card stores `aspect_ratio`, `resolution` etc;
 * Vertex SDK expects `sampleImageSize`, `negativePrompt`, etc.
 */
function buildImageProviderOptions(modelParams?: Record<string, unknown>) {
  const opts: Record<string, unknown> = {
    personGeneration: "allow_all",
  };
  if (!modelParams) return opts;

  // resolution: model card "1K"/"2K" → Vertex sampleImageSize
  if (modelParams.resolution) {
    opts.sampleImageSize = modelParams.resolution;
  }
  if (modelParams.negative_prompt || modelParams.negativePrompt) {
    opts.negativePrompt = modelParams.negative_prompt ?? modelParams.negativePrompt;
  }
  return opts;
}

function buildGeminiImageConfig(params: GoogleImageParams): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  const aspectRatio = params.aspectRatio || (
    typeof params.modelParams?.aspect_ratio === "string" ? params.modelParams.aspect_ratio : undefined
  );
  if (aspectRatio) config.aspectRatio = aspectRatio;
  const resolution = typeof params.modelParams?.resolution === "string" ? params.modelParams.resolution : undefined;
  if (resolution) config.imageSize = resolution.toLowerCase();
  return Object.keys(config).length ? config : undefined;
}

export async function generateGoogleImage(
  creds: GoogleServiceAccount,
  params: GoogleImageParams,
): Promise<GoogleImageResult> {
  const requestedModel = params.modelName
    ? normalizeModelId(params.modelName) ?? params.modelName
    : "nano-banana-2";
  const modelId =
    GOOGLE_IMAGE_MODEL_MAP[requestedModel] ??
    requestedModel;
  const vertex = makeVertex(creds);

  // Force the Gemini `:generateContent` (multimodal) path when references
  // are present — the Imagen `:predict` handler ignores image inputs, so
  // "reference image + prompt" used to silently behave like "prompt only"
  // on gemini-2.5-flash-image (GA).
  const useGenerateContent =
    GEMINI_GENERATE_CONTENT_MODELS.has(modelId) ||
    (params.referenceImages?.length ?? 0) > 0;

  if (useGenerateContent) {
    const imageConfig = buildGeminiImageConfig(params);
    // Gemini content-API path: pass references as inline image parts in the
    // user message, then text. Returned images land in `result.files`.
    const refs = params.referenceImages ?? [];
    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: Uint8Array; mediaType: string }
    > = [
      ...refs.map((img) => ({
        type: "image" as const,
        image: base64ToBytes(img.bytesBase64Encoded),
        mediaType: img.mimeType,
      })),
      { type: "text" as const, text: params.prompt },
    ];
    const result = await generateText({
      model: vertex(modelId),
      // Cast to any: ai-sdk's ModelMessage union typing is over-restrictive
      // for the multimodal { type: "image", image: Uint8Array, mediaType }
      // shape that Vertex actually accepts.
      messages: [{ role: "user", content: userContent as any }],
      providerOptions: {
        vertex: {
          responseModalities: ["TEXT", "IMAGE"],
          ...(imageConfig ? { imageConfig } : {}),
        } as Record<string, any>,
      },
    });
    const imageFile = result.files.find((f) => f.mediaType.startsWith("image/"));
    if (!imageFile) {
      throw new Error(
        `Gemini image generation returned no image for ${modelId} (text: ${result.text.slice(0, 120)})`,
      );
    }
    return {
      data: imageFile.uint8Array,
      mediaType: imageFile.mediaType,
      model: modelId,
    };
  }

  // Imagen-style `:predict` path — text-to-image only, but exposes richer
  // aspectRatio / sampleImageSize / negativePrompt plumbing.
  const ar = (params.aspectRatio || "16:9") as `${number}:${number}`;
  const result = await generateImage({
    model: vertex.image(modelId),
    prompt: params.prompt,
    aspectRatio: ar,
    providerOptions: {
      vertex: buildImageProviderOptions(params.modelParams) as Record<string, any>,
    },
  });
  return {
    data: result.image.uint8Array,
    mediaType: result.image.mediaType,
    model: modelId,
  };
}

// ─── Video Generation (Veo) ─────────────────────────────

/** Vertex's native image payload shape: base64 bytes + MIME type. */
export interface AgentPlatformInlineImage {
  bytesBase64Encoded: string;
  mimeType: string;
}

export interface GoogleVideoParams {
  prompt: string;
  aspectRatio?: string;
  modelName?: string;
  modelParams?: Record<string, unknown>;
  /** First-frame image for image-to-video / first-and-last-frame modes. */
  image?: AgentPlatformInlineImage;
  /** Last-frame image for first-and-last-frame interpolation. */
  tailImage?: AgentPlatformInlineImage;
  /** 1–3 subject/asset reference images (Veo "ingredients to video"). */
  referenceImages?: AgentPlatformInlineImage[];
}

export interface GoogleVideoResult {
  data: Uint8Array;
  mediaType: string;
  model: string;
}

export const GOOGLE_VIDEO_MODELS = new Set([
  "veo-3.1",
  "veo-3.1-startend",
  "veo-3.1-lite",
  "veo-3.1-fast",
  "veo-3.1-fast-startend",
]);

export function isGoogleVideoModel(modelName: string | undefined): boolean {
  return !!modelName && GOOGLE_VIDEO_MODELS.has(modelName);
}

// Veo 3.1 went GA on 2025-11-17; the `-preview` suffixes we used during
// preview have been retired. Standard + Fast are now `-generate-001` (GA),
// Lite is still `-lite-generate-001` in Public preview as of 2026-04.
// See docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate
// Multiple cards map to the same underlying Vertex model ID — the variants
// only differ in which input shape the frontend exposes (text+ref images vs
// first-and-last-frame interpolation). Pricing and capacity are the same.
const GOOGLE_VIDEO_MODEL_MAP: Record<string, string> = {
  "veo-3.1": "veo-3.1-generate-001",
  "veo-3.1-startend": "veo-3.1-generate-001",
  "veo-3.1-fast": "veo-3.1-fast-generate-001",
  "veo-3.1-fast-startend": "veo-3.1-fast-generate-001",
  "veo-3.1-lite": "veo-3.1-lite-generate-001",
};

/**
 * Map model card params → Vertex video provider options.
 * Model card stores `generate_audio`, `aspect_ratio`;
 * Vertex SDK expects `generateAudio`, top-level `aspectRatio`.
 */
function buildVideoProviderOptions(modelParams?: Record<string, unknown>) {
  const opts: Record<string, unknown> = {
    personGeneration: "allow_all",
  };
  if (!modelParams) return opts;

  // generate_audio → generateAudio
  if (modelParams.generate_audio !== undefined) {
    opts.generateAudio = modelParams.generate_audio;
  }
  if (modelParams.negative_prompt || modelParams.negativePrompt) {
    opts.negativePrompt = modelParams.negative_prompt ?? modelParams.negativePrompt;
  }
  return opts;
}

export interface SubmitVeoOperationResult {
  operationName: string;
  modelId: string;
}

function agentPlatformBaseHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

function agentPlatformModelUrl(creds: GoogleServiceAccount, modelId: string, action: string): string {
  const project = creds.project ?? "";
  const location = creds.location ?? "global";
  if (!project) throw new Error("Google Cloud Agent Platform provider account is missing project.");
  return `https://${agentPlatformBaseHost(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:${action}`;
}

/**
 * Submit a Veo generation as a Vertex Long-Running Operation.
 *
 * Returns the `operationName` — a stable handle to the in-flight job on
 * Google's side. Cache it in step state and poll on subsequent retries
 * instead of re-submitting (which would re-bill).
 */
export async function submitVeoOperation(
  creds: GoogleServiceAccount,
  input: GoogleVideoParams,
): Promise<SubmitVeoOperationResult> {
  const modelId =
    GOOGLE_VIDEO_MODEL_MAP[input.modelName ?? "veo-3.1"] ??
    input.modelName ??
    "veo-3.1-generate-001";
  const url = agentPlatformModelUrl(creds, modelId, "predictLongRunning");
  const token = await getVertexAccessTokenForCredentials(creds);

  const instance: Record<string, unknown> = { prompt: input.prompt };
  if (input.image) {
    instance.image = { bytesBase64Encoded: input.image.bytesBase64Encoded, mimeType: input.image.mimeType };
  }
  if (input.tailImage) {
    instance.lastFrame = { bytesBase64Encoded: input.tailImage.bytesBase64Encoded, mimeType: input.tailImage.mimeType };
  }
  if (input.referenceImages?.length) {
    instance.referenceImages = input.referenceImages.map((img) => ({
      image: { bytesBase64Encoded: img.bytesBase64Encoded, mimeType: img.mimeType },
      referenceType: "asset",
    }));
  }

  const parameters: Record<string, unknown> = {
    aspectRatio: input.aspectRatio ?? "16:9",
    sampleCount: 1,
    ...buildVideoProviderOptions(input.modelParams),
  };
  delete parameters.image;
  delete parameters.lastFrame;
  delete parameters.referenceImages;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ instances: [instance], parameters }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<unreadable>");
    throw providerHttpError({ status: resp.status, operation: "submit", message: `Veo predictLongRunning failed (${resp.status}): ${text.slice(0, 500)}` });
  }
  const data = (await resp.json()) as { name?: string };
  if (!data.name) {
    throw new Error(`Veo predictLongRunning returned no operation name: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { operationName: data.name, modelId };
}

/** One-shot poll. Returns `{ done, response?, error? }`. */
export async function fetchVeoOperationOnce(
  creds: GoogleServiceAccount,
  modelId: string,
  operationName: string,
): Promise<{ done?: boolean; response?: any; error?: any; name?: string }> {
  const url = agentPlatformModelUrl(creds, modelId, "fetchPredictOperation");
  const token = await getVertexAccessTokenForCredentials(creds);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operationName }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<unreadable>");
    throw providerHttpError({ status: resp.status, operation: "poll", message: `Veo fetchPredictOperation failed (${resp.status}): ${text.slice(0, 500)}` });
  }
  return resp.json() as Promise<{ done?: boolean; response?: any; error?: any; name?: string }>;
}

export interface VeoVideoBytes {
  bytes: Uint8Array;
  mediaType: string;
}
