import { describe, expect, it } from "vitest";

import {
  GATEWAY_ABUSE_MAX_WINDOW_MINUTES,
  GATEWAY_ABUSE_SIGNALS,
  GatewayAbuseThresholdSchema,
  abuseWindowStart,
  decideGatewayAbuse,
  evaluateGatewayAbuse,
  gatewayClientFingerprint,
  isSuspendableSubject,
  type GatewayAbuseObservation,
  type GatewayAbuseThresholds,
} from "./abuse.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts } from "./testing/memory-ports.js";

const observe = (overrides: Partial<GatewayAbuseObservation> = {}): GatewayAbuseObservation => ({
  signal: "velocity",
  subjectKind: "key",
  subjectId: "gwk_a",
  tenantId: "team:a",
  value: 10,
  ...overrides,
});

describe("decideGatewayAbuse", () => {
  const threshold = { windowMinutes: 5, alertAt: 10, suspendAt: 20 };

  it("does nothing for a signal without a threshold", () => {
    for (const signal of GATEWAY_ABUSE_SIGNALS) expect(decideGatewayAbuse([observe({ signal, value: Number.MAX_SAFE_INTEGER })], {})).toEqual([]);
  });

  it("alerts at alertAt, suspends at suspendAt, and ignores values below alertAt", () => {
    const decisions = decideGatewayAbuse(
      [observe({ value: threshold.alertAt - 1 }), observe({ value: threshold.alertAt }), observe({ value: threshold.suspendAt })],
      { velocity: threshold },
    );
    expect(decisions.map((decision) => [decision.value, decision.action, decision.threshold])).toEqual([
      [threshold.alertAt, "alert", threshold.alertAt],
      [threshold.suspendAt, "suspend", threshold.suspendAt],
    ]);
    expect(decisions.every((decision) => decision.windowMinutes === threshold.windowMinutes)).toBe(true);
  });

  it("only alerts when suspendAt is null", () => {
    const [decision] = decideGatewayAbuse([observe({ value: Number.MAX_SAFE_INTEGER })], { velocity: { ...threshold, suspendAt: null } });
    expect(decision?.action).toBe("alert");
  });

  it("never suspends a client fingerprint, only alerts on it", () => {
    const [decision] = decideGatewayAbuse(
      [observe({ signal: "auth_failures", subjectKind: "client", subjectId: "fp", tenantId: null, value: threshold.suspendAt })],
      { auth_failures: threshold },
    );
    expect(decision).toMatchObject({ action: "alert", threshold: threshold.alertAt });
    expect(isSuspendableSubject("client")).toBe(false);
    expect(isSuspendableSubject("tenant") && isSuspendableSubject("key")).toBe(true);
  });
});

describe("GatewayAbuseThresholdSchema", () => {
  it("accepts a window, alert value and optional suspend value", () => {
    expect(GatewayAbuseThresholdSchema.parse({ windowMinutes: 1, alertAt: 1, suspendAt: null })).toEqual({ windowMinutes: 1, alertAt: 1, suspendAt: null });
  });

  it("refuses unknown fields, non-positive values, suspendAt below alertAt and windows past the maximum", () => {
    for (const bad of [
      { windowMinutes: 1, alertAt: 1, suspendAt: null, extra: 1 },
      { windowMinutes: 1, alertAt: 0, suspendAt: null },
      { windowMinutes: 0, alertAt: 1, suspendAt: null },
      { windowMinutes: 1, alertAt: 5, suspendAt: 4 },
      { windowMinutes: 1, alertAt: 1.5, suspendAt: null },
      { windowMinutes: 1, alertAt: 1 },
    ])
      expect(GatewayAbuseThresholdSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const max = GatewayAbuseThresholdSchema.safeParse({ windowMinutes: Number.MAX_SAFE_INTEGER, alertAt: 1, suspendAt: null });
    expect(max.success).toBe(false);
  });
});

describe("abuseWindowStart", () => {
  it("floors to the window, so every instant of one window shares it", () => {
    const width = 7 * 60_000;
    const start = abuseWindowStart(1_000_000_000_000, 7);
    expect(start % width).toBe(0);
    expect(abuseWindowStart(start + width - 1, 7)).toBe(start);
    expect(abuseWindowStart(start + width, 7)).toBe(start + width);
  });
});

describe("gatewayClientFingerprint", () => {
  it("is a stable short hash per client that differs between clients", async () => {
    const a = await gatewayClientFingerprint({ address: "203.0.113.7", userAgent: "agent/1" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await gatewayClientFingerprint({ address: "203.0.113.7", userAgent: "agent/1" })).toBe(a);
    expect(await gatewayClientFingerprint({ address: "203.0.113.8", userAgent: "agent/1" })).not.toBe(a);
    expect(await gatewayClientFingerprint({ address: "203.0.113.7", userAgent: "agent/2" })).not.toBe(a);
  });
});

describe("evaluateGatewayAbuse", () => {
  const memory = (thresholds: GatewayAbuseThresholds) =>
    createMemoryGatewayPorts({
      identities: {},
      catalog: catalogFixture().catalog,
      providers: { official: [], tenant: [] },
      keys: {},
      prices: [],
      budgets: [],
      startAt: 1_700_000_000_000,
      abuseThresholds: thresholds,
    });

  it("logs each alert once per window, and every suspension it makes", async () => {
    const gateway = memory({ velocity: { windowMinutes: 5, alertAt: 2, suspendAt: 3 } });
    const at = gateway.ports.clock.now();
    for (const [keyId, times] of [["gwk_alert", 2], ["gwk_suspend", 3]] as const)
      for (let index = 0; index < times; index += 1)
        await gateway.ports.abuse.observe({ kind: "request", tenantId: "team:a", keyId, fingerprint: "fp", at });
    expect(await evaluateGatewayAbuse(gateway.ports)).toEqual({ alerts: 2, suspended: 1, failed: 0, pruned: 0 });
    expect(gateway.logs.map((entry) => [entry.event, entry.fields?.subjectId])).toEqual([
      ["gateway.abuse_suspended", "gwk_suspend"],
      ["gateway.abuse_alert", "gwk_alert"],
    ]);
    expect(await evaluateGatewayAbuse(gateway.ports)).toMatchObject({ alerts: 0, suspended: 0 });
    expect(gateway.logs).toHaveLength(2);
  });

  it("counts a signal it cannot measure or a decision it cannot record as failed, and goes on", async () => {
    const gateway = memory({
      velocity: { windowMinutes: 1, alertAt: 1, suspendAt: null },
      spend: { windowMinutes: 1, alertAt: 1, suspendAt: null },
    });
    const at = gateway.ports.clock.now();
    await gateway.ports.abuse.observe({ kind: "request", tenantId: "team:a", keyId: "gwk_a", fingerprint: "fp", at });
    const measure = gateway.ports.abuse.measure;
    gateway.ports.abuse.measure = async (input) => {
      if (input.signal === "spend") throw new Error("ledger down");
      return measure(input);
    };
    gateway.ports.abuse.raise = async () => {
      throw new Error("d1 down");
    };
    expect(await evaluateGatewayAbuse(gateway.ports)).toEqual({ alerts: 0, suspended: 0, failed: 2, pruned: 0 });
    expect(gateway.logs.map((entry) => entry.event)).toEqual(["gateway.abuse_measure_failed", "gateway.abuse_raise_failed"]);
  });

  it("prunes observations past the longest window", async () => {
    const gateway = memory({});
    const old = gateway.ports.clock.now() - (GATEWAY_ABUSE_MAX_WINDOW_MINUTES + 1) * 60_000;
    await gateway.ports.abuse.observe({ kind: "auth_failure", fingerprint: "fp", at: old });
    expect(await evaluateGatewayAbuse(gateway.ports)).toMatchObject({ pruned: 1 });
  });
});
