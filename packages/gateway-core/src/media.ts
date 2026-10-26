/**
 * Official media/AIGC jobs (#359): an accepted generation that outlives one
 * HTTP request (a queued image, a polled video). The adapter that runs the
 * job owns its durability; these functions own the decisions, so every
 * runtime meters media the same way:
 *
 * 1. `planGatewayMediaJob`: allowlist, catalog policy and the shared route
 *    plan (`planGatewayRoutes`) over the caller's one credential scope, priced
 *    at the plan instant. The job freezes the first attempt and that instant,
 *    so a retried admission or a later settlement prices identically.
 * 2. `admitGatewayMediaJob`: limits (a media job in flight) and the hold on
 *    every budget, for the units the price book charges.
 * 3. `restoreGatewayMediaAdmission`: the same admission rebuilt from the job
 *    for settlement in a later step, without holding again.
 * 4. `settleMediaGeneration` (admission.ts): a success is charged its
 *    delivered units (`deliveredMediaUnits`), any failure zero, once.
 *
 * Units come from the price book: of the quantities a job can measure about
 * itself (images, seconds, characters, one request), only the media units the
 * published price has a rate for are charged. A priced unit the job cannot
 * measure refuses with GATEWAY_PRICE_UNAVAILABLE before anything is held.
 */
import {
  assertModelAllowed,
  reserveAdmission,
  type GatewayAdmission,
} from "./admission.js";
import { computeHold } from "./budget.js";
import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { GatewayError, toGatewayError } from "./errors.js";
import type { GatewayIdentity, GatewayPorts } from "./ports.js";
import { assertQuantity, type GatewayPrice } from "./pricing.js";
import {
  normalizeMediaGenerationRequest,
  type GatewayModelKind,
  type GatewayRequest,
} from "./request.js";
import {
  planGatewayRoutes,
  type GatewayRouteAttempt,
  type GatewayRoutePlan,
  type PlanGatewayRoutesInput,
} from "./routing.js";
import type { GatewayMediaUnit, Usage } from "./usage.js";

/** Every unit a media job may be charged in, in price-book order. */
export const GATEWAY_MEDIA_UNITS = [
  "image",
  "video_second",
  "audio_second",
  "character",
  "request",
] as const satisfies readonly GatewayMediaUnit[];

/** What a media job can measure about itself; the price book decides which are charged. */
export type GatewayMediaQuantities = Partial<Record<GatewayMediaUnit, number>>;

/** A planned official media job: everything settlement needs, and no prompt or output. */
export interface GatewayMediaJob {
  /** The ledger request id; stable for the job's whole life (the adapter's durable anchor). */
  requestId: string;
  identity: GatewayIdentity;
  /** Public model code as routed (aliases normalized). */
  modelCode: string;
  kind: GatewayModelKind;
  catalogVersion: string;
  /** The plan's first attempt, frozen: the job runs on exactly this route. */
  attempt: GatewayRouteAttempt;
  quantities: GatewayMediaQuantities;
  /** Epoch ms the job is priced at; every admission and settlement prices as of it. */
  pricedAt: number;
}

export interface PlanMediaJobOptions {
  routing?: Pick<PlanGatewayRoutesInput, "isRouteExecutable" | "mayRetryAmbiguousSubmit" | "maxAttempts">;
}

const isMediaUnit = (unit: string): unit is GatewayMediaUnit =>
  (GATEWAY_MEDIA_UNITS as readonly string[]).includes(unit);

/**
 * The units of `quantities` the price charges. A media rate whose quantity is
 * unknown fails closed, and so does a price with no media rate at all: a job
 * held at zero would leave the budget unprotected.
 */
export function pricedMediaUnits(price: GatewayPrice, quantities: GatewayMediaQuantities): Usage["units"] {
  const units: Usage["units"] = {};
  for (const rate of price.rates) {
    if (!isMediaUnit(rate.unit)) continue;
    const quantity = quantities[rate.unit];
    if (quantity === undefined)
      throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
        message: `The price book charges ${rate.unit}, which this job cannot measure.`,
        details: { modelCode: price.modelCode, unit: rate.unit, priceVersion: price.version, reason: "quantity_unknown" },
      });
    units[rate.unit] = assertQuantity(quantity, rate.unit);
  }
  if (!Object.values(units).some((quantity) => (quantity ?? 0) > 0))
    throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
      message: "The price book has no media rate this job is charged in.",
      details: { modelCode: price.modelCode, priceVersion: price.version, reason: "no_media_rate" },
    });
  return units;
}

/**
 * What a succeeded job is charged: each held unit at the quantity the job
 * delivered when it measured one (a rendered video's seconds), never above
 * the held quantity, which the caller agreed to at admission; otherwise the
 * held quantity.
 */
export function deliveredMediaUnits(
  admission: Pick<GatewayAdmission, "request">,
  measured: GatewayMediaQuantities = {},
): Usage["units"] {
  const units: Usage["units"] = {};
  for (const [unit, held] of Object.entries(admission.request.requestedUnits) as Array<[GatewayMediaUnit, number]>) {
    const observed = measured[unit];
    units[unit] = observed === undefined ? held : Math.min(held, assertQuantity(observed, unit));
  }
  return units;
}

function mediaRequest(job: GatewayMediaJob, price: GatewayPrice): GatewayRequest {
  return normalizeMediaGenerationRequest({
    model: job.modelCode,
    kind: job.kind,
    units: pricedMediaUnits(price, job.quantities),
  });
}

function jobPlan(job: GatewayMediaJob): GatewayRoutePlan {
  return {
    modelCode: job.modelCode,
    kind: job.kind,
    scope: job.attempt.scope,
    catalogVersion: job.catalogVersion,
    attempts: [job.attempt],
  };
}

function priceJob(ports: GatewayPorts, job: GatewayMediaJob): Promise<GatewayPrice> {
  return ports.routes.price({
    identity: job.identity,
    catalogVersion: job.catalogVersion,
    route: job.attempt.route,
    at: job.pricedAt,
  });
}

const coded = <T>(promise: Promise<T>): Promise<T> =>
  promise.catch((error: unknown) => {
    throw toGatewayError(error);
  });

/**
 * Plan a media job for a verified identity: allowlist, catalog policy, the
 * shared route plan over the identity's credential scope, and the price as of
 * now. Nothing is held. Rejects with the planning codes (GATEWAY_MODEL_NOT_FOUND,
 * GATEWAY_NO_ROUTE, GATEWAY_PRICE_UNAVAILABLE, ...).
 */
export function planGatewayMediaJob(
  ports: GatewayPorts,
  input: {
    identity: GatewayIdentity;
    requestId: string;
    model: string;
    kind: GatewayModelKind;
    /** Card parameters the job selected, for route parameter support. */
    requestedParameterIds?: readonly string[];
    quantities: GatewayMediaQuantities;
  },
  options: PlanMediaJobOptions = {},
): Promise<GatewayMediaJob> {
  return coded(
    (async () => {
      const { identity } = input;
      if (input.kind === "text")
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          message: "Text models use the chat or messages protocol.",
          details: { param: "kind" },
        });
      assertModelAllowed(identity, input.model);
      const { catalog } = applyGatewayCatalogPolicy(await ports.routes.catalog(identity));
      const plan = planGatewayRoutes({
        ...options.routing,
        modelCode: input.model,
        kind: input.kind,
        catalog,
        scope: identity.credentialScope,
        providers: await ports.routes.providers(identity, identity.credentialScope),
        ...(input.requestedParameterIds ? { requestedParameterIds: input.requestedParameterIds } : {}),
      });
      const job: GatewayMediaJob = {
        requestId: input.requestId,
        identity,
        modelCode: plan.modelCode,
        kind: input.kind,
        catalogVersion: plan.catalogVersion,
        attempt: plan.attempts[0]!,
        quantities: { ...input.quantities },
        pricedAt: ports.clock.now(),
      };
      // Fail before the job exists when its price cannot be charged.
      mediaRequest(job, await priceJob(ports, job));
      return job;
    })(),
  );
}

/**
 * Admit a planned job: its limits lease (a media job in flight) and the hold
 * for the units the price book charges, under the job's request id. On
 * refusal nothing stays held or leased. Holding twice under one request id is
 * refused by the budgets port, so an adapter that may repeat admission keeps
 * its own record of a reservation it already made.
 */
export function admitGatewayMediaJob(
  ports: GatewayPorts,
  job: GatewayMediaJob,
  options: { holdTtlMs: number },
): Promise<GatewayAdmission> {
  return coded(
    (async () => {
      const price = await priceJob(ports, job);
      return reserveAdmission(ports, {
        requestId: job.requestId,
        identity: job.identity,
        request: mediaRequest(job, price),
        plan: jobPlan(job),
        price,
        pricedAt: job.pricedAt,
        holdTtlMs: options.holdTtlMs,
      });
    })(),
  );
}

/**
 * The admission of an already admitted job, for settling it in a later step:
 * priced as of the job's instant, nothing reserved or leased again.
 * `leaseId` ends the job's limits lease when it settles.
 */
export function restoreGatewayMediaAdmission(
  ports: GatewayPorts,
  job: GatewayMediaJob,
  options: { leaseId?: string } = {},
): Promise<GatewayAdmission> {
  return coded(
    (async () => {
      const price = await priceJob(ports, job);
      const request = mediaRequest(job, price);
      return {
        requestId: job.requestId,
        identity: job.identity,
        request,
        plan: jobPlan(job),
        price,
        pricedAt: job.pricedAt,
        holdMicroCredits: computeHold(request, price),
        reservation: { requestId: job.requestId, holds: [], expiresAt: 0 },
        leaseId: options.leaseId ?? "",
        admittedAt: job.pricedAt,
      };
    })(),
  );
}
