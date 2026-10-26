import { describe, expect, it } from "vitest";

import { circuitFailureInput, countsAgainstCircuit, gatewayCircuitState } from "./circuit.js";
import { nextGatewayAttempt, type GatewayRoutePlan, type UpstreamFailure } from "./routing.js";

describe("gatewayCircuitState", () => {
  it("is closed without an open-until, open before it and half-open from it on", () => {
    expect(gatewayCircuitState(undefined, 10)).toBe("closed");
    expect(gatewayCircuitState({ accountId: "a", consecutiveFailures: 1 }, 10)).toBe("closed");
    const opened = { accountId: "a", consecutiveFailures: 3, openUntil: 100 };
    expect(gatewayCircuitState(opened, 99)).toBe("open");
    expect(gatewayCircuitState(opened, 100)).toBe("half_open");
  });
});

describe("countsAgainstCircuit", () => {
  const plan = {
    modelCode: "m",
    scope: "official",
    catalogVersion: "c",
    attempts: [
      {
        index: 0,
        scope: "official",
        retryClass: "idempotent",
        route: { modelCode: "m", kind: "text", providerId: "official", upstreamId: "openai", upstreamModel: "m", priority: 1 },
      },
    ],
  } as unknown as GatewayRoutePlan;
  const failures: UpstreamFailure[] = [
    { state: "not-sent" },
    { state: "unknown" },
    { state: "streaming" },
    ...[400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504].map((status) => ({ state: "answered" as const, status })),
  ];

  it("counts exactly the failures failover retries before the first byte", () => {
    // A failure the account caused is one the router would try elsewhere; a caller's 4xx and a broken stream are not.
    for (const failure of failures) {
      const retried = nextGatewayAttempt(plan, plan.attempts[0]!, failure).error.code !== "GATEWAY_UPSTREAM_REJECTED"
        && failure.state !== "streaming";
      expect([failure, countsAgainstCircuit(failure)]).toEqual([failure, retried]);
    }
  });
});

describe("circuitFailureInput", () => {
  it("opens for the cooldown from now, with at least one failure to open", () => {
    const input = circuitFailureInput("a", "GATEWAY_UPSTREAM_ERROR", 1_000, { failureThreshold: 0, cooldownMs: 250 });
    expect(input).toEqual({ accountId: "a", code: "GATEWAY_UPSTREAM_ERROR", at: 1_000, threshold: 1, openUntil: 1_250 });
    expect(circuitFailureInput("a", "GATEWAY_UPSTREAM_ERROR", 1_000, { failureThreshold: 2.7, cooldownMs: -5 })).toMatchObject({
      threshold: 2,
      openUntil: 1_000,
    });
  });
});
