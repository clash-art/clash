import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import {
  createQualityReviewResult,
  QualityJudgeResponseSchema,
} from "./quality-review";
import { renderQualityJudgePrompt } from "./quality-review-codex";
import {
  qualityRequestEvidenceKinds,
  verifiedQualityEvidenceFiles,
  type VerifiedQualityEvidenceFile,
} from "./quality-review-evidence";
import type {
  ArtifactEvidence,
  ArtifactKind,
  GeminiQualityReviewer,
  QualityReviewRequest,
  QualityReviewResult,
} from "./types";

export const GEMINI_API_VERSION = "v1beta";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_API_KEY_ENV = "GEMINI_API_KEY";
const ATTACHED_EVIDENCE = "media (images, video, and audio)";
// generateContent rejects requests over 20 MB; base64 inflates inline bytes by 4/3.
const INLINE_MEDIA_BYTES = 14 * 1024 * 1024;
const FILE_POLL_INTERVAL_MS = 1_000;

const GEMINI_JUDGE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "image",
  "video",
  "audio",
]);

// Gemini's documented input MIME types, keyed by the extensions Clash renders and samples.
const MIME_BY_KIND_AND_EXTENSION: Record<string, Record<string, string>> = {
  image: {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  },
  video: {
    ".mp4": "video/mp4",
    ".mov": "video/mov",
    ".webm": "video/webm",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpg",
  },
  audio: {
    ".wav": "audio/wav",
    ".mp3": "audio/mp3",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".aiff": "audio/aiff",
  },
};

/** Only an https origin (or loopback http for tests) is accepted: the key travels in a header. */
export function geminiBaseUrl(value: string | undefined): string {
  const url = new URL(value ?? DEFAULT_BASE_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Gemini base URL must be an https origin without credentials or query",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

export function geminiQualityJudgeSupportsRequest(
  request: QualityReviewRequest,
): boolean {
  return [...qualityRequestEvidenceKinds(request)].every(
    (kind) => kind !== undefined && GEMINI_JUDGE_KINDS.has(kind),
  );
}

export function geminiEvidenceMimeType(
  kind: ArtifactKind,
  path: string,
): string | undefined {
  return MIME_BY_KIND_AND_EXTENSION[kind]?.[extname(path).toLowerCase()];
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { mime_type: string; file_uri: string } };

export type GeminiMediaAttachment = {
  file: VerifiedQualityEvidenceFile;
  mimeType: string;
  fileUri?: string;
};

function geminiResponseSchema(request: QualityReviewRequest): unknown {
  return {
    type: "OBJECT",
    properties: {
      schemaVersion: { type: "INTEGER", description: "Always 1." },
      criteria: {
        type: "ARRAY",
        minItems: request.criteria.length,
        maxItems: request.criteria.length,
        items: {
          type: "OBJECT",
          properties: {
            id: {
              type: "STRING",
              enum: request.criteria.map(({ id }) => id),
            },
            score: { type: "NUMBER", minimum: 0, maximum: 100 },
            rationale: { type: "STRING" },
          },
          required: ["id", "score", "rationale"],
          propertyOrdering: ["id", "score", "rationale"],
        },
      },
      overallRationale: { type: "STRING" },
    },
    required: ["schemaVersion", "criteria", "overallRationale"],
    propertyOrdering: ["schemaVersion", "criteria", "overallRationale"],
  };
}

/**
 * Each attachment is preceded by its public identity so the judge can tie a criterion's
 * evidence ids to the media it is looking at; no workspace path is ever sent.
 */
export function buildGeminiQualityJudgeRequest(input: {
  request: QualityReviewRequest;
  prompt: string;
  attachments: GeminiMediaAttachment[];
}): unknown {
  const parts: GeminiPart[] = [{ text: input.prompt }];
  for (const attachment of input.attachments) {
    const { binding, bytes } = attachment.file;
    parts.push({
      text: `Artifact ${binding.id} (${binding.kind}, sha256 ${binding.sha256}):`,
    });
    parts.push(
      attachment.fileUri
        ? {
            file_data: {
              mime_type: attachment.mimeType,
              file_uri: attachment.fileUri,
            },
          }
        : {
            inline_data: {
              mime_type: attachment.mimeType,
              data: bytes.toString("base64"),
            },
          },
    );
  }
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      candidateCount: 1,
      responseMimeType: "application/json",
      responseSchema: geminiResponseSchema(input.request),
    },
  };
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<Record<string, unknown>> };
  }>;
  modelVersion?: string;
};

const TOOL_PART_KEYS = [
  "functionCall",
  "executableCode",
  "codeExecutionResult",
];

export function parseGeminiQualityJudgeResponse(input: {
  request: QualityReviewRequest;
  reviewer: GeminiQualityReviewer;
  prompt: string;
  responseBody: string;
}): QualityReviewResult {
  let body: GeminiGenerateContentResponse;
  try {
    body = JSON.parse(input.responseBody) as GeminiGenerateContentResponse;
  } catch {
    throw new Error("Gemini quality reviewer returned invalid JSON");
  }
  const candidate = body.candidates?.[0];
  if (!candidate || body.candidates!.length !== 1) {
    throw new Error("Gemini quality reviewer returned no single candidate");
  }
  if (candidate.finishReason !== "STOP") {
    throw new Error(
      `Gemini quality reviewer stopped with ${candidate.finishReason ?? "no finish reason"}`,
    );
  }
  const parts = candidate.content?.parts ?? [];
  for (const part of parts) {
    const toolKey = TOOL_PART_KEYS.find((key) => key in part);
    if (toolKey) {
      throw new Error(
        `The read-only evidence judge attempted a tool operation (${toolKey})`,
      );
    }
  }
  const rawResponse = parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse) as unknown;
  } catch {
    throw new Error("Gemini quality reviewer response is not valid JSON");
  }
  return createQualityReviewResult({
    request: input.request,
    reviewer: {
      kind: "gemini",
      provider: input.reviewer.provider,
      model: input.reviewer.model,
      adapterVersion: `gemini-api ${GEMINI_API_VERSION} ${body.modelVersion ?? "unreported"}`,
      endpointHost: new URL(input.reviewer.baseUrl ?? DEFAULT_BASE_URL).host,
      apiKeyEnv: input.reviewer.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    },
    response: QualityJudgeResponseSchema.parse(parsed),
    prompt: input.prompt,
    rawResponse,
  });
}

async function geminiFetch(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 2_000);
    throw new Error(
      `Gemini ${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

type GeminiFile = { name?: string; uri?: string; state?: string };

async function uploadGeminiFile(input: {
  baseUrl: string;
  headers: Record<string, string>;
  attachment: GeminiMediaAttachment;
  signal: AbortSignal;
}): Promise<{ name: string; uri: string }> {
  const { binding, bytes } = input.attachment.file;
  const start = await geminiFetch(
    `${input.baseUrl}/upload/${GEMINI_API_VERSION}/files`,
    {
      method: "POST",
      headers: {
        ...input.headers,
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.byteLength),
        "x-goog-upload-header-content-type": input.attachment.mimeType,
      },
      body: JSON.stringify({ file: { display_name: binding.id } }),
      signal: input.signal,
    },
    "file upload start",
  );
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload returned no upload URL");
  const finished = await geminiFetch(
    uploadUrl,
    {
      method: "POST",
      headers: {
        ...input.headers,
        "x-goog-upload-offset": "0",
        "x-goog-upload-command": "upload, finalize",
      },
      body: new Uint8Array(bytes),
      signal: input.signal,
    },
    "file upload",
  );
  let file = ((await finished.json()) as { file?: GeminiFile }).file;
  while (file?.name && file.state === "PROCESSING") {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, FILE_POLL_INTERVAL_MS),
    );
    const polled = await geminiFetch(
      `${input.baseUrl}/${GEMINI_API_VERSION}/${file.name}`,
      { headers: input.headers, signal: input.signal },
      "file status",
    );
    file = (await polled.json()) as GeminiFile;
  }
  if (!file?.name || !file.uri || file.state !== "ACTIVE") {
    throw new Error(
      `Gemini file '${binding.id}' did not become active (${file?.state ?? "missing"})`,
    );
  }
  return { name: file.name, uri: file.uri };
}

export async function runGeminiQualityJudge(input: {
  reviewer: GeminiQualityReviewer;
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
  workspace: string;
  caseRoot: string;
}): Promise<QualityReviewResult | undefined> {
  if (!geminiQualityJudgeSupportsRequest(input.request)) return undefined;
  if (input.reviewer.provider !== "google" || !input.reviewer.model.trim()) {
    throw new Error(
      "Gemini quality review requires explicit provider=google and an explicit model",
    );
  }
  const apiKeyEnv = input.reviewer.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`Gemini quality review requires ${apiKeyEnv} to be set`);
  }
  const files = await verifiedQualityEvidenceFiles({
    request: input.request,
    evidence: input.evidence,
    workspace: input.workspace,
    kinds: GEMINI_JUDGE_KINDS,
  });
  if (files.length === 0) return undefined;
  const attachments: GeminiMediaAttachment[] = [];
  for (const file of files) {
    const evidencePath =
      input.evidence.find(({ id }) => id === file.binding.id)?.path ?? "";
    const mimeType = geminiEvidenceMimeType(file.binding.kind, evidencePath);
    if (!mimeType) return undefined;
    attachments.push({ file, mimeType });
  }

  const baseUrl = geminiBaseUrl(input.reviewer.baseUrl);
  const headers = { "x-goog-api-key": apiKey };
  const signal = AbortSignal.timeout(input.reviewer.timeoutMs ?? 5 * 60_000);
  const privateRoot = join(input.caseRoot, "quality-review-private");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const uploaded: string[] = [];
  try {
    const inlineBytes = attachments.reduce(
      (sum, { file }) => sum + file.bytes.byteLength,
      0,
    );
    if (inlineBytes > INLINE_MEDIA_BYTES) {
      for (const attachment of attachments) {
        if (attachment.file.binding.kind === "image") continue;
        const file = await uploadGeminiFile({
          baseUrl,
          headers,
          attachment,
          signal,
        });
        uploaded.push(file.name);
        attachment.fileUri = file.uri;
      }
    }
    const prompt = renderQualityJudgePrompt(input.request, ATTACHED_EVIDENCE);
    const body = buildGeminiQualityJudgeRequest({
      request: input.request,
      prompt,
      attachments,
    });
    await writeFile(
      join(privateRoot, "request-summary.json"),
      `${JSON.stringify(
        {
          endpoint: `${GEMINI_API_VERSION}/models/${input.reviewer.model}:generateContent`,
          promptSha256: createHash("sha256").update(prompt).digest("hex"),
          attachments: attachments.map(({ file, mimeType, fileUri }) => ({
            id: file.binding.id,
            kind: file.binding.kind,
            sha256: file.binding.sha256,
            mimeType,
            transport: fileUri ? "file-api" : "inline",
          })),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const response = await geminiFetch(
      `${baseUrl}/${GEMINI_API_VERSION}/models/${encodeURIComponent(input.reviewer.model)}:generateContent`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      "generateContent",
    );
    const responseBody = await response.text();
    await writeFile(join(privateRoot, "response.json"), responseBody, {
      encoding: "utf8",
      mode: 0o600,
    });
    return parseGeminiQualityJudgeResponse({
      request: input.request,
      reviewer: input.reviewer,
      prompt,
      responseBody,
    });
  } catch (error) {
    // The runner records only a digest of a reviewer failure; keep the readable cause private.
    await writeFile(
      join(privateRoot, "error.log"),
      error instanceof Error ? error.message : String(error),
      { encoding: "utf8", mode: 0o600 },
    );
    throw error;
  } finally {
    await Promise.all(
      uploaded.map((name) =>
        fetch(`${baseUrl}/${GEMINI_API_VERSION}/${name}`, {
          method: "DELETE",
          headers,
        }).catch(() => undefined),
      ),
    );
  }
}
