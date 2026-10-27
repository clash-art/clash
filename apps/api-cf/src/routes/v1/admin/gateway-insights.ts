/**
 * Read-only console views, staff prompt access and retention purge (#353),
 * under /api/v1/admin/gateway. Platform grants only (#392); `?tenantId=`
 * narrows a platform-wide read to one tenant.
 *
 *   GET  /overview   (?tenantId)          30-day spend, requests, failures     usage.read_all
 *   GET  /usage      (?tenantId, filters, cursor) explorer page + per-model totals  usage.read_all
 *   GET  /usage/export (?tenantId, filters) the same filter as CSV (#355)      usage.read_all
 *   GET  /audit      (?tenantId, filters) admin audit rows                     audit.read_all
 *   POST /prompts/:requestId/access       view a retained prompt + response    prompts.view
 *   POST /retention/purge                 purge expired retained bodies now    retention.purge
 *   POST /retention/enforce               30-day metadata / 13-month ledger    retention.purge
 *
 * There is no hold sweep any more (#399): no request holds budget, and
 * settle runs recover through the Durable Run cron.
 *
 * Prompt access is hosted-only behind GATEWAY_STAFF_PROMPT_ACCESS=enabled
 * (default off, self-host unchanged). Every access, whatever its outcome, is
 * audited (`prompt.view`: who, request id, reason, outcome, sizes and
 * SHA-256; never the body) before anything is disclosed; if the audit row
 * cannot be written, nothing is returned. The answer carries the stored bytes.
 */
import { Hono } from "hono";
import {
  GatewayError,
  readRetainedExchange,
  toGatewayError,
  type RetainedBody,
  type RetainedExchange,
} from "@clash/gateway-core";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayAuditQuerySchema,
  GatewayPromptAccessRequestSchema,
  GatewayRetentionEnforceRequestSchema,
  GatewayRetentionPurgeRequestSchema,
  GatewayUsageExportQuerySchema,
  GatewayUsageQuerySchema,
} from "../../../domain/requests";
import { staffPromptAccessEnabled } from "../../../gateway";
import { adminAuditStatement } from "../../../gateway/d1-admin-audit";
import { createD1AdminReads } from "../../../gateway/d1-admin-reads";
import { monotonicClock, toSeconds } from "../../../gateway/d1-common";
import { enforceGatewayDataRetention, gatewayRetentionPorts, purgeGatewayRetention } from "../../../gateway/d1-retention";
import {
  createD1UsageExplorer,
  usageCsvResponse,
  usageExportFileName,
  usageFilterOf,
} from "../../../gateway/d1-usage-explorer";
import { gatewayParam, gatewayQuery, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";

const RequestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const TenantIdSchema = z.string().min(1).max(256).optional();

const reads = (env: Env) => createD1AdminReads(env.DB, { clock: monotonicClock() });
const ms = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));

export const adminInsightRoutes = new Hono<{ Bindings: Env }>();

adminInsightRoutes.get(
  "/overview",
  platformRoute("usage.read_all", async (c) =>
    ok(c, {
      overview: await reads(c.env).overview(gatewayParam(TenantIdSchema, c.req.query("tenantId"), "tenantId")),
    }),
  ),
);

adminInsightRoutes.get(
  "/usage",
  platformRoute("usage.read_all", async (c) => {
    const query = gatewayQuery(c, GatewayUsageQuerySchema);
    return ok(
      c,
      await createD1UsageExplorer(c.env.DB).list(usageFilterOf(query), {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
    );
  }),
);

adminInsightRoutes.get(
  "/usage/export",
  platformRoute("usage.read_all", async (c) => {
    const filter = usageFilterOf(gatewayQuery(c, GatewayUsageExportQuerySchema));
    const exported = await createD1UsageExplorer(c.env.DB).exportCsv(filter, "platform");
    return usageCsvResponse({
      ...exported,
      fileName: usageExportFileName({
        ...(filter.tenantId ? { scope: filter.tenantId } : {}),
        ...(filter.from !== undefined ? { from: filter.from } : {}),
        ...(filter.to !== undefined ? { to: filter.to } : {}),
      }),
    });
  }),
);

adminInsightRoutes.get(
  "/audit",
  platformRoute("audit.read_all", async (c) => {
    const query = gatewayQuery(c, GatewayAuditQuerySchema);
    const from = ms(query.from);
    const to = ms(query.to);
    const entries = await reads(c.env).audit({
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.actorKind ? { actorKind: query.actorKind } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
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

const OUTCOMES: Partial<Record<string, string>> = {
  GATEWAY_PROMPT_NOT_RETAINED: "not_retained",
  GATEWAY_PROMPT_EXPIRED: "expired",
};

const decoder = new TextDecoder();
const bodyView = (part: RetainedBody) => ({
  contentType: part.contentType,
  bytes: part.bytes,
  sha256: part.sha256,
  // A streamed answer cut at the retention cap: `body` ends in the GATEWAY_RETENTION_TRUNCATED marker.
  truncated: part.truncated === true,
  ...(part.truncated ? { observedBytes: part.observedBytes ?? null } : {}),
  // The stored bytes, decoded as the UTF-8 text (JSON, or a stream's SSE) they were written as.
  body: decoder.decode(part.body),
});

function promptView({ entry, request, response }: RetainedExchange) {
  return {
    requestId: entry.requestId,
    tenantId: entry.tenantId,
    userId: entry.userId,
    keyId: entry.keyId ?? null,
    responseStatus: entry.responseStatus,
    storedAt: new Date(entry.storedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    request: bodyView(request),
    response: bodyView(response),
  };
}

adminInsightRoutes.post(
  "/prompts/:requestId/access",
  platformRoute("prompts.view", async (c, actor) => {
    if (!staffPromptAccessEnabled(c.env)) throw new GatewayError("GATEWAY_PROMPT_ACCESS_DISABLED");
    const requestId = gatewayParam(RequestIdSchema, c.req.param("requestId"), "requestId");
    const body = await readGatewayJson(c, GatewayPromptAccessRequestSchema);
    const ports = gatewayRetentionPorts(c.env);
    let exchange: RetainedExchange | undefined;
    let refusal: GatewayError | undefined;
    try {
      exchange = await readRetainedExchange(ports, { requestId });
    } catch (error) {
      refusal = toGatewayError(error);
    }
    const entry = exchange?.entry ?? (await ports.retention.get({ requestId }).catch(() => null));
    const tenantId = entry?.tenantId ?? (await reads(c.env).requestTenant(requestId));
    const requestFound = tenantId !== null;
    // Audited before anything is disclosed: no audit row, no body.
    await adminAuditStatement(c.env.DB, {
      tenantId: tenantId ?? "",
      actor,
      action: "prompt.view",
      targetType: "gateway_request",
      targetId: requestId,
      requestId,
      after: exchange
        ? {
            outcome: "viewed",
            requestFound,
            requestBytes: exchange.request.bytes,
            requestSha256: exchange.request.sha256,
            responseBytes: exchange.response.bytes,
            responseSha256: exchange.response.sha256,
            responseTruncated: exchange.response.truncated === true,
          }
        : { outcome: OUTCOMES[refusal!.code] ?? "failed", requestFound, code: refusal!.code },
      reason: body.reason,
      nowS: toSeconds(Date.now()),
    }).run();
    if (!exchange)
      throw new GatewayError(refusal!.code, {
        message: refusal!.message,
        details: { ...refusal!.details, requestId, requestFound },
        cause: refusal,
      });
    return ok(c, { prompt: promptView(exchange) });
  }),
);

adminInsightRoutes.post(
  "/retention/purge",
  platformRoute("retention.purge", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayRetentionPurgeRequestSchema);
    const result = await purgeGatewayRetention(c.env, { ...(body.limit !== undefined ? { limit: body.limit } : {}) });
    // Like every mutation, a purge that changed nothing records nothing.
    if (result.purged || result.failed)
      await adminAuditStatement(c.env.DB, {
        tenantId: "",
        actor,
        action: "retention.purge",
        targetType: "gateway_retention",
        targetId: "expired",
        after: result,
        nowS: toSeconds(Date.now()),
      }).run();
    return ok(c, { purge: result });
  }),
);

adminInsightRoutes.post(
  "/retention/enforce",
  platformRoute("retention.purge", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayRetentionEnforceRequestSchema);
    const result = await enforceGatewayDataRetention(c.env.DB, body.limit !== undefined ? { limit: body.limit } : {});
    const { more: _more, ...removed } = result;
    // Like every mutation, a run that changed nothing records nothing.
    if (Object.values(removed).some((count) => count > 0))
      await adminAuditStatement(c.env.DB, {
        tenantId: "",
        actor,
        action: "retention.enforce",
        targetType: "gateway_retention",
        targetId: "metadata",
        after: result,
        nowS: toSeconds(Date.now()),
      }).run();
    return ok(c, { retention: result });
  }),
);
