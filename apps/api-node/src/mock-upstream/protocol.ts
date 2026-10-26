/**
 * Fake-key hashing, deterministic token counts, and OpenAI/Anthropic payloads.
 * Never log a full Authorization / x-api-key value — only keyIdFor().
 */
import { createHash } from "node:crypto";
import type { MockUsageOverride } from "./state.ts";

/** Fake keys only (`sk_test_*`). */
export const FAKE_KEY_PREFIX = "sk_test_";

/** sha256(key).slice(0, 12) — hex, as required by NODES §4.4. */
export function keyIdFor(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

export function extractApiKey(headers: Headers): string | undefined {
  const bearer = /^Bearer[\t ]+(\S+)$/i.exec(
    (headers.get("authorization") ?? "").trim(),
  )?.[1];
  if (bearer) return bearer;
  const xApiKey = headers.get("x-api-key")?.trim();
  return xApiKey || undefined;
}

export function assertFakeKey(key: string | undefined): string {
  if (!key || !key.startsWith(FAKE_KEY_PREFIX)) {
    const err = new Error("invalid_api_key");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  return key;
}

/**
 * Deterministic usage from raw body length and max_tokens (not random).
 * Matches gateway-core estimateTokensFromBytes (ceil(bytes/3)) for input.
 */
export function deriveUsage(
  bodyBytes: number,
  maxTokens: number | undefined,
  override?: MockUsageOverride,
): { input: number; output: number; cached: number } {
  if (override) return { ...override };
  const input = bodyBytes <= 0 ? 0 : Math.ceil(bodyBytes / 3);
  const output =
    maxTokens !== undefined
      ? Math.max(0, maxTokens)
      : Math.max(1, Math.ceil(Math.max(bodyBytes, 1) / 8));
  return { input, output, cached: 0 };
}

export function readMaxTokens(body: Record<string, unknown>): number | undefined {
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return value;
  }
  return undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Never resolves — used for mode=hang (and timeout body hang). */
export function hangForever(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

export const MODEL_CATALOG = {
  object: "list" as const,
  data: [
    {
      id: "gpt-4o-mini",
      object: "model" as const,
      created: 1_700_000_000,
      owned_by: "openai",
    },
    {
      id: "gpt-4o",
      object: "model" as const,
      created: 1_700_000_000,
      owned_by: "openai",
    },
    {
      id: "claude-3-5-haiku-latest",
      object: "model" as const,
      created: 1_700_000_000,
      owned_by: "anthropic",
    },
    {
      id: "claude-sonnet-4-20250514",
      object: "model" as const,
      created: 1_700_000_000,
      owned_by: "anthropic",
    },
  ],
};

/** Split a deterministic assistant reply into `chunks` pieces. */
export function contentChunks(chunks: number, outputTokens: number): string[] {
  const n = Math.max(1, chunks);
  const totalChars = Math.max(n, outputTokens);
  const unit = "x";
  const full = unit.repeat(totalChars);
  const size = Math.ceil(full.length / n);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const slice = full.slice(i * size, (i + 1) * size);
    if (slice) parts.push(slice);
  }
  return parts.length ? parts : [""];
}

export function openaiCompletionId(bodyBytes: number): string {
  return `chatcmpl-mock${(bodyBytes % 1_000_000).toString(36)}`;
}

export function anthropicMessageId(bodyBytes: number): string {
  return `msg_mock${(bodyBytes % 1_000_000).toString(36)}`;
}

export function buildOpenAINonStream(options: {
  model: string;
  content: string;
  usage: { input: number; output: number; cached: number };
  id: string;
}) {
  const prompt = options.usage.input + options.usage.cached;
  return {
    id: options.id,
    object: "chat.completion",
    created: 1_700_000_000,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: options.usage.output,
      total_tokens: prompt + options.usage.output,
      ...(options.usage.cached > 0
        ? { prompt_tokens_details: { cached_tokens: options.usage.cached } }
        : {}),
    },
  };
}

export function encodeOpenAISse(
  data: unknown | typeof OPENAI_DONE,
): string {
  if (data === OPENAI_DONE) return "data: [DONE]\n\n";
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const OPENAI_DONE = Symbol("openai-done");

export function openAIStreamFrames(options: {
  model: string;
  parts: string[];
  usage: { input: number; output: number; cached: number };
  id: string;
  includeUsage: boolean;
}): string[] {
  const { model, parts, usage, id, includeUsage } = options;
  const frames: string[] = [];
  frames.push(
    encodeOpenAISse({
      id,
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    }),
  );
  for (const part of parts) {
    frames.push(
      encodeOpenAISse({
        id,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
      }),
    );
  }
  frames.push(
    encodeOpenAISse({
      id,
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
  );
  if (includeUsage) {
    const prompt = usage.input + usage.cached;
    frames.push(
      encodeOpenAISse({
        id,
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: usage.output,
          total_tokens: prompt + usage.output,
          ...(usage.cached > 0
            ? { prompt_tokens_details: { cached_tokens: usage.cached } }
            : {}),
        },
      }),
    );
  }
  frames.push(encodeOpenAISse(OPENAI_DONE));
  return frames;
}

function anthropicEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function buildAnthropicNonStream(options: {
  model: string;
  content: string;
  usage: { input: number; output: number; cached: number };
  id: string;
}) {
  return {
    id: options.id,
    type: "message",
    role: "assistant",
    model: options.model,
    content: [{ type: "text", text: options.content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: options.usage.input,
      output_tokens: options.usage.output,
      cache_read_input_tokens: options.usage.cached,
      cache_creation_input_tokens: 0,
    },
  };
}

export function anthropicStreamFrames(options: {
  model: string;
  parts: string[];
  usage: { input: number; output: number; cached: number };
  id: string;
}): string[] {
  const { model, parts, usage, id } = options;
  const frames: string[] = [];
  frames.push(
    anthropicEvent("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input,
          output_tokens: 1,
          cache_read_input_tokens: usage.cached,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  );
  frames.push(
    anthropicEvent("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );
  for (const part of parts) {
    frames.push(
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: part },
      }),
    );
  }
  frames.push(anthropicEvent("content_block_stop", { index: 0 }));
  frames.push(
    anthropicEvent("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output },
    }),
  );
  frames.push(anthropicEvent("message_stop", {}));
  return frames;
}

