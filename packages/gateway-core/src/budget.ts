/**
 * Pure budget arithmetic for the hybrid settlement model (#399). Adapters own
 * durability (one conditional statement per budget, idempotent by request id
 * and ledger kind); this module owns the decisions so every store charges
 * identically.
 *
 * - Media/AIGC is prepaid: admission debits the exact price (planDebit), all
 *   budgets or none; a failure is refunded in full (planRefund) by a settle
 *   run; a success needs no further money write.
 * - Text/LLM is postpaid: admission only checks that every `hard` budget is
 *   above `-floor` (planCheck), nothing is written; after the request ends a
 *   settle run charges its actual cost (planCharge), which may take a balance
 *   negative, down to about the floor.
 *
 * Invariant for every budget at quiescence: `spent == sum(settle) -
 * sum(refund)` over its ledger rows (checkBudgetInvariants). `reserved` is
 * the legacy hold counter of the retired reserve/settle path: no new request
 * holds anything, and migration 0042 released what was still held, so it is
 * zero; it stays in every balance so a non-zero value is never spendable.
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
import { pricedUnits, type GatewayRequest } from "./request.js";
import { emptyUsage, type Usage } from "./usage.js";

export type BudgetScope = "tenant" | "user" | "key";

/**
 * What a budget's limit does when a request does not fit under it (#354):
 * - `hard`: the request is refused (GATEWAY_BUDGET_EXCEEDED, 402);
 * - `soft`: the request is admitted and flagged `soft_exceeded`;
 * - `alert`: the request is admitted; crossing the alert threshold (100% of
 *   the limit unless `alertThresholdPct` says otherwise) raises one
 *   `alert_threshold` notification per limit and threshold.
 * A tenant wallet is always hard: purchased credits are the hard ceiling.
 */
export const GATEWAY_BUDGET_ENFORCEMENTS = ["hard", "soft", "alert"] as const;
export type BudgetEnforcement = (typeof GATEWAY_BUDGET_ENFORCEMENTS)[number];

export interface BudgetState {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  /** `null` is an explicitly unlimited budget; a missing row is never unlimited. */
  limitMicroCredits: MicroCredits | null;
  /** Debits and charges less refunds; may exceed the limit after a postpaid charge. */
  spentMicroCredits: MicroCredits;
  /** Legacy holds of the retired reserve path; zero since migration 0042. */
  reservedMicroCredits: MicroCredits;
  /** Monotonic version for conditional updates. */
  version: number;
  /** Epoch ms when the period resets, if periodic. */
  resetAt?: number;
  /** Absent: `hard`. */
  enforcement?: BudgetEnforcement;
  /** Percent of the limit (1-100) at which an alert is raised, whatever the enforcement. */
  alertThresholdPct?: number;
}

export type BudgetFlagKind = "soft_exceeded" | "alert_threshold";

/**
 * A budget state a money write (or a text admission check) made visible
 * instead of refusing: never silent. Adapters record each one with the debit
 * or charge that raised it (`soft_exceeded` once per request and budget,
 * `alert_threshold` once per budget and `dedupeKey`), and the data plane
 * reports admission's flags on the answer (GATEWAY_BUDGET_HEADER).
 */
export interface BudgetFlag {
  budgetId: string;
  scope: BudgetScope;
  kind: BudgetFlagKind;
  enforcement: BudgetEnforcement;
  limitMicroCredits: MicroCredits;
  /** Spent plus reserved, this request's amount included. */
  usedMicroCredits: MicroCredits;
  /** For `alert_threshold`: the threshold crossed, percent of the limit. */
  thresholdPct?: number;
  /** `soft_exceeded`: the request id. `alert_threshold`: the limit and threshold, so one alert per configuration. */
  dedupeKey: string;
}

export const budgetEnforcement = (budget: Pick<BudgetState, "enforcement">): BudgetEnforcement => budget.enforcement ?? "hard";

/** The alert threshold in effect, percent of the limit; undefined when the budget raises no alerts. */
export function alertThresholdPct(budget: Pick<BudgetState, "enforcement" | "alertThresholdPct">): number | undefined {
  return budget.alertThresholdPct ?? (budgetEnforcement(budget) === "alert" ? 100 : undefined);
}

/** One alert per limit and threshold: a changed limit or threshold may alert again. */
export const budgetAlertKey = (limitMicroCredits: MicroCredits, thresholdPct: number) =>
  `limit=${limitMicroCredits};pct=${thresholdPct}`;

/**
 * The flags adding `amount` to `budget` (its state before the write) raises:
 * a soft budget pushed past its limit, and any budget at or past its alert
 * threshold. Alerts are candidates: an adapter reports one only the first
 * time it records its `dedupeKey`.
 */
export function budgetFlags(budget: BudgetState, amount: MicroCredits, requestId: string): BudgetFlag[] {
  const limit = budget.limitMicroCredits;
  if (limit === null) return [];
  const used = budget.spentMicroCredits + budget.reservedMicroCredits + amount;
  const enforcement = budgetEnforcement(budget);
  const base = { budgetId: budget.id, scope: budget.scope, enforcement, limitMicroCredits: limit, usedMicroCredits: used };
  const flags: BudgetFlag[] = [];
  if (enforcement === "soft" && used > limit) flags.push({ ...base, kind: "soft_exceeded", dedupeKey: requestId });
  const pct = alertThresholdPct(budget);
  if (pct !== undefined && used * 100 >= limit * pct)
    flags.push({ ...base, kind: "alert_threshold", thresholdPct: pct, dedupeKey: budgetAlertKey(limit, pct) });
  return flags;
}

/**
 * The exact price of a media/AIGC request, debited at admission (prepay):
 * each requested unit at its rate. Text is postpaid and never priced ahead.
 */
export function computeMediaDebit(request: GatewayRequest, price: GatewayPrice): MicroCredits {
  if (request.protocol !== "media")
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "Only a media/AIGC request is debited at admission.",
      details: { protocol: request.protocol },
    });
  const lines: MicroCredits[] = [];
  for (const unit of pricedUnits(request)) {
    const rate = findRate(price, unit);
    if (!rate)
      throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
        details: { modelCode: price.modelCode, unit, priceVersion: price.version },
      });
    lines.push(lineCost(request.requestedUnits[unit as keyof GatewayRequest["requestedUnits"]] ?? 0, rate));
  }
  return sumMicroCredits(lines);
}

/**
 * What is left of a limited budget, negative once postpaid usage ran past
 * its limit; `null` for an unlimited budget.
 */
export function budgetBalance(budget: BudgetState): MicroCredits | null {
  if (budget.limitMicroCredits === null) return null;
  return budget.limitMicroCredits - budget.spentMicroCredits - budget.reservedMicroCredits;
}

/** What is left of a limited budget, never below zero; `null` for an unlimited budget. */
export function remainingMicroCredits(budget: BudgetState): MicroCredits | null {
  const balance = budgetBalance(budget);
  return balance === null ? null : Math.max(0, balance);
}

const byId = (budgets: readonly BudgetState[]) =>
  [...budgets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function exceeded(budget: BudgetState, details: Record<string, unknown>): GatewayError {
  return new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
    details: {
      budgetId: budget.id,
      scope: budget.scope,
      remainingMicroCredits: remainingMicroCredits(budget) ?? 0,
      ...details,
      ...(budget.resetAt !== undefined ? { resetAt: budget.resetAt } : {}),
    },
  });
}

/**
 * Text/LLM admission (postpay): check only, nothing is written. Every `hard`
 * budget must be above `-floor` (`balance > -floor`). The request is charged
 * its actual cost after it ends, which may take the balance down to the
 * floor and, by that request's own cost, past it; concurrent exposure is
 * therefore the floor plus the in-flight requests' costs, which the
 * concurrency limit bounds. `soft` and `alert` budgets never refuse. The
 * flags are what is already true before the request runs: a soft budget past
 * its limit, any budget at or past its alert threshold (budgetFlags with
 * amount zero). The charge records a threshold its own cost crosses.
 */
export function planCheck(
  budgets: readonly BudgetState[],
  floorMicroCredits: MicroCredits,
  requestId = "",
): { flags: BudgetFlag[] } {
  assertMicroCredits(floorMicroCredits, "floor");
  const ordered = byId(budgets);
  for (const budget of ordered) {
    const balance = budgetBalance(budget);
    if (budgetEnforcement(budget) === "hard" && balance !== null && balance <= -floorMicroCredits)
      throw exceeded(budget, { balanceMicroCredits: balance, floorMicroCredits });
  }
  return { flags: ordered.flatMap((budget) => budgetFlags(budget, 0, requestId)) };
}

/**
 * Media/AIGC admission (prepay): debit `amount` from every budget, all or
 * nothing, in id order (the order a SQL adapter writes them in). Each budget
 * is a cap, so each one is debited the full amount. A `hard` budget refuses
 * an amount it does not cover; a prepaid request has no floor. `soft` and
 * `alert` budgets debit past their limit and raise flags.
 */
export function planDebit(
  budgets: readonly BudgetState[],
  amount: MicroCredits,
  requestId = "",
): { budgets: BudgetState[]; flags: BudgetFlag[] } {
  assertMicroCredits(amount, "debit");
  const ordered = byId(budgets);
  for (const budget of ordered) {
    const remaining = remainingMicroCredits(budget);
    if (budgetEnforcement(budget) === "hard" && remaining !== null && amount > remaining)
      throw exceeded(budget, { requiredMicroCredits: amount });
  }
  return {
    budgets: ordered.map((budget) => planCharge(budget, amount)),
    flags: ordered.flatMap((budget) => budgetFlags(budget, amount, requestId)),
  };
}

/**
 * A postpaid charge (and the debit's own write): `spent += amount`. Never
 * refused: the work was done, so refusing would only lose the money.
 */
export function planCharge(budget: BudgetState, amount: MicroCredits): BudgetState {
  assertMicroCredits(amount, "charge");
  return { ...budget, spentMicroCredits: budget.spentMicroCredits + amount, version: budget.version + 1 };
}

/** Return a media debit in full: `spent -= amount`, the amount the debit recorded. */
export function planRefund(budget: BudgetState, amount: MicroCredits): BudgetState {
  assertMicroCredits(amount, "refund");
  if (amount > budget.spentMicroCredits)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A refund exceeds what the budget spent.",
      details: { budgetId: budget.id },
    });
  return { ...budget, spentMicroCredits: budget.spentMicroCredits - amount, version: budget.version + 1 };
}

/**
 * How a request ended.
 * - `completed`: the upstream finished normally.
 * - `partial`: the stream was cut after some output.
 * - `client_aborted`: the caller disconnected.
 * - `upstream_failed`: the upstream failed (before or after output).
 * - `gateway_failed`: the gateway failed before or while calling upstream.
 * - `expired`: a legacy hold released without a settlement (migration 0042).
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
 * What an ended request owes.
 * - Media/AIGC: only a completed generation owes its price (already debited);
 *   any failure owes zero, so its debit is refunded.
 * - Text: delivered output is owed even when the stream ends badly (observed
 *   usage); a request that produced nothing (gateway failure) owes zero.
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
  rule: "non-negative" | "spent-matches-ledger";
  expected?: MicroCredits;
  actual: MicroCredits;
}

/**
 * Quiescent consistency check for one budget against its ledger rows: `spent`
 * is every `settle` amount (debits and charges) less every `refund`.
 */
export function checkBudgetInvariants(
  budget: BudgetState,
  rows: ReadonlyArray<{ kind: "settle" | "refund"; microCredits: MicroCredits }>,
): BudgetInvariantViolation[] {
  const violations: BudgetInvariantViolation[] = [];
  for (const actual of [budget.spentMicroCredits, budget.reservedMicroCredits])
    if (!Number.isSafeInteger(actual) || actual < 0)
      violations.push({ budgetId: budget.id, rule: "non-negative", actual });
  const expected =
    sumMicroCredits(rows.filter((row) => row.kind === "settle").map((row) => row.microCredits)) -
    sumMicroCredits(rows.filter((row) => row.kind === "refund").map((row) => row.microCredits));
  if (expected !== budget.spentMicroCredits)
    violations.push({ budgetId: budget.id, rule: "spent-matches-ledger", expected, actual: budget.spentMicroCredits });
  return violations;
}
