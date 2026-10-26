import { describe, expect, it } from "vitest";

import { settleMediaGeneration } from "./admission.js";
import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { GatewayError, isGatewayError } from "./errors.js";
import { sweepExpiredGatewayHolds } from "./holds.js";
import {
  admitGatewayMediaJob,
  deliveredMediaUnits,
  planGatewayMediaJob,
  pricedMediaUnits,
  restoreGatewayMediaAdmission,
  type GatewayMediaQuantities,
} from "./media.js";
import { priceUsage, type GatewayPriceRate } from "./pricing.js";
import { planGatewayRoutes } from "./routing.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts } from "./testing/memory-ports.js";
import { emptyUsage } from "./usage.js";

const fixture = catalogFixture();
const media = fixture.mediaModel;
const identity = {
  tenantId: "tenant-a",
  userId: "user-a",
  budgetIds: ["wallet-a"],
  credentialScope: "official" as const,
};

function gateway(rates: GatewayPriceRate[], walletMicroCredits: number | null = 1_000_000_000) {
  const memory = createMemoryGatewayPorts({
    identities: {},
    catalog: fixture.catalog,
    providers: fixture.providers,
    keys: fixture.keys,
    prices: media ? [{ modelCode: media.code, version: "price-media-1", rates }] : [],
    budgets: [
      {
        id: "wallet-a",
        tenantId: "tenant-a",
        scope: "tenant",
        scopeId: "tenant-a",
        limitMicroCredits: walletMicroCredits,
        spentMicroCredits: 0,
        reservedMicroCredits: 0,
        version: 0,
      },
    ],
    startAt: 1_700_000_000_000,
  });
  const wallet = async () => (await memory.ports.budgets.snapshot({ tenantId: "tenant-a" }))[0]!;
  return { memory, ports: memory.ports, wallet };
}

const plan = (ports: ReturnType<typeof gateway>["ports"], quantities: GatewayMediaQuantities, requestId = "media-job-1") =>
  planGatewayMediaJob(ports, { identity, requestId, model: media!.code, kind: media!.kind, quantities });

async function expectCode(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isGatewayError(error), String(error)).toBe(true);
  expect((error as GatewayError).code).toBe(code);
  return error as GatewayError;
}

const imageRate: GatewayPriceRate = { unit: "image", microCredits: 40_000, per: 1 };

describe.skipIf(!media)("official media jobs", () => {
  it("plans the shared route plan's first attempt over the caller's scope, priced at the plan instant", async () => {
    const { ports } = gateway([imageRate]);
    const job = await plan(ports, { image: 1, request: 1 });
    const shared = planGatewayRoutes({
      modelCode: media!.code,
      kind: media!.kind,
      catalog: applyGatewayCatalogPolicy(await ports.routes.catalog(identity)).catalog,
      scope: "official",
      providers: await ports.routes.providers(identity, "official"),
    });
    expect(job.attempt).toEqual(shared.attempts[0]);
    expect(job).toMatchObject({ modelCode: shared.modelCode, catalogVersion: shared.catalogVersion, pricedAt: ports.clock.now() });
  });

  it("holds the units the price book charges, in credits, and only those", async () => {
    const quantities = { image: 1, request: 1, character: 12 };
    for (const rates of [[imageRate], [{ unit: "request", microCredits: 75_000, per: 1 }] as GatewayPriceRate[]]) {
      const { ports, wallet } = gateway(rates);
      const job = await plan(ports, quantities);
      const admission = await admitGatewayMediaJob(ports, job, { holdTtlMs: 60_000 });
      const units = pricedMediaUnits(admission.price, quantities);
      expect(Object.keys(units)).toEqual(rates.map((rate) => rate.unit));
      expect(admission.request.requestedUnits).toEqual(units);
      expect(admission.holdMicroCredits).toBe(priceUsage({ ...emptyUsage(), units }, admission.price).microCredits);
      expect((await wallet()).reservedMicroCredits).toBe(admission.holdMicroCredits);
    }
  });

  it("refuses a priced unit the job cannot measure, before anything is held", async () => {
    const { ports, wallet } = gateway([{ unit: "video_second", microCredits: 10_000, per: 1 }]);
    const before = await wallet();
    const error = await expectCode(plan(ports, { image: 1, request: 1 }), "GATEWAY_PRICE_UNAVAILABLE");
    expect(error.details).toMatchObject({ unit: "video_second", reason: "quantity_unknown" });
    expect(await wallet()).toEqual(before);
  });

  it("refuses text kinds and models outside the allowlist", async () => {
    const { ports } = gateway([imageRate]);
    await expectCode(
      planGatewayMediaJob(ports, { identity, requestId: "r", model: fixture.textModel, kind: "text", quantities: { request: 1 } }),
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      planGatewayMediaJob(ports, {
        identity: { ...identity, modelAllowlist: [fixture.textModel] },
        requestId: "r",
        model: media!.code,
        kind: media!.kind,
        quantities: { image: 1 },
      }),
      "GATEWAY_MODEL_NOT_ALLOWED",
    );
  });

  it("a hard wallet the hold does not fit refuses, holding nothing", async () => {
    const { ports, wallet } = gateway([imageRate], 0);
    const job = await plan(ports, { image: 1 });
    await expectCode(admitGatewayMediaJob(ports, job, { holdTtlMs: 60_000 }), "GATEWAY_BUDGET_EXCEEDED");
    expect((await wallet()).reservedMicroCredits).toBe(0);
  });

  it("a provider failure after acceptance settles zero, and no later delivery charges it", async () => {
    const { ports, wallet } = gateway([imageRate]);
    const before = await wallet();
    const job = await plan(ports, { image: 1 });
    const admitted = await admitGatewayMediaJob(ports, job, { holdTtlMs: 60_000 });
    // The upstream accepted the job; it fails in a later step, settled from the job alone.
    const restored = await restoreGatewayMediaAdmission(ports, job, { leaseId: admitted.leaseId });
    expect(restored.holdMicroCredits).toBe(admitted.holdMicroCredits);
    const failed = await settleMediaGeneration(ports, restored, {
      attempt: job.attempt,
      result: { status: "failed", error: new GatewayError("GATEWAY_UPSTREAM_ERROR") },
    });
    expect(failed.result).toMatchObject({ costMicroCredits: 0, duplicate: false });
    expect(await ports.ledger.get({ tenantId: identity.tenantId, requestId: job.requestId })).toMatchObject({
      status: "upstream_failed",
      costMicroCredits: 0,
      errorCode: "GATEWAY_UPSTREAM_ERROR",
      kind: media!.kind,
    });
    // A retried step, or a provider that reports success after all: never a second charge.
    for (const result of [
      { status: "failed" as const, error: new GatewayError("GATEWAY_UPSTREAM_ERROR") },
      { status: "succeeded" as const, units: restored.request.requestedUnits },
    ]) {
      const again = await settleMediaGeneration(ports, await restoreGatewayMediaAdmission(ports, job), {
        attempt: job.attempt,
        result,
      });
      expect(again.result).toMatchObject({ duplicate: true, costMicroCredits: 0 });
    }
    expect(await wallet()).toMatchObject({
      spentMicroCredits: before.spentMicroCredits,
      reservedMicroCredits: before.reservedMicroCredits,
    });
  });

  it("a success is charged its delivered units once", async () => {
    const { ports, wallet } = gateway([imageRate]);
    const job = await plan(ports, { image: 1 });
    await admitGatewayMediaJob(ports, job, { holdTtlMs: 60_000 });
    const restored = await restoreGatewayMediaAdmission(ports, job);
    const units = deliveredMediaUnits(restored);
    const first = await settleMediaGeneration(ports, restored, { attempt: job.attempt, result: { status: "succeeded", units } });
    const cost = priceUsage({ ...emptyUsage(), units }, restored.price).microCredits;
    expect(first.result).toMatchObject({ costMicroCredits: cost, duplicate: false });
    const second = await settleMediaGeneration(ports, restored, { attempt: job.attempt, result: { status: "succeeded", units } });
    expect(second.result).toMatchObject({ costMicroCredits: cost, duplicate: true });
    expect(await wallet()).toMatchObject({ spentMicroCredits: cost, reservedMicroCredits: 0 });
  });

  it("an abandoned job's hold is released by the sweeper at zero; a late success is a duplicate", async () => {
    const { memory, ports, wallet } = gateway([imageRate]);
    const job = await plan(ports, { image: 1 });
    await admitGatewayMediaJob(ports, job, { holdTtlMs: 60_000 });
    memory.advance(60_001);
    expect((await sweepExpiredGatewayHolds(ports)).expired).toBe(1);
    const late = await settleMediaGeneration(ports, await restoreGatewayMediaAdmission(ports, job), {
      attempt: job.attempt,
      result: { status: "succeeded", units: { image: 1 } },
    });
    expect(late.result).toMatchObject({ duplicate: true, costMicroCredits: 0 });
    expect(await wallet()).toMatchObject({ spentMicroCredits: 0, reservedMicroCredits: 0 });
  });
});

describe("deliveredMediaUnits", () => {
  const admission = { request: { requestedUnits: { video_second: 5, request: 1 } } } as never;

  it("charges a measured quantity up to the held one, and the held quantity when unmeasured", () => {
    expect(deliveredMediaUnits(admission, { video_second: 3 })).toEqual({ video_second: 3, request: 1 });
    expect(deliveredMediaUnits(admission, { video_second: 9 })).toEqual({ video_second: 5, request: 1 });
    expect(deliveredMediaUnits(admission)).toEqual({ video_second: 5, request: 1 });
  });
});
