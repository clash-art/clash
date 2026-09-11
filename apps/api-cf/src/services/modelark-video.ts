import { providerHttpError } from "@clash/action-sdk/executable-failure";
export interface ModelArkVideoParams {
  baseUrl?: string;
  prompt: string;
  modelName?: string;
  upstreamModel?: string;
  startFrameUrl?: string;
  endFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  duration?: number | string;
  aspectRatio?: string;
  modelParams?: Record<string, unknown>;
}

export interface ModelArkVideoResult {
  url: string;
  coverImageUrl?: string;
  duration?: number;
  taskId: string;
  model: string;
}

const DEFAULT_MODELARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const MODELARK_MODEL_MAP: Record<string, string> = {
  "seedance-2-text": "doubao-seedance-2-0-260128",
  "seedance-2-startend": "doubao-seedance-2-0-260128",
  "seedance-2-ref": "doubao-seedance-2-0-260128",
  "seedance-2-extend": "doubao-seedance-2-0-260128",
  "seedance-2.5-text": "doubao-seedance-2-5-260628",
  "seedance-2.5-startend": "doubao-seedance-2-5-260628",
  "seedance-2.5-ref": "doubao-seedance-2-5-260628",
  "seedance-2.5-extend": "doubao-seedance-2-5-260628",
};

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || DEFAULT_MODELARK_BASE_URL).replace(/\/$/, "");
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolParam(params: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = params?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function numericDuration(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === "auto") return -1;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mediaContent(
  type: "image_url" | "video_url" | "audio_url",
  role: "reference_image" | "reference_video" | "reference_audio" | "first_frame" | "last_frame",
  urls: string[] | undefined,
): Array<Record<string, unknown>> {
  return (urls ?? [])
    .filter((url) => url.trim())
    .map((url) => ({
      type,
      [type]: { url },
      role,
    }));
}

function extractVideoUrl(json: any): string | undefined {
  return (
    json?.output?.video_url ??
    json?.output?.url ??
    json?.output?.videos?.[0]?.url ??
    json?.content?.video_url ??
    json?.result?.video_url
  );
}

async function parseJsonResponse(resp: Response, label: string): Promise<any> {
  const raw = await resp.text();
  let json: any;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { error: { message: raw } };
  }
  if (!resp.ok) {
    const message = json?.error?.message ?? json?.message ?? `${resp.status} ${resp.statusText}`;
    throw providerHttpError({ status: resp.status, operation: label.includes("retrieve") ? "poll" : "submit", message: `${label} failed: ${message}` });
  }
  return json;
}

function buildContent(params: ModelArkVideoParams): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (params.prompt.trim()) content.push({ type: "text", text: params.prompt.trim() });
  content.push(...mediaContent("image_url", "first_frame", params.startFrameUrl ? [params.startFrameUrl] : []));
  content.push(...mediaContent("image_url", "last_frame", params.endFrameUrl ? [params.endFrameUrl] : []));
  content.push(...mediaContent("image_url", "reference_image", params.referenceImageUrls));
  content.push(...mediaContent("video_url", "reference_video", params.referenceVideoUrls));
  content.push(...mediaContent("audio_url", "reference_audio", params.referenceAudioUrls));
  return content;
}

export async function submitModelArkVideo(
  apiKey: string | undefined,
  params: ModelArkVideoParams,
): Promise<{ taskId: string; model: string }> {
  const key = apiKey?.trim();
  if (!key) throw new Error("ModelArk API key is required for Seedance generation.");
  const modelName = params.modelName ?? "seedance-2-ref";
  const model = params.upstreamModel ?? MODELARK_MODEL_MAP[modelName] ?? modelName;
  const referenceVideos = (params.referenceVideoUrls ?? []).filter((url) => url.trim());
  const editMode = boolParam(params.modelParams, "edit_mode") === true;
  const extensionMode = modelName.endsWith("-extend");
  const startEndMode = modelName.endsWith("-startend") || !!params.startFrameUrl || !!params.endFrameUrl;
  const seedance25 = modelName.startsWith("seedance-2.5") || model.includes("seedance-2-5");
  if (editMode && referenceVideos.length === 0) {
    throw new Error("Seedance edit mode requires at least one reference video.");
  }
  if (extensionMode && referenceVideos.length === 0) {
    throw new Error("Seedance video extension requires at least one reference video.");
  }
  const endpoint = `${normalizeBaseUrl(params.baseUrl)}/contents/generations/tasks`;
  const content = buildContent(params);
  if (!content.length) throw new Error("Prompt or reference media is required for ModelArk video generation.");

  const body: Record<string, unknown> = {
    model,
    content,
  };
  const duration = editMode ? -1 : numericDuration(params.duration);
  if (duration !== undefined) body.duration = duration;
  if (editMode || extensionMode || startEndMode) {
    body.ratio = "adaptive";
  } else if (params.aspectRatio) {
    body.ratio = params.aspectRatio === "auto" ? "adaptive" : params.aspectRatio;
  }
  if (seedance25 && editMode) body.omni_reference_task_type = "edit";
  if (seedance25 && extensionMode) body.omni_reference_task_type = "extend";
  const resolution = stringParam(params.modelParams, "resolution");
  if (resolution) body.resolution = resolution;
  const generateAudio = boolParam(params.modelParams, "generate_audio");
  if (generateAudio !== undefined) body.generate_audio = generateAudio;
  const outputFormat = stringParam(params.modelParams, "output_format");
  if (outputFormat === "mp4" || outputFormat === "mov") body.output_format = outputFormat;

  const createResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const created = await parseJsonResponse(createResp, "ModelArk create video task");
  const taskId = created?.id ?? created?.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error("ModelArk create task response returned no id.");

  return { taskId, model };
}

export async function pollModelArkVideoOnce(
  apiKey: string,
  params: Pick<ModelArkVideoParams, "baseUrl">,
  token: { taskId: string; model: string },
): Promise<ModelArkVideoResult | null> {
  const { taskId, model } = token;
  const key = apiKey.trim();
  const endpoint = `${normalizeBaseUrl(params.baseUrl)}/contents/generations/tasks`;
  const pollResp = await fetch(`${endpoint}/${encodeURIComponent(taskId)}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  const polled = await parseJsonResponse(pollResp, "ModelArk retrieve video task");
  const status = polled?.status ?? polled?.task_status;
  if (status === "succeeded" || status === "success") {
    const url = extractVideoUrl(polled);
    if (!url) throw new Error("ModelArk completed task returned no video URL.");
    return {
      url,
      coverImageUrl: polled?.output?.cover_url ?? polled?.output?.cover_image_url,
      duration: typeof polled?.output?.duration === "number" ? polled.output.duration : undefined,
      taskId,
      model,
    };
  }
  if (status === "failed" || status === "cancelled" || status === "canceled") {
    throw new Error(`ModelArk video generation failed: ${JSON.stringify(polled?.error ?? polled)}`);
  }
  return null;
}
