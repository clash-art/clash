/**
 * Credit billing port (#352, #419, #425): the one contract every host's
 * billing adapter implements, plus the rules both share. api-cf implements it
 * over D1 (apps/api-cf/src/gateway/d1-billing.ts, d1-price-book.ts), api-node
 * over Postgres (apps/api-node/src/gateway-billing.ts); the shared contract
 * suite (`@clash/gateway-core/contract`, `describeGatewayBillingContract`)
 * runs against both.
 *
 * Shared here, never per host:
 *
 * - the views, inputs and actors (a payment actor is
 *   `{ kind: "payment", provider, eventId }`, ledger actor `payment:<provider>`);
 * - ledger request ids, the idempotency anchors (`topup:<tenant>:<key>`,
 *   `refund:<tenant>:<key>`, `adjust:<tenant>:<key>`,
 *   `grant:<subscription>:<period start>`, `expire:<subscription>:<period start>`)
 *   and the subscription id derived from (tenant, key);
 * - ref kinds of credit `adjust` entries (`admin_credit`, `admin_debit`,
 *   `payment_refund`);
 * - purchase mode: a host passes `GatewayBillingPurchaseConfig` in (api-cf
 *   from its plugins, api-node from config/env); in `provider` mode the free
 *   self-credit routes refuse with 409 GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER
 *   before reading the body;
 * - the tenant billing route handlers (`createGatewayBillingHandlers`), so
 *   both hosts answer the same statuses and bodies.
 *
 * Adapters own durability only: each operation is atomic (one D1 batch or one
 * Postgres transaction); the ledger's (request_id, budget_id, kind)
 * uniqueness makes every credit write charge-once.
 */
import type { z } from "zod";

import type { GatewayBillingPeriod } from "./billing.js";
import { GatewayError } from "./errors.js";
import type { GatewayRateLimit } from "./limits.js";
import type { GatewayPriceUnit } from "./pricing.js";
import {
  GatewaySubscribeRequestSchema,
  GatewayTopupRequestSchema,
} from "./billing-schemas.js";

// ─── Actors ─────────────────────────────────────────────────────────────────

/** An authorized console or product caller (admin account or team role). */
export interface GatewayBillingStaffActor {
  kind: "admin" | "user";
  id: string;
  role: string;
}

/**
 * A payment provider's verified webhook (#419), as the system actor of a
 * purchase, renewal, cancel or refund. Ledger `actor_user_id` is
 * `payment:<provider>`; the audit row records provider and event id.
 */
export interface GatewayPaymentActor {
  kind: "payment";
  /** Provider slug, e.g. "polar": lowercase letters, digits, "-" or "_". */
  provider: string;
  /** The provider's webhook event id (or order id) this write answers. */
  eventId: string;
}

export type GatewayBillingActor =
  GatewayBillingStaffActor | GatewayPaymentActor;

/** The identity an audit row and a ledger `actor_user_id` record. */
export interface GatewayBillingAuditIdentity {
  kind: "admin" | "user" | "payment";
  id: string;
  role: string;
}

const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_EVENT_ID = 256;

/** The audit/ledger identity of an actor; a payment actor is validated first. */
export function billingAuditIdentity(
  actor: GatewayBillingActor,
): GatewayBillingAuditIdentity {
  if (actor.kind !== "payment") return actor;
  if (
    !PROVIDER_SLUG.test(actor.provider) ||
    !actor.eventId ||
    actor.eventId.length > MAX_EVENT_ID
  )
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "A payment actor needs a provider slug and an event id.",
      details: { actor: "payment" },
    });
  return {
    kind: "payment",
    id: `payment:${actor.provider}`,
    role: actor.provider,
  };
}

/** Provider and event id recorded in the audit snapshot of a payment write. */
export const billingPaymentRef = (actor: GatewayBillingActor) =>
  actor.kind === "payment"
    ? { payment: { provider: actor.provider, eventId: actor.eventId } }
    : {};

// ─── Ledger anchors ─────────────────────────────────────────────────────────

/** ref_kind of a platform wallet correction: the ledger amount is non-negative, so it carries the direction. */
export const GATEWAY_BILLING_ADMIN_CREDIT = "admin_credit";
export const GATEWAY_BILLING_ADMIN_DEBIT = "admin_debit";
/** ref_kind of a provider refund or chargeback: an `adjust` that removes credits (#419). */
export const GATEWAY_BILLING_PAYMENT_REFUND = "payment_refund";
/** `adjust` ref kinds that are wallet credit entries (shown in the billing summary). */
export const GATEWAY_BILLING_ADJUST_REF_KINDS = [
  GATEWAY_BILLING_ADMIN_CREDIT,
  GATEWAY_BILLING_ADMIN_DEBIT,
  GATEWAY_BILLING_PAYMENT_REFUND,
] as const;
/** Subscription statuses that are live: they grant credits and their rate limits apply. */
export const GATEWAY_LIVE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
] as const;
/** Bounds one rollover call for a subscription many periods behind; the next call continues. */
export const GATEWAY_BILLING_MAX_PERIODS_PER_ROLLOVER = 24;

export const billingRequestIds = {
  topup: (tenantId: string, key: string) => `topup:${tenantId}:${key}`,
  refund: (tenantId: string, key: string) => `refund:${tenantId}:${key}`,
  adjust: (tenantId: string, key: string) => `adjust:${tenantId}:${key}`,
  grant: (subscriptionId: string, periodStartS: number) =>
    `grant:${subscriptionId}:${periodStartS}`,
  expire: (subscriptionId: string, periodStartS: number) =>
    `expire:${subscriptionId}:${periodStartS}`,
};

const encoder = new TextEncoder();

/** The subscription id one (tenant, idempotency key) creates: a replay finds the same row. */
export async function billingSubscriptionId(
  tenantId: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${tenantId}\n${idempotencyKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `gws_${hex.slice(0, 32)}`;
}

/** A refund removes a positive whole number of micro-credits. */
export function assertRefundAmount(microCredits: number): void {
  if (!Number.isSafeInteger(microCredits) || microCredits <= 0)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "A refund removes a positive whole number of micro-credits.",
      details: { microCredits },
    });
}

// ─── Views ──────────────────────────────────────────────────────────────────

/** A stored rate limit (gateway-core GatewayRateLimitSchema). */
export type GatewayBillingRateLimit = Partial<GatewayRateLimit>;

export interface GatewayPackageView {
  id: string;
  name: string;
  status: "active" | "archived";
  billingPeriod: GatewayBillingPeriod;
  priceMinor: number;
  priceCurrency: string;
  /** Credits granted into the tenant wallet each period. */
  periodMicroCredits: number;
  rateLimit: GatewayBillingRateLimit | null;
  /** The payment provider's price id (configuration, #419); null when unset. */
  externalPriceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayTopupPackView {
  id: string;
  name: string;
  status: "active" | "archived";
  priceMinor: number;
  priceCurrency: string;
  /** Credits added to the tenant wallet; they do not expire. */
  microCredits: number;
  /** The payment provider's price id (configuration, #419); null when unset. */
  externalPriceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatewaySubscriptionView {
  id: string;
  tenantId: string;
  packageId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAt: string | null;
  canceledAt: string | null;
  /** Tenant rate limits while live (copied from the package, overridable by a platform admin). */
  rateLimit: GatewayBillingRateLimit | null;
}

export interface GatewayWalletView {
  budgetId: string;
  tenantId: string;
  status: string;
  /** null: explicitly unlimited (cannot hold purchased credits). */
  limitMicroCredits: number | null;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  availableMicroCredits: number | null;
}

export interface GatewayCreditEntryView {
  requestId: string;
  kind: "grant" | "topup" | "expire" | "adjust";
  amountMicroCredits: number;
  refKind: string | null;
  refId: string | null;
  actorUserId: string | null;
  occurredAt: string;
}

export interface GatewayPurchaseResult<T> {
  /** True when the idempotency key was already used for this same purchase. */
  replayed: boolean;
  entry: GatewayCreditEntryView;
  wallet: GatewayWalletView;
  subscription?: T;
}

export interface GatewayRolloverOutcome {
  subscriptionId: string;
  tenantId: string;
  periodsClosed: number;
  expiredMicroCredits: number;
  grantedMicroCredits: number;
  status: string;
  error?: { code: string; message: string };
}

export interface GatewayWalletSummary {
  wallet: GatewayWalletView | null;
  subscription: GatewaySubscriptionView | null;
  entries: GatewayCreditEntryView[];
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface GatewayPackageCreateInput {
  name: string;
  billingPeriod: GatewayBillingPeriod;
  priceMinor: number;
  priceCurrency: string;
  periodMicroCredits: number;
  rateLimit?: GatewayBillingRateLimit;
  externalPriceId?: string | null;
}

export interface GatewayTopupPackCreateInput {
  name: string;
  priceMinor: number;
  priceCurrency: string;
  microCredits: number;
  externalPriceId?: string | null;
}

export interface GatewayPurchaseInput {
  tenantId: string;
  idempotencyKey: string;
  actor: GatewayBillingActor;
}

export interface GatewayRefundInput {
  tenantId: string;
  microCredits: number;
  /** Use the provider's refund id: one key is one refund. */
  idempotencyKey: string;
  /** What was refunded, e.g. the provider order id; default the tenant id. */
  refId?: string;
  reason?: string;
  actor: GatewayPaymentActor;
}

// ─── The port ───────────────────────────────────────────────────────────────

/**
 * Packages, packs, purchases, period close and wallet corrections of the
 * tenant wallet (the `tenant`-scope budget). Every write is atomic and
 * audited; purchases and corrections are idempotent on their key: a repeat
 * answers the original (`replayed: true`), the same key for another item is
 * GATEWAY_IDEMPOTENCY_CONFLICT.
 */
export interface GatewayBillingPort {
  listPackages(): Promise<GatewayPackageView[]>;
  createPackage(
    input: GatewayPackageCreateInput,
    actor: GatewayBillingActor,
  ): Promise<GatewayPackageView>;
  /** No new subscriptions; live ones keep renewing. Archiving twice is a no-op. */
  archivePackage(
    id: string,
    actor: GatewayBillingActor,
  ): Promise<GatewayPackageView>;
  listTopupPacks(): Promise<GatewayTopupPackView[]>;
  createTopupPack(
    input: GatewayTopupPackCreateInput,
    actor: GatewayBillingActor,
  ): Promise<GatewayTopupPackView>;
  archiveTopupPack(
    id: string,
    actor: GatewayBillingActor,
  ): Promise<GatewayTopupPackView>;
  /** Set or clear (null); a price id held elsewhere is GATEWAY_EXTERNAL_PRICE_ID_TAKEN. */
  setPackageExternalPriceId(
    id: string,
    externalPriceId: string | null,
    actor: GatewayBillingActor,
  ): Promise<GatewayPackageView>;
  setTopupPackExternalPriceId(
    id: string,
    externalPriceId: string | null,
    actor: GatewayBillingActor,
  ): Promise<GatewayTopupPackView>;
  packageByExternalPriceId(
    externalPriceId: string,
  ): Promise<GatewayPackageView | null>;
  topupPackByExternalPriceId(
    externalPriceId: string,
  ): Promise<GatewayTopupPackView | null>;
  topup(
    input: GatewayPurchaseInput & { packId: string },
  ): Promise<GatewayPurchaseResult<never>>;
  /** One live subscription per tenant; the first period's grant is in the same write. */
  subscribe(
    input: GatewayPurchaseInput & { packageId: string },
  ): Promise<GatewayPurchaseResult<GatewaySubscriptionView>>;
  /** Ends the live subscription at its current period end; twice is a no-op. */
  cancelSubscription(input: {
    tenantId: string;
    actor: GatewayBillingActor;
  }): Promise<GatewaySubscriptionView>;
  /** Close every ended period as of now (idempotent; no background state). */
  rollover(input: {
    tenantId?: string;
    actor: GatewayBillingActor;
  }): Promise<GatewayRolloverOutcome[]>;
  walletSummary(
    tenantId: string,
    limit?: number,
  ): Promise<GatewayWalletSummary>;
  /** Platform correction: `adjust`, ref_kind admin_credit / admin_debit. */
  adjustWallet(input: {
    tenantId: string;
    deltaMicroCredits: number;
    reason: string;
    idempotencyKey: string;
    actor: GatewayBillingActor;
  }): Promise<GatewayPurchaseResult<never>>;
  /** Provider refund or chargeback: `adjust`, ref_kind payment_refund (#419). */
  refund(input: GatewayRefundInput): Promise<GatewayPurchaseResult<never>>;
  setWalletStatus(input: {
    tenantId: string;
    status: "active" | "suspended";
    reason: string;
    actor: GatewayBillingActor;
  }): Promise<GatewayWalletView>;
  setSubscriptionRateLimit(input: {
    tenantId: string;
    rateLimit: GatewayBillingRateLimit | null;
    reason?: string;
    actor: GatewayBillingActor;
  }): Promise<GatewaySubscriptionView>;
}

// ─── Price book port ────────────────────────────────────────────────────────

export interface GatewayPriceRateView {
  modelCode: string;
  /** '' prices every upstream of the model. */
  upstreamId: string;
  unit: GatewayPriceUnit;
  /** Price of `per` units, in micro-credits. */
  amountMicroCredits: number;
  per: number;
}

export interface GatewayPriceVersionView {
  version: string;
  status: "draft" | "published";
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  createdByUserId: string | null;
  rates: GatewayPriceRateView[];
}

export interface GatewayPriceDraftInput {
  version: string;
  /** Epoch ms. */
  effectiveFrom: number;
  /** Epoch ms; null: open-ended. */
  effectiveTo: number | null;
  rates: ReadonlyArray<{
    modelCode: string;
    upstreamId: string;
    unit: GatewayPriceUnit;
    microCredits: number;
    per: number;
  }>;
  actor: GatewayBillingStaffActor;
}

/**
 * Price-book versions: a draft is replaced as a whole and never charged; a
 * publish stamps every row at once, effective from max(effectiveFrom, now); a
 * published row never changes (GATEWAY_PRICE_VERSION_PUBLISHED). Policy is
 * `assertPriceDraftPolicy` (DeepSeek Flash only).
 */
export interface GatewayPriceBookPort {
  list(filter?: {
    modelCode?: string;
    status?: "draft" | "published";
  }): Promise<GatewayPriceVersionView[]>;
  read(version: string): Promise<GatewayPriceVersionView>;
  putDraft(input: GatewayPriceDraftInput): Promise<GatewayPriceVersionView>;
  publish(input: {
    version: string;
    actor: GatewayBillingStaffActor;
  }): Promise<GatewayPriceVersionView>;
}

// ─── Purchase mode (host configuration) ─────────────────────────────────────

export type GatewayBillingPurchaseMode = "free" | "provider";

/**
 * How credits are bought on this deployment, passed in by the host: api-cf
 * derives it from its plugins (`Plugin.billing`), api-node from
 * `GATEWAY_BILLING_PURCHASE_MODE` / `GATEWAY_BILLING_CHECKOUT_PATH`.
 */
export interface GatewayBillingPurchaseConfig {
  purchaseMode: GatewayBillingPurchaseMode;
  /** Where the client starts a purchase; returned in the 409 details. */
  checkoutPath?: string;
}

/** Closes the free self-credit path when a payment provider owns purchases (fail closed). */
export function assertFreePurchaseMode(
  config: GatewayBillingPurchaseConfig,
): void {
  if (config.purchaseMode === "free") return;
  const { checkoutPath } = config;
  throw new GatewayError("GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER", {
    ...(checkoutPath
      ? {
          message: `Purchases go through the payment provider's checkout: ${checkoutPath}`,
        }
      : {}),
    details: {
      purchaseMode: "provider",
      ...(checkoutPath ? { checkoutPath } : {}),
    },
  });
}

/** Parse a purchase-mode config value (env); anything but "provider" is refused unless empty/"free". */
export function parseGatewayBillingPurchaseMode(
  value: string | undefined,
): GatewayBillingPurchaseMode {
  const mode = value?.trim() ?? "";
  if (mode === "" || mode === "free") return "free";
  if (mode === "provider") return "provider";
  throw Error("GATEWAY_BILLING_PURCHASE_MODE must be free or provider");
}

// ─── Shared request parsing and tenant route handlers ───────────────────────

/** Parse a JSON request body with `schema`; failures are GATEWAY_INVALID_REQUEST naming the fields. */
export function parseGatewayJsonBody<T>(raw: string, schema: z.ZodType<T>): T {
  let body: unknown = {};
  if (raw.trim())
    try {
      body = JSON.parse(raw);
    } catch {
      throw new GatewayError("GATEWAY_INVALID_REQUEST", {
        details: { reason: "json" },
      });
    }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    });
  return parsed.data;
}

export interface GatewayBillingRouteResult {
  status: 200 | 201;
  body: unknown;
}

/**
 * Tenant billing route handlers both hosts mount at /api/v1/gateway (the host
 * authorizes: `billing.read` / `billing.purchase`, held by the tenant owner):
 *
 *   GET  /tenants/:tenantId/billing              summary
 *   GET  /tenants/:tenantId/billing/offers       offers (active packages and packs)
 *   POST /tenants/:tenantId/subscription         subscribe
 *   POST /tenants/:tenantId/subscription/cancel  cancel
 *   POST /tenants/:tenantId/topups               topup
 *
 * In provider mode the three writes refuse with 409 before reading the body.
 * Responses are `cache-control: no-store`.
 */
export function createGatewayBillingHandlers(
  billing: GatewayBillingPort,
  config: GatewayBillingPurchaseConfig | (() => GatewayBillingPurchaseConfig),
) {
  const mode = () => (typeof config === "function" ? config() : config);
  return {
    async summary(tenantId: string): Promise<GatewayBillingRouteResult> {
      return { status: 200, body: await billing.walletSummary(tenantId) };
    },
    async offers(): Promise<GatewayBillingRouteResult> {
      const [packages, packs] = await Promise.all([
        billing.listPackages(),
        billing.listTopupPacks(),
      ]);
      return {
        status: 200,
        body: {
          packages: packages.filter((entry) => entry.status === "active"),
          packs: packs.filter((entry) => entry.status === "active"),
        },
      };
    },
    async subscribe(
      tenantId: string,
      readBody: () => Promise<string>,
      actor: GatewayBillingActor,
    ): Promise<GatewayBillingRouteResult> {
      assertFreePurchaseMode(mode());
      const body = parseGatewayJsonBody(
        await readBody(),
        GatewaySubscribeRequestSchema,
      );
      const result = await billing.subscribe({ tenantId, ...body, actor });
      return { status: result.replayed ? 200 : 201, body: result };
    },
    async cancel(
      tenantId: string,
      actor: GatewayBillingActor,
    ): Promise<GatewayBillingRouteResult> {
      assertFreePurchaseMode(mode());
      return {
        status: 200,
        body: {
          subscription: await billing.cancelSubscription({ tenantId, actor }),
        },
      };
    },
    async topup(
      tenantId: string,
      readBody: () => Promise<string>,
      actor: GatewayBillingActor,
    ): Promise<GatewayBillingRouteResult> {
      assertFreePurchaseMode(mode());
      const body = parseGatewayJsonBody(
        await readBody(),
        GatewayTopupRequestSchema,
      );
      const result = await billing.topup({ tenantId, ...body, actor });
      return { status: result.replayed ? 200 : 201, body: result };
    },
  };
}
