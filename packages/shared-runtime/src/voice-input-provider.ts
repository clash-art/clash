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
import { getVertexAccessTokenForCredentials } from "./google-service-account-auth.js";

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  project: string;
  location?: string;
}

export interface ProviderCredentialsPort {
  resolve(input: {
    userId: string;
    route: ModelUpstreamRoute;
  }): Promise<Record<string, string>>;
}

export interface ProviderUsageAuditPort {
  /**
   * Persist one audit event. The id is stable for a transcript task id, so an
   * adapter store may write `ON CONFLICT DO NOTHING` and retries cannot
   * duplicate the charge record.
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
  /** Stable invocation identity; the audit row id derives from it. */
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

function serviceAccountFromCredentials(
  credentials: Record<string, string>,
): GoogleServiceAccount {
  const raw = credentials.serviceAccountKey?.trim();
  if (!raw) {
    throw new Error(
      "Google Cloud Agent Platform provider account is missing service account credentials.",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      "Google Cloud Agent Platform credentials must be a service account JSON object.",
    );
  }
  const clientEmail =
    typeof parsed.clientEmail === "string"
      ? parsed.clientEmail
      : typeof parsed.client_email === "string"
        ? parsed.client_email
        : "";
  const privateKey =
    typeof parsed.privateKey === "string"
      ? parsed.privateKey
      : typeof parsed.private_key === "string"
        ? parsed.private_key
        : "";
  const project =
    typeof parsed.project === "string"
      ? parsed.project
      : typeof parsed.project_id === "string"
        ? parsed.project_id
        : "";
  const location =
    typeof parsed.location === "string" && parsed.location.trim()
      ? parsed.location.trim()
      : "global";
  if (!clientEmail || !privateKey || !project) {
    throw new Error(
      "Google Cloud Agent Platform credentials must include clientEmail/privateKey/project.",
    );
  }
  return { clientEmail, privateKey, project, location };
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
  const account = serviceAccountFromCredentials(input.credentials);
  const location = account.location ?? "global";
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  const token = await getVertexAccessTokenForCredentials(account);
  return geminiGenerateContent({
    url: `https://${host}/v1/projects/${account.project}/locations/${location}/publishers/google/models/${encodeURIComponent(input.model)}:generateContent`,
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
 * provider request, maps failures, and appends exactly one usage-audit event.
 */
export async function transcribeWithProviderTextGeneration(
  input: ProviderTranscriptionInput,
): Promise<ProviderTranscriptionResult> {
  const { route } = input;
  const fetchImpl = input.ports.fetch ?? fetch;
  const credentials = await input.ports.credentials.resolve({
    userId: input.userId,
    route,
  });
  const provider = providerIdForRoute(route);

  let result: { text: string; model: string };
  if (
    route.upstreamId === "google-agent-platform" ||
    (route.upstreamId === "google-ai-studio" && !credentials.apiKey?.trim())
  ) {
    result = await googleAgentPlatformText({
      credentials,
      model: route.upstreamModel,
      prompt: input.prompt,
      audio: input.audio,
      fetchImpl,
    });
  } else if (route.upstreamId === "google-ai-studio") {
    result = await googleAiStudioText({
      apiKey: credentials.apiKey ?? "",
      baseUrl: credentials.baseUrl,
      model: route.upstreamModel,
      prompt: input.prompt,
      audio: input.audio,
      ...(credentials.cfAigToken ? { cfAigToken: credentials.cfAigToken } : {}),
      fetchImpl,
    });
  } else if (route.apiShape === "pika-chat") {
    throw new Error("Pika chat does not accept inline audio transcription.");
  } else {
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
    result = { text: completion.text, model: completion.model };
  }

  const taskId = input.taskId?.trim() || crypto.randomUUID();
  await input.ports.usage.append({
    id: `voice-input:${taskId}`,
    userId: input.userId,
    providerId: provider,
    ...(route.accountId ? { providerAccountId: route.accountId } : {}),
    modelId: route.modelCode,
    operation: route.upstreamModel,
    taskId,
    actorType: "user",
    actorUserId: input.userId,
    idempotencyKey: `voice-input:${taskId}`,
    status: "completed",
    estimateComplete: false,
    currency: "USD",
    pricingSource: "unavailable",
    billingBasis: {},
    occurredAt: new Date().toISOString(),
  });

  return { text: result.text, provider, model: result.model };
}
