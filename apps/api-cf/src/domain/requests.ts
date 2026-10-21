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

/**
 * A configured rate limit (`rate_limit_json` on keys, catalog models, upstream
 * accounts, packages and subscriptions), as d1-limits.ts enforces it. At least
 * one bound; unknown fields are refused so a typo never silently admits.
 */
export const GatewayRateLimitSchema = z
  .object({
    requestsPerMinute: safeInt().positive().optional(),
    tokensPerMinute: safeInt().positive().optional(),
    concurrency: safeInt().positive().optional(),
  })
  .strict()
  .refine((limits) => Object.keys(limits).length > 0, "empty rate limit");
const RateLimitRequestSchema = GatewayRateLimitSchema;

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

// ─── Gateway admin console (#353) ──────────────────────────────────────────
// Guide: apps/docs/guide/gateway-admin.md. Authorization is
// services/gateway-authz.ts; these schemas only shape the requests.

/** Every role `tenant_member.role` may hold (#392; enforced in D1 by 0038). */
export const GATEWAY_TENANT_ROLES = ["owner", "member"] as const;
/** Platform grants (`gateway_platform_role`), separate from tenant roles. */
export const GATEWAY_PLATFORM_ROLES = ["platform_admin"] as const;

const reason = () => z.string().trim().min(1).max(500);
const identifier = () => z.string().regex(/^[A-Za-z0-9._:@/-]{1,256}$/);

/** Catalog version name, e.g. `2026-11-01` or `c12`. */
export const GatewayCatalogVersionSchema = GatewayPriceVersionSchema;
export const GatewayModelCodeSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/);

/** PUT /api/v1/admin/gateway/catalog/versions/:version/models/:modelCode (draft only). */
export const GatewayCatalogModelRequestSchema = z
  .object({
    /** A shared-types ModelCard whose id is the model code. */
    card: z.record(z.string(), z.unknown()),
    displayName: z.string().trim().min(1).max(128).nullable().optional(),
    enabled: z.boolean().default(true),
    maxOutputTokens: safeInt().positive().nullable().optional(),
    rateLimit: GatewayRateLimitSchema.nullable().optional(),
  })
  .strict();

/** POST /api/v1/admin/gateway/catalog/versions/:version/clone: a new draft copying `from`. */
export const GatewayCatalogCloneRequestSchema = z.object({ from: GatewayCatalogVersionSchema }).strict();

/** An upstream secret: a `GATEWAY_UPSTREAM_*` Worker secret name, or a key sealed on receipt. Write-only. */
export const GatewayUpstreamCredentialSchema = z.union([
  z.object({ secretRef: z.string().regex(/^GATEWAY_UPSTREAM_[A-Z0-9_]{1,120}$/) }).strict(),
  z
    .object({
      apiKey: z.string().trim().min(8).max(4096),
      baseUrl: z.url({ protocol: /^https$/ }).max(2048).optional(),
    })
    .strict(),
]);

const upstreamFields = {
  label: z.string().trim().min(1).max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  region: z.string().regex(/^[a-z0-9-]{0,32}$/).optional(),
  priority: z.number().int().min(0).max(1_000_000).nullable().optional(),
  weight: z.number().int().min(0).max(1_000_000).nullable().optional(),
  supportedModelIds: z.array(GatewayModelCodeSchema).max(500).nullable().optional(),
  modelPriorities: z.record(GatewayModelCodeSchema, z.number().int().min(0).max(1_000_000)).nullable().optional(),
  rateLimit: GatewayRateLimitSchema.nullable().optional(),
};

/** POST /api/v1/admin/gateway/upstreams. */
export const GatewayUpstreamCreateRequestSchema = z
  .object({
    providerId: z.string().regex(/^[a-z0-9._-]{1,64}$/),
    upstreamId: z.string().regex(/^[a-z0-9._-]{0,64}$/).optional(),
    apiShape: z.string().regex(/^[a-z0-9._-]{1,64}$/).nullable().optional(),
    ...upstreamFields,
    credential: GatewayUpstreamCredentialSchema,
  })
  .strict();

/** PATCH /api/v1/admin/gateway/upstreams/:id: non-secret fields; `enabled: false` disables. */
export const GatewayUpstreamUpdateRequestSchema = z
  .object(upstreamFields)
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "empty update");

/** POST /api/v1/admin/gateway/upstreams/:id/rotate. */
export const GatewayUpstreamRotateRequestSchema = z
  .object({ credential: GatewayUpstreamCredentialSchema, reason: reason().optional() })
  .strict();

/** PUT /api/v1/admin/gateway/tenants/:tenantId/budgets/(user|key)/:scopeId. */
export const GatewayBudgetSetRequestSchema = z
  .object({
    /** null: explicitly unlimited (the tenant wallet still caps it). */
    limitMicroCredits: safeInt().nullable(),
    status: z.enum(["active", "suspended"]).optional(),
    reason: reason().optional(),
  })
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

/** PUT …/keys/:keyId/rate-limit and …/subscription/rate-limit; null clears the limit. */
export const GatewayRateLimitUpdateRequestSchema = z
  .object({ rateLimit: GatewayRateLimitSchema.nullable(), reason: reason().optional() })
  .strict();

/** POST /api/v1/admin/gateway/platform-admins. */
export const GatewayPlatformAdminGrantRequestSchema = z
  .object({ userId: z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/), reason: reason().optional() })
  .strict();

/** POST /api/v1/admin/gateway/prompts/:requestId/access: break-glass, so a reason is required. */
export const GatewayPromptAccessRequestSchema = z.object({ reason: reason() }).strict();

/** POST /api/v1/admin/gateway/retention/purge: purge expired retained bodies now. */
export const GatewayRetentionPurgeRequestSchema = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();

/** POST /api/v1/admin/gateway/holds/sweep: expire stale budget holds now. */
export const GatewayHoldSweepRequestSchema = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();

const queryLimit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const queryInstant = () => isoInstant().optional();

/** GET /api/v1/admin/gateway/usage. */
export const GatewayUsageQuerySchema = z
  .object({
    tenantId: z.string().min(1).max(256).optional(),
    userId: identifier().optional(),
    keyId: identifier().optional(),
    modelCode: GatewayModelCodeSchema.optional(),
    kind: z.enum(["hold", "settle", "release", "refund", "adjust", "grant", "topup", "expire"]).optional(),
    from: queryInstant(),
    to: queryInstant(),
    limit: queryLimit(500, 100),
  })
  .strict();

/** GET /api/v1/admin/gateway/audit. */
export const GatewayAuditQuerySchema = z
  .object({
    tenantId: z.string().min(1).max(256).optional(),
    actorUserId: identifier().optional(),
    action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
    targetType: z.string().regex(/^[a-z_]{1,64}$/).optional(),
    targetId: z.string().min(1).max(256).optional(),
    from: queryInstant(),
    to: queryInstant(),
    limit: queryLimit(500, 100),
  })
  .strict();

/** GET /api/v1/admin/gateway/tenants. */
export const GatewayTenantListQuerySchema = z
  .object({ query: z.string().trim().min(1).max(128).optional(), limit: queryLimit(500, 100) })
  .strict();
