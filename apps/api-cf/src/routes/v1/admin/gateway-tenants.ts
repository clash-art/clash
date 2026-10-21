/**
 * Tenants, members, budgets, keys and limits (#353, #392), under
 * /api/v1/admin/gateway. Like the whole admin console these routes answer
 * platform grants only (services/gateway-authz.ts `platformRoute`), never a
 * tenant role. Members are read-only here: team owners manage members and
 * roles in team settings (#354).
 *
 *   GET  /tenants                                         every tenant (?query)         tenants.list
 *   GET  /tenants/:tenantId/members                       members and roles             team.members.read
 *   GET  /tenants/:tenantId/budgets                       wallet, member, key budgets   budgets.read
 *   PUT  /tenants/:tenantId/budgets/:scope/:scopeId       set a user/key budget         team.budgets.allocate
 *   GET  /tenants/:tenantId/keys                          virtual keys (no hashes)      keys.read
 *   PUT  /tenants/:tenantId/keys/:keyId/rate-limit        key rate limits               limits.write
 *   PUT  /tenants/:tenantId/subscription/rate-limit       tenant rate-limit override    subscription.limits.write
 *   POST /tenants/:tenantId/wallet/adjust                 credit correction (reason)    wallet.adjust
 *   POST /tenants/:tenantId/wallet/status                 suspend / reactivate wallet   wallet.adjust
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayBudgetSetRequestSchema,
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
const SubjectIdSchema = z.string().regex(/^[A-Za-z0-9._:@-]{1,256}$/);
const BudgetScopeSchema = z.enum(["user", "key"]);

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

adminTenantRoutes.put(
  "/tenants/:tenantId/budgets/:scope/:scopeId",
  platformRoute("team.budgets.allocate", async (c, actor) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const scope = gatewayParam(BudgetScopeSchema, c.req.param("scope"), "scope");
    const scopeId = gatewayParam(SubjectIdSchema, c.req.param("scopeId"), "scopeId");
    const body = await readGatewayJson(c, GatewayBudgetSetRequestSchema);
    const budget = await tenants(c.env).setBudget({
      tenantId,
      scope,
      scopeId,
      limitMicroCredits: body.limitMicroCredits,
      ...(body.status ? { status: body.status } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { budget });
  }),
);

adminTenantRoutes.get(
  "/tenants/:tenantId/keys",
  platformRoute("keys.read", async (c) =>
    ok(c, { keys: await tenants(c.env).listKeys(tenantParam(c.req.param("tenantId"))) }),
  ),
);

adminTenantRoutes.put(
  "/tenants/:tenantId/keys/:keyId/rate-limit",
  platformRoute("limits.write", async (c, actor) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const keyId = gatewayParam(SubjectIdSchema, c.req.param("keyId"), "keyId");
    const body = await readGatewayJson(c, GatewayRateLimitUpdateRequestSchema);
    return ok(c, { key: await tenants(c.env).setKeyRateLimit({ tenantId, keyId, rateLimit: body.rateLimit, actor }) });
  }),
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
