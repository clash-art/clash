/**
 * Model gateway control plane, mounted at /api/v1/admin/gateway (#352, #353,
 * #394; guide: apps/docs/guide/gateway-admin.md). Only a signed-in admin
 * account reaches these routes (services/admin-identity.ts, before any route);
 * each authorizes through services/gateway-authz.ts (the account role's
 * permissions). Failures are coded gateway errors, whatever the UI shows.
 * Every mutation appends its redacted `gateway_admin_audit` row, actor = the
 * admin account, in the same D1 batch.
 *
 * Price book, packages and top-up packs (admin accounts):
 *   GET  /prices                          price-book versions (?modelCode, ?status)     prices.read
 *   GET  /prices/versions/:version        one version                                     prices.read
 *   PUT  /prices/versions/:version        create or replace a draft                       prices.write
 *   POST /prices/versions/:version/publish                                                prices.write
 *   GET  /packages                        subscription packages                           packages.read
 *   POST /packages                        create                                          packages.write
 *   POST /packages/:id/archive                                                            packages.write
 *   GET  /topup-packs                     top-up packs                                    packages.read
 *   POST /topup-packs                     create                                          packages.write
 *   POST /topup-packs/:id/archive                                                         packages.write
 *   POST /billing/rollover                close ended subscription periods (idempotent)   billing.rollover
 *
 * The other routes live in gateway-access.ts (me, admin accounts),
 * gateway-catalog.ts (catalog, upstreams), gateway-tenants.ts (tenants,
 * members, budgets, keys, limits, wallet) and gateway-insights.ts (overview,
 * usage, audit, abuse, prompts).
 */
import { Hono } from "hono";
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
import { gatewayParam, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";
import { adminAccessRoutes } from "./gateway-access";
import { adminCatalogRoutes } from "./gateway-catalog";
import { adminInsightRoutes } from "./gateway-insights";
import { adminTenantRoutes } from "./gateway-tenants";

const PriceStatusSchema = z.enum(["draft", "published"]).optional();
const IdSchema = z.string().min(1).max(128);

export const adminGatewayRoutes = new Hono<{ Bindings: Env }>();

adminGatewayRoutes.get(
  "/prices",
  platformRoute("prices.read", async (c) => {
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
  platformRoute("prices.read", async (c) => {
    const version = gatewayParam(GatewayPriceVersionSchema, c.req.param("version"), "version");
    return ok(c, { version: await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).read(version) });
  }),
);

adminGatewayRoutes.put(
  "/prices/versions/:version",
  platformRoute("prices.write", async (c, actor) => {
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
      actor,
    });
    return ok(c, { version: draft });
  }),
);

adminGatewayRoutes.post(
  "/prices/versions/:version/publish",
  platformRoute("prices.write", async (c, actor) => {
    const version = gatewayParam(GatewayPriceVersionSchema, c.req.param("version"), "version");
    const published = await createD1PriceBook(c.env.DB, { clock: monotonicClock() }).publish({
      version,
      actor,
    });
    return ok(c, { version: published });
  }),
);

adminGatewayRoutes.get(
  "/packages",
  platformRoute("packages.read", async (c) =>
    ok(c, { packages: await createD1Billing(c.env.DB, { clock: monotonicClock() }).listPackages() }),
  ),
);

adminGatewayRoutes.post(
  "/packages",
  platformRoute("packages.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayPackageCreateRequestSchema);
    const created = await createD1Billing(c.env.DB, { clock: monotonicClock() }).createPackage(body, actor);
    return ok(c, { package: created }, 201);
  }),
);

adminGatewayRoutes.post(
  "/packages/:id/archive",
  platformRoute("packages.write", async (c, actor) => {
    const id = gatewayParam(IdSchema, c.req.param("id"), "id");
    return ok(c, { package: await createD1Billing(c.env.DB, { clock: monotonicClock() }).archivePackage(id, actor) });
  }),
);

adminGatewayRoutes.get(
  "/topup-packs",
  platformRoute("packages.read", async (c) =>
    ok(c, { packs: await createD1Billing(c.env.DB, { clock: monotonicClock() }).listTopupPacks() }),
  ),
);

adminGatewayRoutes.post(
  "/topup-packs",
  platformRoute("packages.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayTopupPackCreateRequestSchema);
    const created = await createD1Billing(c.env.DB, { clock: monotonicClock() }).createTopupPack(body, actor);
    return ok(c, { pack: created }, 201);
  }),
);

adminGatewayRoutes.post(
  "/topup-packs/:id/archive",
  platformRoute("packages.write", async (c, actor) => {
    const id = gatewayParam(IdSchema, c.req.param("id"), "id");
    return ok(c, { pack: await createD1Billing(c.env.DB, { clock: monotonicClock() }).archiveTopupPack(id, actor) });
  }),
);

adminGatewayRoutes.post(
  "/billing/rollover",
  platformRoute("billing.rollover", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayRolloverRequestSchema);
    const subscriptions = await createD1Billing(c.env.DB, { clock: monotonicClock() }).rollover({
      ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      actor,
    });
    return ok(c, { subscriptions, failed: subscriptions.filter((outcome) => outcome.error).length });
  }),
);

adminGatewayRoutes.route("/", adminAccessRoutes);
adminGatewayRoutes.route("/", adminCatalogRoutes);
adminGatewayRoutes.route("/", adminTenantRoutes);
adminGatewayRoutes.route("/", adminInsightRoutes);
