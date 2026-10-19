import type { DatabaseSync } from "node:sqlite";

/**
 * Every Host table in `local.sqlite`, applied serially by the SQLite worker
 * when it opens (or reopens) a data dir. Stores no longer run DDL: before the
 * worker, each of a few dozen store connections ran its own copy of this on
 * first use, and concurrent first uses raced each other's migrations.
 *
 * Runs only inside the worker (erasable TypeScript, no Host imports).
 */
export const LOCAL_SQLITE_SCHEMA_STAGES: ReadonlyArray<
  readonly [string, (db: DatabaseSync) => void]
> = [
  ["metadata", applyMetadataSchema],
  ["provider", applyProviderSchema],
  ["config", applyConfigSchema],
  ["resources", applyResourceSchema],
  ["representations", applyRepresentationSchema],
  ["inspections", applyInspectionSchema],
  ["durable-run-journal", applyDurableRunJournalSchema],
  ["plugin-asset-staging", applyPluginAssetStagingSchema],
  ["durable-output-staging", applyDurableOutputStagingSchema],
  ["plugin-store", applyPluginStoreSchema],
  ["provider-execution-handoff", applyProviderExecutionHandoffSchema],
  ["cloud-content-upload-session", applyCloudContentUploadSessionSchema],
  ["local-replica-identity", applyLocalReplicaIdentitySchema],
];

function inTransaction(db: DatabaseSync, task: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    task();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  columnDefinition: string,
): void {
  const columnName = columnDefinition.trim().split(/\s+/)[0];
  if (!columnName) return;
  if (!columnNames(db, table).has(columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
  }
}

function tableSql(db: DatabaseSync, table: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return typeof row?.sql === "string" ? row.sql : undefined;
}

// ---------------------------------------------------------------------------
// Metadata store

function applyMetadataSchema(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_migration (
      id TEXT PRIMARY KEY NOT NULL,
      completed_at INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      metadata_provisional INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS project_preview_asset (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TEXT,
      position INTEGER NOT NULL,
      PRIMARY KEY (project_id, asset_id, position)
    );

    CREATE TABLE IF NOT EXISTS asset_metadata_index (
      asset_id TEXT NOT NULL,
      metadata_kind TEXT NOT NULL,
      project_id TEXT,
      schema_version INTEGER,
      content_hash TEXT,
      body_hash TEXT,
      producer TEXT NOT NULL,
      summary_json TEXT,
      identity_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (asset_id, metadata_kind)
    );

    CREATE TABLE IF NOT EXISTS metadata_attachment_index (
      target_key TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      target_json TEXT NOT NULL,
      metadata_kind TEXT NOT NULL,
      schema_version INTEGER,
      content_hash TEXT,
      body_hash TEXT,
      producer TEXT NOT NULL,
      summary_json TEXT,
      identity_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, metadata_kind)
    );
    CREATE INDEX IF NOT EXISTS metadata_attachment_project_kind_idx
      ON metadata_attachment_index (project_id, target_kind, metadata_kind);

    CREATE TABLE IF NOT EXISTS local_config (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_cloud_admission (
      project_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      local_replica_id TEXT NOT NULL,
      sync_base_url TEXT NOT NULL,
      status TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      admitted_at TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      last_synced_version BLOB,
      PRIMARY KEY (project_id, local_replica_id)
    );

    -- Additive derived Dashboard card cache. It can always be rebuilt from
    -- Project Loro; no Project, Asset, or user data depends on this table.
    CREATE TABLE IF NOT EXISTS project_card_summary (
      project_id TEXT PRIMARY KEY NOT NULL,
      replica_stamp TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      src_r2_key TEXT NOT NULL,
      cover_r2_key TEXT,
      metadata TEXT,
      source_model TEXT,
      source_prompt TEXT,
      source_task_id TEXT,
      sources TEXT,
      signed_url TEXT,
      signed_url_exp INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS asset_refs (
      asset_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (asset_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS asset_library_refs (
      asset_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (asset_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS global_asset_entry (
      library_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      delete_operation_id TEXT,
      deleted_at TEXT,
      purge_after TEXT,
      purged_at TEXT,
      name TEXT,
      metadata_json TEXT NOT NULL,
      provenance_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (library_id, id)
    );

    CREATE TABLE IF NOT EXISTS asset_node_refs (
      asset_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      field_path TEXT NOT NULL,
      reference_role TEXT NOT NULL DEFAULT 'asset',
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, node_id, field_path, asset_id)
    );

    CREATE TABLE IF NOT EXISTS text_revisions (
      revision_id TEXT PRIMARY KEY NOT NULL,
      text_id TEXT NOT NULL,
      parent_revision_id TEXT,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hash_algorithm TEXT NOT NULL,
      source_file_path TEXT NOT NULL,
      source_file_hash TEXT NOT NULL,
      actor_json TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_import_receipt (
      bundle_digest TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_session (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      runtime_id TEXT,
      agent_id TEXT,
      agent_template_id TEXT,
      permission_mode TEXT,
      acp_session_id TEXT,
      status TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_member (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      agent_id TEXT,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_message (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      turn_id TEXT,
      events_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS session_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mutation_audit (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      operation TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor_client_type TEXT,
      accepted INTEGER NOT NULL,
      reason TEXT,
      result_entity_id TEXT,
      error TEXT,
      mutation_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_broker_audit (
      id TEXT PRIMARY KEY NOT NULL,
      occurred_at TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      project_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    );
    COMMIT;
  `);
  ensureLocalMetadataColumns(db);
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE INDEX IF NOT EXISTS project_owner_idx ON project(owner_id, updated_at);
    CREATE INDEX IF NOT EXISTS project_cloud_admission_project_idx
      ON project_cloud_admission(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS assets_user_idx ON assets(user_id, created_at);
    CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(source_task_id);
    CREATE INDEX IF NOT EXISTS assets_project_idx ON assets(project_id, created_at);
    CREATE INDEX IF NOT EXISTS asset_refs_project_idx ON asset_refs(project_id, imported_at);
    CREATE INDEX IF NOT EXISTS global_asset_entry_library_idx
      ON global_asset_entry(library_id, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS asset_node_refs_asset_idx ON asset_node_refs(asset_id, project_id);
    CREATE INDEX IF NOT EXISTS asset_node_refs_project_idx ON asset_node_refs(project_id, node_id);
    CREATE INDEX IF NOT EXISTS text_revisions_project_node_idx ON text_revisions(project_id, node_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS text_revisions_text_idx ON text_revisions(text_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS runtime_session_project_idx ON runtime_session(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS agent_member_user_idx ON agent_member(user_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_message_session_idx ON chat_message(session_id, created_at);
    CREATE INDEX IF NOT EXISTS session_event_session_idx ON session_event(session_id, seq);
    CREATE INDEX IF NOT EXISTS mutation_audit_created_idx ON mutation_audit(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS mutation_audit_operation_idx ON mutation_audit(operation, created_at DESC);
    CREATE INDEX IF NOT EXISTS mutation_audit_entity_idx ON mutation_audit(entity_kind, entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS plugin_broker_audit_plugin_idx ON plugin_broker_audit(plugin_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS plugin_broker_audit_invocation_idx ON plugin_broker_audit(invocation_id, occurred_at DESC);
    COMMIT;
  `);
}

function ensureLocalMetadataColumns(db: DatabaseSync): void {
  tryAddColumn(db, "project_cloud_admission", "state_version INTEGER NOT NULL DEFAULT 0");
  tryAddColumn(db, "project_cloud_admission", "last_synced_version BLOB");
  for (const column of [
    "completed_at INTEGER NOT NULL DEFAULT 0",
    "source_path TEXT NOT NULL DEFAULT ''",
    "source_sha256 TEXT NOT NULL DEFAULT ''",
  ]) {
    tryAddColumn(db, "local_migration", column);
  }
  for (const column of [
    "owner_id TEXT NOT NULL DEFAULT ''",
    "name TEXT NOT NULL DEFAULT ''",
    "description TEXT",
    "created_at TEXT NOT NULL DEFAULT ''",
    "updated_at TEXT NOT NULL DEFAULT ''",
    "deleted_at TEXT",
    "metadata_provisional INTEGER NOT NULL DEFAULT 0",
  ]) {
    tryAddColumn(db, "project", column);
  }
  for (const column of [
    "asset_id TEXT NOT NULL DEFAULT ''",
    "url TEXT NOT NULL DEFAULT ''",
    "type TEXT NOT NULL DEFAULT 'image'",
    "storage_key TEXT NOT NULL DEFAULT ''",
    "created_at TEXT",
    "position INTEGER NOT NULL DEFAULT 0",
  ]) {
    tryAddColumn(db, "project_preview_asset", column);
  }
  for (const column of [
    "value_json TEXT NOT NULL DEFAULT '{}'",
    "updated_at TEXT NOT NULL DEFAULT ''",
  ]) {
    tryAddColumn(db, "local_config", column);
  }
  for (const column of [
    "user_id TEXT NOT NULL DEFAULT ''",
    "kind TEXT NOT NULL DEFAULT 'image'",
    "src_r2_key TEXT NOT NULL DEFAULT ''",
    "cover_r2_key TEXT",
    "metadata TEXT",
    "source_model TEXT",
    "source_prompt TEXT",
    "source_task_id TEXT",
    "sources TEXT",
    "signed_url TEXT",
    "signed_url_exp INTEGER",
    "created_at INTEGER NOT NULL DEFAULT 0",
    "updated_at INTEGER NOT NULL DEFAULT 0",
    "project_id TEXT",
  ]) {
    tryAddColumn(db, "assets", column);
  }
  tryAddColumn(db, "asset_refs", "imported_at INTEGER NOT NULL DEFAULT 0");
  for (const column of [
    "project_id TEXT NOT NULL DEFAULT ''",
    "node_id TEXT NOT NULL DEFAULT ''",
    "node_type TEXT NOT NULL DEFAULT ''",
    "field_path TEXT NOT NULL DEFAULT ''",
    "reference_role TEXT NOT NULL DEFAULT 'asset'",
    "observed_at INTEGER NOT NULL DEFAULT 0",
  ]) {
    tryAddColumn(db, "asset_node_refs", column);
  }
  for (const column of [
    "text_id TEXT NOT NULL DEFAULT ''",
    "parent_revision_id TEXT",
    "project_id TEXT NOT NULL DEFAULT ''",
    "node_id TEXT NOT NULL DEFAULT ''",
    "created_at TEXT NOT NULL DEFAULT ''",
    "content_hash TEXT NOT NULL DEFAULT ''",
    "hash_algorithm TEXT NOT NULL DEFAULT 'sha256-64'",
    "source_file_path TEXT NOT NULL DEFAULT ''",
    "source_file_hash TEXT NOT NULL DEFAULT ''",
    "actor_json TEXT",
  ]) {
    tryAddColumn(db, "text_revisions", column);
  }
  for (const column of [
    "project_id TEXT NOT NULL DEFAULT ''",
    "title TEXT NOT NULL DEFAULT ''",
    "type TEXT NOT NULL DEFAULT 'runtime'",
    "runtime_id TEXT",
    "agent_id TEXT",
    "agent_template_id TEXT",
    "permission_mode TEXT",
    "acp_session_id TEXT",
    "status TEXT",
    "archived_at TEXT",
    "created_at TEXT NOT NULL DEFAULT ''",
    "updated_at TEXT NOT NULL DEFAULT ''",
  ]) {
    tryAddColumn(db, "runtime_session", column);
  }
  for (const column of [
    "user_id TEXT NOT NULL DEFAULT ''",
    "template_id TEXT NOT NULL DEFAULT ''",
    "runtime_id TEXT NOT NULL DEFAULT ''",
    "agent_id TEXT",
    "display_name TEXT NOT NULL DEFAULT ''",
    "created_at INTEGER NOT NULL DEFAULT 0",
  ]) {
    tryAddColumn(db, "agent_member", column);
  }
  for (const column of [
    "sender_kind TEXT NOT NULL DEFAULT ''",
    "sender_id TEXT NOT NULL DEFAULT ''",
    "turn_id TEXT",
    "events_json TEXT NOT NULL DEFAULT '[]'",
    "created_at INTEGER NOT NULL DEFAULT 0",
  ]) {
    tryAddColumn(db, "chat_message", column);
  }
  for (const column of [
    "created_at INTEGER NOT NULL DEFAULT 0",
    "operation TEXT NOT NULL DEFAULT ''",
    "entity_kind TEXT NOT NULL DEFAULT ''",
    "entity_id TEXT NOT NULL DEFAULT ''",
    "actor_client_type TEXT",
    "accepted INTEGER NOT NULL DEFAULT 0",
    "reason TEXT",
    "result_entity_id TEXT",
    "error TEXT",
    "mutation_json TEXT NOT NULL DEFAULT '{}'",
  ]) {
    tryAddColumn(db, "mutation_audit", column);
  }
  dropColumnIfPresent(db, "mutation_audit", "forced");
  dropColumnIfPresent(db, "workspace_import_receipt", "source_workspace_id");
}

function tryAddColumn(
  db: DatabaseSync,
  table: string,
  columnDefinition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
  } catch {
    // Column already exists, or the existing table is too incompatible for safe repair.
  }
}

function dropColumnIfPresent(
  db: DatabaseSync,
  table: string,
  column: string,
): void {
  if (columnNames(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

// ---------------------------------------------------------------------------
// Provider store

function applyProviderSchema(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_migration (
      id TEXT PRIMARY KEY NOT NULL,
      completed_at INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_accounts (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      id TEXT,
      provider_id TEXT NOT NULL,
      upstream_id TEXT,
      api_shape TEXT,
      region TEXT,
      label TEXT,
      enabled INTEGER NOT NULL,
      priority REAL,
      weight REAL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, account_key)
    );

    CREATE TABLE IF NOT EXISTS provider_account_credentials (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      credential_key TEXT NOT NULL,
      credential_value TEXT NOT NULL,
      PRIMARY KEY (user_id, account_key, credential_key)
    );

    CREATE TABLE IF NOT EXISTS provider_account_supported_models (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, account_key, model_id)
    );

    CREATE TABLE IF NOT EXISTS provider_account_model_priorities (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      priority REAL NOT NULL,
      PRIMARY KEY (user_id, account_key, model_id)
    );

    CREATE TABLE IF NOT EXISTS model_card_configs (
      user_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      custom INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      description TEXT,
      prompt_guidance TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS model_card_provider_bindings (
      user_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, model_id, provider_account_id)
    );

    CREATE TABLE IF NOT EXISTS provider_oauth (
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      verification_uri TEXT,
      user_code TEXT,
      device_code TEXT,
      oauth_state TEXT,
      interval_seconds INTEGER,
      account_label TEXT,
      expires_at TEXT,
      error TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, provider_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS provider_usage_audit (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_account_id TEXT,
      model_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT,
      node_id TEXT,
      actor_type TEXT,
      actor_user_id TEXT,
      actor_agent_id TEXT,
      provider_request_id TEXT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      estimated_cost_micro_usd INTEGER,
      estimate_complete INTEGER NOT NULL,
      currency TEXT NOT NULL,
      pricing_source TEXT NOT NULL,
      billing_basis TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_usage_audit_user_time_idx
      ON provider_usage_audit (user_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS provider_usage_audit_task_idx
      ON provider_usage_audit (user_id, task_id, occurred_at ASC);
  `);
  try {
    ensureLocalProviderSqliteColumns(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sqlitePrimaryKeyColumns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({
      name: typeof row.name === "string" ? row.name : "",
      pk: typeof row.pk === "number" ? row.pk : 0,
    }))
    .filter((row) => row.name && row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
}

function hasPrimaryKey(
  db: DatabaseSync,
  table: string,
  expectedColumns: string[],
): boolean {
  const actual = sqlitePrimaryKeyColumns(db, table);
  return (
    actual.length === expectedColumns.length &&
    actual.every((column, index) => column === expectedColumns[index])
  );
}

function rebuildProviderTableIfPrimaryKeyDiffers(
  db: DatabaseSync,
  table: string,
  expectedPrimaryKey: string[],
  columns: string[],
  createTableSql: (tableName: string) => string,
): void {
  if (hasPrimaryKey(db, table, expectedPrimaryKey)) return;
  const tempTable = `${table}__schema_upgrade`;
  const columnList = columns.join(", ");
  db.exec(`
    DROP TABLE IF EXISTS ${tempTable};
    ${createTableSql(tempTable)}
    INSERT OR IGNORE INTO ${tempTable} (${columnList})
      SELECT ${columnList} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${tempTable} RENAME TO ${table};
  `);
}

function providerAccountsTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      id TEXT,
      provider_id TEXT NOT NULL,
      upstream_id TEXT,
      api_shape TEXT,
      region TEXT,
      label TEXT,
      enabled INTEGER NOT NULL,
      priority REAL,
      weight REAL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, account_key)
    );
  `;
}

function providerAccountCredentialsTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      credential_key TEXT NOT NULL,
      credential_value TEXT NOT NULL,
      PRIMARY KEY (user_id, account_key, credential_key)
    );
  `;
}

function providerAccountSupportedModelsTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, account_key, model_id)
    );
  `;
}

function providerAccountModelPrioritiesTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      priority REAL NOT NULL,
      PRIMARY KEY (user_id, account_key, model_id)
    );
  `;
}

function providerOAuthTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      verification_uri TEXT,
      user_code TEXT,
      device_code TEXT,
      oauth_state TEXT,
      interval_seconds INTEGER,
      account_label TEXT,
      expires_at TEXT,
      error TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, provider_id, account_id)
    );
  `;
}

function ensureLocalProviderSqliteColumns(db: DatabaseSync): void {
  for (const column of [
    "completed_at INTEGER NOT NULL DEFAULT 0",
    "source_path TEXT NOT NULL DEFAULT ''",
    "source_sha256 TEXT NOT NULL DEFAULT ''",
  ]) {
    addColumnIfMissing(db, "local_migration", column);
  }
  for (const column of [
    "account_key TEXT NOT NULL DEFAULT ''",
    "id TEXT",
    "provider_id TEXT NOT NULL DEFAULT ''",
    "upstream_id TEXT",
    "api_shape TEXT",
    "region TEXT",
    "label TEXT",
    "enabled INTEGER NOT NULL DEFAULT 1",
    "priority REAL",
    "weight REAL",
    "created_at TEXT",
    "updated_at TEXT",
  ]) {
    addColumnIfMissing(db, "provider_accounts", column);
  }
  for (const column of [
    "account_key TEXT NOT NULL DEFAULT ''",
    "credential_key TEXT NOT NULL DEFAULT ''",
    "credential_value TEXT NOT NULL DEFAULT ''",
  ]) {
    addColumnIfMissing(db, "provider_account_credentials", column);
  }
  for (const column of [
    "account_key TEXT NOT NULL DEFAULT ''",
    "model_id TEXT NOT NULL DEFAULT ''",
    "position INTEGER NOT NULL DEFAULT 0",
  ]) {
    addColumnIfMissing(db, "provider_account_supported_models", column);
  }
  for (const column of [
    "account_key TEXT NOT NULL DEFAULT ''",
    "model_id TEXT NOT NULL DEFAULT ''",
    "priority REAL NOT NULL DEFAULT 0",
  ]) {
    addColumnIfMissing(db, "provider_account_model_priorities", column);
  }
  for (const column of [
    "provider_id TEXT NOT NULL DEFAULT ''",
    "account_id TEXT NOT NULL DEFAULT ''",
    "status TEXT NOT NULL DEFAULT 'pending'",
    "access_token TEXT",
    "refresh_token TEXT",
    "token_type TEXT",
    "verification_uri TEXT",
    "user_code TEXT",
    "device_code TEXT",
    "oauth_state TEXT",
    "interval_seconds INTEGER",
    "account_label TEXT",
    "expires_at TEXT",
    "error TEXT",
    "created_at TEXT",
    "updated_at TEXT",
  ]) {
    addColumnIfMissing(db, "provider_oauth", column);
  }
  rebuildProviderTableIfPrimaryKeyDiffers(
    db,
    "provider_accounts",
    ["user_id", "account_key"],
    [
      "user_id",
      "account_key",
      "id",
      "provider_id",
      "upstream_id",
      "api_shape",
      "region",
      "label",
      "enabled",
      "priority",
      "weight",
      "created_at",
      "updated_at",
    ],
    providerAccountsTableSql,
  );
  rebuildProviderTableIfPrimaryKeyDiffers(
    db,
    "provider_account_credentials",
    ["user_id", "account_key", "credential_key"],
    ["user_id", "account_key", "credential_key", "credential_value"],
    providerAccountCredentialsTableSql,
  );
  rebuildProviderTableIfPrimaryKeyDiffers(
    db,
    "provider_account_supported_models",
    ["user_id", "account_key", "model_id"],
    ["user_id", "account_key", "model_id", "position"],
    providerAccountSupportedModelsTableSql,
  );
  rebuildProviderTableIfPrimaryKeyDiffers(
    db,
    "provider_account_model_priorities",
    ["user_id", "account_key", "model_id"],
    ["user_id", "account_key", "model_id", "priority"],
    providerAccountModelPrioritiesTableSql,
  );
  rebuildProviderTableIfPrimaryKeyDiffers(
    db,
    "provider_oauth",
    ["user_id", "provider_id", "account_id"],
    [
      "user_id",
      "provider_id",
      "account_id",
      "status",
      "access_token",
      "refresh_token",
      "token_type",
      "verification_uri",
      "user_code",
      "device_code",
      "oauth_state",
      "interval_seconds",
      "account_label",
      "expires_at",
      "error",
      "created_at",
      "updated_at",
    ],
    providerOAuthTableSql,
  );
}

// ---------------------------------------------------------------------------
// Smaller stores

function applyConfigSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_config (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function applyResourceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_resources (
      resource_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      digest_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      content_type TEXT,
      storage_key TEXT NOT NULL,
      facts_verified INTEGER NOT NULL DEFAULT 0 CHECK (facts_verified IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    DROP INDEX IF EXISTS local_resources_digest;
    CREATE INDEX IF NOT EXISTS local_resources_digest_lookup
      ON local_resources (digest_sha256);
    CREATE TABLE IF NOT EXISTS local_resource_staging (
      resource_id TEXT PRIMARY KEY,
      digest_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  if (!/\bfacts_verified\b/i.test(tableSql(db, "local_resources") ?? "")) {
    db.exec(`
      ALTER TABLE local_resources
        ADD COLUMN facts_verified INTEGER NOT NULL DEFAULT 0
        CHECK (facts_verified IN (0, 1));
    `);
  }
}

/**
 * The legacy thumbnail-only table is converted in one transaction: rename,
 * create, copy and drop either all land or none do. (Before the worker, the
 * copy ran after the rename had committed, so a crash in between lost rows.)
 */
function applyRepresentationSchema(db: DatabaseSync): void {
  const existing = tableSql(db, "local_asset_representations");
  if (existing !== undefined && !/\bresult_json\b/i.test(existing)) {
    inTransaction(db, () => {
      db.exec(`
        ALTER TABLE local_asset_representations RENAME TO local_asset_representations_legacy;
        CREATE TABLE local_asset_representations (
          source_resource_id TEXT NOT NULL,
          recipe TEXT NOT NULL,
          role TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source_resource_id, recipe)
        );
      `);
      const rows = db
        .prepare(
          "SELECT source_resource_id, recipe, representation_resource_id, created_at FROM local_asset_representations_legacy",
        )
        .all();
      const insert = db.prepare(`
        INSERT INTO local_asset_representations (
          source_resource_id, recipe, role, result_json, created_at
        ) VALUES (?, ?, 'thumbnail', ?, ?)
      `);
      for (const row of rows) {
        if (
          typeof row.source_resource_id === "string" &&
          typeof row.recipe === "string" &&
          typeof row.representation_resource_id === "string" &&
          typeof row.created_at === "number"
        ) {
          insert.run(
            row.source_resource_id,
            row.recipe,
            JSON.stringify({
              role: "thumbnail",
              recipe: row.recipe,
              resourceId: row.representation_resource_id,
            }),
            row.created_at,
          );
        }
      }
      db.exec("DROP TABLE local_asset_representations_legacy");
    });
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_asset_representations (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        role TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS local_asset_representations_role
      ON local_asset_representations (source_resource_id, role, created_at);
  `);
}

function applyInspectionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_asset_inspections (
      source_resource_id TEXT NOT NULL,
      recipe TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      inspected_at INTEGER NOT NULL,
      PRIMARY KEY (source_resource_id, recipe)
    );
  `);
  if (!/\brecipe\b/i.test(tableSql(db, "local_asset_inspections") ?? "")) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE local_asset_inspections
        RENAME TO local_asset_inspections_unversioned;
      CREATE TABLE local_asset_inspections (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        inspected_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
      DROP TABLE local_asset_inspections_unversioned;
      COMMIT;
    `);
  }
}

function applyDurableRunJournalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generator_definition_archive (
      plugin_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      PRIMARY KEY (plugin_id, definition_id, version, schema_hash)
    );
    CREATE TABLE IF NOT EXISTS durable_run_journal (
      action_run_id TEXT NOT NULL,
      output_slot TEXT NOT NULL,
      owner_realm TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      phase TEXT NOT NULL,
      recover_at INTEGER,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (action_run_id, output_slot)
    );

    CREATE INDEX IF NOT EXISTS durable_run_journal_recovery
      ON durable_run_journal (owner_realm, owner_id, recover_at);
  `);
}

function applyPluginAssetStagingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_plugin_asset_staging (
      project_id TEXT NOT NULL,
      project_asset_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      media_type TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, project_asset_id)
    );
    CREATE INDEX IF NOT EXISTS local_plugin_asset_staging_resource
      ON local_plugin_asset_staging (resource_id);
  `);
  addColumnIfMissing(db, "local_plugin_asset_staging", "byte_length INTEGER");
  addColumnIfMissing(db, "local_plugin_asset_staging", "account_id TEXT");
}

function applyDurableOutputStagingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_durable_output_staging (
      project_id TEXT NOT NULL,
      action_run_id TEXT NOT NULL,
      output_slot TEXT NOT NULL,
      project_asset_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, action_run_id, output_slot)
    );
  `);
  addColumnIfMissing(db, "local_durable_output_staging", "content_type TEXT");
  addColumnIfMissing(db, "local_durable_output_staging", "byte_length INTEGER");
}

function applyPluginStoreSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_store (
      plugin_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, account_id, key)
    );
  `);
}

function applyProviderExecutionHandoffSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_execution_handoff (
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, node_id)
    );
  `);
}

function applyCloudContentUploadSessionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_content_upload_session (
      session_key TEXT PRIMARY KEY,
      upload_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function applyLocalReplicaIdentitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_replica_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      replica_id TEXT NOT NULL
    );
  `);
}
