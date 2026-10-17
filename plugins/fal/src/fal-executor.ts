import {
  ProviderExecutionError,
  providerHttpError,
} from "@clash/action-sdk/executable-failure";

export const HUNYUAN3D_TEXT_TO_3D_ENDPOINT = "fal-ai/hunyuan3d-v3/text-to-3d";

export type FalDirectorModelQuality = "normal" | "low-poly" | "geometry";
export type FalMediaKind = "image" | "video" | "audio" | "model";

export interface FalDirectorModelInput {
  prompt: string;
  quality: FalDirectorModelQuality;
  pbr: boolean;
  faceCount?: number;
}

export interface FalPollState {
  requestId: string;
  phase?: "status" | "result";
  /** Exact queue endpoint selected during submit; required for dynamic edit/i2v routes. */
  endpoint?: string;
}

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

function normalizedFaceCount(value: number | undefined): number {
  if (value === undefined) return 500_000;
  if (!Number.isFinite(value)) {
    throw invalidRequest("3D model face count must be finite");
  }
  return Math.max(40_000, Math.min(1_500_000, Math.round(value)));
}

export function invalidRequest(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_request",
    message,
    retryable: false,
    requestState: "rejected",
  });
}

function invalidResponse(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_response",
    message,
    retryable: false,
    requestState: "accepted",
  });
}

export function buildFalDirectorModelInput(
  input: FalDirectorModelInput,
): Record<string, unknown> {
  const prompt = input.prompt.trim();
  if (!prompt) throw invalidRequest("3D model prompt is required");
  if (new TextEncoder().encode(prompt).byteLength > 1024) {
    throw invalidRequest("3D model prompt must be at most 1024 UTF-8 bytes");
  }
  const generateType =
    input.quality === "low-poly"
      ? "LowPoly"
      : input.quality === "geometry"
        ? "Geometry"
        : "Normal";
  return {
    prompt,
    enable_pbr: input.quality === "geometry" ? false : input.pbr,
    face_count: normalizedFaceCount(input.faceCount),
    generate_type: generateType,
    polygon_type: input.quality === "low-poly" ? "quadrilateral" : "triangle",
  };
}

async function readJson(response: {
  text(): Promise<string>;
}): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return { detail: raw };
  }
}

function nested(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageFrom(body: Record<string, unknown>, fallback: string): string {
  const error = nested(body.error);
  if (typeof error?.message === "string" && error.message) {
    return error.message;
  }
  if (typeof body.detail === "string" && body.detail) return body.detail;
  if (typeof body.error === "string" && body.error) return body.error;
  return fallback;
}

function queueUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}

function apiKeyHeader(apiKey: string, requestState: "rejected" | "accepted") {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new ProviderExecutionError({
      code: "authentication_failed",
      message: "This fal.ai account has no apiKey stored.",
      retryable: false,
      requestState,
    });
  }
  return { authorization: `Key ${normalized}` };
}

export async function falSubmit(options: {
  apiKey: string;
  endpoint: string;
  input: Record<string, unknown> | FalDirectorModelInput;
  fetch: FetchLike;
  queueBaseUrl?: string;
}): Promise<{ status: "accepted"; pollState: FalPollState }> {
  const headers = apiKeyHeader(options.apiKey, "rejected");
  const input =
    options.endpoint === HUNYUAN3D_TEXT_TO_3D_ENDPOINT
      ? buildFalDirectorModelInput(options.input as FalDirectorModelInput)
      : options.input;
  const response = await options.fetch(
    queueUrl(options.queueBaseUrl ?? "https://queue.fal.run", options.endpoint),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw providerHttpError({
      status: response.status,
      message: `fal request failed: ${messageFrom(body, response.statusText)}`,
      operation: "submit",
    });
  }
  const requestId = body.request_id ?? body.requestId;
  if (typeof requestId !== "string" || !requestId) {
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: "fal response returned no request_id",
      retryable: false,
      requestState: "unknown",
    });
  }
  return {
    status: "accepted",
    pollState: {
      requestId,
      ...(options.endpoint === HUNYUAN3D_TEXT_TO_3D_ENDPOINT
        ? {}
        : { endpoint: options.endpoint }),
    },
  };
}

function resultFile(
  body: Record<string, unknown>,
  kind: FalMediaKind,
): Record<string, unknown> | undefined {
  const result = nested(body.data) ?? body;
  if (kind === "image") {
    return Array.isArray(result.images) ? nested(result.images[0]) : undefined;
  }
  if (kind === "video") return nested(result.video);
  if (kind === "audio") {
    return (
      nested(result.audio) ??
      nested(result.audio_file) ??
      (Array.isArray(result.audios) ? nested(result.audios[0]) : undefined)
    );
  }
  return nested(result.model_glb) ?? nested(nested(result.model_urls)?.glb);
}

function defaultContentType(kind: FalMediaKind): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  if (kind === "audio") return "audio/mpeg";
  return "model/gltf-binary";
}

export async function falPoll(options: {
  apiKey: string;
  endpoint: string;
  kind?: FalMediaKind;
  state: FalPollState;
  fetch: FetchLike;
  queueBaseUrl?: string;
}): Promise<
  | { status: "accepted"; pollState: FalPollState; retryAfterMs?: number }
  | {
      status: "completed";
      media: { url: string; contentType: string };
      thumbnailUrl?: string;
    }
> {
  const headers = apiKeyHeader(options.apiKey, "accepted");
  const requestUrl = `${queueUrl(options.queueBaseUrl ?? "https://queue.fal.run", options.endpoint)}/requests/${encodeURIComponent(options.state.requestId)}`;
  if (options.state.phase === "result") {
    const resultResponse = await options.fetch(requestUrl, { headers });
    const resultBody = await readJson(resultResponse);
    if (!resultResponse.ok) {
      throw providerHttpError({
        status: resultResponse.status,
        message: `fal result failed: ${messageFrom(resultBody, resultResponse.statusText)}`,
        operation: "poll",
      });
    }
    const kind = options.kind ?? "model";
    const file = resultFile(resultBody, kind);
    if (typeof file?.url !== "string" || !file.url) {
      throw invalidResponse(`fal ${kind} result returned no media URL`);
    }
    const result = nested(resultBody.data) ?? resultBody;
    const thumbnail = nested(result.thumbnail);
    return {
      status: "completed",
      media: {
        url: file.url,
        contentType:
          typeof file.content_type === "string" && file.content_type
            ? file.content_type
            : defaultContentType(kind),
      },
      ...(typeof thumbnail?.url === "string" && thumbnail.url
        ? { thumbnailUrl: thumbnail.url }
        : {}),
    };
  }

  const statusResponse = await options.fetch(`${requestUrl}/status`, {
    headers,
  });
  const statusBody = await readJson(statusResponse);
  if (!statusResponse.ok) {
    throw providerHttpError({
      status: statusResponse.status,
      message: `fal status failed: ${messageFrom(statusBody, statusResponse.statusText)}`,
      operation: "poll",
    });
  }
  const status = statusBody.status;
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
    return {
      status: "accepted",
      pollState: options.state,
      retryAfterMs: 1_000,
    };
  }
  if (status === "FAILED" || status === "ERROR" || status === "CANCELLED") {
    throw new ProviderExecutionError({
      code: "provider_failed",
      message: `fal request failed: ${messageFrom(statusBody, String(status))}`,
      retryable: false,
      requestState: "accepted",
      providerCode: String(status),
    });
  }
  if (status !== "COMPLETED") {
    throw invalidResponse(
      `fal returned an unrecognized task status: ${JSON.stringify(status)}`,
    );
  }
  return {
    status: "accepted",
    pollState: {
      requestId: options.state.requestId,
      phase: "result",
      ...(options.state.endpoint ? { endpoint: options.state.endpoint } : {}),
    },
    retryAfterMs: 0,
  };
}

function fileExtension(contentType: string): string {
  return contentType.split("/")[1]?.split(/[;+]/)[0] || "bin";
}

export async function uploadFalBytes(options: {
  apiKey: string;
  bytes: Uint8Array;
  contentType: string;
  fileName?: string;
  fetch: FetchLike;
  storageBaseUrl?: string;
}): Promise<string> {
  const headers = apiKeyHeader(options.apiKey, "rejected");
  const baseUrl = (
    options.storageBaseUrl ?? "https://rest.alpha.fal.ai"
  ).replace(/\/+$/, "");
  const multipart = options.bytes.byteLength > 90 * 1024 * 1024;
  const initiate = await options.fetch(
    `${baseUrl}/storage/upload/${multipart ? "initiate-multipart" : "initiate"}?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        content_type: options.contentType,
        file_name:
          options.fileName ??
          `clash-reference.${fileExtension(options.contentType)}`,
      }),
    },
  );
  const initiated = await readJson(initiate);
  if (!initiate.ok) {
    throw providerHttpError({
      status: initiate.status,
      message: `fal upload initiation failed: ${messageFrom(initiated, initiate.statusText)}`,
      operation: "submit",
    });
  }
  const uploadUrl = initiated.upload_url;
  const fileUrl = initiated.file_url;
  if (typeof uploadUrl !== "string" || typeof fileUrl !== "string") {
    throw new ProviderExecutionError({
      code: "invalid_response",
      message: "fal upload initiation returned no upload_url or file_url",
      retryable: false,
      requestState: "rejected",
    });
  }

  if (!multipart) {
    const uploaded = await options.fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": options.contentType },
      body: options.bytes as BodyInit,
    });
    if (!uploaded.ok) {
      const body = await readJson(uploaded);
      throw providerHttpError({
        status: uploaded.status,
        message: `fal upload failed: ${messageFrom(body, uploaded.statusText)}`,
        operation: "submit",
      });
    }
    return fileUrl;
  }

  const parsedUrl = new URL(uploadUrl);
  const chunkSize = 10 * 1024 * 1024;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (
    let start = 0, partNumber = 1;
    start < options.bytes.byteLength;
    start += chunkSize, partNumber += 1
  ) {
    const partUrl = `${parsedUrl.origin}${parsedUrl.pathname}/${partNumber}${parsedUrl.search}`;
    const partResponse = await options.fetch(partUrl, {
      method: "PUT",
      body: options.bytes.slice(start, start + chunkSize) as BodyInit,
    });
    const part = await readJson(partResponse);
    if (!partResponse.ok || typeof part.etag !== "string") {
      throw providerHttpError({
        status: partResponse.status,
        message: `fal multipart upload failed: ${messageFrom(part, partResponse.statusText)}`,
        operation: "submit",
      });
    }
    parts.push({ partNumber, etag: part.etag });
  }
  const completed = await options.fetch(
    `${parsedUrl.origin}${parsedUrl.pathname}/complete${parsedUrl.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    },
  );
  if (!completed.ok) {
    const body = await readJson(completed);
    throw providerHttpError({
      status: completed.status,
      message: `fal multipart completion failed: ${messageFrom(body, completed.statusText)}`,
      operation: "submit",
    });
  }
  return fileUrl;
}
