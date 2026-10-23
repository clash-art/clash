import { describe, expect, it } from "vitest";

import {
  alertThresholdPct,
  budgetAlertKey,
  budgetFlags,
  checkBudgetInvariants,
  computeHold,
  planRelease,
  planReserve,
  planSettle,
  settleRequest,
  type BudgetState,
  type GatewayOutcome,
} from "./budget.js";
import { GatewayError } from "./errors.js";
import { priceUsage, type GatewayPrice } from "./pricing.js";
import { normalizeMediaGenerationRequest, normalizeOpenAIChatRequest } from "./request.js";
import { emptyUsage } from "./usage.js";

const price: GatewayPrice = {
  modelCode: "m",
  version: "v1",
  maxOutputTokens: 4096,
  rates: [
    { unit: "input_token", microCredits: 3_000_000, per: 1_000_000 },
    { unit: "output_token", microCredits: 15_000_000, per: 1_000_000 },
    { unit: "image", microCredits: 40_000, per: 1 },
  ],
};

const budget = (id: string, limit: number | null, spent = 0, reserved = 0): BudgetState => ({
  id,
  scope: "user",
  scopeId: id,
  limitMicroCredits: limit,
  spentMicroCredits: spent,
  reservedMicroCredits: reserved,
  version: 0,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GatewayError ? error.code : "not-coded";
  }
  return "no-error";
};

const chat = (extra: Record<string, unknown> = {}) =>
  normalizeOpenAIChatRequest({ model: "m", messages: [{ role: "user", content: "hello there" }], ...extra });

describe("computeHold", () => {
  it("is the price of the worst case: the input estimate plus the output ceiling", () => {
    const request = chat({ max_tokens: 100 });
    expect(computeHold(request, price)).toBe(
      priceUsage({ ...emptyUsage(), inputTokens: request.estimatedInputTokens, outputTokens: 100 }, price).microCredits,
    );
    const unbounded = chat();
    expect(computeHold(unbounded, price)).toBe(
      priceUsage(
        { ...emptyUsage(), inputTokens: unbounded.estimatedInputTokens, outputTokens: price.maxOutputTokens! },
        price,
      ).microCredits,
    );
    // A request may not raise its ceiling above the model's.
    const greedy = chat({ max_tokens: 1_000_000 });
    expect(computeHold(greedy, price)).toBe(
      priceUsage(
        { ...emptyUsage(), inputTokens: greedy.estimatedInputTokens, outputTokens: price.maxOutputTokens! },
        price,
      ).microCredits,
    );
  });

  it("prices requested media units", () => {
    const request = normalizeMediaGenerationRequest({ model: "m", kind: "image", units: { image: 3 } });
    expect(computeHold(request, price)).toBe(priceUsage({ ...emptyUsage(), units: { image: 3 } }, price).microCredits);
  });

  it("refuses to guess an unbounded output", () => {
    expect(codeOf(() => computeHold(chat(), { ...price, maxOutputTokens: undefined }))).toBe(
      "GATEWAY_INVALID_REQUEST",
    );
    expect(codeOf(() => computeHold(chat({ max_tokens: 5 }), { ...price, rates: [] }))).toBe(
      "GATEWAY_PRICE_UNAVAILABLE",
    );
  });
});

describe("reserve / settle arithmetic", () => {
  it("reserves on every budget or none", () => {
    const budgets = [budget("b", 100, 60), budget("a", 1000), budget("c", null)];
    expect(codeOf(() => planReserve(budgets, 41))).toBe("GATEWAY_BUDGET_EXCEEDED");
    const reserved = planReserve(budgets, 40);
    expect(reserved.budgets.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    for (const entry of reserved.budgets) {
      const original = budgets.find((candidate) => candidate.id === entry.id)!;
      expect(entry.reservedMicroCredits).toBe(original.reservedMicroCredits + 40);
      expect(entry.spentMicroCredits).toBe(original.spentMicroCredits);
    }
    expect(budgets[0]!.reservedMicroCredits).toBe(0);
  });

  it("reports which budget refused, with what remains", () => {
    try {
      planReserve([budget("tight", 10, 4, 3)], 4);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).details).toMatchObject({ budgetId: "tight", remainingMicroCredits: 3 });
    }
  });

  it("refuses only on hard budgets; soft and alert budgets hold past their limit and raise flags", () => {
    const soft = { ...budget("soft", 10, 8), enforcement: "soft" as const };
    const alert = { ...budget("alert", 10, 8), enforcement: "alert" as const };
    expect(codeOf(() => planReserve([budget("hard", 10, 8)], 3))).toBe("GATEWAY_BUDGET_EXCEEDED");
    expect(codeOf(() => planReserve([soft, alert, budget("hard", 10, 8)], 3))).toBe("GATEWAY_BUDGET_EXCEEDED");
    const planned = planReserve([soft, alert], 3, "req-1");
    expect(planned.budgets.map((entry) => entry.reservedMicroCredits)).toEqual([3, 3]);
    expect(planned.flags.map(({ budgetId, kind }) => [budgetId, kind])).toEqual([
      ["alert", "alert_threshold"],
      ["soft", "soft_exceeded"],
    ]);
    expect(planned.flags.find((flag) => flag.kind === "soft_exceeded")).toMatchObject({ dedupeKey: "req-1", usedMicroCredits: 11 });
    // Within the limit: a soft budget raises nothing.
    expect(planReserve([soft], 2).flags).toEqual([]);
    // Unlimited budgets never flag.
    expect(planReserve([{ ...budget("open", null), enforcement: "soft" }], 99).flags).toEqual([]);
  });

  it("alerts at the configured threshold on any enforcement, once per limit and threshold", () => {
    const tracked = { ...budget("t", 100, 70), alertThresholdPct: 80 };
    expect(budgetFlags(tracked, 9, "r")).toEqual([]);
    const [flag] = budgetFlags(tracked, 10, "r");
    expect(flag).toMatchObject({ kind: "alert_threshold", enforcement: "hard", thresholdPct: 80, usedMicroCredits: 80 });
    expect(flag!.dedupeKey).toBe(budgetAlertKey(100, 80));
    expect(budgetFlags({ ...tracked, limitMicroCredits: 200 }, 100, "r")[0]!.dedupeKey).not.toBe(flag!.dedupeKey);
    // An alert budget without a threshold alerts at its limit.
    expect(alertThresholdPct({ enforcement: "alert" })).toBe(100);
    expect(alertThresholdPct({ enforcement: "hard" })).toBeUndefined();
  });

  it("settles the stored hold, charges actual cost and reports overshoot", () => {
    const [held] = planReserve([budget("a", 100)], 50).budgets;
    const settled = planSettle(held!, { budgetId: "a", microCredits: 50 }, 20);
    expect(settled.budget).toMatchObject({ spentMicroCredits: 20, reservedMicroCredits: 0 });
    expect(settled.overshootMicroCredits).toBe(0);
    const over = planSettle(held!, { budgetId: "a", microCredits: 50 }, 130);
    expect(over.budget.spentMicroCredits).toBe(130);
    expect(over.overshootMicroCredits).toBe(30);
    expect(planRelease(held!, { budgetId: "a", microCredits: 50 })).toMatchObject({
      spentMicroCredits: 0,
      reservedMicroCredits: 0,
    });
    expect(codeOf(() => planSettle(held!, { budgetId: "other", microCredits: 50 }, 1))).toBe("GATEWAY_INTERNAL");
    expect(codeOf(() => planSettle(held!, { budgetId: "a", microCredits: 50 }, 0.5))).toBe("GATEWAY_INTERNAL");
  });

  it("keeps integer counters and the invariants through a long reserve/settle sequence", () => {
    let state = budget("a", 5_000_000);
    const holds: Array<{ microCredits: number; state: "open" | "settled" | "released"; settledMicroCredits?: number }> = [];
    let seed = 42;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let step = 0; step < 500; step += 1) {
      const open = holds.filter((hold) => hold.state === "open");
      if (open.length && next(2) === 0) {
        const hold = open[next(open.length)]!;
        const cost = next(hold.microCredits + 1);
        state = planSettle(state, { budgetId: "a", microCredits: hold.microCredits }, cost).budget;
        hold.state = "settled";
        hold.settledMicroCredits = cost;
      } else {
        const amount = next(20_000) + 1;
        try {
          state = planReserve([state], amount).budgets[0]!;
          holds.push({ microCredits: amount, state: "open" });
        } catch (error) {
          expect((error as GatewayError).code).toBe("GATEWAY_BUDGET_EXCEEDED");
        }
      }
      expect(state.spentMicroCredits + state.reservedMicroCredits).toBeLessThanOrEqual(state.limitMicroCredits!);
      expect(checkBudgetInvariants(state, holds)).toEqual([]);
    }
  });

  it("detects counters that drifted from their holds", () => {
    const violations = checkBudgetInvariants(budget("a", 100, 10, 5), [
      { microCredits: 7, state: "open" },
      { microCredits: 9, state: "settled", settledMicroCredits: 10 },
    ]);
    expect(violations.map((violation) => violation.rule)).toEqual(["reserved-matches-holds"]);
  });
});

describe("settleRequest", () => {
  const usage = { ...emptyUsage(), inputTokens: 100, outputTokens: 40, units: { image: 2 } };
  const media = normalizeMediaGenerationRequest({ model: "m", kind: "image", units: { image: 2 } });
  const text = chat({ max_tokens: 64 });
  const failures: GatewayOutcome[] = ["partial", "client_aborted", "upstream_failed", "gateway_failed", "expired"];

  it("charges a media generation only when it completed", () => {
    for (const outcome of failures)
      expect(settleRequest({ request: media, outcome, usage, price }).costMicroCredits, outcome).toBe(0);
    expect(settleRequest({ request: media, outcome: "completed", usage, price }).costMicroCredits).toBe(
      priceUsage(usage, price).microCredits,
    );
  });

  it("charges delivered text output, and nothing when nothing was produced", () => {
    const textUsage = { ...emptyUsage(), inputTokens: 100, outputTokens: 40 };
    for (const outcome of ["completed", "partial", "client_aborted", "upstream_failed"] as const)
      expect(settleRequest({ request: text, outcome, usage: textUsage, price }).costMicroCredits, outcome).toBe(
        priceUsage(textUsage, price).microCredits,
      );
    for (const outcome of ["gateway_failed", "expired"] as const)
      expect(settleRequest({ request: text, outcome, usage: textUsage, price }).costMicroCredits, outcome).toBe(0);
  });
});
