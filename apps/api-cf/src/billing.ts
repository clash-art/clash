/**
 * Server-only credit API for hosted payments plugins (#419).
 *
 * A plugin that sells credits through a payment provider declares
 * `billing: { purchaseMode: "provider" }` (plugins/types.ts), which closes the
 * free purchase routes (routes/v1/gateway-billing.ts), and records what the
 * provider confirmed through these operations from its verified webhook:
 *
 *   const billing = createD1Billing(env.DB, { clock: monotonicClock() });
 *   const actor = { kind: "payment", provider: "polar", eventId } as const;
 *   await billing.topup({ tenantId, packId, idempotencyKey: orderId, actor });
 *   await billing.subscribe({ tenantId, packageId, idempotencyKey: subscriptionId, actor });
 *   await billing.cancelSubscription({ tenantId, actor });
 *   await billing.refund({ tenantId, microCredits, idempotencyKey: refundId, refId: orderId, actor });
 *   await billing.rollover({ actor });               // scheduled period close
 *   await billing.topupPackByExternalPriceId(priceId); // price id → pack (configuration)
 *
 * Never mount these on a client-reachable route without the plugin's own
 * provider signature check: they credit the wallet unconditionally. The
 * tenant id must come from server-side state (checkout metadata the plugin
 * set), never from the client.
 */
export {
  createD1Billing,
  type BillingActor,
  type D1Billing,
  type PackageView,
  type PaymentActor,
  type PurchaseResult,
  type SubscriptionView,
  type TopupPackView,
  type WalletView,
} from "./gateway/d1-billing";
export { monotonicClock } from "./gateway/d1-common";
export { billingPurchaseMode } from "./plugins/registry";
export type { BillingPluginConfig, BillingPurchaseMode, Plugin } from "./plugins/types";
