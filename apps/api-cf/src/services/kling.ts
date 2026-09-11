import { providerHttpError } from "@clash/action-sdk/executable-failure";
import * as jose from "jose";

const DEFAULT_KLING_URL = "https://api-beijing.klingai.com/v1/videos/image2video";

interface KlingConfig {
  accessKey: string;
  secretKey: string;
  apiUrl?: string;
}

interface KlingGenerateParams {
  image: string;
  prompt?: string;
  duration?: number;
  cfgScale?: number;
  negativePrompt?: string;
  model?: string;
  isBase64?: boolean;
}

interface KlingResult {
  code: number;
  data: {
    task_id: string;
    task_status: string;
    task_result?: {
      videos: Array<{ url: string; duration: number; cover_image_url?: string }>;
    };
  };
}

async function generateJwtToken(config: KlingConfig): Promise<string> {
  const secret = new TextEncoder().encode(config.secretKey);
  const now = Math.floor(Date.now() / 1000);

  return await new jose.SignJWT({
    iss: config.accessKey,
    exp: now + 1800,
    nbf: now - 5,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secret);
}

function stripDataUrl(base64Str: string): string {
  if (base64Str.startsWith("data:")) {
    const idx = base64Str.indexOf(",");
    return idx >= 0 ? base64Str.slice(idx + 1) : base64Str;
  }
  return base64Str;
}

/** Create a video generation task and return the task_id. */
export async function createVideoTask(
  config: KlingConfig,
  params: KlingGenerateParams
): Promise<string> {
  const token = await generateJwtToken(config);

  const image = params.isBase64 ? stripDataUrl(params.image) : params.image;

  const payload: Record<string, unknown> = {
    model_name: params.model ?? "kling-v1",
    image,
    duration: String(params.duration ?? 5),
  };
  if (params.prompt) payload.prompt = params.prompt;
  if (params.negativePrompt) payload.negative_prompt = params.negativePrompt;
  if (params.cfgScale !== undefined && params.cfgScale !== 0.5) {
    payload.cfg_scale = params.cfgScale;
  }

  const baseUrl = config.apiUrl || DEFAULT_KLING_URL;
  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw providerHttpError({ status: resp.status, operation: "submit", message: `Kling API error ${resp.status}: ${text}` });
  }

  const result = (await resp.json()) as KlingResult;
  if (result.code !== 0) {
    throw new Error(`Kling API returned error: ${JSON.stringify(result)}`);
  }

  const taskId = result.data?.task_id;
  if (!taskId) {
    throw new Error(`No task_id returned: ${JSON.stringify(result)}`);
  }

  return taskId;
}

/** A single status request; hosted waiting belongs to the durable scheduler. */
export async function pollVideoTaskOnce(config: KlingConfig, taskId: string): Promise<{ url: string; duration: number; coverImageUrl?: string } | null> {
  const token = await generateJwtToken(config);
  const baseUrl = config.apiUrl || DEFAULT_KLING_URL;
  const queryUrl = `${baseUrl}/${taskId}`;
  const resp = await fetch(queryUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw providerHttpError({ status: resp.status, operation: "poll", message: `Kling poll error: ${resp.status}` });

  const result = (await resp.json()) as KlingResult;
  if (result.code !== 0) throw new Error(`Kling query failed: ${JSON.stringify(result)}`);

  const status = result.data?.task_status;
  if (status === "succeed") {
    const videos = result.data.task_result?.videos;
    if (!videos?.length) throw new Error("No videos in completed result");
    return { url: videos[0].url, duration: videos[0].duration, coverImageUrl: videos[0].cover_image_url };
  }
  if (status === "failed") {
    throw new Error(`Video generation failed: ${JSON.stringify(result.data)}`);
  }

  return null;
}
