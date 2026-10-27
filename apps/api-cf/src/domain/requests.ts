import { z } from "zod";
import {
  GATEWAY_BUDGET_ENFORCEMENTS,
  GATEWAY_SUSPENSION_SUBJECTS,
  GatewayAbuseThresholdSchema,
  GatewayIdempotencyKeySchema,
  GatewayPriceVersionSchema,
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
// The billing request schemas live in @clash/gateway-core (billing-schemas.ts,
// #425) so every host parses the same bodies; re-exported here.
export {
  GatewayExternalPriceIdRequestSchema,
  GatewayIdempotencyKeySchema,
  GatewayPackageCreateRequestSchema,
  GatewayPriceDraftRequestSchema,
  GatewayPriceVersionSchema,
  GatewayRolloverRequestSchema,
  GatewaySubscribeRequestSchema,
  GatewayTopupPackCreateRequestSchema,
  GatewayTopupRequestSchema,
  GatewayWalletAdjustRequestSchema,
  GatewayWalletStatusRequestSchema,
} from "@clash/gateway-core";

const safeInt = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoInstant = () => z.iso.datetime({ offset: true });

/**
 * A configured rate limit (`rate_limit_json` on keys, members, tenants,
 * catalog models, upstream accounts, packages and subscriptions), as
 * d1-limits.ts enforces it: gateway-core's one schema. At least one bound;
 * unknown fields are refused so a typo never silently admits.
 */
export { GatewayRateLimitSchema };
const RateLimitRequestSchema = GatewayRateLimitSchema;

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

/** POST /api/v1/admin/gateway/catalog/versions/:version/seed: the AIGC/media-first launch draft. */
export const GatewayCatalogSeedRequestSchema = z
  .object({
    /** Chat-only text models to add after every AIGC/media model; none by default. */
    textModelCodes: z.array(GatewayModelCodeSchema).max(200).optional(),
  })
  .strict();

/** A credential field name, e.g. `apiKey`, `accessKey`, `serviceAccountKey`. */
const credentialField = () => z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
const httpsUrl = () => z.url({ protocol: /^https$/ }).max(2048);

/**
 * An upstream secret, write-only: a `GATEWAY_UPSTREAM_*` Worker secret name
 * (with the field names its JSON value holds; `apiKey` alone by default), an
 * API key sealed on receipt, or several fields sealed on receipt (Kling's
 * `accessKey` + `secretKey`, a Vertex `serviceAccountKey`).
 */
export const GatewayUpstreamCredentialSchema = z.union([
  z
    .object({
      secretRef: z.string().regex(/^GATEWAY_UPSTREAM_[A-Z0-9_]{1,120}$/),
      fields: z.array(credentialField()).min(1).max(8).optional(),
    })
    .strict(),
  z
    .object({
      apiKey: z.string().trim().min(8).max(4096),
      baseUrl: httpsUrl().optional(),
    })
    .strict(),
  z
    .object({
      credentials: z
        .record(credentialField(), z.string().trim().min(1).max(16_384))
        .refine((fields) => {
          const count = Object.keys(fields).length;
          return count >= 1 && count <= 8;
        }, "1 to 8 credential fields")
        .refine((fields) => fields.baseUrl === undefined || httpsUrl().safeParse(fields.baseUrl).success, {
          message: "baseUrl must be an https URL",
          path: ["baseUrl"],
        })
        .refine((fields) => fields.apiKey === undefined || fields.apiKey.length >= 8, {
          message: "apiKey is too short",
          path: ["apiKey"],
        }),
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
  .object({
    credential: GatewayUpstreamCredentialSchema,
    drain: z.boolean().optional(),
    reason: reason().optional(),
  })
  .strict();

/** A key version name, e.g. `v2`. */
export const GatewayUpstreamKeyVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);

/** POST /api/v1/admin/gateway/upstreams/:id/revoke: remove one key version. */
export const GatewayUpstreamRevokeRequestSchema = z
  .object({
    keyVersion: GatewayUpstreamKeyVersionSchema,
    reason: reason().optional(),
  })
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

/** PUT …/keys/:keyId/rate-limit and …/subscription/rate-limit; null clears the limit. */
export const GatewayRateLimitUpdateRequestSchema = z
  .object({
    rateLimit: GatewayRateLimitSchema.nullable(),
    reason: reason().optional(),
  })
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
  .object({
    query: z.string().trim().min(1).max(128).optional(),
    limit: queryLimit(500, 100),
  })
  .strict();
