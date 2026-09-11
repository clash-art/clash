/**
 * Move AI HTTP layer.
 *
 * Pure translation between this plugin's request/response shapes and the exact GraphQL contract
 * documented at https://api.move.ai/ugc/graphql: `createFile` -> presigned PUT upload ->
 * `createSingleCamTake` -> `createSingleCamJob`, polled through `getJob`. No fetch call happens
 * anywhere outside this file; the adapter only ever calls the functions below.
 */

import { ProviderExecutionError, providerHttpError } from "@clash/action-sdk";

/** Documented, exact GraphQL endpoint. Never derived or environment-configurable. */
export const MOVE_AI_API_URL = "https://api.move.ai/ugc/graphql";

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array<ArrayBuffer>;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export type MoveAiPollState = {
  jobId: string;
};

type MoveAiSourceFormat = "MP4" | "MOV" | "AVI";
type MoveAiCreateFileType = "mp4" | "mov" | "avi";

const MEDIA_TYPE_MAP: Record<
  string,
  { format: MoveAiSourceFormat; createFileType: MoveAiCreateFileType }
> = {
  "video/mp4": { format: "MP4", createFileType: "mp4" },
  "video/quicktime": { format: "MOV", createFileType: "mov" },
  "video/x-msvideo": { format: "AVI", createFileType: "avi" },
};

const CREATE_FILE_MUTATION = `
mutation CreateFile($type: String!) {
  createFile(type: $type) {
    id
    presignedUrl
  }
}`;

const CREATE_SINGLE_CAM_TAKE_MUTATION = `
mutation CreateSingleCamTake($sources: [SourceInput!]!) {
  createSingleCamTake(sources: $sources) {
    id
  }
}`;

const CREATE_SINGLE_CAM_JOB_MUTATION = `
mutation CreateSingleCamJob($takeId: String!, $options: OptionsInput, $outputs: [OutputType]) {
  createSingleCamJob(takeId: $takeId, options: $options, outputs: $outputs) {
    id
    progress {
      state
      percentageComplete
    }
  }
}`;

const GET_JOB_QUERY = `
query GetJob($jobId: String!) {
  getJob(jobId: $jobId) {
    progress {
      state
      percentageComplete
    }
    outputs {
      key
      file {
        id
        presignedUrl
      }
    }
  }
}`;

function invalidRequest(message: string): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_request",
    message,
    retryable: false,
    requestState: "rejected",
  });
}

function invalidResponse(
  message: string,
  requestState: "rejected" | "accepted",
): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "invalid_response",
    message,
    retryable: false,
    requestState,
  });
}

function authenticationFailed(
  requestState: "rejected" | "accepted",
): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "authentication_failed",
    message: "This Move AI account has no apiKey stored.",
    retryable: false,
    requestState,
  });
}

function requireApiKey(
  apiKey: string,
  requestState: "rejected" | "accepted",
): string {
  const value = apiKey.trim();
  if (!value) throw authenticationFailed(requestState);
  return value;
}

/**
 * Resolves the source media type after stripping content-type parameters (`; codecs=...`), or
 * rejects an unknown/missing type before any request is sent.
 */
function resolveMediaType(
  mediaType: string,
): { format: MoveAiSourceFormat; createFileType: MoveAiCreateFileType } {
  const stripped = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  const mapped = stripped ? MEDIA_TYPE_MAP[stripped] : undefined;
  if (!mapped) {
    throw invalidRequest(
      `Move AI does not support media type ${JSON.stringify(mediaType)}. Use video/mp4, video/quicktime, or video/x-msvideo.`,
    );
  }
  return mapped;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface GraphQlErrorEntry {
  message?: unknown;
}

/**
 * Sends one GraphQL POST and returns its `data` payload, translating every non-`data` outcome
 * (non-2xx HTTP, top-level `errors`, or a malformed envelope) into a `ProviderExecutionError`
 * with the request-state boundary appropriate to the calling operation.
 */
async function moveAiGraphQlRequest<T>(options: {
  apiKey: string;
  query: string;
  variables: Record<string, unknown>;
  operation: "submit" | "poll";
  fetch: FetchLike;
}): Promise<T> {
  const requestState = options.operation === "submit" ? "rejected" : "accepted";
  const response = await options.fetch(MOVE_AI_API_URL, {
    method: "POST",
    headers: {
      Authorization: options.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: options.query, variables: options.variables }),
  });
  if (!response.ok) {
    throw providerHttpError({
      status: response.status,
      message: `Move AI request failed: ${response.statusText}`,
      operation: options.operation,
    });
  }
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidResponse("Move AI returned a malformed response.", requestState);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidResponse("Move AI returned a malformed response.", requestState);
  }
  const body = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0] as GraphQlErrorEntry | undefined;
    const message =
      first && typeof first.message === "string" && first.message
        ? first.message
        : "Move AI GraphQL request failed.";
    throw new ProviderExecutionError({
      code: "provider_failed",
      message,
      retryable: false,
      requestState,
    });
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    throw invalidResponse("Move AI response is missing a data payload.", requestState);
  }
  return body.data as T;
}

export interface MoveAiSubmitOptions {
  apiKey: string;
  bytes: Uint8Array;
  mediaType: string;
  trackFingers?: boolean;
  floorPlane?: boolean;
  trackBall?: boolean;
  fetch: FetchLike;
}

/**
 * Submits one take end-to-end (createFile -> PUT upload -> createSingleCamTake ->
 * createSingleCamJob) and returns only the durable, secret-free poll state the Host will hand
 * back unread.
 */
export async function moveAiSubmitTake(
  options: MoveAiSubmitOptions,
): Promise<{ status: "accepted"; pollState: MoveAiPollState }> {
  const apiKey = requireApiKey(options.apiKey, "rejected");
  const media = resolveMediaType(options.mediaType);

  const createFileData = await moveAiGraphQlRequest<{
    createFile?: { id?: unknown; presignedUrl?: unknown };
  }>({
    apiKey,
    query: CREATE_FILE_MUTATION,
    variables: { type: media.createFileType },
    operation: "submit",
    fetch: options.fetch,
  });
  const fileId = createFileData.createFile?.id;
  const presignedUploadUrl = createFileData.createFile?.presignedUrl;
  if (typeof fileId !== "string" || !fileId) {
    throw invalidResponse("Move AI createFile response is missing id.", "rejected");
  }
  if (typeof presignedUploadUrl !== "string" || !presignedUploadUrl) {
    throw invalidResponse(
      "Move AI createFile response is missing presignedUrl.",
      "rejected",
    );
  }

  const putResponse = await options.fetch(presignedUploadUrl, {
    method: "PUT",
    body: Uint8Array.from(options.bytes),
  });
  if (!putResponse.ok) {
    throw providerHttpError({
      status: putResponse.status,
      message: `Move AI upload failed: ${putResponse.statusText}`,
      operation: "submit",
    });
  }

  const takeData = await moveAiGraphQlRequest<{
    createSingleCamTake?: { id?: unknown };
  }>({
    apiKey,
    query: CREATE_SINGLE_CAM_TAKE_MUTATION,
    variables: {
      sources: [{ deviceLabel: "cam01", fileId, format: media.format }],
    },
    operation: "submit",
    fetch: options.fetch,
  });
  const takeId = takeData.createSingleCamTake?.id;
  if (typeof takeId !== "string" || !takeId) {
    throw invalidResponse(
      "Move AI createSingleCamTake response is missing id.",
      "rejected",
    );
  }

  const jobOptions: Record<string, unknown> = { mocapModel: "S2" };
  if (options.trackFingers !== undefined) jobOptions.trackFingers = options.trackFingers;
  if (options.floorPlane !== undefined) jobOptions.floorPlane = options.floorPlane;
  if (options.trackBall !== undefined) jobOptions.trackBall = options.trackBall;

  const jobData = await moveAiGraphQlRequest<{
    createSingleCamJob?: { id?: unknown };
  }>({
    apiKey,
    query: CREATE_SINGLE_CAM_JOB_MUTATION,
    variables: { takeId, options: jobOptions, outputs: ["MAIN_GLB"] },
    operation: "submit",
    fetch: options.fetch,
  });
  const jobId = jobData.createSingleCamJob?.id;
  if (typeof jobId !== "string" || !jobId) {
    throw invalidResponse(
      "Move AI createSingleCamJob response is missing id.",
      "rejected",
    );
  }

  return { status: "accepted", pollState: { jobId } };
}

export type MoveAiJobOutcome =
  | { status: "accepted"; pollState: MoveAiPollState; retryAfterMs: number }
  | { status: "completed"; media: { url: string; mediaType: string } };

/** `getJob` is the one poll query shared by every job this plugin submits. */
export async function moveAiPollJob(options: {
  apiKey: string;
  state: MoveAiPollState;
  fetch: FetchLike;
}): Promise<MoveAiJobOutcome> {
  const apiKey = requireApiKey(options.apiKey, "accepted");
  const data = await moveAiGraphQlRequest<{
    getJob?: {
      progress?: { state?: unknown; percentageComplete?: unknown };
      outputs?: unknown;
    };
  }>({
    apiKey,
    query: GET_JOB_QUERY,
    variables: { jobId: options.state.jobId },
    operation: "poll",
    fetch: options.fetch,
  });

  const state = data.getJob?.progress?.state;
  if (state === "NOT_STARTED" || state === "RUNNING") {
    return { status: "accepted", pollState: options.state, retryAfterMs: 2_000 };
  }
  if (state === "FAILED") {
    throw new ProviderExecutionError({
      code: "provider_failed",
      message: "Move AI job failed.",
      retryable: false,
      requestState: "accepted",
    });
  }
  if (state === "FINISHED") {
    const outputs = Array.isArray(data.getJob?.outputs) ? data.getJob!.outputs : [];
    const mainGlb = (outputs as unknown[])
      .map(record)
      .find((output) => output.key === "MAIN_GLB");
    const url = mainGlb ? record(mainGlb.file).presignedUrl : undefined;
    if (typeof url !== "string" || !url) {
      throw invalidResponse(
        "Move AI job finished without a MAIN_GLB output presignedUrl.",
        "accepted",
      );
    }
    return {
      status: "completed",
      media: { url, mediaType: "model/gltf-binary" },
    };
  }
  throw invalidResponse(
    `Move AI returned an unrecognized job state: ${JSON.stringify(state)}`,
    "accepted",
  );
}
