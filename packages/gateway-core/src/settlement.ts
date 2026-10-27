/**
 * Settlement follow-ups (#399): the money writes that happen after a request
 * ends, delivered as dedicated durable settle runs (N2).
 *
 * - Text/LLM postpay: a request that owes something dispatches one `charge`
 *   intent carrying its actual cost; the run writes the ledger `settle` rows.
 *   A request that owes nothing (a gateway failure, no output) writes nothing.
 * - Media/AIGC prepay: a success needs nothing (the debit at admission was
 *   exact); a failure dispatches one `refund` intent whose run returns the
 *   debit in full.
 *
 * Delivery is the adapter's GatewaySettlementPort: journal first, scheduler
 * second, recovery re-dispatching only journaled intents. A run applies its
 * intent with `applyGatewaySettlement`, idempotent through the ledger's
 * unique `(request_id, budget_id, kind)`: a duplicate Workflow step, a
 * replayed recovery or a second dispatch moves no money. A crash before the
 * intent is journaled loses the follow-up: the accepted edge (a lost charge,
 * or a media overpayment until an operator refunds it).
 *
 * GatewaySettlementIntentSchema is the one schema of a frozen intent; an
 * adapter parses its journaled copy with it before applying.
 */
import { z } from "zod";

import { GatewayError } from "./errors.js";
import { MICRO_CREDITS_PER_CREDIT, assertMicroCredits, type MicroCredits } from "./pricing.js";
import type { GatewayIdentity, GatewayPorts, SettlementApplyResult, UsageEvent } from "./ports.js";
import { GatewayMediaUnitSchema, type GatewayModelKind } from "./request.js";

export const GATEWAY_SETTLEMENT_DEFAULTS = {
  /**
   * Text/LLM credit floor: a postpaid request is admitted while every hard
   * budget's balance is above `-floor`, so a wallet may run briefly negative
   * while in-flight usage settles. One credit unless the deployment says
   * otherwise (GatewayAppOptions.creditFloor, per platform or per caller).
   */
  creditFloorMicroCredits: MICRO_CREDITS_PER_CREDIT,
  /** An Idempotency-Key claim's lifetime when admission is given none (the data plane sets its own). */
  idempotencyTtlMs: 10 * 60 * 1000,
} as const;

/** A fixed floor, or one resolved per caller (a tenant-level override). */
export type GatewayCreditFloor =
  | MicroCredits
  | ((identity: GatewayIdentity) => MicroCredits | Promise<MicroCredits>);

/** The floor in effect for this caller; rejects with GATEWAY_INTERNAL when it is not whole micro-credits. */
export async function resolveCreditFloor(
  floor: GatewayCreditFloor | undefined,
  identity: GatewayIdentity,
): Promise<MicroCredits> {
  const resolved =
    typeof floor === "function" ? await floor(identity) : (floor ?? GATEWAY_SETTLEMENT_DEFAULTS.creditFloorMicroCredits);
  assertMicroCredits(resolved, "floor");
  return resolved;
}

const id = z.string().trim().min(1);
const count = z.number().int().nonnegative();
const failedStatus = z.enum(["partial", "client_aborted", "upstream_failed", "gateway_failed", "expired"]);

const GatewayUsageSchema = z
  .object({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count,
    cacheWriteTokens: count,
    units: z.partialRecord(GatewayMediaUnitSchema, count),
    source: z.enum(["reported", "estimated"]),
  })
  .strict();

const GatewayUsageEventSchema = z
  .object({
    requestId: id,
    tenantId: id,
    userId: id,
    keyId: id.optional(),
    modelCode: id,
    kind: id.transform((kind) => kind as GatewayModelKind),
    upstreamId: id,
    accountId: id.optional(),
    credentialScope: z.enum(["official", "tenant"]),
    usage: GatewayUsageSchema,
    costMicroCredits: count,
    priceVersion: id,
    catalogVersion: id,
    status: z.union([z.literal("settled"), failedStatus]),
    errorCode: id.optional(),
    occurredAt: count,
  })
  .strict() satisfies z.ZodType<UsageEvent, unknown>;

export const GatewaySettlementIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("charge"),
      /** The ledger event to write, actual cost included. */
      event: GatewayUsageEventSchema,
      /** Every budget the caller draws on, as authenticated at admission. */
      budgetIds: z.array(id).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refund"),
      requestId: id,
      tenantId: id,
      /** How the generation ended; recorded on the refund rows. */
      status: failedStatus,
      errorCode: id.optional(),
      occurredAt: count,
    })
    .strict(),
]);

export type GatewaySettlementIntent = z.infer<typeof GatewaySettlementIntentSchema>;
export type GatewaySettlementKind = GatewaySettlementIntent["kind"];

/** A journaled intent, parsed; anything else is GATEWAY_INTERNAL (a run never applies what it cannot read). */
export function parseGatewaySettlementIntent(value: unknown): GatewaySettlementIntent {
  const parsed = GatewaySettlementIntentSchema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A journaled settlement intent is not a valid intent.",
      details: { issues: parsed.error.issues.length },
    });
  return parsed.data;
}

/** The request a settlement intent belongs to. */
export function settlementRequestId(intent: GatewaySettlementIntent): string {
  return intent.kind === "charge" ? intent.event.requestId : intent.requestId;
}

/** When the request ended: the intent's frozen instant, so a re-dispatch derives the same run. */
export function settlementOccurredAt(intent: GatewaySettlementIntent): number {
  return intent.kind === "charge" ? intent.event.occurredAt : intent.occurredAt;
}

/**
 * The one run of an intent: a request owes at most one charge and at most one
 * refund, so (request id, kind) names it in every adapter's journal.
 */
export function gatewaySettlementRunKey(intent: GatewaySettlementIntent): { requestId: string; kind: GatewaySettlementKind } {
  return { requestId: settlementRequestId(intent), kind: intent.kind };
}

/**
 * Apply one intent: the provider step of a settle run. Idempotent by request
 * id and ledger kind, so any number of retries charges or refunds once.
 */
export function applyGatewaySettlement(
  ports: { budgets: Pick<GatewayPorts["budgets"], "charge" | "refund"> },
  intent: GatewaySettlementIntent,
): Promise<SettlementApplyResult> {
  if (intent.kind === "refund")
    return ports.budgets.refund({
      requestId: intent.requestId,
      tenantId: intent.tenantId,
      status: intent.status,
      occurredAt: intent.occurredAt,
      ...(intent.errorCode ? { errorCode: intent.errorCode } : {}),
    });
  return ports.budgets.charge({ ...intent.event, budgetIds: intent.budgetIds });
}
