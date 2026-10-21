/**
 * Read-only console views and staff prompt access (#353), under
 * /api/v1/admin/gateway. Reads with `?tenantId=` use the caller's tenant role;
 * without it they are platform-wide and platform_admin only.
 *
 *   GET  /overview   (?tenantId)          30-day spend, requests, failures     tenant.read | usage.read_all
 *   GET  /usage      (?tenantId, filters) ledger entries + per-model totals    usage.read  | usage.read_all
 *   GET  /audit      (?tenantId, filters) admin audit rows                     audit.read  | audit.read_all
 *   GET  /abuse                           live rate-limit counters             abuse.read
 *   POST /prompts/:requestId/access       staff prompt access (decision 10)    prompts.view
 *
 * Prompt access is hosted-only behind GATEWAY_STAFF_PROMPT_ACCESS=enabled
 * (default off, self-host unchanged) and always audited. The gateway retains
 * no request or response bodies, so an allowed access answers
 * GATEWAY_PROMPT_NOT_RETAINED; no body storage exists to read.
 */
import { Hono } from "hono";
import { GatewayError } from "@clash/gateway-core";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayAuditQuerySchema,
  GatewayPromptAccessRequestSchema,
  GatewayUsageQuerySchema,
} from "../../../domain/requests";
import { adminAuditStatement } from "../../../gateway/d1-admin-audit";
import { createD1AdminReads } from "../../../gateway/d1-admin-reads";
import { monotonicClock, toSeconds } from "../../../gateway/d1-common";
import { gatewayParam, gatewayQuery, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute, scopedRoute } from "../../../services/gateway-authz";

const RequestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/** Hosted-only switch for decision 10; anything but "enabled" is off. */
export function staffPromptAccessEnabled(env: Pick<Env, "GATEWAY_STAFF_PROMPT_ACCESS">): boolean {
  return env.GATEWAY_STAFF_PROMPT_ACCESS === "enabled";
}

const reads = (env: Env) => createD1AdminReads(env.DB, { clock: monotonicClock() });
const ms = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));

export const adminInsightRoutes = new Hono<{ Bindings: Env }>();

adminInsightRoutes.get(
  "/overview",
  scopedRoute({ tenant: "tenant.read", platform: "usage.read_all" }, async (c, _actor, tenantId) =>
    ok(c, { overview: await reads(c.env).overview(tenantId) }),
  ),
);

adminInsightRoutes.get(
  "/usage",
  scopedRoute({ tenant: "usage.read", platform: "usage.read_all" }, async (c, _actor, tenantId) => {
    const query = gatewayQuery(c, GatewayUsageQuerySchema);
    const from = ms(query.from);
    const to = ms(query.to);
    return ok(
      c,
      await reads(c.env).usage({
        ...(tenantId ? { tenantId } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.keyId ? { keyId: query.keyId } : {}),
        ...(query.modelCode ? { modelCode: query.modelCode } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: query.limit,
      }),
    );
  }),
);

adminInsightRoutes.get(
  "/audit",
  scopedRoute({ tenant: "audit.read", platform: "audit.read_all" }, async (c, _actor, tenantId) => {
    const query = gatewayQuery(c, GatewayAuditQuerySchema);
    const from = ms(query.from);
    const to = ms(query.to);
    const entries = await reads(c.env).audit({
      ...(tenantId ? { tenantId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      limit: query.limit,
    });
    return ok(c, { entries });
  }),
);

adminInsightRoutes.get(
  "/abuse",
  platformRoute("abuse.read", async (c) => ok(c, { abuse: await reads(c.env).abuse() })),
);

adminInsightRoutes.post(
  "/prompts/:requestId/access",
  platformRoute("prompts.view", async (c, actor) => {
    if (!staffPromptAccessEnabled(c.env)) throw new GatewayError("GATEWAY_PROMPT_ACCESS_DISABLED");
    const requestId = gatewayParam(RequestIdSchema, c.req.param("requestId"), "requestId");
    const body = await readGatewayJson(c, GatewayPromptAccessRequestSchema);
    const tenantId = await reads(c.env).requestTenant(requestId);
    // Every access is audited, including this one that finds nothing to show.
    await adminAuditStatement(c.env.DB, {
      tenantId: tenantId ?? "",
      actor,
      action: "prompt.view",
      targetType: "gateway_request",
      targetId: requestId,
      after: { outcome: "not_retained", requestFound: tenantId !== null },
      reason: body.reason,
      nowS: toSeconds(Date.now()),
    }).run();
    throw new GatewayError("GATEWAY_PROMPT_NOT_RETAINED", {
      details: { requestId, requestFound: tenantId !== null, retained: false },
    });
  }),
);
