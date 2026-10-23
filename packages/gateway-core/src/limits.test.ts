import { describe, expect, it } from "vitest";

import {
  GATEWAY_RATE_LIMIT_FIELDS,
  GatewayRateLimitSchema,
  StoredGatewayRateLimitSchema,
  requireAdmission,
  tightestRateLimit,
} from "./limits.js";
import { GatewayError, gatewayErrorResponseInit } from "./errors.js";

describe("rate limit schema", () => {
  it("accepts every configurable bound as a positive integer", () => {
    for (const field of GATEWAY_RATE_LIMIT_FIELDS) expect(GatewayRateLimitSchema.safeParse({ [field]: 2 }).success, field).toBe(true);
  });

  it("refuses an empty limit, an unknown field and a non-positive or fractional bound", () => {
    for (const value of [{}, { requestsPerMinut: 5 }, { concurrency: 0 }, { tokensPerMinute: -1 }, { mediaJobs: 1.5 }, { requestsPerMinute: "5" }])
      expect(GatewayRateLimitSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("reads stored limits leniently about unknown fields but never about a bound", () => {
    expect(StoredGatewayRateLimitSchema.parse({ concurrency: 2, future: true })).toMatchObject({ concurrency: 2 });
    expect(StoredGatewayRateLimitSchema.safeParse({ concurrency: 0 }).success).toBe(false);
  });

  it("merges limits counted in one subject to the tightest bound per field", () => {
    expect(tightestRateLimit([{ requestsPerMinute: 10, concurrency: 4 }, undefined, { requestsPerMinute: 5, mediaJobs: 2 }])).toEqual({
      requestsPerMinute: 5,
      concurrency: 4,
      mediaJobs: 2,
    });
    expect(tightestRateLimit([undefined, {}])).toBeUndefined();
  });
});

describe("limit denial", () => {
  it("is a coded 429 with Retry-After in whole seconds", () => {
    let caught: unknown;
    try {
      requireAdmission({ allowed: false, code: "GATEWAY_RATE_LIMITED", scope: "tenant", retryAfterMs: 1_200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const init = gatewayErrorResponseInit(caught as GatewayError, "openai");
    expect(init.status).toBe(429);
    expect(init.headers["x-clash-error-code"]).toBe("GATEWAY_RATE_LIMITED");
    expect(init.headers["retry-after"]).toBe("2");
    expect((caught as GatewayError).details).toEqual({ scope: "tenant" });
  });
});
