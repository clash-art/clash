/**
 * Tenants, members, budgets, keys and limits (#353), under
 * /api/v1/admin/gateway. Tenant routes accept the caller's role in that
 * tenant (services/gateway-authz.ts matrix) or platform_admin; wallet
 * corrections and subscription overrides are platform-only.
 *
 *   GET  /tenants                                         every tenant (?query)         tenants.list
 *   GET  /tenants/:tenantId/members                       members and roles             members.read
 *   PUT  /tenants/:tenantId/members/:userId/role          change a role                 roles.write
 *   GET  /tenants/:tenantId/budgets                       wallet, member, key budgets   budgets.read
 *   PUT  /tenants/:tenantId/budgets/:scope/:scopeId       set a user/key budget         budgets.write
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
  GatewayMemberRoleRequestSchema,
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
import { adminJson as ok, platformRoute, tenantRoute } from "../../../services/gateway-authz";

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
  tenantRoute("members.read", async (c, _actor, tenantId) =>
    ok(c, { members: await tenants(c.env).listMembers(tenantId) }),
  ),
);

adminTenantRoutes.put(
  "/tenants/:tenantId/members/:userId/role",
  tenantRoute("roles.write", async (c, actor, tenantId) => {
    const userId = gatewayParam(SubjectIdSchema, c.req.param("userId"), "userId");
    const body = await readGatewayJson(c, GatewayMemberRoleRequestSchema);
    const member = await tenants(c.env).setMemberRole({
      tenantId,
      userId,
      role: body.role,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { member });
  }),
);

adminTenantRoutes.get(
  "/tenants/:tenantId/budgets",
  tenantRoute("budgets.read", async (c, _actor, tenantId) => {
    const [budgets, summary] = await Promise.all([
      tenants(c.env).listBudgets(tenantId),
      billing(c.env).walletSummary(tenantId, 0),
    ]);
    return ok(c, { budgets, wallet: summary.wallet, subscription: summary.subscription });
  }),
);

adminTenantRoutes.put(
  "/tenants/:tenantId/budgets/:scope/:scopeId",
  tenantRoute("budgets.write", async (c, actor, tenantId) => {
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
  tenantRoute("keys.read", async (c, _actor, tenantId) => ok(c, { keys: await tenants(c.env).listKeys(tenantId) })),
);

adminTenantRoutes.put(
  "/tenants/:tenantId/keys/:keyId/rate-limit",
  tenantRoute("limits.write", async (c, actor, tenantId) => {
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
