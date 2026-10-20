/**
 * Model gateway control plane for platform admins (#352), mounted at
 * /api/v1/admin/gateway. Every route requires the platform-admin grant
 * (services/gateway-admin.ts); failures are coded gateway errors.
 *
 *   GET  /prices                          price-book versions (?modelCode, ?status)
 *   GET  /prices/versions/:version        one version
 *   PUT  /prices/versions/:version        create or replace a draft
 *   POST /prices/versions/:version/publish
 *   GET  /packages                        subscription packages
 *   POST /packages                        create
 *   POST /packages/:id/archive
 *   GET  /topup-packs                     top-up packs
 *   POST /topup-packs                     create
 *   POST /topup-packs/:id/archive
 *   POST /billing/rollover                close ended subscription periods (idempotent)
 *
 * The admin page is #353; this is its API.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayPackageCreateRequestSchema,
  GatewayPriceDraftRequestSchema,
  GatewayPriceVersionSchema,
  GatewayRolloverRequestSchema,
  GatewayTopupPackCreateRequestSchema,
} from "../../../domain/requests";
import { createD1Billing } from "../../../gateway/d1-billing";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1PriceBook } from "../../../gateway/d1-price-book";
import { gatewayParam, readGatewayJson, requireGatewayPlatformAdmin } from "../../../services/gateway-admin";
import { gatewayErrorResponse } from "../../../services/gateway-tokens";

type AdminContext = Context<{ Bindings: Env }>;

const NO_STORE = { "cache-control": "no-store" };
const ok = (c: AdminContext, body: unknown, status: 200 | 201 = 200) => c.json(body, status, NO_STORE);

/** Run `handler` as a platform admin; any failure becomes its coded error response. */
const admin =
  (handler: (c: AdminContext, actor: ReturnType<typeof requireGatewayPlatformAdmin>) => Promise<Response>) =>
  async (c: AdminContext) => {
    try {
      return await handler(c, requireGatewayPlatformAdmin(c));
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

const PriceStatusSchema = z.enum(["draft", "published"]).optional();
const IdSchema = z.string().min(1).max(128);

export const adminGatewayRoutes = new Hono<{ Bindings: Env }>();

adminGatewayRoutes.get(
  "/prices",
  admin(async (c) => {
    const modelCode = c.req.query("modelCode");
    const status = gatewayParam(PriceStatusSchema, c.req.query("status"), "status");
    const versions = await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).list({
      ...(modelCode ? { modelCode } : {}),
      ...(status ? { status } : {}),
    });
    return ok(c, { versions });
  }),
);

adminGatewayRoutes.get(
  "/prices/versions/:version",
  admin(async (c) => {
    const version = gatewayParam(GatewayPriceVersionSchema, c.req.param("version"), "version");
    return ok(c, { version: await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).read(version) });
  }),
);

adminGatewayRoutes.put(
  "/prices/versions/:version",
  admin(async (c, actor) => {
    const version = gatewayParam(GatewayPriceVersionSchema, c.req.param("version"), "version");
    const body = await readGatewayJson(c, GatewayPriceDraftRequestSchema);
    const draft = await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).putDraft({
      version,
      effectiveFrom: Date.parse(body.effectiveFrom),
      effectiveTo: body.effectiveTo ? Date.parse(body.effectiveTo) : null,
      rates: body.rates.map((rate) => ({
        modelCode: rate.modelCode,
        upstreamId: rate.upstreamId ?? "",
        unit: rate.unit,
        microCredits: rate.amountMicroCredits,
        per: rate.per,
      })),
      actorUserId: actor.userId,
    });
    return ok(c, { version: draft });
  }),
);

adminGatewayRoutes.post(
  "/prices/versions/:version/publish",
  admin(async (c, actor) => {
    const version = gatewayParam(GatewayPriceVersionSchema, c.req.param("version"), "version");
    const published = await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).publish({
      version,
      actorUserId: actor.userId,
    });
    return ok(c, { version: published });
  }),
);

adminGatewayRoutes.get(
  "/packages",
  admin(async (c) => ok(c, { packages: await createD1Billing(c.env.DB, { clock: monotonicClock() }).listPackages() })),
);

adminGatewayRoutes.post(
  "/packages",
  admin(async (c, actor) => {
    const body = await readGatewayJson(c, GatewayPackageCreateRequestSchema);
    const created = await createD1Billing(c.env.DB, { clock: monotonicClock() }).createPackage(body, actor);
    return ok(c, { package: created }, 201);
  }),
);

adminGatewayRoutes.post(
  "/packages/:id/archive",
  admin(async (c, actor) => {
    const id = gatewayParam(IdSchema, c.req.param("id"), "id");
    return ok(c, { package: await createD1Billing(c.env.DB, { clock: monotonicClock() }).archivePackage(id, actor) });
  }),
);

adminGatewayRoutes.get(
  "/topup-packs",
  admin(async (c) => ok(c, { packs: await createD1Billing(c.env.DB, { clock: monotonicClock() }).listTopupPacks() })),
);

adminGatewayRoutes.post(
  "/topup-packs",
  admin(async (c, actor) => {
    const body = await readGatewayJson(c, GatewayTopupPackCreateRequestSchema);
    const created = await createD1Billing(c.env.DB, { clock: monotonicClock() }).createTopupPack(body, actor);
    return ok(c, { pack: created }, 201);
  }),
);

adminGatewayRoutes.post(
  "/topup-packs/:id/archive",
  admin(async (c, actor) => {
    const id = gatewayParam(IdSchema, c.req.param("id"), "id");
    return ok(c, { pack: await createD1Billing(c.env.DB, { clock: monotonicClock() }).archiveTopupPack(id, actor) });
  }),
);

adminGatewayRoutes.post(
  "/billing/rollover",
  admin(async (c, actor) => {
    const body = await readGatewayJson(c, GatewayRolloverRequestSchema);
    const subscriptions = await createD1Billing(c.env.DB, { clock: monotonicClock() }).rollover({
      ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      actor,
    });
    return ok(c, { subscriptions, failed: subscriptions.filter((outcome) => outcome.error).length });
  }),
);
