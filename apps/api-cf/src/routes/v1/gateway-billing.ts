/**
 * Tenant credit purchases (#352), mounted at /api/v1/gateway. A platform admin
 * or the tenant owner records a purchase; there is no payment provider. The
 * credits fund the tenant wallet (for a team tenant, the team wallet); member
 * and key budgets are unchanged. Every purchase takes an idempotency key: a
 * repeat answers the original purchase (200, `replayed: true`), the same key
 * for a different item is GATEWAY_IDEMPOTENCY_CONFLICT.
 *
 *   GET  /tenants/:tenantId/billing              wallet, live subscription, credit entries
 *   POST /tenants/:tenantId/subscription         subscribe to a package (first period granted)
 *   POST /tenants/:tenantId/subscription/cancel  end at the current period end
 *   POST /tenants/:tenantId/topups               buy a top-up pack
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { Env } from "../../config";
import { GatewaySubscribeRequestSchema, GatewayTopupRequestSchema } from "../../domain/requests";
import { createD1Billing, type BillingActor } from "../../gateway/d1-billing";
import { monotonicClock } from "../../gateway/d1-common";
import { gatewayParam, readGatewayJson, requireTenantBillingActor } from "../../services/gateway-admin";
import { gatewayErrorResponse } from "../../services/gateway-tokens";

type BillingContext = Context<{ Bindings: Env }>;

const NO_STORE = { "cache-control": "no-store" };
const TenantIdSchema = z.string().min(1).max(256);

/** Run `handler` as the tenant's owner or a platform admin; failures are coded. */
const tenantBilling =
  (handler: (c: BillingContext, tenantId: string, actor: BillingActor) => Promise<Response>) =>
  async (c: BillingContext) => {
    try {
      const tenantId = gatewayParam(TenantIdSchema, c.req.param("tenantId"), "tenantId");
      return await handler(c, tenantId, await requireTenantBillingActor(c, tenantId));
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

const billing = (c: BillingContext) => createD1Billing(c.env.DB, { clock: monotonicClock() });

export const gatewayBillingRoutes = new Hono<{ Bindings: Env }>();

gatewayBillingRoutes.get(
  "/tenants/:tenantId/billing",
  tenantBilling(async (c, tenantId) => c.json(await billing(c).walletSummary(tenantId), 200, NO_STORE)),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/subscription",
  tenantBilling(async (c, tenantId, actor) => {
    const body = await readGatewayJson(c, GatewaySubscribeRequestSchema);
    const result = await billing(c).subscribe({ tenantId, ...body, actor });
    return c.json(result, result.replayed ? 200 : 201, NO_STORE);
  }),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/subscription/cancel",
  tenantBilling(async (c, tenantId, actor) =>
    c.json({ subscription: await billing(c).cancelSubscription({ tenantId, actor }) }, 200, NO_STORE),
  ),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/topups",
  tenantBilling(async (c, tenantId, actor) => {
    const body = await readGatewayJson(c, GatewayTopupRequestSchema);
    const result = await billing(c).topup({ tenantId, ...body, actor });
    return c.json(result, result.replayed ? 200 : 201, NO_STORE);
  }),
);
