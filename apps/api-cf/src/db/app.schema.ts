import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { users as betterAuthUsers } from "./better-auth.schema";
// No foreign keys — see AGENTS.md

/**
 * Projects table - stores basic project metadata
 * Canvas data (nodes/edges) is managed by Loro Sync Server in Durable Objects
 */
export const projects = sqliteTable("project", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

/** Cloud control-plane workspace. Identity rows intentionally have no FK. */
export const tenants = sqliteTable("tenant", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const tenantMembers = sqliteTable(
  "tenant_member",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.tenantId, table.userId] }),
    userIdx: index("tenant_member_user_idx").on(table.userId),
  }),
);

/**
 * API Tokens — enables CLI and external agent access.
 * Token format: clsh_ + 40 hex chars. Only SHA-256 hash is stored.
 */
export const apiTokens = sqliteTable(
  "api_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    apiTokenUserIdIdx: index("api_token_userId_idx").on(table.userId),
    apiTokenHashIdx: index("api_token_hash_idx").on(table.tokenHash),
  }),
);

/** Short-lived, one-time OAuth authorization codes for the public CLI client. */
export const cliOauthCodes = sqliteTable(
  "cli_oauth_code",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    cliOauthCodeExpiryIdx: index("cli_oauth_code_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

/**
 * User Variables — encrypted key-value store for API keys used by actions.
 * Values are AES-GCM encrypted with ACTION_SECRET_KEY env var.
 * Actions declare required variables in their manifest (secrets[]).
 * Platform decrypts and injects at runtime.
 */
export const userVariables = sqliteTable(
  "user_variable",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    userVariableUserIdx: index("user_variable_userId_idx").on(table.userId),
    userVariableUniqueIdx: index("user_variable_unique_idx").on(
      table.userId,
      table.key,
    ),
  }),
);

/**
 * Provider Accounts — encrypted credentials for model provider routing.
 * One user can store multiple accounts for the same provider; routing picks
 * enabled rows by priority. Secrets are encrypted as one credential map, while
 * configuredCredentials only stores non-sensitive key names for UI/catalog state.
 */
export const providerAccounts = sqliteTable(
  "provider_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    providerId: text("provider_id").notNull(),
    upstreamId: text("upstream_id"),
    apiShape: text("api_shape"),
    region: text("region"),
    label: text("label"),
    enabled: integer("enabled").notNull().default(1),
    priority: integer("priority"),
    weight: integer("weight"),
    encryptedCredentials: text("encrypted_credentials"),
    configuredCredentials: text("configured_credentials"),
    supportedModelIds: text("supported_model_ids"),
    modelPriorities: text("model_priorities"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    providerAccountUserIdx: index("provider_account_user_idx").on(table.userId),
    providerAccountProviderIdx: index("provider_account_provider_idx").on(
      table.userId,
      table.providerId,
      table.upstreamId,
    ),
  }),
);

/** Immutable per-request provider usage and estimated-cost audit events. */
export const providerUsageAudit = sqliteTable(
  "provider_usage_audit",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id"),
    modelId: text("model_id").notNull(),
    operation: text("operation").notNull(),
    taskId: text("task_id").notNull(),
    projectId: text("project_id"),
    nodeId: text("node_id"),
    actorType: text("actor_type"),
    actorUserId: text("actor_user_id"),
    actorAgentId: text("actor_agent_id"),
    providerRequestId: text("provider_request_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    estimatedCostMicroUsd: integer("estimated_cost_micro_usd"),
    estimateComplete: integer("estimate_complete").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    pricingSource: text("pricing_source").notNull(),
    billingBasis: text("billing_basis").notNull().default("{}"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => ({
    providerUsageAuditUserTimeIdx: index(
      "provider_usage_audit_user_time_idx",
    ).on(table.userId, table.occurredAt),
    providerUsageAuditUserTaskIdx: index(
      "provider_usage_audit_user_task_idx",
    ).on(table.userId, table.taskId),
  }),
);

export const modelCardConfigs = sqliteTable(
  "model_card_config",
  {
    userId: text("user_id").notNull(),
    modelId: text("model_id").notNull(),
    custom: integer("custom").notNull().default(0),
    kind: text("kind").notNull().default("text"),
    name: text("name"),
    description: text("description"),
    promptGuidance: text("prompt_guidance"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    modelCardConfigPk: primaryKey({ columns: [table.userId, table.modelId] }),
    modelCardConfigUserIdx: index("model_card_config_user_idx").on(
      table.userId,
    ),
  }),
);

export const modelCardProviderBindings = sqliteTable(
  "model_card_provider_binding",
  {
    userId: text("user_id").notNull(),
    modelId: text("model_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    upstreamModel: text("upstream_model").notNull(),
    position: integer("position").notNull().default(0),
  },
  (table) => ({
    modelCardProviderBindingPk: primaryKey({
      columns: [table.userId, table.modelId, table.providerAccountId],
    }),
    modelCardProviderBindingUserIdx: index(
      "model_card_provider_binding_user_idx",
    ).on(table.userId),
  }),
);

/**
 * Provider OAuth records — account-scoped authorization state for providers
 * that are not API-key based. Token payloads stay internal; public APIs only
 * expose status and device-flow metadata.
 */
export const providerOAuth = sqliteTable(
  "provider_oauth",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id"),
    status: text("status").notNull().default("pending"),
    encryptedTokens: text("encrypted_tokens"),
    verificationUri: text("verification_uri"),
    userCode: text("user_code"),
    deviceCode: text("device_code"),
    intervalSeconds: integer("interval_seconds"),
    accountLabel: text("account_label"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    error: text("error"),
    hasTokens: integer("has_tokens").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    providerOAuthUserIdx: index("provider_oauth_user_idx").on(table.userId),
    providerOAuthProviderIdx: index("provider_oauth_provider_idx").on(
      table.userId,
      table.providerId,
      table.accountId,
    ),
  }),
);

/**
 * Installed Actions — globally installed canvas actions per user.
 * Actions appear in all project toolbars.
 */
export const installedActions = sqliteTable(
  "installed_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => betterAuthUsers.id, { onDelete: "cascade" }),
    actionId: text("action_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    manifest: text("manifest").notNull(),
    runtime: text("runtime").notNull().default("worker"),
    version: text("version"),
    author: text("author"),
    repository: text("repository"),
    workerUrl: text("worker_url"),
    icon: text("icon"),
    color: text("color"),
    tags: text("tags"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    installedActionUserIdx: index("installed_action_userId_idx").on(
      table.userId,
    ),
    installedActionUniqueIdx: index("installed_action_unique_idx").on(
      table.userId,
      table.actionId,
    ),
  }),
);

/**
 * Assets — generated/uploaded media metadata.
 * Single source of truth per asset. Immutable to user APIs (only system writes).
 *
 * Storage: raw blobs referenced by `srcR2Key` (and `coverR2Key` for video
 * thumbnails). Descriptive metadata (dimensions, duration, byte size, audio
 * waveform peaks, future fields) lives in the JSON `metadata` column — none
 * of it is a query predicate, so collapsing those fields lets us evolve the
 * shape without migrations.
 */
export const assets = sqliteTable(
  "assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    srcR2Key: text("src_r2_key").notNull(),
    coverR2Key: text("cover_r2_key"),
    /** JSON-serialized AssetMetadata (see apps/api-cf/src/services/assets.ts). */
    metadata: text("metadata"),
    sourceModel: text("source_model"),
    sourcePrompt: text("source_prompt"),
    sourceTaskId: text("source_task_id"),
    /**
     * Lineage — JSON-serialized AssetSource[] (see @clash/shared-types/assets).
     * Each entry: { assetId, role: 'edit-source' | 'reference' | 'primary' }.
     * NULL on uploads and pre-lineage rows; populated by edit pipeline (single
     * 'edit-source') and generation pipelines (one per reference image).
     */
    sources: text("sources"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    assetsUserIdx: index("assets_user_idx").on(table.userId, table.createdAt),
    assetsTaskIdx: index("assets_task_idx").on(table.sourceTaskId),
  }),
);

/** Capability-broker audit log. Never stores credential values or payload bodies. */
export const pluginBrokerAudit = sqliteTable(
  "plugin_broker_audit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    capabilityId: text("capability_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    projectId: text("project_id").notNull(),
    invocationId: text("invocation_id").notNull(),
    requestId: text("request_id").notNull(),
    operation: text("operation").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => ({
    pluginBrokerAuditPluginIdx: index("plugin_broker_audit_plugin_idx").on(
      table.pluginId,
      table.occurredAt,
    ),
    pluginBrokerAuditInvocationIdx: index(
      "plugin_broker_audit_invocation_idx",
    ).on(table.invocationId, table.occurredAt),
  }),
);

/**
 * Asset References — M:N junction. One row per (asset, project) pair.
 * Cross-project import = INSERT here; R2 blob shared via assets.srcR2Key.
 * Delete a row when its project no longer references the asset; mark-and-sweep
 * GC reclaims R2 blobs once neither project nor library refs point to them.
 */
export const assetRefs = sqliteTable(
  "asset_refs",
  {
    assetId: text("asset_id").notNull(),
    projectId: text("project_id").notNull(),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.assetId, table.projectId] }),
    assetRefsProjectIdx: index("asset_refs_project_idx").on(table.projectId),
    assetRefsAssetIdx: index("asset_refs_asset_idx").on(table.assetId),
  }),
);

/** Explicit membership in a user's reusable global asset library. */
export const assetLibraryRefs = sqliteTable(
  "asset_library_refs",
  {
    assetId: text("asset_id").notNull(),
    userId: text("user_id").notNull(),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.assetId, table.userId] }),
    assetLibraryRefsUserIdx: index("asset_library_refs_user_idx").on(
      table.userId,
      table.addedAt,
    ),
    assetLibraryRefsAssetIdx: index("asset_library_refs_asset_idx").on(
      table.assetId,
    ),
  }),
);

/**
 * Installed Skills — globally installed AI agent skills per user.
 * Skills are SKILL.md instruction sets for Claude Code.
 */
export const installedSkills = sqliteTable(
  "installed_skill",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => betterAuthUsers.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    repository: text("repository"),
    version: text("version"),
    author: text("author"),
    icon: text("icon"),
    tags: text("tags"),
    linkedActionId: text("linked_action_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    installedSkillUserIdx: index("installed_skill_userId_idx").on(table.userId),
    installedSkillUniqueIdx: index("installed_skill_unique_idx").on(
      table.userId,
      table.skillId,
    ),
  }),
);
