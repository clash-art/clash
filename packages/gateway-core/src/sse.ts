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
  type GatewayUsageShape,
  type Usage,
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

export interface UsageCaptureStream {
  /** Pass-through stream: bytes leave exactly as they arrived. */
  stream: TransformStream<Uint8Array, Uint8Array>;
  accumulator: UsageAccumulator;
  /** Bytes forwarded so far; >0 means retrying this attempt is no longer safe. */
  readonly forwardedBytes: number;
  /** Resolves once: complete when the upstream body ends, incomplete on `stop()`. */
  readonly done: Promise<{ usage: Usage; reported: boolean; completed: boolean }>;
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
  let settle!: (value: { usage: Usage; reported: boolean; completed: boolean }) => void;
  const done = new Promise<{ usage: Usage; reported: boolean; completed: boolean }>(
    (resolve) => {
      settle = resolve;
    },
  );
  let finished = false;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    settle({ usage: accumulator.snapshot(), reported: accumulator.reported, completed });
  };
  const observe = (events: SseEvent[]) => {
    for (const event of events) {
      const payload = parseData(event.data);
      if (payload !== undefined) accumulator.observe(payload);
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
