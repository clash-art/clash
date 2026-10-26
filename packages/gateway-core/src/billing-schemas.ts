/**
 * Request schemas of the gateway price book and credit billing (#352, #419),
 * shared by every host (#425): api-cf and api-node parse the same bodies with
 * the same (single) zod. Amounts are integer micro-credits (1 credit =
 * 1_000_000); fiat prices are integer minor units of an ISO 4217 currency.
 * Times are ISO 8601 instants.
 */
import { z } from "zod";

import { GATEWAY_BILLING_PERIODS } from "./billing.js";
import { GatewayRateLimitSchema } from "./limits.js";
import { GATEWAY_PRICE_UNITS } from "./pricing.js";

const RateLimitRequestSchema = GatewayRateLimitSchema;
const reason = () => z.string().trim().min(1).max(500);

const safeInt = () =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoInstant = () => z.iso.datetime({ offset: true });

/** Price-book version name, e.g. `2026-11-01` or `v12`. */
export const GatewayPriceVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/);

/** Client-chosen purchase idempotency key; one key is one purchase per tenant. */
export const GatewayIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/);

/** PUT /api/v1/admin/gateway/prices/versions/:version: create or replace a draft. */
export const GatewayPriceDraftRequestSchema = z
  .object({
    effectiveFrom: isoInstant(),
    effectiveTo: isoInstant().nullable().optional(),
    rates: z
      .array(
        z
          .object({
            modelCode: z.string().min(1).max(256),
            /** Omitted or '': every upstream of the model. */
            upstreamId: z.string().max(256).optional(),
            unit: z.enum(GATEWAY_PRICE_UNITS),
            /** Price of `per` units, in micro-credits. */
            amountMicroCredits: safeInt(),
            per: safeInt().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

const currency = () => z.string().regex(/^[A-Z]{3}$/);
/** A payment provider's price/product id (#419): configuration, opaque to core. */
const externalPriceId = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[\x21-\x7e]+$/);

/** POST /api/v1/admin/gateway/packages. */
export const GatewayPackageCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    billingPeriod: z.enum(GATEWAY_BILLING_PERIODS),
    priceMinor: safeInt(),
    priceCurrency: currency(),
    /** Credits granted into the tenant wallet each period. */
    periodMicroCredits: safeInt(),
    /** Tenant rate limits while subscribed. */
    rateLimit: RateLimitRequestSchema.optional(),
    /** The payment provider's price id (#419). */
    externalPriceId: externalPriceId().nullable().optional(),
  })
  .strict();

/** POST /api/v1/admin/gateway/topup-packs. Top-up credits do not expire. */
export const GatewayTopupPackCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    priceMinor: safeInt(),
    priceCurrency: currency(),
    microCredits: safeInt(),
    /** The payment provider's price id (#419). */
    externalPriceId: externalPriceId().nullable().optional(),
  })
  .strict();

/** POST /api/v1/admin/gateway/{packages,topup-packs}/:id/external-price. null clears it. */
export const GatewayExternalPriceIdRequestSchema = z
  .object({ externalPriceId: externalPriceId().nullable() })
  .strict();

/** POST /api/v1/gateway/tenants/:tenantId/subscription. */
export const GatewaySubscribeRequestSchema = z
  .object({
    packageId: z.string().min(1).max(128),
    idempotencyKey: GatewayIdempotencyKeySchema,
  })
  .strict();

/** POST /api/v1/gateway/tenants/:tenantId/topups. */
export const GatewayTopupRequestSchema = z
  .object({
    packId: z.string().min(1).max(128),
    idempotencyKey: GatewayIdempotencyKeySchema,
  })
  .strict();

/** POST /api/v1/admin/gateway/billing/rollover. Omitted tenantId: every due subscription. */
export const GatewayRolloverRequestSchema = z
  .object({ tenantId: z.string().min(1).max(256).optional() })
  .strict();

/** POST /api/v1/admin/gateway/tenants/:tenantId/wallet/adjust (platform correction). */
export const GatewayWalletAdjustRequestSchema = z
  .object({
    deltaMicroCredits: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((value) => value !== 0, "zero adjustment"),
    reason: reason(),
    idempotencyKey: GatewayIdempotencyKeySchema,
  })
  .strict();

/** POST /api/v1/admin/gateway/tenants/:tenantId/wallet/status. */
export const GatewayWalletStatusRequestSchema = z
  .object({ status: z.enum(["active", "suspended"]), reason: reason() })
  .strict();
