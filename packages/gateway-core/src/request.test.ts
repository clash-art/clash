import { describe, expect, it } from "vitest";
import { activeModelParameterIds } from "@clash/shared-types/model-routing";

import { GatewayError } from "./errors.js";
import {
  callerOmittedStreamUsage,
  normalizeAnthropicMessagesRequest,
  normalizeMediaGenerationRequest,
  normalizeOpenAIChatRequest,
  prepareUpstreamBody,
} from "./request.js";

const rejection = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected a GatewayError");
};

describe("OpenAI chat normalization", () => {
  const body = {
    model: "gpt-x",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 50,
    max_completion_tokens: 20,
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
  };

  it("keeps the body intact and extracts routing facts", () => {
    const request = normalizeOpenAIChatRequest(structuredClone(body), { idempotencyKey: "  key-1 " });
    expect(request).toMatchObject({ protocol: "openai-chat", kind: "text", model: "gpt-x", stream: true });
    expect(request.body).toEqual(body);
    // max_completion_tokens supersedes the deprecated max_tokens.
    expect(request.maxOutputTokens).toBe(20);
    expect(request.idempotencyKey).toBe("key-1");
    expect(request.bodyBytes).toBe(new TextEncoder().encode(JSON.stringify(body)).byteLength);
    expect(Number.isSafeInteger(request.estimatedInputTokens)).toBe(true);
    expect(request.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("rejects an invalid body with a coded error naming the field", () => {
    const error = rejection(() => normalizeOpenAIChatRequest({ model: "gpt-x", messages: [] }));
    expect(error.code).toBe("GATEWAY_INVALID_REQUEST");
    expect(error.details?.param).toBe("messages");
    expect(rejection(() => normalizeOpenAIChatRequest("nope")).code).toBe("GATEWAY_INVALID_REQUEST");
  });

  it("rejects a body that cannot be serialized with a coded error", () => {
    const error = rejection(() =>
      normalizeOpenAIChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], n: 1n }),
    );
    expect(error.code).toBe("GATEWAY_INVALID_REQUEST");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("rejects an oversized body", () => {
    expect(rejection(() => normalizeOpenAIChatRequest(body, { maxBodyBytes: 10 })).code).toBe(
      "GATEWAY_REQUEST_TOO_LARGE",
    );
  });

  it("asks a streaming upstream for usage without touching the caller's body", () => {
    const request = normalizeOpenAIChatRequest({ ...body, stream_options: { other: 1 } });
    const upstream = prepareUpstreamBody(request, "upstream-model");
    expect(upstream).toMatchObject({ model: "upstream-model", stream_options: { other: 1, include_usage: true } });
    expect(request.body.model).toBe("gpt-x");
    expect(request.body.stream_options).toEqual({ other: 1 });
    expect(callerOmittedStreamUsage(request)).toBe(true);
    const nonStream = normalizeOpenAIChatRequest({ ...body, stream: false });
    expect(prepareUpstreamBody(nonStream, "m")).not.toHaveProperty("stream_options");
  });
});

describe("Anthropic messages normalization", () => {
  it("requires max_tokens, as the Messages API does", () => {
    const error = rejection(() =>
      normalizeAnthropicMessagesRequest({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("GATEWAY_INVALID_REQUEST");
    expect(error.details?.param).toBe("max_tokens");
  });

  it("passes system, tools and cache_control through", () => {
    const body = {
      model: "claude-x",
      max_tokens: 1024,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "t", input_schema: { type: "object" } }],
    };
    const request = normalizeAnthropicMessagesRequest(structuredClone(body));
    expect(request).toMatchObject({ protocol: "anthropic-messages", stream: false, maxOutputTokens: 1024 });
    expect(request.body).toEqual(body);
    expect(prepareUpstreamBody(request, "claude-upstream")).toEqual({ ...body, model: "claude-upstream" });
  });
});

describe("media normalization", () => {
  it("carries requested billable units and the shared resolver's active parameters", () => {
    const params = { aspect_ratio: "16:9", seed: null, style: "" };
    const request = normalizeMediaGenerationRequest({ model: "img", kind: "image", params, units: { image: 4 } });
    expect(request).toMatchObject({ protocol: "media", kind: "image", stream: false, requestedUnits: { image: 4 } });
    expect(request.requestedParameterIds).toEqual(activeModelParameterIds(params));
  });

  it("refuses text models, missing units and fractional units", () => {
    expect(
      rejection(() => normalizeMediaGenerationRequest({ model: "m", kind: "text", units: { request: 1 } })).code,
    ).toBe("GATEWAY_INVALID_REQUEST");
    const unitless = rejection(() => normalizeMediaGenerationRequest({ model: "m", kind: "image", units: { image: 0 } }));
    expect(unitless.code).toBe("GATEWAY_INVALID_REQUEST");
    expect(unitless.details?.param).toBe("units");
    expect(
      rejection(() => normalizeMediaGenerationRequest({ model: "m", kind: "video", units: { video_second: 2.5 } }))
        .code,
    ).toBe("GATEWAY_INVALID_REQUEST");
  });
});
