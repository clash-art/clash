/**
 * Tenant credit purchases (#352), mounted at /api/v1/gateway. Authorization
 * is services/gateway-authz.ts: the tenant owner holds `billing.read` and
 * `billing.purchase`, a member neither. This is a product route: admin
 * accounts never reach it (#394); the console corrects a wallet with
 * wallet/adjust instead. Self-host (no billing plugin) has no payment provider:
 * the purchase routes grant credits directly. When a plugin declares
 * `billing.purchaseMode = "provider"` (#419) the three write routes refuse with
 * 409 GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER (the message names the
 * plugin's checkout path) before reading the body, and credits arrive only through the
 * plugin's verified webhooks (server-only API `@clash/api-cf/billing`); the
 * read route is unchanged. The credits fund the tenant
 * wallet (for a team tenant, the team wallet); member and key budgets are
 * unchanged. Every purchase takes an idempotency key: a repeat answers the
 * original purchase (200, `replayed: true`), the same key for a different
 * item is GATEWAY_IDEMPOTENCY_CONFLICT.
 *
 *   GET  /tenants/:tenantId/billing              wallet, live subscription, credit entries
 *   POST /tenants/:tenantId/subscription         subscribe to a package (first period granted)
 *   POST /tenants/:tenantId/subscription/cancel  end at the current period end
 *   POST /tenants/:tenantId/topups               buy a top-up pack
 */
import { GatewayError } from "@clash/gateway-core";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../config";
import { GatewaySubscribeRequestSchema, GatewayTopupRequestSchema } from "../../domain/requests";
import { createD1Billing } from "../../gateway/d1-billing";
import { monotonicClock } from "../../gateway/d1-common";
import { readGatewayJson } from "../../services/gateway-admin";
import { tenantRoute } from "../../services/gateway-authz";
import { billingPurchaseMode, getPlugins } from "../../plugins/registry";

type BillingContext = Context<{ Bindings: Env }>;

const NO_STORE = { "cache-control": "no-store" };

const billing = (c: BillingContext) => createD1Billing(c.env.DB, { clock: monotonicClock() });

/** Closes the free self-credit path when a payments plugin owns purchases (fail closed). */
function requireFreePurchaseMode(): void {
  const plugin = getPlugins();
  if (billingPurchaseMode(plugin) === "free") return;
  const checkoutPath = plugin.billing?.checkoutPath;
  throw new GatewayError("GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER", {
    ...(checkoutPath ? { message: `Purchases go through the payment provider's checkout: ${checkoutPath}` } : {}),
    details: { purchaseMode: "provider", ...(checkoutPath ? { checkoutPath } : {}) },
  });
}

export const gatewayBillingRoutes = new Hono<{ Bindings: Env }>();

gatewayBillingRoutes.get(
  "/tenants/:tenantId/billing",
  tenantRoute("billing.read", async (c, _actor, tenantId) => c.json(await billing(c).walletSummary(tenantId), 200, NO_STORE)),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/subscription",
  tenantRoute("billing.purchase", async (c, actor, tenantId) => {
    requireFreePurchaseMode();
    const body = await readGatewayJson(c, GatewaySubscribeRequestSchema);
    const result = await billing(c).subscribe({ tenantId, ...body, actor });
    return c.json(result, result.replayed ? 200 : 201, NO_STORE);
  }),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/subscription/cancel",
  tenantRoute("billing.purchase", async (c, actor, tenantId) => {
    requireFreePurchaseMode();
    return c.json({ subscription: await billing(c).cancelSubscription({ tenantId, actor }) }, 200, NO_STORE);
  }),
);

gatewayBillingRoutes.post(
  "/tenants/:tenantId/topups",
  tenantRoute("billing.purchase", async (c, actor, tenantId) => {
    requireFreePurchaseMode();
    const body = await readGatewayJson(c, GatewayTopupRequestSchema);
    const result = await billing(c).topup({ tenantId, ...body, actor });
    return c.json(result, result.replayed ? 200 : 201, NO_STORE);
  }),
);
