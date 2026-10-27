/**
 * Request admission and settlement over GatewayPorts: authenticate -> catalog
 * policy -> (protocol model mapping) -> allowlist -> plan -> price -> limits
 * -> money (#399), then at most one follow-up.
 *
 * Money at admission: a media/AIGC request is prepaid (one atomic debit of
 * its exact price); a text request is postpaid (a read-only check that every
 * hard budget is above the credit floor). Follow-up when the request ends
 * (settleGatewayRequest): a text request that owes something dispatches a
 * `charge` settle run for its actual cost; a failed media request dispatches
 * a `refund` settle run; a media success needs nothing (settlement.ts).
 * Adapters wrap these around the upstream call; HTTP shells live elsewhere.
 */
import { computeMediaDebit, settleRequest, type BudgetFlag, type GatewayOutcome, type Settlement } from "./budget.js";
import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { requireAdmission, type GatewayRateLimitHeaders } from "./limits.js";
import {
  ledgerStatus,
  type BudgetAdmission,
  type GatewayIdentity,
  type GatewayPorts,
  type SettlementDispatch,
  type UsageEvent,
} from "./ports.js";
import { assertPriceCovers, type GatewayPrice, type MicroCredits } from "./pricing.js";
import { pricedUnits, type GatewayRequest } from "./request.js";
import {
  planGatewayRoutes,
  type GatewayCatalog,
  type GatewayCredentialScope,
  type GatewayRouteAttempt,
  type GatewayRoutePlan,
  type PlanGatewayRoutesInput,
} from "./routing.js";
import { GATEWAY_SETTLEMENT_DEFAULTS, resolveCreditFloor, type GatewayCreditFloor } from "./settlement.js";
import { emptyUsage, type Usage } from "./usage.js";

/** How the request pays: prepaid at admission (media) or postpaid after it ends (text). */
export type GatewayPayment =
  | { mode: "prepaid"; debitMicroCredits: MicroCredits }
  | { mode: "postpaid"; floorMicroCredits: MicroCredits };

export interface GatewayAdmission {
  requestId: string;
  identity: GatewayIdentity;
  request: GatewayRequest;
  plan: GatewayRoutePlan;
  /** Price of the first attempt; a media debit is computed from it. */
  price: GatewayPrice;
  /** Epoch ms the request was priced at; failover attempts are priced at the same instant. */
  pricedAt: number;
  payment: GatewayPayment;
  /** Budget flags admission raised; reported on the answer. */
  flags: BudgetFlag[];
  leaseId: string;
  /** OpenAI-style rate-limit state from admission; set on every answer. */
  limitHeaders?: GatewayRateLimitHeaders;
  admittedAt: number;
}

export interface AdmitOptions {
  /** Text/LLM credit floor (settlement.ts); GATEWAY_SETTLEMENT_DEFAULTS when absent. */
  creditFloor?: GatewayCreditFloor;
  /**
   * How long an Idempotency-Key's claim may stay open (ports.ts
   * IdempotencyClaim); it must outlive the request. GATEWAY_SETTLEMENT_DEFAULTS
   * when absent.
   */
  idempotencyTtlMs?: number;
  routing?: Pick<
    PlanGatewayRoutesInput,
    "isRouteExecutable" | "mayRetryAmbiguousSubmit" | "firstByteTimeoutMs" | "maxAttempts"
  >;
  /**
   * Maps the model id the caller sent onto a catalog public code (Anthropic
   * agents send Anthropic model ids). The admitted request carries the public
   * code, so the allowlist, limits, ledger and answers all see that code.
   */
  resolveModel?: (requested: string, catalog: GatewayCatalog) => string;
}

export function assertModelAllowed(identity: GatewayIdentity, model: string): void {
  if (identity.modelAllowlist && !identity.modelAllowlist.includes(model))
    throw new GatewayError("GATEWAY_MODEL_NOT_ALLOWED", { details: { model } });
}

/** The scopes an identity's requests may be served from, in priority order. */
export function credentialScopeOrder(identity: GatewayIdentity): GatewayCredentialScope[] {
  const order = identity.credentialPriority?.length ? identity.credentialPriority : [identity.credentialScope];
  return [...new Set(order)];
}

/**
 * Plan a request in the first scope of the caller's priority that has a
 * route (#369). The plan holds one scope only, so a failover never crosses
 * from BYOK to official (or back) after the budget was reserved for it; the
 * returned identity carries the resolved scope.
 */
export async function planForIdentity(
  ports: Pick<GatewayPorts, "routes">,
  identity: GatewayIdentity,
  input: Omit<PlanGatewayRoutesInput, "scope" | "providers">,
): Promise<{ plan: GatewayRoutePlan; identity: GatewayIdentity }> {
  let last: unknown;
  for (const scope of credentialScopeOrder(identity)) {
    const providers = await ports.routes.providers(identity, scope);
    try {
      const plan = planGatewayRoutes({ ...input, scope, providers });
      return { plan, identity: scope === identity.credentialScope ? identity : { ...identity, credentialScope: scope } };
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "GATEWAY_NO_ROUTE") throw error;
      last = error;
    }
  }
  throw last ?? new GatewayError("GATEWAY_NO_ROUTE", { details: { model: input.modelCode } });
}

/** Admit or reject with a coded error; on rejection nothing is debited or leased. */
export function admitGatewayRequest(
  ports: GatewayPorts,
  input: { httpRequest: Request; request: GatewayRequest },
  options: AdmitOptions = {},
): Promise<GatewayAdmission> {
  return admit(ports, input, options).catch((error: unknown) => {
    throw toGatewayError(error);
  });
}

/** The ledger event of a request priced on `attempt`. */
function usageEvent(
  ports: GatewayPorts,
  admission: Pick<GatewayAdmission, "requestId" | "identity" | "plan">,
  input: {
    attempt: GatewayRouteAttempt;
    usage: Usage;
    costMicroCredits: MicroCredits;
    priceVersion: string;
    status: UsageEvent["status"];
    errorCode?: string;
  },
): UsageEvent {
  const { identity } = admission;
  return {
    requestId: admission.requestId,
    tenantId: identity.tenantId,
    userId: identity.userId,
    ...(identity.keyId ? { keyId: identity.keyId } : {}),
    modelCode: admission.plan.modelCode,
    kind: input.attempt.route.kind,
    upstreamId: input.attempt.route.upstreamId,
    ...(input.attempt.route.accountId ? { accountId: input.attempt.route.accountId } : {}),
    credentialScope: input.attempt.scope,
    usage: input.usage,
    costMicroCredits: input.costMicroCredits,
    priceVersion: input.priceVersion,
    catalogVersion: admission.plan.catalogVersion,
    status: input.status,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    occurredAt: ports.clock.now(),
  };
}

async function admit(
  ports: GatewayPorts,
  input: { httpRequest: Request; request: GatewayRequest },
  options: AdmitOptions,
): Promise<GatewayAdmission> {
  const caller = await ports.identity.authenticate(input.httpRequest);
  const { catalog } = applyGatewayCatalogPolicy(await ports.routes.catalog(caller));
  const request = options.resolveModel
    ? { ...input.request, model: options.resolveModel(input.request.model, catalog) }
    : input.request;
  assertModelAllowed(caller, request.model);
  const { plan, identity } = await planForIdentity(ports, caller, {
    ...options.routing,
    modelCode: request.model,
    kind: request.kind,
    catalog,
    requestedParameterIds: request.requestedParameterIds,
  });
  const pricedAt = ports.clock.now();
  const price = await ports.routes.price({
    identity,
    catalogVersion: catalog.version,
    route: plan.attempts[0]!.route,
    at: pricedAt,
  });
  return payAdmission(
    ports,
    { requestId: ports.ids.requestId(), identity, request, plan, price, pricedAt },
    options,
  );
}

/** How a request pays (#399): media is prepaid its exact price, text is postpaid above the credit floor. */
export async function gatewayPayment(
  request: GatewayRequest,
  price: GatewayPrice,
  identity: GatewayIdentity,
  creditFloor?: GatewayCreditFloor,
): Promise<GatewayPayment> {
  assertPriceCovers(price, pricedUnits(request));
  return request.protocol === "media"
    ? { mode: "prepaid", debitMicroCredits: computeMediaDebit(request, price) }
    : { mode: "postpaid", floorMicroCredits: await resolveCreditFloor(creditFloor, identity) };
}

/**
 * The money half of admission, for a request already planned and priced: the
 * limits lease, then the media debit or the text floor check on every budget
 * under `requestId`. On refusal nothing is debited or leased. Media jobs
 * (media.ts) call it with the request id and price instant their job froze;
 * a repeated debit under that id is a no-op (charge-once).
 */
export async function payAdmission(
  ports: GatewayPorts,
  input: {
    requestId: string;
    identity: GatewayIdentity;
    request: GatewayRequest;
    plan: GatewayRoutePlan;
    price: GatewayPrice;
    pricedAt: number;
  },
  options: Pick<AdmitOptions, "creditFloor" | "idempotencyTtlMs"> = {},
): Promise<GatewayAdmission> {
  const { requestId, identity, request, plan, price, pricedAt } = input;
  // The budget learns the one scope the request is served from; a plan that
  // mixed scopes could reach an official key on a BYOK-exempt admission.
  const credentialScope = plan.attempts[0]?.scope ?? identity.credentialScope;
  if (plan.attempts.some((attempt) => attempt.scope !== credentialScope))
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A route plan mixes credential scopes.",
      details: { reason: "mixed_credential_scope" },
    });
  const payment = await gatewayPayment(request, price, identity, options.creditFloor);
  const limitDecision = await ports.limits.admit({
    tenantId: identity.tenantId,
    userId: identity.userId,
    ...(identity.keyId ? { keyId: identity.keyId } : {}),
    modelCode: plan.modelCode,
    estimatedTokens: request.estimatedInputTokens + (request.maxOutputTokens ?? 0),
    ...(request.protocol === "media" ? { media: true } : {}),
  });
  const leaseId = requireAdmission(limitDecision);
  const admittedAt = ports.clock.now();
  try {
    const idempotency = request.idempotencyKey
      ? {
          idempotency: {
            key: request.idempotencyKey,
            expiresAt: admittedAt + (options.idempotencyTtlMs ?? GATEWAY_SETTLEMENT_DEFAULTS.idempotencyTtlMs),
          },
        }
      : {};
    const money: BudgetAdmission =
      payment.mode === "prepaid"
        ? await ports.budgets.debit({
            ...usageEvent(ports, { requestId, identity, plan }, {
              attempt: plan.attempts[0]!,
              usage: { ...emptyUsage(), units: request.requestedUnits },
              costMicroCredits: payment.debitMicroCredits,
              priceVersion: price.version,
              status: "settled",
            }),
            budgetIds: identity.budgetIds,
            ...idempotency,
          })
        : await ports.budgets.check({
            requestId,
            tenantId: identity.tenantId,
            budgetIds: identity.budgetIds,
            credentialScope,
            floorMicroCredits: payment.floorMicroCredits,
            ...idempotency,
          });
    const flags = money.flags ?? [];
    // Admitted past a soft limit, or across an alert threshold: recorded by
    // the budgets port, logged here, and reported on the answer.
    for (const flag of flags)
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
      payment,
      flags,
      leaseId,
      ...(limitDecision.allowed && limitDecision.headers ? { limitHeaders: limitDecision.headers } : {}),
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

export interface GatewaySettleResult {
  settlement: Settlement;
  /** The follow-up settle run journaled for this request; null when none is owed. */
  dispatch: SettlementDispatch | null;
}

/**
 * How an accepted media/AIGC generation ended. `units` are what the upstream
 * delivered (for example images produced); the admission debit already paid
 * for what was requested.
 */
export type MediaGenerationResult =
  | { status: "succeeded"; units: Usage["units"] }
  | { status: "failed"; error: GatewayError };

/**
 * Settle a media/AIGC generation after the upstream accepted it (the hook a
 * media route calls when its job ends). A success needs no money write: the
 * debit was exact. A failure, whatever was requested or partly produced,
 * dispatches the full refund as `upstream_failed` with the failure's code.
 */
export function settleMediaGeneration(
  ports: GatewayPorts,
  admission: GatewayAdmission,
  input: { attempt: GatewayRouteAttempt; result: MediaGenerationResult; price?: GatewayPrice },
): Promise<GatewaySettleResult> {
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

/**
 * End a request once: dispatch the follow-up it owes (journaled before this
 * resolves), and end the concurrency lease whatever happens. Rejects with the
 * coded error when the follow-up could not be journaled; nothing else is
 * retried here, the settle run owns that.
 */
export async function settleGatewayRequest(
  ports: GatewayPorts,
  admission: GatewayAdmission,
  input: SettleGatewayInput,
): Promise<GatewaySettleResult> {
  try {
    const settlement = settleRequest({
      request: admission.request,
      outcome: input.outcome,
      usage: input.usage,
      price: input.price ?? admission.price,
    });
    const { identity } = admission;
    const status = ledgerStatus(input.outcome);
    // Admitted with no budget (a BYOK caller the adapter lets pay its own
    // upstream, #369): no money was written and none is owed.
    if (identity.budgetIds.length === 0) return { settlement, dispatch: null };
    if (admission.payment.mode === "prepaid") {
      if (status === "settled") return { settlement, dispatch: null };
      const dispatch = await ports.settlement.dispatch({
        kind: "refund",
        requestId: admission.requestId,
        tenantId: identity.tenantId,
        status,
        ...(input.error ? { errorCode: input.error.code } : {}),
        occurredAt: ports.clock.now(),
      });
      return { settlement, dispatch };
    }
    // Postpaid: nothing owed, nothing written.
    if (settlement.costMicroCredits === 0) return { settlement, dispatch: null };
    const dispatch = await ports.settlement.dispatch({
      kind: "charge",
      event: usageEvent(ports, admission, {
        attempt: input.attempt,
        usage: settlement.usage,
        costMicroCredits: settlement.costMicroCredits,
        priceVersion: settlement.priced.priceVersion,
        status,
        ...(input.error ? { errorCode: input.error.code } : {}),
      }),
      budgetIds: [...identity.budgetIds],
    });
    return { settlement, dispatch };
  } catch (error) {
    throw toGatewayError(error);
  } finally {
    // After the follow-up is journaled: a retry under the key is then
    // already settled. A failure here leaves the claim to its expiry.
    if (admission.request.idempotencyKey)
      await ports.budgets
        .endIdempotency({ requestId: admission.requestId, tenantId: admission.identity.tenantId })
        .catch((error: unknown) =>
          ports.logger.warn("gateway.idempotency_end_failed", {
            requestId: admission.requestId,
            cause: toGatewayError(error).code,
          }),
        );
    await ports.limits.release({ leaseId: admission.leaseId }).catch(() => undefined);
  }
}
