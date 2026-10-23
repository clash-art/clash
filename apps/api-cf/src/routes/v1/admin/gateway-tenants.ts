/**
 * Tenants, members, budgets, keys and limits (#353, #392), under
 * /api/v1/admin/gateway. Like the whole admin console these routes answer
 * platform grants only (services/gateway-authz.ts `platformRoute`), never a
 * tenant role. Teams are read-only here (#354): their owners manage members,
 * roles, member and key budgets, and key, member and tenant rate limits in
 * team settings (routes/v1/gateway-team.ts). The console keeps the platform
 * levers: wallet corrections and status, and the subscription's rate limit.
 *
 *   GET  /tenants                                         every tenant (?query)         tenants.list
 *   GET  /tenants/:tenantId/members                       members and roles             team.members.read
 *   GET  /tenants/:tenantId/budgets                       wallet, member, key budgets   budgets.read
 *   GET  /tenants/:tenantId/keys                          virtual keys (no hashes)      keys.read
 *   PUT  /tenants/:tenantId/subscription/rate-limit       tenant rate-limit override    subscription.limits.write
 *   POST /tenants/:tenantId/wallet/adjust                 credit correction (reason)    wallet.adjust
 *   POST /tenants/:tenantId/wallet/status                 suspend / reactivate wallet   wallet.adjust
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayRateLimitUpdateRequestSchema,
  GatewayTenantListQuerySchema,
  GatewayWalletAdjustRequestSchema,
  GatewayWalletStatusRequestSchema,
} from "../../../domain/requests";
import { createD1AdminReads } from "../../../gateway/d1-admin-reads";
import { createD1Billing } from "../../../gateway/d1-billing";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1TenantAdmin } from "../../../gateway/d1-tenant-admin";
import { gatewayParam, gatewayQuery, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";

const TenantIdSchema = z.string().min(1).max(256);

const tenants = (env: Env) => createD1TenantAdmin(env.DB, { clock: monotonicClock() });
const billing = (env: Env) => createD1Billing(env.DB, { clock: monotonicClock() });
const tenantParam = (value: string | undefined) => gatewayParam(TenantIdSchema, value, "tenantId");

export const adminTenantRoutes = new Hono<{ Bindings: Env }>();

adminTenantRoutes.get(
  "/tenants",
  platformRoute("tenants.list", async (c) => {
    const query = gatewayQuery(c, GatewayTenantListQuerySchema);
    return ok(c, {
      tenants: await createD1AdminReads(c.env.DB, { clock: monotonicClock() }).tenants({
        ...(query.query ? { query: query.query } : {}),
        limit: query.limit,
      }),
    });
  }),
);

adminTenantRoutes.get(
  "/tenants/:tenantId/members",
  platformRoute("team.members.read", async (c) =>
    ok(c, { members: await tenants(c.env).listMembers(tenantParam(c.req.param("tenantId"))) }),
  ),
);

adminTenantRoutes.get(
  "/tenants/:tenantId/budgets",
  platformRoute("budgets.read", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const [budgets, summary] = await Promise.all([
      tenants(c.env).listBudgets(tenantId),
      billing(c.env).walletSummary(tenantId, 0),
    ]);
    return ok(c, { budgets, wallet: summary.wallet, subscription: summary.subscription });
  }),
);

adminTenantRoutes.get(
  "/tenants/:tenantId/keys",
  platformRoute("keys.read", async (c) =>
    ok(c, { keys: await tenants(c.env).listKeys(tenantParam(c.req.param("tenantId"))) }),
  ),
);

adminTenantRoutes.put(
  "/tenants/:tenantId/subscription/rate-limit",
  platformRoute("subscription.limits.write", async (c, actor) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const body = await readGatewayJson(c, GatewayRateLimitUpdateRequestSchema);
    const subscription = await billing(c.env).setSubscriptionRateLimit({
      tenantId,
      rateLimit: body.rateLimit,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { subscription });
  }),
);

adminTenantRoutes.post(
  "/tenants/:tenantId/wallet/adjust",
  platformRoute("wallet.adjust", async (c, actor) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const body = await readGatewayJson(c, GatewayWalletAdjustRequestSchema);
    const result = await billing(c.env).adjustWallet({ tenantId, ...body, actor });
    return ok(c, result, result.replayed ? 200 : 201);
  }),
);

adminTenantRoutes.post(
  "/tenants/:tenantId/wallet/status",
  platformRoute("wallet.adjust", async (c, actor) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const body = await readGatewayJson(c, GatewayWalletStatusRequestSchema);
    return ok(c, { wallet: await billing(c.env).setWalletStatus({ tenantId, ...body, actor }) });
  }),
);
