/**
 * Abuse signals, thresholds and suspension (#356), under
 * /api/v1/admin/gateway (guide: apps/docs/guide/gateway-admin.md#abuse).
 * Admin accounts only; each mutation writes its `gateway_admin_audit` row in
 * the same D1 batch (gateway/d1-abuse.ts).
 *
 *   GET  /abuse                                  signals, thresholds, alerts, suspensions,     abuse.read
 *                                                live rate-limit counters
 *   PUT  /abuse/thresholds/:signal               configure or clear a signal's threshold       abuse.thresholds.write
 *   POST /abuse/suspensions                      suspend a tenant or key by id                  abuse.suspend
 *   POST /abuse/suspensions/:suspensionId/lift   lift an active suspension                      abuse.suspend
 *
 * Suspending takes and answers ids only: no route here reads or returns key
 * material, so `abuse.suspend` can be held without any credential access.
 */
import { Hono } from "hono";
import { GATEWAY_ABUSE_SIGNALS, type GatewayAbuseActor } from "@clash/gateway-core";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayAbuseThresholdRequestSchema,
  GatewayLiftSuspensionRequestSchema,
  GatewaySuspendRequestSchema,
} from "../../../domain/requests";
import { abuseSubjectTenant, createD1GatewayAbusePort, readGatewayAbuse } from "../../../gateway/d1-abuse";
import type { GatewayAdminActor } from "../../../gateway/d1-admin-audit";
import { createD1AdminReads } from "../../../gateway/d1-admin-reads";
import { monotonicClock } from "../../../gateway/d1-common";
import { gatewayParam, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";

/** The window a signal without a threshold is shown over. */
export const ABUSE_DEFAULT_WINDOW_MINUTES = 60;
/** Subjects shown per signal, alerts and suspensions per read. */
const ABUSE_READ_LIMIT = 50;

const SignalSchema = z.enum(GATEWAY_ABUSE_SIGNALS);
const SuspensionIdSchema = z.string().regex(/^gws_[A-Za-z0-9]{1,64}$/);

/** Console routes act as the admin account the middleware verified. */
const abuseActor = (actor: GatewayAdminActor): GatewayAbuseActor => ({ kind: "admin", id: actor.id, role: actor.role });

export const adminAbuseRoutes = new Hono<{ Bindings: Env }>();

adminAbuseRoutes.get(
  "/abuse",
  platformRoute("abuse.read", async (c) => {
    const clock = monotonicClock();
    const [live, abuse] = await Promise.all([
      createD1AdminReads(c.env.DB, { clock }).abuse(),
      readGatewayAbuse(c.env.DB, { now: clock.now(), defaultWindowMinutes: ABUSE_DEFAULT_WINDOW_MINUTES, limit: ABUSE_READ_LIMIT }),
    ]);
    return ok(c, { abuse: { ...live, ...abuse } });
  }),
);

adminAbuseRoutes.put(
  "/abuse/thresholds/:signal",
  platformRoute("abuse.thresholds.write", async (c, actor) => {
    const signal = gatewayParam(SignalSchema, c.req.param("signal"), "signal");
    const body = await readGatewayJson(c, GatewayAbuseThresholdRequestSchema);
    const port = createD1GatewayAbusePort(c.env.DB);
    const result = await port.setThreshold({
      signal,
      threshold: body.threshold,
      actor: abuseActor(actor),
      ...(body.reason ? { reason: body.reason } : {}),
      at: Date.now(),
    });
    return ok(c, { signal, threshold: (await port.thresholds())[signal] ?? null, changed: result.changed });
  }),
);

adminAbuseRoutes.post(
  "/abuse/suspensions",
  platformRoute("abuse.suspend", async (c, actor) => {
    const body = await readGatewayJson(c, GatewaySuspendRequestSchema);
    const tenantId = await abuseSubjectTenant(c.env.DB, body);
    const suspension = await createD1GatewayAbusePort(c.env.DB).suspend({
      ...body,
      tenantId,
      actor: abuseActor(actor),
      at: Date.now(),
    });
    return ok(c, { suspension }, 201);
  }),
);

adminAbuseRoutes.post(
  "/abuse/suspensions/:suspensionId/lift",
  platformRoute("abuse.suspend", async (c, actor) => {
    const suspensionId = gatewayParam(SuspensionIdSchema, c.req.param("suspensionId"), "suspensionId");
    const body = await readGatewayJson(c, GatewayLiftSuspensionRequestSchema);
    const suspension = await createD1GatewayAbusePort(c.env.DB).lift({
      suspensionId,
      reason: body.reason,
      actor: abuseActor(actor),
      at: Date.now(),
    });
    return ok(c, { suspension });
  }),
);
