import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// No foreign keys — see AGENTS.md

/*
 * Clash official model gateway tables (web/drizzle/0032_gateway.sql; guide:
 * apps/docs/guide/gateway-schema.md). Timestamps are unix seconds; money is
 * integer micro-credits (1 credit = 1_000_000), matching @clash/gateway-core
 * `MicroCredits`. No column stores prompt, completion or response bodies.
 *
 * Retention: usage metadata 30 days (operational ledger columns are NULLed,
 * ended tokens deleted); ledger and admin audit 13 months.
 */

const createdAt = () =>
  integer("created_at")
    .notNull()
    .default(sql`(strftime('%s', 'now'))`);
const updatedAt = () =>
  integer("updated_at")
    .notNull()
    .default(sql`(strftime('%s', 'now'))`);

/** Virtual keys (sk_gw_…). Only the SHA-256 hash and a display prefix are stored. */
export const gatewayKeys = sqliteTable(
  "gateway_key",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    /** NULL means the whole published catalog. */
    modelAllowlistJson: text("model_allowlist_json"),
    /** `official` | `tenant`; a key is served by exactly one scope. */
    credentialScope: text("credential_scope").notNull().default("official"),
    budgetId: text("budget_id"),
    rateLimitJson: text("rate_limit_json"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("gateway_key_token_hash_idx").on(table.tokenHash),
    tenantUserIdx: index("gateway_key_tenant_user_idx").on(
      table.tenantId,
      table.userId,
    ),
    credentialScopeCheck: check(
      "gateway_key_credential_scope_check",
      sql`${table.credentialScope} IN ('official', 'tenant')`,
    ),
  }),
);

/** Short-lived gateway tokens; rows are deleted 30 days after expiry or revocation. */
export const gatewayTokens = sqliteTable(
  "gateway_token",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    keyId: text("key_id"),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    modelAllowlistJson: text("model_allowlist_json"),
    credentialScope: text("credential_scope").notNull().default("official"),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("gateway_token_token_hash_idx").on(
      table.tokenHash,
    ),
    tenantUserIdx: index("gateway_token_tenant_user_idx").on(
      table.tenantId,
      table.userId,
    ),
    expiresAtIdx: index("gateway_token_expires_at_idx").on(table.expiresAt),
    credentialScopeCheck: check(
      "gateway_token_credential_scope_check",
      sql`${table.credentialScope} IN ('official', 'tenant')`,
    ),
  }),
);

/**
 * Official upstream credentials, server-owned and disjoint from tenant BYOK
 * `provider_account`: no tenant or user column exists to select by. The secret
 * is a Worker secret reference or a sealed envelope, never plaintext.
 */
export const gatewayUpstreamAccounts = sqliteTable(
  "gateway_upstream_account",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    upstreamId: text("upstream_id").notNull().default(""),
    apiShape: text("api_shape"),
    region: text("region").notNull().default(""),
    label: text("label"),
    enabled: integer("enabled").notNull().default(1),
    priority: integer("priority"),
    weight: integer("weight"),
    supportedModelIdsJson: text("supported_model_ids_json"),
    modelPrioritiesJson: text("model_priorities_json"),
    secretRef: text("secret_ref"),
    encryptedCredentials: text("encrypted_credentials"),
    configuredCredentials: text("configured_credentials"),
    keyVersion: text("key_version").notNull().default("v1"),
    rateLimitJson: text("rate_limit_json"),
    rotatedAt: integer("rotated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    providerIdx: index("gateway_upstream_account_provider_idx").on(
      table.providerId,
      table.upstreamId,
      table.region,
    ),
    secretCheck: check(
      "gateway_upstream_account_secret_check",
      sql`${table.secretRef} IS NOT NULL OR ${table.encryptedCredentials} IS NOT NULL`,
    ),
  }),
);

/** Versioned published catalog: one model card per model per catalog version. */
export const gatewayModels = sqliteTable(
  "gateway_model",
  {
    id: text("id").primaryKey(),
    catalogVersion: text("catalog_version").notNull(),
    modelCode: text("model_code").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name"),
    enabled: integer("enabled").notNull().default(1),
    cardJson: text("card_json").notNull(),
    maxOutputTokens: integer("max_output_tokens"),
    rateLimitJson: text("rate_limit_json"),
    publishedAt: integer("published_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    versionCodeIdx: uniqueIndex("gateway_model_version_code_idx").on(
      table.catalogVersion,
      table.modelCode,
    ),
  }),
);

/** Price book rates: `amountMicro` per `per` units, in micro-units of `currency`. */
export const gatewayPrices = sqliteTable(
  "gateway_price",
  {
    id: text("id").primaryKey(),
    priceVersion: text("price_version").notNull(),
    modelCode: text("model_code").notNull(),
    /** '' applies to every upstream of the model. */
    upstreamId: text("upstream_id").notNull().default(""),
    unit: text("unit").notNull(),
    amountMicro: integer("amount_micro").notNull(),
    per: integer("per").notNull(),
    currency: text("currency").notNull().default("credit"),
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    source: text("source").notNull().default("manual"),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    rateIdx: uniqueIndex("gateway_price_rate_idx").on(
      table.priceVersion,
      table.modelCode,
      table.upstreamId,
      table.unit,
    ),
    modelEffectiveIdx: index("gateway_price_model_effective_idx").on(
      table.modelCode,
      table.effectiveFrom,
    ),
    amountCheck: check(
      "gateway_price_amount_check",
      sql`${table.amountMicro} >= 0`,
    ),
    perCheck: check("gateway_price_per_check", sql`${table.per} > 0`),
  }),
);

/**
 * Budgets: `tenant` is the team wallet, `user` a member budget the owner
 * allocates from it, `key` a per-key cap. NULL limit = explicitly unlimited.
 */
export const gatewayBudgets = sqliteTable(
  "gateway_budget",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    parentBudgetId: text("parent_budget_id"),
    allocatedByUserId: text("allocated_by_user_id"),
    period: text("period").notNull().default("none"),
    periodStart: integer("period_start"),
    resetAt: integer("reset_at"),
    limitMicroCredits: integer("limit_micro_credits"),
    spentMicroCredits: integer("spent_micro_credits").notNull().default(0),
    reservedMicroCredits: integer("reserved_micro_credits")
      .notNull()
      .default(0),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    scopeIdx: uniqueIndex("gateway_budget_scope_idx").on(
      table.tenantId,
      table.scope,
      table.scopeId,
    ),
    scopeCheck: check(
      "gateway_budget_scope_check",
      sql`${table.scope} IN ('tenant', 'user', 'key')`,
    ),
    limitCheck: check(
      "gateway_budget_limit_check",
      sql`${table.limitMicroCredits} IS NULL OR ${table.limitMicroCredits} >= 0`,
    ),
    spentCheck: check(
      "gateway_budget_spent_check",
      sql`${table.spentMicroCredits} >= 0`,
    ),
    reservedCheck: check(
      "gateway_budget_reserved_check",
      sql`${table.reservedMicroCredits} >= 0`,
    ),
  }),
);

export const GATEWAY_LEDGER_KINDS = [
  "hold",
  "settle",
  "release",
  "refund",
  "adjust",
  "grant",
  "topup",
  "expire",
] as const;

/**
 * Append-only money journal, one entry per (request_id, budget_id, kind).
 * Only a hold's status changes in place, in the batch that appends its
 * closing entry. Operational columns (upstream/account/provider request id,
 * error code) are NULLed after 30 days; rows are kept 13 months.
 */
export const gatewayUsageLedger = sqliteTable(
  "gateway_usage_ledger",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    /** '' when the entry draws on no budget. */
    budgetId: text("budget_id").notNull().default(""),
    kind: text("kind", { enum: GATEWAY_LEDGER_KINDS }).notNull(),
    status: text("status").notNull(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id"),
    keyId: text("key_id"),
    amountMicroCredits: integer("amount_micro_credits").notNull(),
    modelCode: text("model_code"),
    modelKind: text("model_kind"),
    credentialScope: text("credential_scope"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    unitsJson: text("units_json").notNull().default("{}"),
    usageSource: text("usage_source"),
    priceVersion: text("price_version"),
    catalogVersion: text("catalog_version"),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    upstreamId: text("upstream_id"),
    accountId: text("account_id"),
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    expiresAt: integer("expires_at"),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    entryIdx: uniqueIndex("gateway_usage_ledger_entry_idx").on(
      table.requestId,
      table.budgetId,
      table.kind,
    ),
    tenantTimeIdx: index("gateway_usage_ledger_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    keyTimeIdx: index("gateway_usage_ledger_key_time_idx").on(
      table.keyId,
      table.occurredAt,
    ),
    budgetStatusIdx: index("gateway_usage_ledger_budget_status_idx").on(
      table.budgetId,
      table.status,
    ),
    kindCheck: check(
      "gateway_usage_ledger_kind_check",
      sql`${table.kind} IN (${sql.raw(GATEWAY_LEDGER_KINDS.map((kind) => `'${kind}'`).join(", "))})`,
    ),
    amountCheck: check(
      "gateway_usage_ledger_amount_check",
      sql`${table.amountMicroCredits} >= 0`,
    ),
  }),
);

/** One append-only row per admin mutation, with redacted before/after snapshots. */
export const gatewayAdminAudit = sqliteTable(
  "gateway_admin_audit",
  {
    id: text("id").primaryKey(),
    /** '' for platform-wide changes. */
    tenantId: text("tenant_id").notNull().default(""),
    actorUserId: text("actor_user_id").notNull(),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    reason: text("reason"),
    requestId: text("request_id"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => ({
    tenantTimeIdx: index("gateway_admin_audit_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    targetIdx: index("gateway_admin_audit_target_idx").on(
      table.targetType,
      table.targetId,
    ),
  }),
);

/** Subscription packages: a fiat price (minor units) granting credits per period. */
export const gatewayPackages = sqliteTable(
  "gateway_package",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    billingPeriod: text("billing_period").notNull().default("month"),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency").notNull(),
    creditsMicro: integer("credits_micro").notNull(),
    modelAllowlistJson: text("model_allowlist_json"),
    rateLimitJson: text("rate_limit_json"),
    featuresJson: text("features_json").notNull().default("{}"),
    externalPriceId: text("external_price_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    priceCheck: check(
      "gateway_package_price_check",
      sql`${table.priceMinor} >= 0`,
    ),
    creditsCheck: check(
      "gateway_package_credits_check",
      sql`${table.creditsMicro} >= 0`,
    ),
  }),
);

/** One-off credit packs; a purchase is a ledger `topup` entry. */
export const gatewayTopupPacks = sqliteTable(
  "gateway_topup_pack",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency").notNull(),
    creditsMicro: integer("credits_micro").notNull(),
    validityDays: integer("validity_days"),
    externalPriceId: text("external_price_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    priceCheck: check(
      "gateway_topup_pack_price_check",
      sql`${table.priceMinor} >= 0`,
    ),
    creditsCheck: check(
      "gateway_topup_pack_credits_check",
      sql`${table.creditsMicro} >= 0`,
    ),
  }),
);

export const gatewayTenantSubscriptions = sqliteTable(
  "gateway_tenant_subscription",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    packageId: text("package_id").notNull(),
    status: text("status").notNull(),
    currentPeriodStart: integer("current_period_start").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
    cancelAt: integer("cancel_at"),
    canceledAt: integer("canceled_at"),
    externalSubscriptionId: text("external_subscription_id"),
    rateLimitJson: text("rate_limit_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    tenantStatusIdx: index("gateway_tenant_subscription_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  }),
);
