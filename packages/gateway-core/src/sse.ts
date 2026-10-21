/**
 * Server-Sent Events helpers over Web Streams only (global in Workers and
 * Node 24). Parsing follows the WHATWG event-stream rules: lines end in LF,
 * CRLF or CR; `:` starts a comment; repeated `data:` lines join with LF; a
 * blank line dispatches; a single leading space after the colon is dropped.
 */
import {
  toAnthropicErrorBody,
  toOpenAIErrorBody,
  type GatewayError,
  type GatewayWireProtocol,
} from "./errors.js";
import {
  createUsageAccumulator,
  streamContentBytes,
  type GatewayUsageShape,
  type StreamObservation,
  type UsageAccumulator,
} from "./usage.js";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** The OpenAI stream terminator payload (`data: [DONE]`). */
export const OPENAI_STREAM_DONE = "[DONE]";

export interface SseParser {
  /** Feed decoded text; returns the events completed by it. */
  push(text: string): SseEvent[];
  /** Stop parsing; an event without its terminating blank line is discarded per spec. */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let sawData = false;

  const dispatch = (out: SseEvent[]) => {
    if (sawData)
      out.push({
        data: data.join("\n"),
        ...(event !== undefined ? { event } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {}),
      });
    data = [];
    event = undefined;
    retry = undefined;
    sawData = false;
  };

  const line = (text: string, out: SseEvent[]) => {
    if (text === "") return dispatch(out);
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      sawData = true;
    } else if (field === "event") event = value;
    else if (field === "id") {
      if (!value.includes("\0")) id = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  };

  return {
    push(text) {
      buffer += text;
      const out: SseEvent[] = [];
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A trailing CR may be the first half of CRLF split across chunks.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index), out);
        buffer = buffer.slice(match.index + match[0].length);
      }
      return out;
    },
    end() {
      const out: SseEvent[] = [];
      if (buffer.endsWith("\r")) line(buffer.slice(0, -1), out);
      buffer = "";
      data = [];
      event = undefined;
      retry = undefined;
      sawData = false;
      return out;
    },
  };
}

/** Serialize one event; multi-line data becomes one `data:` line per line. */
export function encodeSseEvent(event: SseEvent): string {
  let out = "";
  if (event.event !== undefined) out += `event: ${event.event}\n`;
  if (event.id !== undefined) out += `id: ${event.id}\n`;
  if (event.retry !== undefined) out += `retry: ${event.retry}\n`;
  for (const part of event.data.split(/\r\n|\r|\n/)) out += `data: ${part}\n`;
  return `${out}\n`;
}

/** Keep-alive comment; clients ignore it, proxies see traffic. */
export function encodeSseComment(text = ""): string {
  return `:${text ? ` ${text.replace(/\r\n|\r|\n/g, " ")}` : ""}\n\n`;
}

/**
 * An in-stream error for a stream that already started: Anthropic's
 * `event: error` frame, or an OpenAI-shaped `data: {"error": ...}` frame.
 */
export function encodeSseError(error: GatewayError, protocol: GatewayWireProtocol): string {
  return protocol === "anthropic"
    ? encodeSseEvent({ event: "error", data: JSON.stringify(toAnthropicErrorBody(error)) })
    : encodeSseEvent({ data: JSON.stringify(toOpenAIErrorBody(error)) });
}

function parseData(data: string): unknown {
  if (data === OPENAI_STREAM_DONE) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The event carries the stream's final output count: OpenAI's usage chunk
 * (cumulative, sent once at the end), or Anthropic's `message_delta` usage
 * (`message_start` only carries a starting output count).
 */
function finalOutputReported(shape: GatewayUsageShape, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  if (shape === "openai-chat") return typeof usage?.completion_tokens === "number";
  return payload.type === "message_delta" && typeof usage?.output_tokens === "number";
}

/**
 * OpenAI's `stream_options.include_usage` chunk: `choices` is always empty and
 * `usage` is set. The gateway injects the option for metering, so a caller
 * that did not ask for it gets this event removed (callerOmittedStreamUsage).
 */
export function isOpenAIUsageOnlyChunk(event: SseEvent): boolean {
  const payload = parseData(event.data);
  return isRecord(payload) && Array.isArray(payload.choices) && payload.choices.length === 0 && isRecord(payload.usage);
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * End of the first complete event in `bytes` (the index after its blank
 * line), or -1. A lone CR at the very end may be the first half of CRLF, so it
 * waits for more input unless `final`.
 */
function eventEnd(bytes: Uint8Array, final: boolean): number {
  let lineEmpty = true;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== LF && byte !== CR) {
      lineEmpty = false;
      continue;
    }
    if (byte === CR) {
      if (index + 1 === bytes.length && !final) return -1;
      if (bytes[index + 1] === LF) index += 1;
    }
    if (lineEmpty) return index + 1;
    lineEmpty = true;
  }
  return -1;
}

/**
 * Pass an SSE byte stream through, dropping whole events `drop` selects. Kept
 * events leave as their original bytes, unchanged, as soon as their blank
 * line arrives; at most one partial event is held. Comments are kept.
 */
export function createSseEventFilter(drop: (event: SseEvent) => boolean): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder();
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    for (;;) {
      const end = eventEnd(pending, final);
      if (end === -1) return;
      const raw = pending.subarray(0, end);
      // The event is known complete here, so end() also takes a final lone CR.
      const parser = createSseParser();
      const events = [...parser.push(decoder.decode(raw)), ...parser.end()];
      if (!(events.length === 1 && drop(events[0]!))) controller.enqueue(raw.slice());
      pending = pending.slice(end);
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending);
      joined.set(chunk, pending.byteLength);
      pending = joined;
      emit(controller, false);
    },
    flush(controller) {
      emit(controller, true);
      if (pending.byteLength) controller.enqueue(pending);
    },
  });
}

export interface UsageCaptureResult extends StreamObservation {
  /** The upstream body ended (it was not stopped). */
  completed: boolean;
  /**
   * The protocol's own end marker was seen (OpenAI `data: [DONE]`, Anthropic
   * `message_stop`). A body that ended without it was cut short.
   */
  terminated: boolean;
}

export interface UsageCaptureStream {
  /** Pass-through stream: bytes leave exactly as they arrived. */
  stream: TransformStream<Uint8Array, Uint8Array>;
  accumulator: UsageAccumulator;
  /** Bytes forwarded so far; >0 means retrying this attempt is no longer safe. */
  readonly forwardedBytes: number;
  /** Resolves once: complete when the upstream body ends, incomplete on `stop()`. */
  readonly done: Promise<UsageCaptureResult>;
  /**
   * Resolve `done` as incomplete with the usage observed so far. The adapter
   * calls it on client abort or upstream error; a TransformStream gets no
   * flush in either case, so settlement must not wait for one.
   */
  stop(): void;
}

/**
 * Tee usage out of an upstream SSE body without buffering it. Pipe the
 * upstream body through `stream` and return the readable side to the caller.
 */
export function createUsageCaptureStream(shape: GatewayUsageShape): UsageCaptureStream {
  const accumulator = createUsageAccumulator(shape);
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let forwardedBytes = 0;
  let outputBytes = 0;
  let outputReported = false;
  let terminated = false;
  let settle!: (value: UsageCaptureResult) => void;
  const done = new Promise<UsageCaptureResult>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    settle({
      usage: accumulator.snapshot(),
      reported: accumulator.reported,
      outputReported,
      outputBytes,
      completed,
      terminated,
    });
  };
  const observe = (events: SseEvent[]) => {
    for (const event of events) {
      if (event.data === OPENAI_STREAM_DONE) {
        if (shape === "openai-chat") terminated = true;
        continue;
      }
      const payload = parseData(event.data);
      if (payload === undefined) continue;
      accumulator.observe(payload);
      outputBytes += streamContentBytes(shape, payload);
      if (finalOutputReported(shape, payload)) outputReported = true;
      if (shape === "anthropic-messages" && (payload as { type?: unknown }).type === "message_stop") terminated = true;
    }
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      forwardedBytes += chunk.byteLength;
      controller.enqueue(chunk);
      observe(parser.push(decoder.decode(chunk, { stream: true })));
    },
    flush() {
      // Lenient for metering only (the caller's bytes are untouched): an
      // upstream that closes without the final blank line still has its last
      // event, usually the one carrying usage, observed.
      observe(parser.push(`${decoder.decode()}\n\n`));
      parser.end();
      finish(true);
    },
  });
  return {
    stream,
    accumulator,
    get forwardedBytes() {
      return forwardedBytes;
    },
    done,
    stop: () => finish(false),
  };
}
