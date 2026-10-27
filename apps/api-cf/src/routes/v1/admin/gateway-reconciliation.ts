/**
 * Nightly usage reconciliation (#355; guide: apps/docs/guide/gateway-usage.md),
 * under /api/v1/admin/gateway. Admin accounts only.
 *
 *   GET  /reconciliation/reports        (?from, ?to)     imported upstream reports      reconciliation.read
 *   PUT  /reconciliation/reports/:day/:source            replace one day's report       reconciliation.write
 *   GET  /reconciliation/runs           (?day, ?status)  runs, newest first             reconciliation.read
 *   GET  /reconciliation/runs/:id                        one run with per-group diffs   reconciliation.read
 *   POST /reconciliation/runs           { day, source? } reconcile one day now          reconciliation.write
 *
 * The nightly job (index.ts `scheduled`) reconciles yesterday and every day
 * whose report changed since its last run; these routes import reports and
 * re-run a day on demand. Imports and admin runs are audited in the batch
 * that writes them; differences are platform `adjust` ledger entries, never
 * a tenant charge.
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayReconcileDaySchema,
  GatewayReconcileRunQuerySchema,
  GatewayReconcileRunRequestSchema,
  GatewayReconcileSourceSchema,
  GatewayUpstreamReportQuerySchema,
  GatewayUpstreamReportRequestSchema,
} from "../../../domain/requests";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1ReconciliationAdmin, reconcileGatewayDay } from "../../../gateway/d1-reconciliation";
import { gatewayParam, gatewayQuery, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";

const RunIdSchema = z.string().regex(/^gwrec_[0-9a-f]{24}$/);

const admin = (env: Env) => createD1ReconciliationAdmin(env.DB, { clock: monotonicClock() });

export const adminReconciliationRoutes = new Hono<{ Bindings: Env }>();

adminReconciliationRoutes.get(
  "/reconciliation/reports",
  platformRoute("reconciliation.read", async (c) => {
    const query = gatewayQuery(c, GatewayUpstreamReportQuerySchema);
    return ok(c, {
      reports: await admin(c.env).listReports({
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        limit: query.limit,
      }),
    });
  }),
);

adminReconciliationRoutes.put(
  "/reconciliation/reports/:day/:source",
  platformRoute("reconciliation.write", async (c, actor) => {
    const day = gatewayParam(GatewayReconcileDaySchema, c.req.param("day"), "day");
    const source = gatewayParam(GatewayReconcileSourceSchema, c.req.param("source"), "source");
    const body = await readGatewayJson(c, GatewayUpstreamReportRequestSchema);
    const report = await admin(c.env).importReport({
      day,
      source,
      groups: body.groups,
      actor,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return ok(c, { report });
  }),
);

adminReconciliationRoutes.get(
  "/reconciliation/runs",
  platformRoute("reconciliation.read", async (c) => {
    const query = gatewayQuery(c, GatewayReconcileRunQuerySchema);
    return ok(c, {
      runs: await admin(c.env).listRuns({
        ...(query.day ? { day: query.day } : {}),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
      }),
    });
  }),
);

adminReconciliationRoutes.get(
  "/reconciliation/runs/:id",
  platformRoute("reconciliation.read", async (c) => {
    const id = gatewayParam(RunIdSchema, c.req.param("id"), "id");
    return ok(c, { run: await admin(c.env).readRun(id) });
  }),
);

adminReconciliationRoutes.post(
  "/reconciliation/runs",
  platformRoute("reconciliation.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayReconcileRunRequestSchema);
    const run = await reconcileGatewayDay(c.env, { day: body.day, actor, ...(body.source ? { source: body.source } : {}) });
    return ok(c, { run: await admin(c.env).readRun(run.id), posted: run.posted }, 201);
  }),
);
