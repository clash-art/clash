import { z } from "zod";
import { GATEWAY_BILLING_PERIODS, GATEWAY_PRICE_UNITS } from "@clash/gateway-core";

/** Default model names — single source of truth for request schemas & response metadata. */
export const DEFAULT_IMAGE_MODEL = "nano-banana-2";
export const DEFAULT_VIDEO_MODEL = "kling-v1";

export const GenerateImageRequestSchema = z.object({
  prompt: z.string(),
  project_id: z.string().describe("Project ID for R2 storage path"),
  asset_id: z.string().describe("Pre-allocated asset ID"),
  asset_name: z.string().describe("Asset name for the record"),
  system_prompt: z.string().default(""),
  aspect_ratio: z.string().default("16:9"),
  base64_images: z.array(z.string()).default([]),
  reference_image_urls: z.array(z.string()).default([]),
  model_name: z.string().nullish().default(DEFAULT_IMAGE_MODEL),
});
export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;

export const GenerateVideoRequestSchema = z.object({
  prompt: z.string(),
  project_id: z.string().describe("Project ID for R2 storage path"),
  asset_id: z.string().describe("Pre-allocated asset ID"),
  asset_name: z.string().describe("Asset name for the record"),
  image_url: z.string().nullish(),
  base64_images: z.array(z.string()).default([]),
  reference_image_urls: z.array(z.string()).default([]),
  duration: z.number().default(5),
  cfg_scale: z.number().default(0.5),
  model: z.string().default(DEFAULT_VIDEO_MODEL),
});
export type GenerateVideoRequest = z.infer<typeof GenerateVideoRequestSchema>;

export const GenerateDescriptionRequestSchema = z.object({
  url: z.string(),
  task_id: z.string(),
});
export type GenerateDescriptionRequest = z.infer<typeof GenerateDescriptionRequestSchema>;

export const GenerateSemanticIDRequestSchema = z.object({
  project_id: z.string(),
  count: z.number().min(1).max(100).default(1),
});
export type GenerateSemanticIDRequest = z.infer<typeof GenerateSemanticIDRequestSchema>;

export const TaskSubmitRequestSchema = z.object({
  task_type: z.enum(["image_gen", "video_gen", "audio_gen", "text_gen", "image_desc", "video_desc", "video_thumbnail"]),
  project_id: z.string(),
  node_id: z.string(),
  params: z.record(z.string(), z.any()),
});
export type TaskSubmitRequest = z.infer<typeof TaskSubmitRequestSchema>;

/** Gateway token scopes: `models:invoke` calls the data plane; `usage:read` reads the caller's own usage. */
export const GATEWAY_TOKEN_SCOPES = ["models:invoke", "usage:read"] as const;
export type GatewayTokenScope = (typeof GATEWAY_TOKEN_SCOPES)[number];

/** POST /api/v1/gateway/tokens. Omitted fields: personal tenant, `models:invoke`, whole catalog. */
export const MintGatewayTokenRequestSchema = z
  .object({
    tenantId: z.string().min(1).max(256).optional(),
    scopes: z.array(z.enum(GATEWAY_TOKEN_SCOPES)).min(1).max(16).optional(),
    modelAllowlist: z.array(z.string().min(1).max(256)).min(1).max(256).optional(),
  })
  .strict();
export type MintGatewayTokenRequest = z.infer<typeof MintGatewayTokenRequestSchema>;

// ─── Gateway price book and credit billing (#352) ──────────────────────────
// Amounts are integer micro-credits (1 credit = 1_000_000); fiat prices are
// integer minor units of an ISO 4217 currency. Times are ISO 8601 instants.

const safeInt = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoInstant = () => z.iso.datetime({ offset: true });

/** Price-book version name, e.g. `2026-11-01` or `v12`. */
export const GatewayPriceVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/** Client-chosen purchase idempotency key; one key is one purchase per tenant. */
export const GatewayIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

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

const RateLimitRequestSchema = z
  .object({
    requestsPerMinute: z.number().int().positive().optional(),
    tokensPerMinute: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .strict()
  .refine((limits) => Object.keys(limits).length > 0, "empty rate limit");

const currency = () => z.string().regex(/^[A-Z]{3}$/);

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
  })
  .strict();

/** POST /api/v1/admin/gateway/topup-packs. Top-up credits do not expire. */
export const GatewayTopupPackCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    priceMinor: safeInt(),
    priceCurrency: currency(),
    microCredits: safeInt(),
  })
  .strict();

/** POST /api/v1/gateway/tenants/:tenantId/subscription. */
export const GatewaySubscribeRequestSchema = z
  .object({ packageId: z.string().min(1).max(128), idempotencyKey: GatewayIdempotencyKeySchema })
  .strict();

/** POST /api/v1/gateway/tenants/:tenantId/topups. */
export const GatewayTopupRequestSchema = z
  .object({ packId: z.string().min(1).max(128), idempotencyKey: GatewayIdempotencyKeySchema })
  .strict();

/** POST /api/v1/admin/gateway/billing/rollover. Omitted tenantId: every due subscription. */
export const GatewayRolloverRequestSchema = z
  .object({ tenantId: z.string().min(1).max(256).optional() })
  .strict();
