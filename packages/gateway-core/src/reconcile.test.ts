/**
 * Nightly reconciliation (#355) over an in-memory port: differences become
 * adjustments valued at the price book, re-runs post only what changed, a
 * missing report is never "matched", unpriced groups make the run
 * incomplete, and the window closes at day end / metadata retention.
 * Expected amounts are computed with priceUsage from the fixture price, never
 * restated.
 */
import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.js";
import { priceUsage, type GatewayPrice } from "./pricing.js";
import {
  emptyReconcileUsage,
  gatewayDayWindow,
  gatewayUtcDay,
  GATEWAY_DAY_MS,
  parseReconcileAdjustRequestId,
  reconcileGatewayUsage,
  reconcileGatewayUsageDay,
  type GatewayReconcileSource,
  type GatewayReconciliationPort,
  type LedgerUsageGroup,
  type PostedAdjustment,
  type ReconcileRun,
  type ReconcileUsage,
  type UpstreamUsageGroup,
} from "./reconcile.js";
import { GATEWAY_METADATA_RETENTION_MS } from "./retention.js";

const PRICE: GatewayPrice = {
  modelCode: "m",
  version: "price-1",
  rates: [
    { unit: "input_token", microCredits: 3_000_000, per: 1_000_000 },
    { unit: "output_token", microCredits: 15_000_000, per: 1_000_000 },
  ],
};

const usage = (overrides: Partial<ReconcileUsage>): ReconcileUsage => ({ ...emptyReconcileUsage(), ...overrides });
const value = (u: ReconcileUsage) =>
  priceUsage({ ...u, units: {}, source: "reported" }, PRICE).microCredits;

function memoryPort(options: { priced?: (modelCode: string) => boolean } = {}) {
  const state = {
    ledger: [] as LedgerUsageGroup[],
    reports: new Map<string, Array<{ source: GatewayReconcileSource; groups: UpstreamUsageGroup[] }>>(),
    posted: [] as Array<PostedAdjustment & { day: string }>,
    runs: [] as ReconcileRun[],
  };
  const port: GatewayReconciliationPort = {
    async ledgerUsage() {
      return state.ledger;
    },
    async upstreamUsage({ day }) {
      return state.reports.get(day) ?? [];
    },
    async price({ modelCode }) {
      if (options.priced && !options.priced(modelCode)) throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE");
      return { ...PRICE, modelCode };
    },
    async posted({ day }) {
      return state.posted.filter((entry) => entry.day === day);
    },
    async record(run) {
      state.runs.push(run);
      let posted = 0;
      for (const diff of run.diffs) {
        if (!diff.adjustRequestId) continue;
        const current = state.posted
          .filter((entry) => parseReconcileAdjustRequestId(entry.requestId)?.groupKey === diff.groupKey)
          .reduce((sum, entry) => sum + entry.signedMicroCredits, 0);
        if (current !== diff.postedMicroCredits || state.posted.some((entry) => entry.requestId === diff.adjustRequestId))
          continue;
        state.posted.push({ day: run.day, requestId: diff.adjustRequestId, signedMicroCredits: diff.adjustMicroCredits });
        posted += 1;
      }
      return { posted };
    },
    async pendingDays() {
      return [...state.reports.keys()].filter((day) => !state.runs.some((run) => run.day === day));
    },
  };
  return { port, state };
}

const silent = { info() {}, warn() {}, error() {} };
const group = { upstreamId: "openai", accountId: "gwu_a", modelCode: "m" };

function setup(now: number, options?: { priced?: (modelCode: string) => boolean }) {
  const { port, state } = memoryPort(options);
  let runs = 0;
  const ports = {
    reconciliation: port,
    ids: { requestId: () => `gwrec_${String((runs += 1)).padStart(24, "0")}` },
    clock: { now: () => now },
    logger: silent,
  };
  return { ports, state };
}

// Noon, two days after a fixed day: inside every window.
const DAY = "2026-10-20";
const NOW = gatewayDayWindow(DAY).to + GATEWAY_DAY_MS + 12 * 60 * 60 * 1000;

describe("reconcileGatewayUsageDay", () => {
  it("records a matched run and posts nothing when the upstream agrees with the ledger", async () => {
    const { ports, state } = setup(NOW);
    const counted = usage({ requests: 3, inputTokens: 100, outputTokens: 50 });
    state.ledger = [{ ...group, usage: counted, chargedMicroCredits: value(counted) }];
    state.reports.set(DAY, [{ source: "invoice", groups: [{ ...group, usage: counted }] }]);
    const run = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(run).toMatchObject({ status: "matched", source: "invoice", posted: 0 });
    expect(state.posted).toEqual([]);
  });

  it("values a difference at the price book and posts it once; a re-run posts nothing more", async () => {
    const { ports, state } = setup(NOW);
    const ledger = usage({ requests: 2, inputTokens: 100, outputTokens: 50 });
    const upstream = usage({ requests: 3, inputTokens: 180, outputTokens: 90 });
    state.ledger = [{ ...group, usage: ledger, chargedMicroCredits: value(ledger) }];
    state.reports.set(DAY, [{ source: "invoice", groups: [{ ...group, usage: upstream }] }]);
    const first = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(first.status).toBe("adjusted");
    expect(first.posted).toBe(1);
    expect(first.diffs[0]).toMatchObject({
      deltaMicroCredits: value(upstream) - value(ledger),
      adjustMicroCredits: value(upstream) - value(ledger),
      priceVersion: PRICE.version,
    });
    const again = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(again.posted).toBe(0);
    expect(again.diffs[0]).toMatchObject({ adjustMicroCredits: 0, postedMicroCredits: value(upstream) - value(ledger) });
    expect(state.posted.reduce((sum, entry) => sum + entry.signedMicroCredits, 0)).toBe(value(upstream) - value(ledger));
  });

  it("posts only the change after a corrected report, and reverses an earlier adjustment once the usage matches", async () => {
    const { ports, state } = setup(NOW);
    const ledger = usage({ requests: 1, inputTokens: 100 });
    state.ledger = [{ ...group, usage: ledger, chargedMicroCredits: value(ledger) }];
    state.reports.set(DAY, [{ source: "invoice", groups: [{ ...group, usage: usage({ requests: 1, inputTokens: 400 }) }] }]);
    await reconcileGatewayUsageDay(ports, { day: DAY });
    state.reports.set(DAY, [{ source: "invoice", groups: [{ ...group, usage: ledger }] }]);
    const corrected = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(corrected.posted).toBe(1);
    expect(state.posted.reduce((sum, entry) => sum + entry.signedMicroCredits, 0)).toBe(0);
    expect(new Set(state.posted.map((entry) => entry.requestId)).size).toBe(state.posted.length);
  });

  it("counts usage the ledger never recorded, and ledger usage the upstream never reported, with opposite signs", async () => {
    const { ports, state } = setup(NOW);
    const onlyLedger = { ...group, accountId: "gwu_ledger_only" };
    const onlyUpstream = { ...group, accountId: "gwu_upstream_only" };
    const counted = usage({ requests: 1, inputTokens: 10, outputTokens: 10 });
    state.ledger = [{ ...onlyLedger, usage: counted, chargedMicroCredits: value(counted) }];
    state.reports.set(DAY, [{ source: "ai_gateway", groups: [{ ...onlyUpstream, usage: counted }] }]);
    const run = await reconcileGatewayUsageDay(ports, { day: DAY });
    const byAccount = Object.fromEntries(run.diffs.map((diff) => [diff.accountId, diff.adjustMicroCredits]));
    expect(byAccount[onlyLedger.accountId]).toBe(-value(counted));
    expect(byAccount[onlyUpstream.accountId]).toBe(value(counted));
  });

  it("records a day without any upstream report as source_missing, never as matched", async () => {
    const { ports, state } = setup(NOW);
    const counted = usage({ requests: 1, inputTokens: 10 });
    state.ledger = [{ ...group, usage: counted, chargedMicroCredits: value(counted) }];
    const run = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(run).toMatchObject({ status: "source_missing", errorCode: "GATEWAY_RECONCILE_SOURCE_MISSING", posted: 0 });
    expect(state.runs.map((entry) => entry.status)).toEqual(["source_missing"]);
  });

  it("prefers the invoice when both sources were imported, and honours an explicit source", async () => {
    const { ports, state } = setup(NOW);
    state.reports.set(DAY, [
      { source: "ai_gateway", groups: [] },
      { source: "invoice", groups: [] },
    ]);
    expect((await reconcileGatewayUsageDay(ports, { day: DAY })).source).toBe("invoice");
    expect((await reconcileGatewayUsageDay(ports, { day: DAY, source: "ai_gateway" })).source).toBe("ai_gateway");
  });

  it("marks a group the price book cannot value and the run incomplete, posting nothing for it", async () => {
    const { ports, state } = setup(NOW, { priced: (modelCode) => modelCode !== "unpriced" });
    const unpriced = { ...group, modelCode: "unpriced" };
    state.reports.set(DAY, [{ source: "invoice", groups: [{ ...unpriced, usage: usage({ requests: 1, inputTokens: 5 }) }] }]);
    const run = await reconcileGatewayUsageDay(ports, { day: DAY });
    expect(run.status).toBe("incomplete");
    expect(run.diffs[0]).toMatchObject({ errorCode: "GATEWAY_PRICE_UNAVAILABLE", deltaMicroCredits: null, adjustMicroCredits: 0 });
    expect(state.posted).toEqual([]);
  });

  it("refuses a day that has not ended, or whose start is past the metadata retention", async () => {
    const today = gatewayUtcDay(NOW);
    await expect(reconcileGatewayUsageDay(setup(NOW).ports, { day: today })).rejects.toMatchObject({
      code: "GATEWAY_RECONCILE_WINDOW_CLOSED",
    });
    const tooOld = gatewayUtcDay(NOW - GATEWAY_METADATA_RETENTION_MS - GATEWAY_DAY_MS);
    await expect(reconcileGatewayUsageDay(setup(NOW).ports, { day: tooOld })).rejects.toMatchObject({
      code: "GATEWAY_RECONCILE_WINDOW_CLOSED",
    });
    await expect(reconcileGatewayUsageDay(setup(NOW).ports, { day: "2026-02-30" })).rejects.toMatchObject({
      code: "GATEWAY_INVALID_REQUEST",
    });
  });
});

describe("reconcileGatewayUsage (nightly)", () => {
  it("reconciles yesterday and every earlier day whose report arrived since, each on its own", async () => {
    const { ports, state } = setup(NOW);
    const late = gatewayUtcDay(NOW - 5 * GATEWAY_DAY_MS);
    state.reports.set(late, [{ source: "invoice", groups: [] }]);
    const result = await reconcileGatewayUsage(ports);
    expect(result.failed).toBe(0);
    expect(result.runs.map((run) => run.day).sort()).toEqual([late, gatewayUtcDay(NOW - GATEWAY_DAY_MS)].sort());
    expect(result.runs.find((run) => run.day === gatewayUtcDay(NOW - GATEWAY_DAY_MS))?.status).toBe("source_missing");
  });
});
