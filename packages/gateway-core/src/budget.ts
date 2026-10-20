/**
 * Pure reserve / settle / release arithmetic. Adapters own durability (one
 * conditional statement per budget, idempotent by request id); this module
 * owns the decisions so every store charges identically.
 *
 * Invariants for every limited budget: `spent + reserved <= limit` at admission;
 * at quiescence `reserved == sum(open holds)` and `spent == sum(settled costs)`.
 * A settlement may push `spent` past the limit (an upstream that ignored
 * `max_tokens`): refusing it would lose money and leave the hold open.
 */
import { GatewayError } from "./errors.js";
import {
  assertMicroCredits,
  findRate,
  lineCost,
  priceUsage,
  sumMicroCredits,
  type GatewayPrice,
  type MicroCredits,
  type PricedUsage,
} from "./pricing.js";
import { holdUnits, type GatewayRequest } from "./request.js";
import { emptyUsage, type Usage } from "./usage.js";

export type BudgetScope = "tenant" | "user" | "key";

export interface BudgetState {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  /** `null` is an explicitly unlimited budget; a missing row is never unlimited. */
  limitMicroCredits: MicroCredits | null;
  spentMicroCredits: MicroCredits;
  reservedMicroCredits: MicroCredits;
  /** Monotonic version for conditional updates. */
  version: number;
  /** Epoch ms when the period resets, if periodic. */
  resetAt?: number;
}

export interface BudgetHold {
  budgetId: string;
  microCredits: MicroCredits;
}

/**
 * Upper bound for a request's cost:
 * text = estimated input at the input rate + output ceiling at the output rate;
 * media = each requested unit at its rate.
 */
export function computeHold(request: GatewayRequest, price: GatewayPrice): MicroCredits {
  const lines: MicroCredits[] = [];
  for (const unit of holdUnits(request)) {
    const rate = findRate(price, unit);
    if (!rate)
      throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
        details: { modelCode: price.modelCode, unit, priceVersion: price.version },
      });
    let quantity: number;
    if (unit === "input_token") quantity = request.estimatedInputTokens;
    else if (unit === "output_token") {
      const ceiling = price.maxOutputTokens;
      const asked = request.maxOutputTokens;
      if (asked === undefined && ceiling === undefined)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          message: "max_tokens is required: the model publishes no output ceiling.",
          details: { param: "max_tokens" },
        });
      quantity = Math.min(asked ?? ceiling!, ceiling ?? asked!);
    } else quantity = request.requestedUnits[unit as keyof GatewayRequest["requestedUnits"]] ?? 0;
    lines.push(lineCost(quantity, rate));
  }
  return sumMicroCredits(lines);
}

export function remainingMicroCredits(budget: BudgetState): MicroCredits | null {
  if (budget.limitMicroCredits === null) return null;
  return Math.max(
    0,
    budget.limitMicroCredits - budget.spentMicroCredits - budget.reservedMicroCredits,
  );
}

/**
 * Reserve `hold` on every applicable budget, all or nothing. Each budget is a
 * cap, so each one is held for the full amount. Budgets are processed in id
 * order, the same order a SQL adapter must lock them in.
 */
export function planReserve(
  budgets: readonly BudgetState[],
  hold: MicroCredits,
): { budgets: BudgetState[]; holds: BudgetHold[] } {
  assertMicroCredits(hold, "hold");
  const ordered = [...budgets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const budget of ordered) {
    const remaining = remainingMicroCredits(budget);
    if (remaining !== null && hold > remaining)
      throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
        details: {
          budgetId: budget.id,
          scope: budget.scope,
          remainingMicroCredits: remaining,
          requiredMicroCredits: hold,
          ...(budget.resetAt !== undefined ? { resetAt: budget.resetAt } : {}),
        },
      });
  }
  return {
    budgets: ordered.map((budget) => ({
      ...budget,
      reservedMicroCredits: budget.reservedMicroCredits + hold,
      version: budget.version + 1,
    })),
    holds: ordered.map((budget) => ({ budgetId: budget.id, microCredits: hold })),
  };
}

/** Close one hold with the actual cost. The stored hold is released, never recomputed. */
export function planSettle(
  budget: BudgetState,
  hold: BudgetHold,
  cost: MicroCredits,
): { budget: BudgetState; overshootMicroCredits: MicroCredits } {
  assertMicroCredits(cost, "cost");
  if (hold.budgetId !== budget.id || hold.microCredits > budget.reservedMicroCredits)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "Settlement does not match an open hold on this budget.",
      details: { budgetId: budget.id },
    });
  const next: BudgetState = {
    ...budget,
    spentMicroCredits: budget.spentMicroCredits + cost,
    reservedMicroCredits: budget.reservedMicroCredits - hold.microCredits,
    version: budget.version + 1,
  };
  const overshoot =
    budget.limitMicroCredits === null
      ? 0
      : Math.max(0, next.spentMicroCredits + next.reservedMicroCredits - budget.limitMicroCredits);
  return { budget: next, overshootMicroCredits: overshoot };
}

/** Return a hold untouched: nothing was consumed. */
export function planRelease(budget: BudgetState, hold: BudgetHold): BudgetState {
  return planSettle(budget, hold, 0).budget;
}

/**
 * How a request ended.
 * - `completed`: the upstream finished normally.
 * - `partial`: the stream was cut after some output.
 * - `client_aborted`: the caller disconnected.
 * - `upstream_failed`: the upstream failed (before or after output).
 * - `gateway_failed`: the gateway failed before or while calling upstream.
 * - `expired`: the hold expired without a settlement (sweeper).
 */
export type GatewayOutcome =
  | "completed"
  | "partial"
  | "client_aborted"
  | "upstream_failed"
  | "gateway_failed"
  | "expired";

export interface Settlement {
  outcome: GatewayOutcome;
  usage: Usage;
  priced: PricedUsage;
  costMicroCredits: MicroCredits;
}

/**
 * Charge for an ended request.
 * - Media/AIGC: only a completed generation is charged; any failure is zero.
 * - Text: delivered output is charged even when the stream ends badly
 *   (observed usage, never the full hold); a request that produced nothing
 *   (gateway failure, expiry) is zero.
 */
export function settleRequest(input: {
  request: Pick<GatewayRequest, "protocol">;
  outcome: GatewayOutcome;
  usage: Usage;
  price: GatewayPrice;
}): Settlement {
  const chargeable =
    input.request.protocol === "media"
      ? input.outcome === "completed"
      : input.outcome !== "gateway_failed" && input.outcome !== "expired";
  const usage = chargeable ? input.usage : { ...emptyUsage(), source: input.usage.source };
  const priced = priceUsage(usage, input.price);
  return {
    outcome: input.outcome,
    usage,
    priced,
    costMicroCredits: priced.microCredits,
  };
}

export interface BudgetInvariantViolation {
  budgetId: string;
  rule: "non-negative" | "reserved-matches-holds" | "spent-matches-settled";
  expected?: MicroCredits;
  actual: MicroCredits;
}

/** Quiescent consistency check for one budget's counters against its hold rows. */
export function checkBudgetInvariants(
  budget: BudgetState,
  holds: ReadonlyArray<{ microCredits: MicroCredits; state: "open" | "settled" | "released"; settledMicroCredits?: MicroCredits }>,
): BudgetInvariantViolation[] {
  const violations: BudgetInvariantViolation[] = [];
  for (const actual of [budget.spentMicroCredits, budget.reservedMicroCredits])
    if (!Number.isSafeInteger(actual) || actual < 0)
      violations.push({ budgetId: budget.id, rule: "non-negative", actual });
  const open = sumMicroCredits(
    holds.filter((hold) => hold.state === "open").map((hold) => hold.microCredits),
  );
  if (open !== budget.reservedMicroCredits)
    violations.push({
      budgetId: budget.id,
      rule: "reserved-matches-holds",
      expected: open,
      actual: budget.reservedMicroCredits,
    });
  const settled = sumMicroCredits(
    holds
      .filter((hold) => hold.state === "settled")
      .map((hold) => hold.settledMicroCredits ?? 0),
  );
  if (settled !== budget.spentMicroCredits)
    violations.push({
      budgetId: budget.id,
      rule: "spent-matches-settled",
      expected: settled,
      actual: budget.spentMicroCredits,
    });
  return violations;
}
