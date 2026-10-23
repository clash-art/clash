/**
 * Request admission and settlement over GatewayPorts: authenticate -> allowlist
 * -> catalog policy -> plan -> price -> hold -> limits -> reserve, then exactly
 * one settlement.
 * Adapters wrap these around the upstream call; HTTP shells live elsewhere.
 */
import {
  computeHold,
  settleRequest,
  type GatewayOutcome,
  type Settlement,
} from "./budget.js";
import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { requireAdmission } from "./limits.js";
import {
  ledgerStatus,
  type GatewayIdentity,
  type GatewayPorts,
  type Reservation,
  type SettleResult,
} from "./ports.js";
import { assertPriceCovers, type GatewayPrice, type MicroCredits } from "./pricing.js";
import { holdUnits, type GatewayRequest } from "./request.js";
import {
  planGatewayRoutes,
  type GatewayRouteAttempt,
  type GatewayRoutePlan,
  type PlanGatewayRoutesInput,
} from "./routing.js";
import { emptyUsage, type Usage } from "./usage.js";

export interface GatewayAdmission {
  requestId: string;
  identity: GatewayIdentity;
  request: GatewayRequest;
  plan: GatewayRoutePlan;
  /** Price of the first attempt; the hold is computed from it. */
  price: GatewayPrice;
  /** Epoch ms the request was priced at; failover attempts are priced at the same instant. */
  pricedAt: number;
  holdMicroCredits: MicroCredits;
  reservation: Reservation;
  leaseId: string;
  admittedAt: number;
}

export interface AdmitOptions {
  /** How long a hold may stay open before the sweeper expires it. */
  holdTtlMs: number;
  routing?: Pick<
    PlanGatewayRoutesInput,
    "isRouteExecutable" | "mayRetryAmbiguousSubmit" | "firstByteTimeoutMs" | "maxAttempts"
  >;
}

export function assertModelAllowed(identity: GatewayIdentity, model: string): void {
  if (identity.modelAllowlist && !identity.modelAllowlist.includes(model))
    throw new GatewayError("GATEWAY_MODEL_NOT_ALLOWED", { details: { model } });
}

/** Admit or reject with a coded error; on rejection nothing stays held or leased. */
export function admitGatewayRequest(
  ports: GatewayPorts,
  input: { httpRequest: Request; request: GatewayRequest },
  options: AdmitOptions,
): Promise<GatewayAdmission> {
  return admit(ports, input, options).catch((error: unknown) => {
    throw toGatewayError(error);
  });
}

async function admit(
  ports: GatewayPorts,
  input: { httpRequest: Request; request: GatewayRequest },
  options: AdmitOptions,
): Promise<GatewayAdmission> {
  const identity = await ports.identity.authenticate(input.httpRequest);
  const { request } = input;
  assertModelAllowed(identity, request.model);
  const { catalog } = applyGatewayCatalogPolicy(await ports.routes.catalog(identity));
  const providers = await ports.routes.providers(identity, identity.credentialScope);
  const plan = planGatewayRoutes({
    ...options.routing,
    modelCode: request.model,
    kind: request.kind,
    catalog,
    scope: identity.credentialScope,
    providers,
    requestedParameterIds: request.requestedParameterIds,
  });
  const pricedAt = ports.clock.now();
  const price = await ports.routes.price({
    identity,
    catalogVersion: catalog.version,
    route: plan.attempts[0]!.route,
    at: pricedAt,
  });
  assertPriceCovers(price, holdUnits(request));
  const holdMicroCredits = computeHold(request, price);
  const requestId = ports.ids.requestId();
  const leaseId = requireAdmission(
    await ports.limits.admit({
      tenantId: identity.tenantId,
      userId: identity.userId,
      ...(identity.keyId ? { keyId: identity.keyId } : {}),
      modelCode: plan.modelCode,
      estimatedTokens: request.estimatedInputTokens + (request.maxOutputTokens ?? 0),
      ...(request.protocol === "media" ? { media: true } : {}),
    }),
  );
  const admittedAt = ports.clock.now();
  try {
    const reservation = await ports.budgets.reserve({
      requestId,
      tenantId: identity.tenantId,
      budgetIds: identity.budgetIds,
      holdMicroCredits,
      expiresAt: admittedAt + options.holdTtlMs,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    });
    // Admitted past a soft limit, or across an alert threshold: recorded by
    // the budgets port, logged here, and reported on the answer.
    for (const flag of reservation.flags ?? [])
      ports.logger.warn(flag.kind === "soft_exceeded" ? "gateway.budget_soft_exceeded" : "gateway.budget_alert", {
        requestId,
        tenantId: identity.tenantId,
        budgetId: flag.budgetId,
        scope: flag.scope,
        enforcement: flag.enforcement,
        limitMicroCredits: flag.limitMicroCredits,
        usedMicroCredits: flag.usedMicroCredits,
        thresholdPct: flag.thresholdPct,
      });
    return {
      requestId,
      identity,
      request,
      plan,
      price,
      pricedAt,
      holdMicroCredits,
      reservation,
      leaseId,
      admittedAt,
    };
  } catch (error) {
    await ports.limits.release({ leaseId }).catch(() => undefined);
    throw error;
  }
}

export interface SettleGatewayInput {
  /** The attempt that produced the outcome (the last one tried). */
  attempt: GatewayRouteAttempt;
  outcome: GatewayOutcome;
  usage: Usage;
  /** Price of `attempt` when it differs from the admission price. */
  price?: GatewayPrice;
  error?: GatewayError;
}

/**
 * How an accepted media/AIGC generation ended. `units` are what the upstream
 * delivered (for example images produced), priced from the price book.
 */
export type MediaGenerationResult =
  | { status: "succeeded"; units: Usage["units"] }
  | { status: "failed"; error: GatewayError };

/**
 * Settle a media/AIGC generation after the upstream accepted it (the hook a
 * media route calls when its job ends). Only a success is charged; a failure
 * after acceptance settles `upstream_failed` at cost zero, whatever units were
 * requested or partly produced, and records the failure's code.
 */
export function settleMediaGeneration(
  ports: GatewayPorts,
  admission: GatewayAdmission,
  input: { attempt: GatewayRouteAttempt; result: MediaGenerationResult; price?: GatewayPrice },
): Promise<{ settlement: Settlement; result: SettleResult }> {
  if (admission.request.protocol !== "media")
    return Promise.reject(
      new GatewayError("GATEWAY_INTERNAL", {
        message: "settleMediaGeneration settles media requests only.",
        details: { protocol: admission.request.protocol },
      }),
    );
  const { result } = input;
  return settleGatewayRequest(ports, admission, {
    attempt: input.attempt,
    ...(input.price ? { price: input.price } : {}),
    ...(result.status === "succeeded"
      ? { outcome: "completed" as const, usage: { ...emptyUsage(), units: result.units } }
      : { outcome: "upstream_failed" as const, usage: emptyUsage(), error: result.error }),
  });
}

/** Settle exactly once and end the concurrency lease, whatever happens. */
export async function settleGatewayRequest(
  ports: GatewayPorts,
  admission: GatewayAdmission,
  input: SettleGatewayInput,
): Promise<{ settlement: Settlement; result: SettleResult }> {
  try {
    const settlement = settleRequest({
      request: admission.request,
      outcome: input.outcome,
      usage: input.usage,
      price: input.price ?? admission.price,
    });
    const { identity } = admission;
    const result = await ports.budgets.settle({
      requestId: admission.requestId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      ...(identity.keyId ? { keyId: identity.keyId } : {}),
      modelCode: admission.plan.modelCode,
      kind: input.attempt.route.kind,
      upstreamId: input.attempt.route.upstreamId,
      ...(input.attempt.route.accountId ? { accountId: input.attempt.route.accountId } : {}),
      credentialScope: input.attempt.scope,
      usage: settlement.usage,
      costMicroCredits: settlement.costMicroCredits,
      priceVersion: settlement.priced.priceVersion,
      catalogVersion: admission.plan.catalogVersion,
      status: ledgerStatus(input.outcome),
      ...(input.error ? { errorCode: input.error.code } : {}),
      occurredAt: ports.clock.now(),
    });
    return { settlement, result };
  } catch (error) {
    throw toGatewayError(error);
  } finally {
    await ports.limits.release({ leaseId: admission.leaseId }).catch(() => undefined);
  }
}
