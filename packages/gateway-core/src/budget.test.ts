import { describe, expect, it } from "vitest";

import {
  alertThresholdPct,
  budgetAlertKey,
  budgetBalance,
  budgetFlags,
  checkBudgetInvariants,
  computeMediaDebit,
  planCharge,
  planCheck,
  planDebit,
  planRefund,
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

describe("computeMediaDebit", () => {
  it("is the exact price of the requested media units", () => {
    const request = normalizeMediaGenerationRequest({ model: "m", kind: "image", units: { image: 3 } });
    expect(computeMediaDebit(request, price)).toBe(priceUsage({ ...emptyUsage(), units: { image: 3 } }, price).microCredits);
  });

  it("never prices text ahead, and refuses a unit without a rate", () => {
    expect(codeOf(() => computeMediaDebit(chat({ max_tokens: 5 }), price))).toBe("GATEWAY_INTERNAL");
    const request = normalizeMediaGenerationRequest({ model: "m", kind: "image", units: { image: 1 } });
    expect(codeOf(() => computeMediaDebit(request, { ...price, rates: [] }))).toBe("GATEWAY_PRICE_UNAVAILABLE");
  });
});

describe("planCheck (text postpay admission)", () => {
  it("admits while every hard budget is above -floor and writes nothing", () => {
    const budgets = [budget("a", 100, 100), budget("b", 100, 104), budget("open", null, 1_000)];
    expect(planCheck(budgets, 5)).toEqual({ flags: [] });
    expect(budgets.map(budgetBalance)).toEqual([0, -4, null]);
  });

  it("refuses at -floor, naming the budget, its balance and the floor", () => {
    try {
      planCheck([budget("a", 100), budget("low", 100, 105)], 5);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("GATEWAY_BUDGET_EXCEEDED");
      expect((error as GatewayError).details).toMatchObject({
        budgetId: "low",
        balanceMicroCredits: -5,
        floorMicroCredits: 5,
        remainingMicroCredits: 0,
      });
    }
    // A zero floor refuses an empty budget.
    expect(codeOf(() => planCheck([budget("a", 100, 100)], 0))).toBe("GATEWAY_BUDGET_EXCEEDED");
    // A legacy hold counts against the balance.
    expect(codeOf(() => planCheck([budget("a", 100, 90, 15)], 5))).toBe("GATEWAY_BUDGET_EXCEEDED");
  });

  it("never refuses on soft or alert budgets, and reports what is already true as flags", () => {
    const soft = { ...budget("soft", 10, 30), enforcement: "soft" as const };
    const alert = { ...budget("alert", 10, 30), enforcement: "alert" as const };
    const planned = planCheck([soft, alert], 0, "req-1");
    expect(planned.flags.map(({ budgetId, kind }) => [budgetId, kind])).toEqual([
      ["alert", "alert_threshold"],
      ["soft", "soft_exceeded"],
    ]);
    expect(planned.flags.find((flag) => flag.kind === "soft_exceeded")).toMatchObject({ dedupeKey: "req-1", usedMicroCredits: 30 });
  });

  it("rejects a floor that is not whole micro-credits", () => {
    expect(codeOf(() => planCheck([budget("a", 100)], -1))).toBe("GATEWAY_INTERNAL");
    expect(codeOf(() => planCheck([budget("a", 100)], 0.5))).toBe("GATEWAY_INTERNAL");
  });
});

describe("planDebit / planCharge / planRefund", () => {
  it("debits every budget or none, the full amount each, in id order", () => {
    const budgets = [budget("b", 100, 60), budget("a", 1000), budget("c", null)];
    expect(codeOf(() => planDebit(budgets, 41))).toBe("GATEWAY_BUDGET_EXCEEDED");
    const debited = planDebit(budgets, 40);
    expect(debited.budgets.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    for (const entry of debited.budgets) {
      const original = budgets.find((candidate) => candidate.id === entry.id)!;
      expect(entry.spentMicroCredits).toBe(original.spentMicroCredits + 40);
      expect(entry.reservedMicroCredits).toBe(original.reservedMicroCredits);
      expect(entry.version).toBe(original.version + 1);
    }
    expect(budgets[0]!.spentMicroCredits).toBe(60);
  });

  it("has no floor for a prepaid debit, and refuses only on hard budgets", () => {
    expect(codeOf(() => planDebit([budget("hard", 10, 8)], 3))).toBe("GATEWAY_BUDGET_EXCEEDED");
    const soft = { ...budget("soft", 10, 8), enforcement: "soft" as const };
    const alert = { ...budget("alert", 10, 8), enforcement: "alert" as const };
    expect(codeOf(() => planDebit([soft, alert, budget("hard", 10, 8)], 3))).toBe("GATEWAY_BUDGET_EXCEEDED");
    const planned = planDebit([soft, alert], 3, "req-1");
    expect(planned.budgets.map((entry) => entry.spentMicroCredits)).toEqual([11, 11]);
    expect(planned.flags.map(({ budgetId, kind }) => [budgetId, kind])).toEqual([
      ["alert", "alert_threshold"],
      ["soft", "soft_exceeded"],
    ]);
    expect(planDebit([soft], 2).flags).toEqual([]);
    expect(planDebit([{ ...budget("open", null), enforcement: "soft" }], 99).flags).toEqual([]);
  });

  it("charges past the limit without refusing, and refunds exactly what was recorded", () => {
    const charged = planCharge(budget("a", 100, 90), 30);
    expect(charged.spentMicroCredits).toBe(120);
    expect(budgetBalance(charged)).toBe(-20);
    expect(planRefund(charged, 30)).toMatchObject({ spentMicroCredits: 90, version: 2 });
    expect(codeOf(() => planRefund(budget("a", 100, 5), 6))).toBe("GATEWAY_INTERNAL");
    expect(codeOf(() => planCharge(budget("a", 100), 0.5))).toBe("GATEWAY_INTERNAL");
  });

  it("alerts at the configured threshold on any enforcement, once per limit and threshold", () => {
    const tracked = { ...budget("t", 100, 70), alertThresholdPct: 80 };
    expect(budgetFlags(tracked, 9, "r")).toEqual([]);
    const [flag] = budgetFlags(tracked, 10, "r");
    expect(flag).toMatchObject({ kind: "alert_threshold", enforcement: "hard", thresholdPct: 80, usedMicroCredits: 80 });
    expect(flag!.dedupeKey).toBe(budgetAlertKey(100, 80));
    expect(budgetFlags({ ...tracked, limitMicroCredits: 200 }, 100, "r")[0]!.dedupeKey).not.toBe(flag!.dedupeKey);
    expect(alertThresholdPct({ enforcement: "alert" })).toBe(100);
    expect(alertThresholdPct({ enforcement: "hard" })).toBeUndefined();
  });

  it("keeps integer counters and spent == settle - refund through a long debit/charge/refund sequence", () => {
    let state = budget("a", 5_000_000);
    const rows: Array<{ kind: "settle" | "refund"; microCredits: number }> = [];
    const debits: number[] = [];
    let seed = 42;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let step = 0; step < 500; step += 1) {
      const choice = next(3);
      const amount = next(20_000) + 1;
      if (choice === 0 && debits.length) {
        const refunded = debits.splice(next(debits.length), 1)[0]!;
        state = planRefund(state, refunded);
        rows.push({ kind: "refund", microCredits: refunded });
      } else if (choice === 1) {
        try {
          planCheck([state], 1_000_000);
          state = planCharge(state, amount);
          rows.push({ kind: "settle", microCredits: amount });
        } catch (error) {
          expect((error as GatewayError).code).toBe("GATEWAY_BUDGET_EXCEEDED");
        }
      } else {
        try {
          state = planDebit([state], amount).budgets[0]!;
          rows.push({ kind: "settle", microCredits: amount });
          debits.push(amount);
        } catch (error) {
          expect((error as GatewayError).code).toBe("GATEWAY_BUDGET_EXCEEDED");
        }
      }
      expect(Number.isSafeInteger(state.spentMicroCredits)).toBe(true);
      expect(checkBudgetInvariants(state, rows)).toEqual([]);
    }
  });

  it("detects a spent counter that drifted from its ledger rows", () => {
    const violations = checkBudgetInvariants(budget("a", 100, 10), [
      { kind: "settle", microCredits: 7 },
      { kind: "settle", microCredits: 9 },
      { kind: "refund", microCredits: 7 },
    ]);
    expect(violations).toEqual([{ budgetId: "a", rule: "spent-matches-ledger", expected: 9, actual: 10 }]);
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
