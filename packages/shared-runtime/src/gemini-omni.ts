import { providerHttpError } from "@clash/action-sdk/executable-failure";
export type GeminiOmniInputPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface GeminiOmniInteraction {
  id?: string;
  name?: string;
  status?: string;
  error?: { message?: string; [key: string]: unknown };
  steps?: unknown[];
  [key: string]: unknown;
}

export interface GeminiOmniVideoOutput {
  mimeType: string;
  data?: string;
  uri?: string;
}

export interface CreateGeminiOmniInteractionInput {
  /** The Developer API credential. Agent Platform refuses it; see `accessToken`. */
  apiKey?: string;
  /**
   * An OAuth2 access token. Not an api key -- this API answers one with 401 "API keys are not
   * supported by this API", measured with a key that generateContent accepts.
   */
  accessToken?: string;
  /** The Cloud project the interaction is billed to; it is part of the path, not a header. */
  project?: string;
  baseUrl?: string;
  model: string;
  input: ReadonlyArray<GeminiOmniInputPart>;
  aspectRatio: "16:9" | "9:16";
  /** Return immediately with `in_progress` and poll, instead of waiting for the video inline. */
  background?: boolean;
  /** A `gs://bucket/path` to write the video to, instead of receiving it as base64. */
  gcsUri?: string;
  duration: number;
  fetch?: typeof fetch;
}

export interface GetGeminiOmniInteractionInput {
  apiKey?: string;
  accessToken?: string;
  project?: string;
  baseUrl?: string;
  interactionId: string;
  fetch?: typeof fetch;
}

/**
 * Two surfaces serve Interactions, and they do not share a spelling.
 *
 * Agent Platform, as Google documents it:
 *   POST https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT}/locations/global/interactions
 *   Authorization: Bearer <token>
 *
 * The Developer API, measured:
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   x-goog-api-key: <key>
 *
 * Neither spelling works on the other host -- `/v1beta1/interactions` on generativelanguage is 404,
 * `/v1/interactions` on aiplatform is 404 -- so the host decides the whole shape, including which
 * credential it will take.
 *
 * What is measured and what is not: Agent Platform's refusal of api keys is measured (401, with a
 * key that generateContent accepts). The Developer API's endpoint is measured to exist (403 "Gemini
 * API has not been used in project", which is a routed request refused on project configuration,
 * not a 404). A *successful* api-key call to Interactions has not been made here -- the only key
 * available is a Cloud key whose project has the Gemini API switched off, and an AI Studio key was
 * never in hand. The header choice below follows Google's documentation for that surface.
 */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Whether this base url is Agent Platform, which alone needs a project and a token. */
function isAgentPlatform(baseUrl: string): boolean {
  return /aiplatform\.googleapis\.com/.test(baseUrl);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiBaseUrl(value?: string): string {
  return trimTrailingSlash(value || DEFAULT_BASE_URL);
}

/** The collection url. Agent Platform carries the project in its path; the Developer API does not. */
function interactionsUrl(baseUrl: string, project: string | undefined): string {
  if (!isAgentPlatform(baseUrl)) return `${baseUrl}/interactions`;
  if (!project) {
    throw new Error(
      "Gemini Omni on Agent Platform needs the Cloud project id: it is a path segment, "
      + "as /v1beta1/projects/{project}/locations/global/interactions. "
      + "The Developer API needs no project.",
    );
  }
  return `${baseUrl}/projects/${project}/locations/global/interactions`;
}


/** Accepts a bare id or a `interactions/{id}` name, and yields the bare id. */
function interactionId(value: string): string {
  return value.trim().replace(/^interactions\//, "");
}

function interactionPath(value: string): string {
  const trimmed = value.replace(/^\/+/, "");
  return trimmed.startsWith("interactions/") ? trimmed : `interactions/${trimmed}`;
}

async function parseJsonResponse(response: Response, operation: string): Promise<any> {
  const raw = await response.text();
  let json: any;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { error: { message: raw || response.statusText } };
  }
  if (!response.ok) {
    throw providerHttpError({ status: response.status, operation: operation === "interaction creation" ? "submit" : "poll", message: `Gemini Omni ${operation} failed: ${json?.error?.message ?? response.statusText}` });
  }
  return json;
}

function headers(
  input: { accessToken?: string; apiKey?: string; baseUrl?: string },
  contentType = false,
): Record<string, string> {
  const json: Record<string, string> = contentType ? { "content-type": "application/json" } : {};
  const baseUrl = apiBaseUrl(input.baseUrl);

  if (isAgentPlatform(baseUrl)) {
    const accessToken = input.accessToken?.trim();
    if (!accessToken) {
      throw new Error(
        "Gemini Omni on Agent Platform requires an OAuth2 access token. That surface refuses api "
        + "keys outright (401 \"API keys are not supported by this API\").",
      );
    }
    return { authorization: `Bearer ${accessToken}`, ...json };
  }

  // No falling back to accessToken. The two are different kinds of credential, and accepting either
  // would let a caller aim at one surface holding the other's secret -- failing at the vendor with a
  // message about the credential rather than about the mix-up.
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Gemini Omni on the Developer API requires a Google API key. "
      + "An access token belongs to Agent Platform, which is a different base url.",
    );
  }
  return { "x-goog-api-key": apiKey, ...json };
}


export async function createGeminiOmniInteraction(
  input: CreateGeminiOmniInteractionInput,
): Promise<GeminiOmniInteraction> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = apiBaseUrl(input.baseUrl);
  const serializedInput = input.input.length === 1 && input.input[0]?.type === "text"
    ? input.input[0].text
    : input.input.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mime_type: part.mimeType });
  const requestHeaders = headers(input, true);
  const response = await fetchImpl(interactionsUrl(baseUrl, input.project), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      model: input.model,
      input: serializedInput,
      response_format: {
        type: "video",
        aspect_ratio: input.aspectRatio,
        duration: `${input.duration}s`,
        // Delivery to a bucket when one is named, bytes otherwise. The two fields travel together:
        // `delivery: "uri"` alone answers 400 "Video delivery mode 'URI' requires a `gcs_uri`",
        // which is what this request used to send unconditionally -- so every omni call was
        // guaranteed to fail, and nothing could authenticate well enough to discover it.
        //
        // Inline costs a third more on the wire than the file: 3302376 characters of base64 for
        // 2476780 bytes of MP4, measured on one generation.
        ...(input.gcsUri ? { delivery: "uri", gcs_uri: input.gcsUri } : {}),
      },
      // Measured as real: `background: true` returns `in_progress` and must then be polled. Left
      // opt-in, because the default is synchronous and answers with the video in one call.
      ...(input.background ? { background: true } : {}),
      store: true,
      stream: false,
    }),
  });
  return parseJsonResponse(response, "interaction creation");
}

export async function getGeminiOmniInteraction(
  input: GetGeminiOmniInteractionInput,
): Promise<GeminiOmniInteraction> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = apiBaseUrl(input.baseUrl);
  // The same collection, addressed by id. Building it separately is how the create call ended up on
  // one host and the poll on another.
  const response = await fetchImpl(
    `${interactionsUrl(baseUrl, input.project)}/${interactionId(input.interactionId)}`,
    {
    method: "GET",
    headers: headers(input),
  });
  return parseJsonResponse(response, "interaction polling");
}

function findVideo(value: unknown): GeminiOmniVideoOutput | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideo(item);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const isVideo = record.type === "video" || (
    typeof record.mime_type === "string" && record.mime_type.startsWith("video/")
  );
  if (isVideo) {
    const data = typeof record.data === "string" ? record.data : undefined;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    if (data || uri) {
      return {
        ...(data ? { data } : {}),
        ...(uri ? { uri } : {}),
        mimeType: typeof record.mime_type === "string" ? record.mime_type : "video/mp4",
      };
    }
  }

  for (const nested of Object.values(record)) {
    const found = findVideo(nested);
    if (found) return found;
  }
  return undefined;
}

export function extractGeminiOmniVideo(
  interaction: GeminiOmniInteraction,
): GeminiOmniVideoOutput | undefined {
  return findVideo(interaction.steps) ?? findVideo(interaction);
}

export function geminiOmniInteractionId(interaction: GeminiOmniInteraction): string {
  const id = interaction.id ?? interaction.name;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Gemini Omni interaction response did not include an id.");
  }
  return id;
}

export function geminiOmniInteractionStatus(interaction: GeminiOmniInteraction): string {
  return String(interaction.status ?? "").trim().toLowerCase();
}

export async function downloadGeminiOmniVideo(input: {
  apiKey?: string;
  accessToken?: string;
  uri: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
  const fetchImpl = input.fetch ?? fetch;
  const match = /(?:^|\/)files\/([^/:?#]+)/.exec(input.uri);
  if (match?.[1]) {
    const fileId = match[1];
    let baseUrl = apiBaseUrl(input.baseUrl);
    if (!input.baseUrl) {
      try {
        const uri = new URL(input.uri);
        const filesIndex = uri.pathname.indexOf("/files/");
        if (filesIndex >= 0) baseUrl = `${uri.origin}${uri.pathname.slice(0, filesIndex)}`;
      } catch {
        // Relative files/<id> URIs use the default Gemini base URL.
      }
    }
    const metadataUrl = `${baseUrl}/files/${encodeURIComponent(fileId)}`;
    const metadataResponse = await fetchImpl(metadataUrl, { method: "GET", headers: headers(input) });
    const metadata = await parseJsonResponse(metadataResponse, "file polling");
    const state = typeof metadata?.state === "string" ? metadata.state : typeof metadata?.state?.name === "string" ? metadata.state.name : "";
    if (state.toUpperCase() === "FAILED") throw new Error("Gemini Omni generated video file processing failed.");
    if (state.toUpperCase() !== "ACTIVE") return undefined;
    const response = await fetchImpl(`${metadataUrl}:download?alt=media`, {
      method: "GET",
      headers: headers(input),
    });
    if (!response.ok) {
      const message = await response.text();
      throw providerHttpError({ status: response.status, operation: "poll", message: `Gemini Omni video download failed: ${message || response.statusText}` });
    }
    return {
      bytes: await response.arrayBuffer(),
      mimeType: response.headers.get("content-type")?.split(";")[0] || "video/mp4",
    };
  }

  let downloadHeaders: Record<string, string> = {};
  try {
    const uri = new URL(input.uri);
    // Google's own hosts want the credential on the download too; anywhere else is a signed url and
    // sending it there would leak the token to whoever hosts the bytes.
    if (uri.hostname.endsWith(".googleapis.com")) {
      downloadHeaders = headers(input);
    }
  } catch {
    downloadHeaders = headers(input);
  }
  const response = await fetchImpl(input.uri, { method: "GET", headers: downloadHeaders });
  if (!response.ok) {
    const message = await response.text();
    throw providerHttpError({ status: response.status, operation: "poll", message: `Gemini Omni video download failed: ${message || response.statusText}` });
  }
  return {
    bytes: await response.arrayBuffer(),
    mimeType: response.headers.get("content-type")?.split(";")[0] || "video/mp4",
  };
}
