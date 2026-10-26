/**
 * Normalized usage. Token fields are disjoint so pricing never double counts:
 * `inputTokens` excludes cache reads and cache writes, matching Anthropic's
 * `input_tokens`; OpenAI's `prompt_tokens` includes `cached_tokens`, so the
 * OpenAI reader subtracts them.
 */

export type GatewayUsageShape = "openai-chat" | "anthropic-messages";

/** Non-token units for media/AIGC and flat-fee requests. */
export type GatewayMediaUnit =
  | "image"
  | "video_second"
  | "audio_second"
  | "character"
  | "request";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Prompt tokens written into the provider's prompt cache. */
  cacheWriteTokens: number;
  units: Partial<Record<GatewayMediaUnit, number>>;
  /** `reported` only when every counted field came from the upstream. */
  source: "reported" | "estimated";
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    units: {},
    source: "reported",
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function addUsage(a: Usage, b: Usage): Usage {
  const units: Partial<Record<GatewayMediaUnit, number>> = { ...a.units };
  for (const [unit, quantity] of Object.entries(b.units) as Array<
    [GatewayMediaUnit, number]
  >)
    units[unit] = (units[unit] ?? 0) + quantity;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    units,
    source:
      a.source === "estimated" || b.source === "estimated"
        ? "estimated"
        : "reported",
  };
}

/** Conservative token estimate when a provider reports no usage (bytes / 3, rounded up). */
export function estimateTokensFromBytes(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 3);
}

export interface UsageAccumulator {
  /** Feed one parsed JSON payload: a whole response body or one SSE `data:` object. */
  observe(payload: unknown): void;
  /** True once the upstream reported any usage. */
  readonly reported: boolean;
  snapshot(): Usage;
}

/**
 * Accumulate usage across a non-streamed response or a stream's events.
 *
 * OpenAI chat: the `usage` object (final chunk when streaming with
 * `stream_options.include_usage`) is cumulative, so the latest one wins.
 * Anthropic messages: `message_start.message.usage` carries input and cache
 * counts; `message_delta.usage.output_tokens` is cumulative, so the maximum wins.
 */
export function createUsageAccumulator(
  shape: GatewayUsageShape,
): UsageAccumulator {
  const usage = emptyUsage();
  let reported = false;

  const observeOpenAI = (payload: Record<string, unknown>) => {
    const raw = record(payload.usage);
    if (!raw) return;
    const prompt = count(raw.prompt_tokens);
    const completion = count(raw.completion_tokens);
    const cached = count(record(raw.prompt_tokens_details)?.cached_tokens) ?? 0;
    if (prompt === undefined && completion === undefined) return;
    reported = true;
    if (prompt !== undefined) {
      usage.cachedInputTokens = Math.min(cached, prompt);
      usage.inputTokens = prompt - usage.cachedInputTokens;
    }
    if (completion !== undefined) usage.outputTokens = completion;
  };

  const observeAnthropicUsage = (raw: Record<string, unknown> | undefined) => {
    if (!raw) return;
    const input = count(raw.input_tokens);
    const output = count(raw.output_tokens);
    const cacheRead = count(raw.cache_read_input_tokens);
    const cacheWrite = count(raw.cache_creation_input_tokens);
    if (
      input === undefined &&
      output === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined
    )
      return;
    reported = true;
    if (input !== undefined) usage.inputTokens = Math.max(usage.inputTokens, input);
    if (output !== undefined)
      usage.outputTokens = Math.max(usage.outputTokens, output);
    if (cacheRead !== undefined)
      usage.cachedInputTokens = Math.max(usage.cachedInputTokens, cacheRead);
    if (cacheWrite !== undefined)
      usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, cacheWrite);
  };

  const observeAnthropic = (payload: Record<string, unknown>) => {
    if (payload.type === "message_start")
      observeAnthropicUsage(record(record(payload.message)?.usage));
    else observeAnthropicUsage(record(payload.usage));
  };

  return {
    observe(payload) {
      const body = record(payload);
      if (!body) return;
      if (shape === "openai-chat") observeOpenAI(body);
      else observeAnthropic(body);
    },
    get reported() {
      return reported;
    },
    snapshot() {
      return { ...usage, units: { ...usage.units } };
    },
  };
}

const utf8 = new TextEncoder();
const textBytes = (value: unknown): number => (typeof value === "string" ? utf8.encode(value).byteLength : 0);

/**
 * UTF-8 bytes of generated content in one stream event: text, reasoning,
 * refusals and tool-call arguments, never SSE or JSON framing. The basis of
 * the output estimate for a stream that ended before reporting usage.
 */
export function streamContentBytes(shape: GatewayUsageShape, payload: unknown): number {
  const body = record(payload);
  if (!body) return 0;
  if (shape === "anthropic-messages") {
    if (body.type !== "content_block_delta") return 0;
    const delta = record(body.delta);
    return delta ? textBytes(delta.text) + textBytes(delta.partial_json) + textBytes(delta.thinking) : 0;
  }
  if (!Array.isArray(body.choices)) return 0;
  let bytes = 0;
  for (const choice of body.choices) {
    const delta = record(record(choice)?.delta);
    if (!delta) continue;
    bytes += textBytes(delta.content) + textBytes(delta.reasoning_content) + textBytes(delta.refusal);
    if (Array.isArray(delta.tool_calls))
      for (const call of delta.tool_calls) {
        const fn = record(record(call)?.function);
        bytes += textBytes(fn?.name) + textBytes(fn?.arguments);
      }
  }
  return bytes;
}

/** What a usage capture saw of one stream. */
export interface StreamObservation {
  usage: Usage;
  /** The upstream reported any usage. */
  reported: boolean;
  /**
   * The upstream reported its final output count (OpenAI's usage chunk,
   * Anthropic's `message_delta` usage), not only a starting value.
   */
  outputReported: boolean;
  /** Generated content bytes seen (streamContentBytes). */
  outputBytes: number;
}

/**
 * Usage to settle a stream with. The reported usage when the upstream reported
 * its final output; otherwise reported input (or the admission estimate) plus
 * the larger of any reported output and the estimate from delivered content,
 * capped at the request's output ceiling, marked `estimated`. A stream cut
 * after n tokens is charged about n tokens: never zero output for delivered
 * content, never the full output ceiling.
 */
export function streamedUsage(
  observed: StreamObservation,
  estimate: { inputTokens: number; maxOutputTokens?: number },
): Usage {
  if (observed.reported && observed.outputReported) return { ...observed.usage, units: { ...observed.usage.units } };
  const fromBytes = estimateTokensFromBytes(observed.outputBytes);
  const estimatedOutput =
    estimate.maxOutputTokens === undefined ? fromBytes : Math.min(fromBytes, estimate.maxOutputTokens);
  const base = observed.reported
    ? { ...observed.usage, units: { ...observed.usage.units } }
    : { ...emptyUsage(), inputTokens: estimate.inputTokens };
  return { ...base, outputTokens: Math.max(base.outputTokens, estimatedOutput), source: "estimated" };
}

/**
 * Final usage for settlement: the reported usage when the upstream sent any,
 * otherwise the admission estimate plus observed output, marked `estimated`.
 */
export function settledUsage(
  accumulator: UsageAccumulator,
  estimate: { inputTokens: number; outputBytes?: number },
): Usage {
  if (accumulator.reported) return accumulator.snapshot();
  return {
    ...emptyUsage(),
    inputTokens: estimate.inputTokens,
    outputTokens: estimateTokensFromBytes(estimate.outputBytes ?? 0),
    source: "estimated",
  };
}
