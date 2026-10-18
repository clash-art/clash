/**
 * Provider-route transcription call shared by the Cloudflare and Node
 * adapters. Credentials, audit persistence and `fetch` are injected; this
 * module knows only how a text-generation Provider accepts inline audio.
 */
import type {
  ModelUpstreamRoute,
  ProviderUsageAuditEvent,
} from "@clash/shared-types";
import {
  bytesToBase64,
  generateTextCompletion,
  type TextGenerationMessage,
} from "./text-generation.js";
import type { VoiceInputAudio } from "./cloud-project-host/voice-input.js";
import { VoiceInputError } from "./cloud-project-host/voice-input-error.js";
import {
  getVertexAccessTokenForCredentials,
  googleAgentPlatformModelUrl,
  googleServiceAccountFromCredentials,
} from "./google-service-account-auth.js";

export interface ProviderCredentialsPort {
  resolve(input: {
    userId: string;
    route: ModelUpstreamRoute;
  }): Promise<Record<string, string>>;
}

export interface ProviderUsageAuditPort {
  /**
   * Persist one audit event. Stores write `ON CONFLICT DO NOTHING` on the event
   * id, so re-appending the same event is a no-op. A throw fails the request
   * with VOICE_INPUT_USAGE_AUDIT_FAILED; it is never swallowed.
   */
  append(event: ProviderUsageAuditEvent): Promise<void>;
}

export interface ProviderTranscriptionPorts {
  credentials: ProviderCredentialsPort;
  usage: ProviderUsageAuditPort;
  fetch?: typeof fetch;
}

export interface ProviderTranscriptionInput {
  userId: string;
  route: ModelUpstreamRoute;
  audio: VoiceInputAudio;
  prompt: string;
  language?: string;
  /** Invocation identity for the audit row; a fresh id per transcription when omitted. */
  taskId?: string;
  ports: ProviderTranscriptionPorts;
}

export interface ProviderTranscriptionResult {
  text: string;
  provider: string;
  model: string;
}

export function providerIdForRoute(route: ModelUpstreamRoute): string {
  return route.providerId ?? route.upstreamId ?? "provider";
}

function geminiResponseText(response: unknown): string {
  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown } }).content
        ?.parts;
      return Array.isArray(parts) ? parts : [];
    })
    .filter(
      (part): part is { text: string } =>
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

async function geminiGenerateContent(input: {
  url: string;
  headers: Record<string, string>;
  model: string;
  prompt: string;
  audio: VoiceInputAudio;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; model: string }> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: input.prompt },
            {
              inlineData: {
                mimeType: input.audio.mediaType,
                data: bytesToBase64(input.audio.bytes),
              },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });
  const raw = await response.text();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { error: { message: raw } };
  }
  if (!response.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ??
      `${response.status} ${response.statusText}`;
    throw new Error(`Gemini text request failed: ${message}`);
  }
  const text = geminiResponseText(json);
  if (!text.trim()) {
    throw new Error(`Gemini text returned no content for ${input.model}.`);
  }
  return { text, model: input.model };
}

async function googleAiStudioText(input: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  audio: VoiceInputAudio;
  cfAigToken?: string;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; model: string }> {
  if (!input.apiKey.trim()) {
    throw new Error("Google AI Studio provider account is missing apiKey.");
  }
  let baseUrl = (
    input.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");
  if (!/\/v1(beta|alpha)?$/.test(baseUrl)) baseUrl = `${baseUrl}/v1beta`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": input.apiKey,
  };
  if (input.cfAigToken && /gateway\.ai\.cloudflare\.com/.test(baseUrl)) {
    headers["cf-aig-authorization"] = `Bearer ${input.cfAigToken}`;
  }
  return geminiGenerateContent({
    url: `${baseUrl}/models/${encodeURIComponent(input.model)}:generateContent`,
    headers,
    model: input.model,
    prompt: input.prompt,
    audio: input.audio,
    fetchImpl: input.fetchImpl,
  });
}

async function googleAgentPlatformText(input: {
  credentials: Record<string, string>;
  model: string;
  prompt: string;
  audio: VoiceInputAudio;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; model: string }> {
  const account = googleServiceAccountFromCredentials(input.credentials);
  const token = await getVertexAccessTokenForCredentials(account);
  return geminiGenerateContent({
    url: googleAgentPlatformModelUrl(
      account,
      encodeURIComponent(input.model),
      "generateContent",
    ),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    model: input.model,
    prompt: input.prompt,
    audio: input.audio,
    fetchImpl: input.fetchImpl,
  });
}

/**
 * One Provider invocation through the hosted text-generation path. The caller
 * owns selection/readiness; this function resolves credentials, performs the
 * provider request, and records `submitted` then `completed` or `failed` usage events; an audit failure is an explicit VOICE_INPUT_USAGE_AUDIT_FAILED error.
 */
export async function transcribeWithProviderTextGeneration(
  input: ProviderTranscriptionInput,
): Promise<ProviderTranscriptionResult> {
  const { route } = input;
  if (route.apiShape === "pika-chat") {
    throw new VoiceInputError(
      "Pika chat does not accept inline audio transcription.",
      409,
      "VOICE_INPUT_NOT_CONFIGURED",
    );
  }
  const credentials = await input.ports.credentials.resolve({
    userId: input.userId,
    route,
  });
  const provider = providerIdForRoute(route);
  const taskId = input.taskId?.trim() || crypto.randomUUID();
  const event = (
    status: ProviderUsageAuditEvent["status"],
    error?: string,
  ): ProviderUsageAuditEvent => ({
    id: `voice-input:${taskId}:${status}`,
    userId: input.userId,
    providerId: provider,
    ...(route.accountId ? { providerAccountId: route.accountId } : {}),
    modelId: route.modelCode,
    operation: route.upstreamModel,
    taskId,
    actorType: "user",
    actorUserId: input.userId,
    idempotencyKey: `voice-input:${taskId}`,
    status,
    estimateComplete: false,
    currency: "USD",
    pricingSource: "unavailable",
    billingBasis: {},
    ...(error ? { errorMessage: error.slice(0, 500) } : {}),
    occurredAt: new Date().toISOString(),
  });

  // Recorded before the Provider is called: if the audit store is down the
  // request fails here, before anything is charged.
  try {
    await input.ports.usage.append(event("submitted"));
  } catch (error) {
    throw usageAuditError(
      "Voice input did not run: its Provider usage could not be recorded",
      error,
    );
  }

  let result: { text: string; model: string };
  try {
    result = await callProvider(input, credentials);
  } catch (providerError) {
    const message =
      providerError instanceof Error ? providerError.message : String(providerError);
    try {
      await input.ports.usage.append(event("failed", message));
    } catch (auditError) {
      // Keep the Provider's failure first; add the audit failure, never replace it.
      throw usageAuditError(
        `${message} (the failed Provider call could not be recorded either)`,
        auditError,
      );
    }
    throw providerError;
  }

  try {
    await input.ports.usage.append(event("completed"));
  } catch (error) {
    throw usageAuditError(
      "The Provider transcribed the audio but its completed usage could not be recorded, so the transcript was not returned; the submitted usage record exists",
      error,
    );
  }
  return { text: result.text, provider, model: result.model };
}

function usageAuditError(message: string, cause: unknown): VoiceInputError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return new VoiceInputError(
    `${message}${detail}`,
    502,
    "VOICE_INPUT_USAGE_AUDIT_FAILED",
  );
}

async function callProvider(
  input: ProviderTranscriptionInput,
  credentials: Record<string, string>,
): Promise<{ text: string; model: string }> {
  const { route } = input;
  const fetchImpl = input.ports.fetch ?? fetch;
  if (
    route.upstreamId === "google-agent-platform" ||
    (route.upstreamId === "google-ai-studio" && !credentials.apiKey?.trim())
  ) {
    return googleAgentPlatformText({
      credentials,
      model: route.upstreamModel,
      prompt: input.prompt,
      audio: input.audio,
      fetchImpl,
    });
  }
  if (route.upstreamId === "google-ai-studio") {
    return googleAiStudioText({
      apiKey: credentials.apiKey ?? "",
      baseUrl: credentials.baseUrl,
      model: route.upstreamModel,
      prompt: input.prompt,
      audio: input.audio,
      ...(credentials.cfAigToken ? { cfAigToken: credentials.cfAigToken } : {}),
      fetchImpl,
    });
  }
  const textProvider =
    route.apiShape === "anthropic-compatible"
      ? "anthropic-compatible"
      : "openai-compatible";
  const messages: TextGenerationMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: input.prompt },
        {
          type: "audio",
          data: input.audio.bytes,
          mediaType: input.audio.mediaType,
        },
      ],
    },
  ];
  const completion = await generateTextCompletion({
    provider: textProvider,
    apiKey: credentials.apiKey ?? "",
    baseUrl: credentials.baseUrl,
    model: route.upstreamModel,
    messages,
    fetch: fetchImpl,
  });
  return { text: completion.text, model: completion.model };
}
