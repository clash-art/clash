import { providerHttpError, ProviderExecutionError } from "@clash/action-sdk/executable-failure";
export const PIKA_MEDIA_BASE_URL = "https://api.dev.pika.art";

export type PikaMediaStatus = "queued" | "running" | "completed" | "failed";

export interface PikaMediaJob {
  id: string;
  status: PikaMediaStatus;
  output?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

type PikaFetch = typeof globalThis.fetch;

interface PikaRequestOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: PikaFetch;
}

function baseUrl(value?: string): string {
  return (value?.trim() || PIKA_MEDIA_BASE_URL).replace(/\/+$/, "");
}

function requireApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) throw new Error("Pika API key is required");
  return apiKey;
}

function operationPath(value: string): string {
  const operation = value.replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(operation)) {
    throw new Error(`Invalid Pika media operation: ${value}`);
  }
  return operation;
}

async function json(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await response.text();
    return text ? { message: text } : {};
  }
  return response.json();
}

function errorMessage(body: any, fallback: string): string {
  return body?.error?.message ?? body?.message ?? fallback;
}

function parseJob(value: any): PikaMediaJob {
  if (!value || typeof value.id !== "string" || !value.id) {
    throw new Error("Pika response returned no media job id");
  }
  if (!["queued", "running", "completed", "failed"].includes(value.status)) {
    throw new Error(`Pika response returned an invalid media job status: ${String(value.status)}`);
  }
  return value as PikaMediaJob;
}

export async function createPikaMediaJob(options: PikaRequestOptions & {
  operation: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<PikaMediaJob> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(
    `${baseUrl(options.baseUrl)}/v1/media/${operationPath(options.operation)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        "x-api-key": requireApiKey(options.apiKey),
      },
      body: JSON.stringify(options.input),
    },
  );
  const body = await json(response);
  if (!response.ok) {
    throw providerHttpError({ status: response.status, operation: "submit", message: `Pika media request failed: ${errorMessage(body, response.statusText)}` });
  }
  const job = parseJob(body);
  if (job.status === "failed") throw pikaJobError(job);
  return job;
}

function pikaJobError(job: PikaMediaJob): Error {
  const code = job.error?.code ? ` (${job.error.code})` : "";
  return new ProviderExecutionError({ code: "execution_failed", message: `Pika media job failed${code}: ${job.error?.message ?? "unknown error"}`, retryable: false, requestState: "accepted", providerCode: `PIKA_JOB_FAILED:${job.error?.code ?? "unknown"}` });
}

export async function getPikaMediaJob(
  options: PikaRequestOptions & {
    jobId: string;
  },
): Promise<PikaMediaJob> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(
    `${baseUrl(options.baseUrl)}/v1/media/jobs/${encodeURIComponent(options.jobId)}`,
    { headers: { "x-api-key": requireApiKey(options.apiKey) } },
  );
  const body = await json(response);
  if (!response.ok) {
    throw providerHttpError({ status: response.status, operation: "poll", message: `Pika media status failed: ${errorMessage(body, response.statusText)}` });
  }
  const job = parseJob(body);
  if (job.status === "failed") throw pikaJobError(job);
  return job;
}

export async function getPikaMediaContent(
  options: PikaRequestOptions & {
    jobId: string;
  },
): Promise<{ url: string }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(
    `${baseUrl(options.baseUrl)}/v1/media/jobs/${encodeURIComponent(options.jobId)}/content`,
    { headers: { "x-api-key": requireApiKey(options.apiKey) } },
  );
  const body = await json(response);
  if (!response.ok) {
    throw providerHttpError({ status: response.status, operation: "poll", message: `Pika media content failed: ${errorMessage(body, response.statusText)}` });
  }
  if (typeof body?.url !== "string" || !body.url) {
    throw new Error(`Pika media job returned no content URL: ${options.jobId}`);
  }
  return { url: body.url };
}

export async function uploadPikaMedia(options: PikaRequestOptions & {
  bytes: Uint8Array;
  contentType: string;
}): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${baseUrl(options.baseUrl)}/v1/media/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": requireApiKey(options.apiKey),
    },
    body: JSON.stringify({ content_type: options.contentType, size_bytes: options.bytes.byteLength }),
  });
  const body = await json(response);
  if (!response.ok) {
    throw new Error(`Pika media upload request failed: ${errorMessage(body, response.statusText)}`);
  }
  if (typeof body?.upload_url !== "string" || typeof body?.url !== "string") {
    throw new Error("Pika media upload response is missing upload_url or url");
  }
  const headers = body.headers && typeof body.headers === "object"
    ? body.headers as Record<string, string>
    : {};
  const uploaded = await fetchImpl(body.upload_url, {
    method: "PUT",
    headers,
    body: options.bytes as RequestInit["body"],
  });
  if (!uploaded.ok) {
    throw new Error(`Pika media upload failed: ${uploaded.status} ${uploaded.statusText}`.trim());
  }
  return body.url;
}
