import { providerHttpError } from "@clash/action-sdk/executable-failure";
export interface BflFlux3VideoInput {
  prompt: string;
  duration?: number | string;
  aspectRatio?: string;
  modelParams?: Record<string, unknown>;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
}

export interface BflFlux3VideoRequestOptions {
  apiKey: string;
  input: BflFlux3VideoInput;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface BflFlux3VideoResult {
  requestId: string;
  url: string;
  pollingUrl: string;
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanParam(params: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const value = params?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberParam(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bflResolution(value: string | undefined): "hd" | "fhd" {
  return value === "1080p" || value === "fhd" ? "fhd" : "hd";
}

export function resolveFlux3KeyframeIndices(
  params: Record<string, unknown> | undefined,
  keyframeCount: number,
  duration: unknown,
): number[] {
  if (keyframeCount <= 0) return [];
  const numericDuration = typeof duration === "number" ? duration : Number.parseInt(String(duration ?? ""), 10);
  if (!Number.isInteger(numericDuration) || numericDuration < 5 || numericDuration > 20) {
    throw new Error("FLUX 3 keyframes require an explicit whole-number duration from 5 to 20 seconds.");
  }
  const lastFrame = numericDuration * 24;
  const raw = params?.keyframe_frame_indices;
  if (raw == null || raw === "") {
    if (keyframeCount === 1) return [0];
    return Array.from({ length: keyframeCount }, (_, index) =>
      Math.round((index * lastFrame) / (keyframeCount - 1)));
  }
  if (typeof raw !== "string") {
    throw new Error("FLUX 3 keyframe_frame_indices must be a JSON array string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FLUX 3 keyframe_frame_indices must contain valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== keyframeCount) {
    throw new Error(`FLUX 3 keyframe_frame_indices must contain exactly ${keyframeCount} entries.`);
  }
  const indices = parsed.map(Number);
  const valid = indices.every((value, index) =>
    Number.isInteger(value)
    && value >= 0
    && value <= lastFrame
    && (index === 0 || value > indices[index - 1]));
  if (!valid) {
    throw new Error(`FLUX 3 keyframe indices must be unique, increasing integers between 0 and ${lastFrame}.`);
  }
  return indices;
}

export function buildBflFlux3VideoRequest(input: BflFlux3VideoInput): Record<string, unknown> {
  const images = input.referenceImageUrls ?? [];
  const videos = input.referenceVideoUrls ?? [];
  if (images.length > 0 && videos.length > 0) {
    throw new Error("FLUX 3 accepts either keyframe images or one continuation video, not both.");
  }
  if (images.length > 10) throw new Error("FLUX 3 accepts at most 10 keyframe images.");
  if (videos.length > 1) throw new Error("FLUX 3 accepts one continuation video.");

  const params = input.modelParams;
  const common = {
    prompt: input.prompt,
    duration: input.duration ?? params?.duration ?? "auto",
    aspect_ratio: input.aspectRatio ?? stringParam(params, "aspect_ratio") ?? "auto",
    resolution: bflResolution(stringParam(params, "resolution")),
    generate_audio: booleanParam(params, "generate_audio", true),
    safety_tolerance: Math.max(0, Math.min(4, numberParam(params, "safety_tolerance", 2))),
  };

  if (videos.length === 1) {
    return { mode: "v2v", ...common, start_video: videos[0] };
  }
  if (images.length > 0) {
    const indices = resolveFlux3KeyframeIndices(params, images.length, common.duration);
    return {
      mode: "i2v",
      ...common,
      keyframes: images.map((imageUrl, index) => ({ image_url: imageUrl, frame_index: indices[index] })),
    };
  }
  return { mode: "t2v", ...common };
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || "https://api.bfl.ai").replace(/\/+$/, "");
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

function firstHttpUrl(value: unknown): string | undefined {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstHttpUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sample", "video", "url", "result", "output", "data"]) {
    const url = firstHttpUrl(record[key]);
    if (url) return url;
  }
  for (const nested of Object.values(record)) {
    const url = firstHttpUrl(nested);
    if (url) return url;
  }
  return undefined;
}

export async function submitBflFlux3Video(options: BflFlux3VideoRequestOptions): Promise<{ requestId: string; pollingUrl: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const headers = { "content-type": "application/json", "x-key": options.apiKey };
  const submittedResponse = await fetchImpl(`${baseUrl}/v1/flux-3-video`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildBflFlux3VideoRequest(options.input)),
  });
  const submitted = await responseJson(submittedResponse);
  if (!submittedResponse.ok) {
    throw providerHttpError({ status: submittedResponse.status, operation: "submit", message: `BFL FLUX 3 request failed: ${submitted?.detail ?? submitted?.error?.message ?? submittedResponse.statusText}` });
  }
  const requestId = submitted?.id;
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("BFL FLUX 3 response returned no task id.");
  }
  const pollingUrl = typeof submitted?.polling_url === "string" && submitted.polling_url
    ? submitted.polling_url
    : `${baseUrl}/v1/get_result?id=${encodeURIComponent(requestId)}`;

  return { requestId, pollingUrl };
}

export async function pollBflFlux3VideoOnce(
  options: Pick<BflFlux3VideoRequestOptions, "apiKey" | "fetch">,
  token: { requestId: string; pollingUrl: string },
): Promise<BflFlux3VideoResult | null> {
  const { requestId, pollingUrl } = token;
  const fetchImpl = options.fetch ?? fetch;
  const polledResponse = await fetchImpl(pollingUrl, { headers: { "x-key": options.apiKey } });
  const polled = await responseJson(polledResponse);
  if (!polledResponse.ok) {
    throw providerHttpError({ status: polledResponse.status, operation: "poll", message: `BFL FLUX 3 poll failed: ${polled?.detail ?? polled?.error?.message ?? polledResponse.statusText}` });
  }
  const status = String(polled?.status ?? "").toLowerCase();
  if (status === "ready") {
    const url = firstHttpUrl(polled?.result ?? polled);
    if (!url) throw new Error("BFL FLUX 3 result returned no video URL.");
    return { requestId, url, pollingUrl };
  }
  if (status === "error" || status.includes("moderated") || status === "task not found") {
    throw new Error(`BFL FLUX 3 request failed: ${polled?.details?.error ?? polled?.details ?? polled?.status}`);
  }
  return null;
}
