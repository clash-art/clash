import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// No foreign keys — see AGENTS.md

/*
 * Postgres Node self-host schema is postgres/0016_gateway.sql (#362, N2 kinds).
 * This file remains the D1/api-cf Drizzle mirror only — not a supported SQLite gateway topology.
 * Clash official model gateway tables (web/drizzle/0032_gateway.sql; guide:
 * apps/docs/guide/gateway-schema.md). Timestamps are unix seconds; money is
 * integer micro-credits (1 credit = 1_000_000), matching @clash/gateway-core
 * `MicroCredits`. No column stores prompt, completion or response bodies:
 * retained bodies are R2 objects, described by `gateway_request_retention`.
 *
 * Retention: usage metadata 30 days (operational ledger columns are NULLed,
 * ended tokens deleted); retained request/response bodies 30 days (0037);
 * ledger and admin audit 13 months.
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
    /** `session` (sessions.id) | `api_token` (api_token.id); NULL when minted from `keyId` (0033). */
    parentKind: text("parent_kind"),
    parentId: text("parent_id"),
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
    parentIdx: index("gateway_token_parent_idx").on(
      table.parentKind,
      table.parentId,
    ),
    parentKindCheck: check(
      "gateway_token_parent_kind_check",
      sql`${table.parentKind} IS NULL OR ${table.parentKind} IN ('session', 'api_token')`,
    ),
    credentialScopeCheck: check(
      "gateway_token_credential_scope_check",
      sql`${table.credentialScope} IN ('official', 'tenant')`,
    ),
  }),
);

/** The D1 surface the sign-out cascade needs; satisfied by D1Database. */
export interface GatewayTokenRevocationDb {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

/**
 * Sign-out cascade (#346): revoke every live gateway token minted from a
 * Better Auth session. Both Better Auth instances (web Worker and api-cf)
 * install it as `databaseHooks`, so sign-out, revoke-session(s) and user
 * deletion all cascade. Verification also requires the parent session row,
 * so a failed cascade write can never keep a token alive.
 */
export async function revokeSessionGatewayTokens(
  db: GatewayTokenRevocationDb,
  sessionId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare(
      `UPDATE gateway_token SET revoked_at = ?1
        WHERE parent_kind = 'session' AND parent_id = ?2 AND revoked_at IS NULL`,
    )
    .bind(nowSeconds, sessionId)
    .run();
}

/** Better Auth `databaseHooks` that run the cascade after a session row is deleted. */
export function gatewaySessionDatabaseHooks(
  db: () => GatewayTokenRevocationDb,
  onError: (error: unknown) => void = () => {},
) {
  return {
    session: {
      delete: {
        after: async (session: { id: string }) => {
          try {
            await revokeSessionGatewayTokens(db(), session.id);
          } catch (error) {
            onError(error);
          }
        },
      },
    },
  };
}

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
    /** The active key's first characters (0043, #350); never the key. */
    keyPrefix: text("key_prefix"),
    /** Highest key version number ever issued; a revoked number is never reused. */
    keySerial: integer("key_serial").notNull().default(1),
    /** The previous version while a rotation drains; refused-key retries fall back to it. */
    drainingKeyVersion: text("draining_key_version"),
    drainingSecretRef: text("draining_secret_ref"),
    drainingEncryptedCredentials: text("draining_encrypted_credentials"),
    drainingConfiguredCredentials: text("draining_configured_credentials"),
    drainingKeyPrefix: text("draining_key_prefix"),
    drainingSince: integer("draining_since"),
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

/**
 * Circuit-breaker counters per official upstream account (0043, #350):
 * operational state only, no request, tenant or key material. Times are
 * epoch milliseconds (`*_ms`).
 */
export const gatewayUpstreamHealth = sqliteTable(
  "gateway_upstream_health",
  {
    accountId: text("account_id").primaryKey(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    openUntilMs: integer("open_until_ms"),
    lastFailureCode: text("last_failure_code"),
    lastFailureAtMs: integer("last_failure_at_ms"),
    lastSuccessAtMs: integer("last_success_at_ms"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    failuresCheck: check("gateway_upstream_health_failures_check", sql`${table.consecutiveFailures} >= 0`),
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
    /** (0035) NULL: draft, never charged. Set once, when the version is published. */
    publishedAt: integer("published_at"),
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

export const GATEWAY_BUDGET_ENFORCEMENTS = ["hard", "soft", "alert"] as const;

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
    /** hard | soft | alert (0041; triggers keep a tenant wallet hard). */
    enforcement: text("enforcement", { enum: GATEWAY_BUDGET_ENFORCEMENTS }).notNull().default("hard"),
    /** 1-100: alert at this share of the limit; NULL = at the limit for `alert`, never otherwise. */
    alertThresholdPct: integer("alert_threshold_pct"),
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
 * closing entry, or to `settle_failed` (with error_code) when settlement
 * failed, pending reconciliation by a later settle. Operational columns
 * (upstream/account/provider request id, error code) are NULLed after 30
 * days; rows are kept 13 months.
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
    /** Stale-hold sweeper: open holds by expiry (0039). */
    holdExpiryIdx: index("gateway_usage_ledger_hold_expiry_idx").on(
      table.kind,
      table.status,
      table.expiresAt,
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

export const GATEWAY_BUDGET_EVENT_KINDS = ["soft_exceeded", "alert_threshold"] as const;

/**
 * Budget notifications (0041, #354), written in the reservation's batch:
 * `soft_exceeded` once per request admitted past a soft limit, and
 * `alert_threshold` once per budget, limit and threshold. Counters are the
 * budget's after the hold; metadata only.
 */
export const gatewayBudgetEvents = sqliteTable(
  "gateway_budget_event",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    budgetId: text("budget_id").notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    kind: text("kind", { enum: GATEWAY_BUDGET_EVENT_KINDS }).notNull(),
    enforcement: text("enforcement").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    requestId: text("request_id"),
    limitMicroCredits: integer("limit_micro_credits").notNull(),
    spentMicroCredits: integer("spent_micro_credits").notNull(),
    reservedMicroCredits: integer("reserved_micro_credits").notNull(),
    thresholdPct: integer("threshold_pct"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("gateway_budget_event_dedupe_idx").on(
      table.budgetId,
      table.kind,
      table.dedupeKey,
    ),
    tenantTimeIdx: index("gateway_budget_event_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    kindCheck: check(
      "gateway_budget_event_kind_check",
      sql`${table.kind} IN ('soft_exceeded', 'alert_threshold')`,
    ),
  }),
);

/**
 * Fixed-window request/token counters for the gateway limits port
 * (web/drizzle/0034_gateway_limits.sql). `subject` names what is counted and
 * always starts with its tenant (0041): `tenant:<t>`, `tenant:<t>:user:<u>`,
 * `tenant:<t>:key:<k>`, `tenant:<t>:model:<m>:user:<u>`; `window_start` is
 * unix seconds.
 */
export const gatewayRateWindows = sqliteTable(
  "gateway_rate_window",
  {
    subject: text("subject").notNull(),
    windowStart: integer("window_start").notNull(),
    requests: integer("requests").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.subject, table.windowStart] }),
  }),
);

/** In-flight concurrency leases; a lease expires on its own if never released. */
export const gatewayInflight = sqliteTable(
  "gateway_inflight",
  {
    leaseId: text("lease_id").notNull(),
    subject: text("subject").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leaseId, table.subject] }),
    subjectIdx: index("gateway_inflight_subject_idx").on(
      table.subject,
      table.expiresAt,
    ),
  }),
);

/**
 * Abuse observations (0046, #356): per-minute counters of authenticated
 * requests and 401 answers per tenant, key and client fingerprint (a
 * truncated hash, never the address). `''` tenant/key: an unrecognized
 * credential. Deleted after 24 hours.
 */
export const gatewayAbuseObservations = sqliteTable(
  "gateway_abuse_observation",
  {
    kind: text("kind", { enum: ["request", "auth_failure"] }).notNull(),
    tenantId: text("tenant_id").notNull().default(""),
    keyId: text("key_id").notNull().default(""),
    fingerprint: text("fingerprint").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.kind, table.tenantId, table.keyId, table.fingerprint, table.windowStart],
    }),
    timeIdx: index("gateway_abuse_observation_time_idx").on(table.kind, table.windowStart),
    kindCheck: check("gateway_abuse_observation_kind_check", sql`${table.kind} IN ('request', 'auth_failure')`),
  }),
);

export const GATEWAY_ABUSE_SIGNAL_NAMES = ["spend", "auth_failures", "shared_key", "velocity"] as const;

/** One configured threshold per abuse signal (0046); no row: shown, never acted on. */
export const gatewayAbuseThresholds = sqliteTable(
  "gateway_abuse_threshold",
  {
    signal: text("signal", { enum: GATEWAY_ABUSE_SIGNAL_NAMES }).primaryKey(),
    windowMinutes: integer("window_minutes").notNull(),
    alertAt: integer("alert_at").notNull(),
    /** NULL: alert only. */
    suspendAt: integer("suspend_at"),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => ({
    signalCheck: check(
      "gateway_abuse_threshold_signal_check",
      sql`${table.signal} IN ('spend', 'auth_failures', 'shared_key', 'velocity')`,
    ),
    windowCheck: check("gateway_abuse_threshold_window_check", sql`${table.windowMinutes} BETWEEN 1 AND 1440`),
    valueCheck: check(
      "gateway_abuse_threshold_value_check",
      sql`${table.alertAt} > 0 AND (${table.suspendAt} IS NULL OR ${table.suspendAt} >= ${table.alertAt})`,
    ),
  }),
);

/**
 * Suspensions of a tenant or a key (0046): token verification refuses a
 * credential while a suspension of its tenant, token or virtual key is active
 * (`lifted_at` NULL), with GATEWAY_SUSPENDED. History; never deleted.
 */
export const gatewaySuspensions = sqliteTable(
  "gateway_suspension",
  {
    id: text("id").primaryKey(),
    subjectKind: text("subject_kind", { enum: ["tenant", "key"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    source: text("source", { enum: ["manual", "auto"] }).notNull(),
    signal: text("signal"),
    reason: text("reason").notNull(),
    /** `admin` (an admin account) or `system` (a threshold). */
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: integer("created_at").notNull(),
    liftedAt: integer("lifted_at"),
    liftedBy: text("lifted_by"),
    liftReason: text("lift_reason"),
  },
  (table) => ({
    activeIdx: uniqueIndex("gateway_suspension_active_idx")
      .on(table.subjectKind, table.subjectId)
      .where(sql`${table.liftedAt} IS NULL`),
    tenantIdx: index("gateway_suspension_tenant_idx").on(table.tenantId, table.createdAt),
    subjectCheck: check("gateway_suspension_subject_check", sql`${table.subjectKind} IN ('tenant', 'key')`),
    sourceCheck: check(
      "gateway_suspension_source_check",
      sql`${table.source} IN ('manual', 'auto') AND (${table.source} = 'manual' OR ${table.signal} IS NOT NULL)`,
    ),
  }),
);

/** Threshold alerts (0046): one per signal, subject, threshold window and action. */
export const gatewayAbuseAlerts = sqliteTable(
  "gateway_abuse_alert",
  {
    id: text("id").primaryKey(),
    signal: text("signal", { enum: GATEWAY_ABUSE_SIGNAL_NAMES }).notNull(),
    subjectKind: text("subject_kind", { enum: ["tenant", "key", "client"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    tenantId: text("tenant_id").notNull().default(""),
    value: integer("value").notNull(),
    threshold: integer("threshold").notNull(),
    windowMinutes: integer("window_minutes").notNull(),
    windowStart: integer("window_start").notNull(),
    action: text("action", { enum: ["alert", "suspend"] }).notNull(),
    suspensionId: text("suspension_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("gateway_abuse_alert_dedupe_idx").on(
      table.signal,
      table.subjectKind,
      table.subjectId,
      table.windowStart,
      table.action,
    ),
    timeIdx: index("gateway_abuse_alert_time_idx").on(table.createdAt),
  }),
);

/**
 * One append-only row per admin mutation, with redacted before/after
 * snapshots. 0036 triggers refuse UPDATE, and DELETE before 13 months. The
 * actor is an identity kind plus its id (0040): admin accounts live in
 * ./admin-auth, never in the product users table (#394).
 */
export const gatewayAdminAudit = sqliteTable(
  "gateway_admin_audit",
  {
    id: text("id").primaryKey(),
    /** '' for platform-wide changes. */
    tenantId: text("tenant_id").notNull().default(""),
    /** An admin account id for `admin`, a product user id for `user`. */
    actorId: text("actor_id").notNull(),
    /** `admin`, `user` (a team role), `system` (an abuse threshold, 0046), `bootstrap` or `migration`. */
    actorKind: text("actor_kind").notNull().default("user"),
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
    timeIdx: index("gateway_admin_audit_time_idx").on(table.occurredAt),
    actorIdx: index("gateway_admin_audit_actor_idx").on(
      table.actorKind,
      table.actorId,
      table.occurredAt,
    ),
  }),
);

/**
 * Retained request/response body metadata (0037, 0039): where the two R2
 * objects are, their sizes and SHA-256, and whether a streamed answer's copy
 * was truncated at the cap. Never the bodies. `expires_at` is `stored_at` + 30
 * days; purge deletes the objects and sets `purged`.
 */
export const gatewayRequestRetention = sqliteTable(
  "gateway_request_retention",
  {
    requestId: text("request_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    keyId: text("key_id"),
    /** stored | failed | purged */
    status: text("status").notNull(),
    errorCode: text("error_code"),
    requestKey: text("request_key").notNull(),
    requestBytes: integer("request_bytes").notNull(),
    requestSha256: text("request_sha256").notNull(),
    requestType: text("request_type").notNull(),
    responseKey: text("response_key").notNull(),
    responseBytes: integer("response_bytes").notNull(),
    responseSha256: text("response_sha256").notNull(),
    responseType: text("response_type").notNull(),
    responseStatus: integer("response_status").notNull(),
    /**
     * 1: a streamed answer's copy was cut at the retention cap and ends in the
     * GATEWAY_RETENTION_TRUNCATED marker (0039).
     */
    responseTruncated: integer("response_truncated").notNull().default(0),
    /** With responseTruncated: bytes the caller actually received. */
    responseObservedBytes: integer("response_observed_bytes"),
    storedAt: integer("stored_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    purgedAt: integer("purged_at"),
  },
  (table) => ({
    statusCheck: check(
      "gateway_request_retention_status_check",
      sql`${table.status} IN ('stored', 'failed', 'purged')`,
    ),
    expiryIdx: index("gateway_request_retention_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    tenantTimeIdx: index("gateway_request_retention_tenant_time_idx").on(
      table.tenantId,
      table.storedAt,
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
    externalPriceIdx: uniqueIndex("gateway_package_external_price_idx").on(table.externalPriceId),
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
    externalPriceIdx: uniqueIndex("gateway_topup_pack_external_price_idx").on(table.externalPriceId),
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

export const GATEWAY_MEDIA_JOB_STATUSES = [
  "planned",
  "admitted",
  "settled",
  "refused",
] as const;
export type GatewayMediaJobStatus = (typeof GATEWAY_MEDIA_JOB_STATUSES)[number];

/**
 * Official media/AIGC jobs (0049, #359): one row per hosted generation run
 * served by official upstream accounts. The server-side record that the run
 * is official (only the run that planned it resolves official credentials)
 * and the durable anchor of its ledger request: `requestId` is the gateway
 * request id of the job's hold and settle rows. `jobJson` is the gateway-core
 * `GatewayMediaJob` (identity, frozen route, quantities, price instant);
 * never a prompt, output or credential.
 */
export const gatewayMediaJobs = sqliteTable(
  "gateway_media_job",
  {
    requestId: text("request_id").primaryKey(),
    taskId: text("task_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    modelCode: text("model_code").notNull(),
    kind: text("kind").notNull(),
    status: text("status", { enum: GATEWAY_MEDIA_JOB_STATUSES })
      .notNull()
      .default("planned"),
    jobJson: text("job_json").notNull(),
    leaseId: text("lease_id"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    taskIdx: uniqueIndex("gateway_media_job_task_idx").on(table.taskId),
    tenantTimeIdx: index("gateway_media_job_tenant_time_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    statusCheck: check(
      "gateway_media_job_status_check",
      sql`${table.status} IN (${sql.raw(GATEWAY_MEDIA_JOB_STATUSES.map((status) => `'${status}'`).join(", "))})`,
    ),
  }),
);
