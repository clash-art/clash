import { describe, expect, it } from "vitest";

import {
  GATEWAY_ERROR_CODES,
  GATEWAY_ERROR_TABLE,
  GatewayError,
  gatewayErrorResponseInit,
  isGatewayError,
  toAnthropicErrorBody,
  toGatewayError,
  toOpenAIErrorBody,
} from "./errors.js";

// Anthropic's documented HTTP status -> error.type table
// (https://docs.anthropic.com/en/api/errors).
const ANTHROPIC_DOCUMENTED: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  504: "timeout_error",
  529: "overloaded_error",
};

describe("gateway error table", () => {
  it("maps every code to a status and to OpenAI and Anthropic bodies", () => {
    expect(GATEWAY_ERROR_CODES.length).toBe(Object.keys(GATEWAY_ERROR_TABLE).length);
    for (const code of GATEWAY_ERROR_CODES) {
      const entry = GATEWAY_ERROR_TABLE[code];
      expect(entry, code).toBeDefined();
      expect(Number.isInteger(entry.status) && entry.status >= 400 && entry.status < 600, code).toBe(
        true,
      );
      const error = new GatewayError(code);
      expect(error.status).toBe(entry.status);
      expect(error.message).toMatch(/\S/);

      // OpenAI error object: { error: { message, type, param, code } }.
      const openai = toOpenAIErrorBody(error);
      expect(Object.keys(openai.error).sort()).toEqual(["code", "message", "param", "type"]);
      expect(openai.error.code).toBe(code);
      expect(openai.error.type).toMatch(/\S/);
      expect(openai.error.param).toBeNull();

      // Anthropic error object: { type: "error", error: { type, message } }.
      const anthropic = toAnthropicErrorBody(error);
      expect(anthropic.type).toBe("error");
      expect(Object.keys(anthropic.error).sort()).toEqual(["message", "type"]);
      expect(anthropic.error.message).toContain(code);
      expect(Object.values(ANTHROPIC_DOCUMENTED)).toContain(anthropic.error.type);
      const documented = ANTHROPIC_DOCUMENTED[entry.status];
      if (documented) expect(anthropic.error.type, code).toBe(documented);
    }
  });

  it("names the codes the gateway design commits clients to", () => {
    // Codes named in the gateway design report's Host/runtime contract.
    expect(GATEWAY_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "GATEWAY_AUTH_REQUIRED",
        "GATEWAY_TOKEN_EXPIRED",
        "GATEWAY_MODEL_NOT_ALLOWED",
        "GATEWAY_BUDGET_EXCEEDED",
        "GATEWAY_KEY_UNAVAILABLE",
      ]),
    );
  });

  it("renders the wire response with the code header and Retry-After in seconds", () => {
    const error = new GatewayError("GATEWAY_RATE_LIMITED", { retryAfterMs: 1500 });
    const openai = gatewayErrorResponseInit(error, "openai");
    expect(openai.status).toBe(error.status);
    expect(openai.headers["x-clash-error-code"]).toBe("GATEWAY_RATE_LIMITED");
    // RFC 9110 Retry-After is delay-seconds.
    expect(openai.headers["retry-after"]).toBe("2");
    expect(openai.body).toEqual(toOpenAIErrorBody(error));
    expect(gatewayErrorResponseInit(error, "anthropic").body).toEqual(toAnthropicErrorBody(error));
    expect(gatewayErrorResponseInit(new GatewayError("GATEWAY_INTERNAL"), "openai").headers).not.toHaveProperty(
      "retry-after",
    );
  });

  it("carries a request parameter into the OpenAI body", () => {
    const error = new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: "messages" } });
    expect(toOpenAIErrorBody(error).error.param).toBe("messages");
  });

  it("coerces anything thrown into a coded error", () => {
    const coded = new GatewayError("GATEWAY_NO_ROUTE");
    expect(toGatewayError(coded)).toBe(coded);
    const unknown = toGatewayError(new TypeError("boom"));
    expect(unknown.code).toBe("GATEWAY_INTERNAL");
    expect(unknown.cause).toBeInstanceOf(TypeError);
    expect(toGatewayError("string").code).toBe("GATEWAY_INTERNAL");
    // An error from another copy of the package keeps its code.
    const foreign = Object.assign(new Error("other copy"), { name: "GatewayError", code: "GATEWAY_FORBIDDEN" });
    expect(isGatewayError(foreign)).toBe(true);
    expect(toGatewayError(foreign).code).toBe("GATEWAY_FORBIDDEN");
    expect(isGatewayError(Object.assign(new Error("x"), { name: "GatewayError", code: "NOPE" }))).toBe(false);
  });
});
