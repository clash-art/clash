import { describe, expect, it } from "vitest";

import { GatewayError, toAnthropicErrorBody, toOpenAIErrorBody } from "./errors.js";
import {
  OPENAI_STREAM_DONE,
  createSseParser,
  createUsageCaptureStream,
  encodeSseComment,
  encodeSseError,
  encodeSseEvent,
  type SseEvent,
} from "./sse.js";

const parseAll = (text: string, chunkSize = text.length) => {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize)
    events.push(...parser.push(text.slice(offset, offset + chunkSize)));
  events.push(...parser.end());
  return events;
};

describe("SSE parser (WHATWG event-stream rules)", () => {
  it("joins data lines and ignores comments (spec example)", () => {
    // The last-event-ID buffer persists across events until an `id` field changes it.
    expect(parseAll(": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n")).toEqual([
      { data: "first event", id: "1" },
      { data: "second event", id: "" },
      { data: " third event", id: "" },
    ]);
    expect(parseAll("data: YHOO\ndata: +2\ndata: 10\n\n")).toEqual([{ data: "YHOO\n+2\n10" }]);
  });

  it("accepts LF, CRLF and CR line endings and any chunking", () => {
    const lf = "event: message_start\ndata: {\"a\":1}\n\ndata: x\n\n";
    const expected = parseAll(lf);
    expect(expected).toEqual([{ event: "message_start", data: '{"a":1}' }, { data: "x" }]);
    for (const text of [lf, lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r")])
      for (const size of [1, 2, 3, 7, text.length]) expect(parseAll(text, size)).toEqual(expected);
  });

  it("discards an event that never got its blank line", () => {
    expect(parseAll("data: complete\n\ndata: cut")).toEqual([{ data: "complete" }]);
  });

  it("round-trips encoded events, comments and retry", () => {
    const events: SseEvent[] = [
      { event: "delta", data: "line one\nline two", id: "7", retry: 1500 },
      { data: OPENAI_STREAM_DONE, id: "8" },
    ];
    expect(parseAll(events.map(encodeSseEvent).join("") + encodeSseComment("keep-alive"))).toEqual(events);
    expect(parseAll(encodeSseComment())).toEqual([]);
  });

  it("frames errors in the caller's protocol", () => {
    const error = new GatewayError("GATEWAY_BUDGET_EXCEEDED");
    const [anthropic] = parseAll(encodeSseError(error, "anthropic"));
    expect(anthropic!.event).toBe("error");
    expect(JSON.parse(anthropic!.data)).toEqual(toAnthropicErrorBody(error));
    const [openai] = parseAll(encodeSseError(error, "openai"));
    expect(JSON.parse(openai!.data)).toEqual(toOpenAIErrorBody(error));
  });
});

const encoder = new TextEncoder();

async function pipe(text: string, shape: "openai-chat" | "anthropic-messages", chunkSize = 5) {
  const capture = createUsageCaptureStream(shape);
  const bytes = encoder.encode(text);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
  const forwarded = await new Response(source.pipeThrough(capture.stream)).arrayBuffer();
  return { capture, forwarded: new Uint8Array(forwarded), bytes, result: await capture.done };
}

// Anthropic Messages streaming docs example (abridged deltas).
const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "stop_reason": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}\n\n',
  'event: content_block_start\ndata: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n',
  "event: ping\ndata: {\"type\": \"ping\"}\n\n",
  'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}\n\n',
  'event: content_block_stop\ndata: {"type": "content_block_stop", "index": 0}\n\n',
  'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}\n\n',
  'event: message_stop\ndata: {"type": "message_stop"}\n\n',
].join("");

describe("usage capture stream", () => {
  it("forwards Anthropic bytes unchanged and captures usage", async () => {
    const { forwarded, bytes, result, capture } = await pipe(ANTHROPIC_STREAM, "anthropic-messages");
    expect(forwarded).toEqual(bytes);
    expect(capture.forwardedBytes).toBe(bytes.byteLength);
    expect(result).toMatchObject({ completed: true, reported: true, usage: { inputTokens: 25, outputTokens: 15 } });
  });

  it("captures the OpenAI include_usage chunk and survives [DONE] and split UTF-8", async () => {
    const text = [
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"héllo ✓"}}],"usage":null}\n\n',
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
      `data: ${OPENAI_STREAM_DONE}\n\n`,
    ].join("");
    const { forwarded, bytes, result } = await pipe(text, "openai-chat", 3);
    expect(forwarded).toEqual(bytes);
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  it("still meters an upstream that closes without the final blank line", async () => {
    const { result } = await pipe(ANTHROPIC_STREAM.replace(/\n\n$/, "").replace(/\n\nevent: message_stop[\s\S]*$/, ""), "anthropic-messages");
    expect(result.usage.outputTokens).toBe(15);
  });

  it("resolves incomplete with observed usage when stopped", async () => {
    const capture = createUsageCaptureStream("anthropic-messages");
    const writer = capture.stream.writable.getWriter();
    const reader = capture.stream.readable.getReader();
    const firstEvent = ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.indexOf("\n\n") + 2);
    void writer.write(encoder.encode(firstEvent));
    await reader.read();
    capture.stop();
    expect(await capture.done).toMatchObject({ completed: false, reported: true, usage: { inputTokens: 25 } });
  });
});
