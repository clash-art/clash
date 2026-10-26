import { z } from "zod";
import {
  GATEWAY_BILLING_PERIODS,
  GATEWAY_BUDGET_ENFORCEMENTS,
  GATEWAY_PRICE_UNITS,
  GATEWAY_SUSPENSION_SUBJECTS,
  GatewayAbuseThresholdSchema,
  GatewayRateLimitSchema,
} from "@clash/gateway-core";

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
 * A configured rate limit (`rate_limit_json` on keys, members, tenants,
 * catalog models, upstream accounts, packages and subscriptions), as
 * d1-limits.ts enforces it: gateway-core's one schema. At least one bound;
 * unknown fields are refused so a typo never silently admits.
 */
export { GatewayRateLimitSchema };
const RateLimitRequestSchema = GatewayRateLimitSchema;

const currency = () => z.string().regex(/^[A-Z]{3}$/);
/** A payment provider's price/product id (#419): configuration, opaque to core. */
const externalPriceId = () => z.string().trim().min(1).max(256).regex(/^[\x21-\x7e]+$/);

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
/**
 * Admin account roles (`admin_accounts.role`, 0040): admin accounts, never
 * product users (#394). `support_agent` (0046, #356) triages abuse without
 * any credential, prompt or configuration access; it is not the team role
 * #392 retired.
 */
export const GATEWAY_PLATFORM_ROLES = ["platform_admin", "support_agent"] as const;

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

/**
 * POST /api/v1/admin/gateway/upstreams/:id/rotate: add key version N+1.
 * `drain` (default true) keeps the previous version until it is revoked;
 * `false` revokes every previous version at once.
 */
export const GatewayUpstreamRotateRequestSchema = z
  .object({ credential: GatewayUpstreamCredentialSchema, drain: z.boolean().optional(), reason: reason().optional() })
  .strict();

/** A key version name, e.g. `v2`. */
export const GatewayUpstreamKeyVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);

/** POST /api/v1/admin/gateway/upstreams/:id/revoke: remove one key version. */
export const GatewayUpstreamRevokeRequestSchema = z
  .object({ keyVersion: GatewayUpstreamKeyVersionSchema, reason: reason().optional() })
  .strict();

/**
 * PUT /api/v1/gateway/tenants/:tenantId/budgets/(user|key)/:scopeId: the team
 * owner allocates a member or key budget (team settings, #354).
 */
export const GatewayBudgetSetRequestSchema = z
  .object({
    /** null: explicitly unlimited (the tenant wallet still caps it). */
    limitMicroCredits: safeInt().nullable(),
    status: z.enum(["active", "suspended"]).optional(),
    /** hard (refuse), soft (admit and flag) or alert (admit and notify); unchanged when omitted, hard for a new budget. */
    enforcement: z.enum(GATEWAY_BUDGET_ENFORCEMENTS).optional(),
    /** 1-100: alert at this share of the limit; null clears it; unchanged when omitted. */
    alertThresholdPct: z.number().int().min(1).max(100).nullable().optional(),
    /**
     * Set a limit below what is already spent and held (refused otherwise
     * with GATEWAY_BUDGET_BELOW_USAGE). An override needs a reason and is
     * audited as `budget.override`.
     */
    override: z.literal(true).optional(),
    reason: reason().optional(),
  })
  .strict()
  .refine((body) => !body.override || body.reason !== undefined, { message: "an override needs a reason", path: ["reason"] });

/** Team name for POST /api/v1/gateway/teams. */
export const GatewayTeamCreateRequestSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

/** POST /api/v1/gateway/tenants/:tenantId/invites. */
export const GatewayInviteCreateRequestSchema = z
  .object({
    email: z.email().max(254).transform((email) => email.toLowerCase()),
    role: z.enum(GATEWAY_TENANT_ROLES).default("member"),
  })
  .strict();

/** The invite secret from the invite link (`gwi_<id>.<secret>`). */
export const GatewayInviteTokenSchema = z.string().regex(/^gwi_[0-9a-f]{24}\.[0-9a-f]{64}$/);

/** POST /api/v1/gateway/invites/lookup and /invites/accept. */
export const GatewayInviteTokenRequestSchema = z.object({ token: GatewayInviteTokenSchema }).strict();

/** PUT /api/v1/gateway/tenants/:tenantId/members/:userId/role. */
export const GatewayMemberRoleRequestSchema = z
  .object({ role: z.enum(GATEWAY_TENANT_ROLES), reason: reason().optional() })
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

/** An admin account id (`adm_…`, admin_accounts.id). */
export const GatewayAdminAccountIdSchema = z.string().regex(/^adm_[A-Za-z0-9]{1,64}$/);

/** POST /api/v1/admin/gateway/admin-accounts: a new admin account (#394). The password is never echoed or audited. */
export const GatewayAdminAccountCreateRequestSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(100),
    password: z.string().min(12).max(128),
    /** Absent: `platform_admin`. */
    role: z.enum(GATEWAY_PLATFORM_ROLES).optional(),
    reason: reason().optional(),
  })
  .strict();

/** POST /api/v1/admin/gateway/prompts/:requestId/access: break-glass, so a reason is required. */
export const GatewayPromptAccessRequestSchema = z.object({ reason: reason() }).strict();

/** POST /api/v1/admin/gateway/retention/purge: purge expired retained bodies now. */
export const GatewayRetentionPurgeRequestSchema = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();

/** PUT /api/v1/admin/gateway/abuse/thresholds/:signal (#356); `threshold: null` clears it. */
export const GatewayAbuseThresholdRequestSchema = z
  .object({ threshold: GatewayAbuseThresholdSchema.nullable(), reason: reason().optional() })
  .strict();

/**
 * POST /api/v1/admin/gateway/abuse/suspensions (#356): suspend a tenant or a
 * key by id. Ids only: suspending never needs or discloses key material.
 */
export const GatewaySuspendRequestSchema = z
  .object({ subjectKind: z.enum(GATEWAY_SUSPENSION_SUBJECTS), subjectId: identifier(), reason: reason() })
  .strict();

/** POST /api/v1/admin/gateway/abuse/suspensions/:suspensionId/lift (#356). */
export const GatewayLiftSuspensionRequestSchema = z.object({ reason: reason() }).strict();

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
    actorKind: z.enum(["admin", "user", "bootstrap", "migration"]).optional(),
    actorId: identifier().optional(),
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
