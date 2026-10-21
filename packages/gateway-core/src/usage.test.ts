import { describe, expect, it } from "vitest";

import {
  addUsage,
  createUsageAccumulator,
  emptyUsage,
  estimateTokensFromBytes,
  settledUsage,
  streamContentBytes,
  streamedUsage,
  type StreamObservation,
  type Usage,
} from "./usage.js";

const integers = (usage: Usage) =>
  [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens, ...Object.values(usage.units)].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );

describe("OpenAI chat usage", () => {
  it("splits cached prompt tokens out of prompt_tokens", () => {
    // OpenAI prompt-caching guide example: cached_tokens is a subset of prompt_tokens.
    const accumulator = createUsageAccumulator("openai-chat");
    accumulator.observe({
      object: "chat.completion",
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });
    const usage = accumulator.snapshot();
    expect(usage).toMatchObject({ inputTokens: 2006 - 1920, cachedInputTokens: 1920, outputTokens: 300 });
    expect(usage.inputTokens + usage.cachedInputTokens).toBe(2006);
    expect(accumulator.reported).toBe(true);
    expect(integers(usage)).toBe(true);
  });

  it("takes the final include_usage chunk of a stream", () => {
    const accumulator = createUsageAccumulator("openai-chat");
    accumulator.observe({ object: "chat.completion.chunk", choices: [{ delta: { content: "Hi" } }], usage: null });
    expect(accumulator.reported).toBe(false);
    accumulator.observe({
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
    });
    expect(accumulator.snapshot()).toMatchObject({ inputTokens: 9, outputTokens: 12, cachedInputTokens: 0 });
  });

  it("ignores counts that are not non-negative integers", () => {
    const accumulator = createUsageAccumulator("openai-chat");
    accumulator.observe({ usage: { prompt_tokens: 1.5, completion_tokens: -3 } });
    expect(accumulator.reported).toBe(false);
    expect(accumulator.snapshot()).toEqual(emptyUsage());
  });
});

describe("Anthropic messages usage", () => {
  it("reads message_start input and the cumulative message_delta output", () => {
    // Anthropic streaming docs example.
    const accumulator = createUsageAccumulator("anthropic-messages");
    accumulator.observe({
      type: "message_start",
      message: { type: "message", role: "assistant", content: [], usage: { input_tokens: 25, output_tokens: 1 } },
    });
    accumulator.observe({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    accumulator.observe({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } });
    expect(accumulator.snapshot()).toMatchObject({ inputTokens: 25, outputTokens: 15 });
  });

  it("keeps cache reads and writes disjoint from input tokens", () => {
    const accumulator = createUsageAccumulator("anthropic-messages");
    accumulator.observe({
      type: "message",
      usage: { input_tokens: 21, cache_creation_input_tokens: 188086, cache_read_input_tokens: 0, output_tokens: 393 },
    });
    expect(accumulator.snapshot()).toMatchObject({
      inputTokens: 21,
      cacheWriteTokens: 188086,
      cachedInputTokens: 0,
      outputTokens: 393,
    });
  });
});

describe("settled usage", () => {
  it("falls back to an estimate marked as such when the upstream reports nothing", () => {
    const accumulator = createUsageAccumulator("anthropic-messages");
    const usage = settledUsage(accumulator, { inputTokens: 40, outputBytes: 10 });
    expect(usage.source).toBe("estimated");
    expect(usage.inputTokens).toBe(40);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(integers(usage)).toBe(true);
  });

  it("prefers reported usage", () => {
    const accumulator = createUsageAccumulator("openai-chat");
    accumulator.observe({ usage: { prompt_tokens: 3, completion_tokens: 4 } });
    expect(settledUsage(accumulator, { inputTokens: 999 })).toEqual(accumulator.snapshot());
  });

  it("adds usage field by field and stays estimated once any part is", () => {
    const a: Usage = { ...emptyUsage(), inputTokens: 1, units: { image: 2 } };
    const b: Usage = { ...emptyUsage(), outputTokens: 5, units: { image: 1, video_second: 4 }, source: "estimated" };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 1,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: { image: 3, video_second: 4 },
      source: "estimated",
    });
  });
});

describe("streamed usage", () => {
  const observed = (overrides: Partial<StreamObservation> = {}): StreamObservation => ({
    usage: emptyUsage(),
    reported: false,
    outputReported: false,
    outputBytes: 0,
    ...overrides,
  });

  it("settles the upstream's final report unchanged", () => {
    const usage = { ...emptyUsage(), inputTokens: 11, outputTokens: 7 };
    expect(streamedUsage(observed({ usage, reported: true, outputReported: true, outputBytes: 9_999 }), { inputTokens: 1 })).toEqual(usage);
  });

  it("estimates a cut stream from delivered content, never below a reported start, never above the ceiling", () => {
    const bytes = 30;
    const unreported = streamedUsage(observed({ outputBytes: bytes }), { inputTokens: 5 });
    expect(unreported).toMatchObject({ inputTokens: 5, outputTokens: estimateTokensFromBytes(bytes), source: "estimated" });
    // Anthropic: message_start reported input, the stream was cut before message_delta.
    const started = { ...emptyUsage(), inputTokens: 25, outputTokens: 1 };
    expect(streamedUsage(observed({ usage: started, reported: true, outputBytes: bytes }), { inputTokens: 5 })).toMatchObject({
      inputTokens: 25,
      outputTokens: estimateTokensFromBytes(bytes),
      source: "estimated",
    });
    expect(streamedUsage(observed({ usage: started, reported: true }), { inputTokens: 5 }).outputTokens).toBe(1);
    expect(streamedUsage(observed({ outputBytes: 3_000 }), { inputTokens: 5, maxOutputTokens: 4 }).outputTokens).toBe(4);
    expect(integers(unreported)).toBe(true);
  });

  it("counts generated content only, in UTF-8 bytes", () => {
    const text = "hé ✓";
    expect(streamContentBytes("openai-chat", { choices: [{ delta: { content: text, reasoning_content: "r" } }] })).toBe(
      new TextEncoder().encode(`${text}r`).byteLength,
    );
    expect(streamContentBytes("openai-chat", { choices: [], usage: { prompt_tokens: 1 } })).toBe(0);
    expect(streamContentBytes("anthropic-messages", { type: "content_block_delta", delta: { type: "text_delta", text } })).toBe(
      new TextEncoder().encode(text).byteLength,
    );
    expect(streamContentBytes("anthropic-messages", { type: "message_start", message: { content: [] } })).toBe(0);
  });
});
