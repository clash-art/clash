import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ProviderUsageAuditEventSchema,
  type ProviderUsageAuditEvent,
} from "@clash/shared-types";
import {
  providerAccountKey,
  type LocalProviderAccountConfig,
  type LocalProviderOAuthRecord,
  type LocalUserModelCardConfig,
} from "./provider-accounts.js";
import {
  createLocalSqliteConnection,
  type LocalSqliteDatabase as SqliteDatabase,
} from "./local-sqlite-connection.js";

const PROVIDER_ACCOUNTS_MIGRATION_ID = "provider-accounts-sqlite-v1";
const PROVIDER_OAUTH_MIGRATION_ID = "provider-oauth-sqlite-v1";
const VOLCENGINE_MODELARK_MIGRATION_ID = "provider-accounts-volcengine-modelark-v1";
const LEGACY_VOLCENGINE_ID = "volcengine";
const CANONICAL_VOLCENGINE_MODELARK_ID = "volcengine-modelark";
const SECRET_PREFIX = "enc:v1:";
const secretKeyCache = new Map<string, Promise<Buffer>>();

function sqlitePath(dataDir: string): string {
  return join(dataDir, "local.sqlite");
}

/**
 * Where the encryption key lives, which is not beside what it encrypts.
 *
 * It used to be `provider-secret.key` in the same directory as `local.sqlite`, both 0600. Anything
 * that copied the data directory -- a backup, a support bundle, an rsync -- carried the ciphertext
 * and its key together, which makes the encryption an encoding.
 *
 * A platform keystore is the real answer and is not this. Electron's `safeStorage` fits the app;
 * the daemon needs a route that does not prompt on every unattended read, and `keytar` was archived
 * in 2023. Until that is settled, separating the two at least makes copying the data directory
 * insufficient.
 */
export function providerSecretKeyPath(dataDir: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || dataDir;
  return join(home, ".clash", "keys", "provider-secret.key");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  return optionalString(row[key]);
}

function rowOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  return optionalNumber(row[key]);
}

function keyFromString(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.startsWith("base64:")) {
    const decoded = Buffer.from(trimmed.slice("base64:".length), "base64");
    if (decoded.byteLength === 32) return decoded;
  }
  return createHash("sha256").update(trimmed).digest();
}

async function resolveKeyFromFile(dataDir: string): Promise<Buffer> {
  const path = providerSecretKeyPath(dataDir);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return keyFromString(`base64:${existing}`);
  } catch {
    // Generate below.
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64");
  await writeFile(path, `${generated}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return keyFromString(`base64:${generated}`);
}

export async function resolveProviderSecretKey(dataDir: string): Promise<Buffer> {
  const cached = secretKeyCache.get(dataDir);
  if (cached) return cached;
  const task = (async () => {
    const envKey = process.env.CLASH_LOCAL_PROVIDER_SECRET_KEY || process.env.CLASH_LOCAL_SECRET_KEY;
    if (envKey) return keyFromString(envKey);
    return resolveKeyFromFile(dataDir);
  })();
  secretKeyCache.set(dataDir, task);
  return task;
}

function encryptSecret(value: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_PREFIX.slice(0, -1),
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptSecret(value: string, key: Buffer, aad: string): string {
  if (!value.startsWith(SECRET_PREFIX)) return value;
  const parts = value.split(":");
  if (parts.length !== 5) throw new Error("Invalid encrypted local provider secret");
  const [, version, ivText, tagText, encryptedText] = parts;
  if (version !== "v1") throw new Error(`Unsupported encrypted local provider secret version: ${version}`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt local provider secret", { cause: error });
  }
}

function providerCredentialAad(userId: string, accountKey: string, credentialKey: string): string {
  return `provider-account-credential:${userId}:${accountKey}:${credentialKey}`;
}

function providerOAuthAad(userId: string, providerId: string, accountId: string, field: string): string {
  return `provider-oauth:${userId}:${providerId}:${accountId}:${field}`;
}

async function rowCount(db: SqliteDatabase, sql: string): Promise<number> {
  const row = await db.prepare(sql).get();
  const value = row?.count;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function hasMigrationMarker(db: SqliteDatabase, id: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT id FROM local_migration WHERE id = ?").get(id));
}

async function markMigration(db: SqliteDatabase, id: string, dataDir: string, sourceSha256: string): Promise<void> {
  await db.prepare(`
    INSERT OR REPLACE INTO local_migration (id, completed_at, source_path, source_sha256)
    VALUES (?, ?, ?, ?)
  `).run(id, Math.floor(Date.now() / 1000), sqlitePath(dataDir), sourceSha256);
}

async function hasProviderAccountRows(db: SqliteDatabase): Promise<boolean> {
  return (await rowCount(db, "SELECT COUNT(*) AS count FROM provider_accounts")) > 0;
}

async function hasProviderOAuthRows(db: SqliteDatabase): Promise<boolean> {
  return (await rowCount(db, "SELECT COUNT(*) AS count FROM provider_oauth")) > 0;
}

async function hasLegacyVolcengineModelarkRows(db: SqliteDatabase): Promise<boolean> {
  return (await rowCount(db, `
    SELECT COUNT(*) AS count
      FROM provider_accounts
     WHERE provider_id = '${LEGACY_VOLCENGINE_ID}'
       AND upstream_id = '${LEGACY_VOLCENGINE_ID}'
  `)) > 0;
}

/**
 * Only a row whose provider and upstream are both the legacy bare `volcengine`
 * id is the old ModelArk account. Sibling ecosystems (`volcengine-speech`,
 * `volcengine-mediakit`) and rows matching a single column stay untouched.
 */
function canonicalizeVolcengineModelarkAccount(account: LocalProviderAccountConfig): LocalProviderAccountConfig {
  if (account.providerId !== LEGACY_VOLCENGINE_ID || account.upstreamId !== LEGACY_VOLCENGINE_ID) return account;
  return {
    ...account,
    providerId: CANONICAL_VOLCENGINE_MODELARK_ID,
    upstreamId: CANONICAL_VOLCENGINE_MODELARK_ID,
  };
}

async function clearProviderAccountsUnsafe(db: SqliteDatabase): Promise<void> {
  await db.prepare("DELETE FROM provider_account_model_priorities").run();
  await db.prepare("DELETE FROM provider_account_supported_models").run();
  await db.prepare("DELETE FROM provider_account_credentials").run();
  await db.prepare("DELETE FROM provider_accounts").run();
}

async function clearProviderOAuthUnsafe(db: SqliteDatabase): Promise<void> {
  await db.prepare("DELETE FROM provider_oauth").run();
}

async function hasPlaintextProviderAccountSecrets(db: SqliteDatabase): Promise<boolean> {
  return (await rowCount(db, `
    SELECT COUNT(*) AS count
      FROM provider_account_credentials
     WHERE credential_value IS NOT NULL
       AND credential_value != ''
       AND credential_value NOT LIKE '${SECRET_PREFIX}%'
  `)) > 0;
}

async function hasPlaintextProviderOAuthSecrets(db: SqliteDatabase): Promise<boolean> {
  return (await rowCount(db, `
    SELECT COUNT(*) AS count
      FROM provider_oauth
     WHERE (access_token IS NOT NULL AND access_token != '' AND access_token NOT LIKE '${SECRET_PREFIX}%')
        OR (refresh_token IS NOT NULL AND refresh_token != '' AND refresh_token NOT LIKE '${SECRET_PREFIX}%')
        OR (user_code IS NOT NULL AND user_code != '' AND user_code NOT LIKE '${SECRET_PREFIX}%')
        OR (device_code IS NOT NULL AND device_code != '' AND device_code NOT LIKE '${SECRET_PREFIX}%')
        OR (oauth_state IS NOT NULL AND oauth_state != '' AND oauth_state NOT LIKE '${SECRET_PREFIX}%')
  `)) > 0;
}

async function replaceProviderAccountsUnsafe(db: SqliteDatabase, accounts: LocalProviderAccountConfig[], secretKey: Buffer): Promise<void> {
  await clearProviderAccountsUnsafe(db);

  const insertAccount = db.prepare(`
    INSERT INTO provider_accounts (
      user_id, account_key, id, provider_id, upstream_id, region, label,
      api_shape, enabled, priority, weight, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCredential = db.prepare(`
    INSERT INTO provider_account_credentials (
      user_id, account_key, credential_key, credential_value
    ) VALUES (?, ?, ?, ?)
  `);
  const insertSupportedModel = db.prepare(`
    INSERT INTO provider_account_supported_models (
      user_id, account_key, model_id, position
    ) VALUES (?, ?, ?, ?)
  `);
  const insertModelPriority = db.prepare(`
    INSERT INTO provider_account_model_priorities (
      user_id, account_key, model_id, priority
    ) VALUES (?, ?, ?, ?)
  `);

  for (const account of accounts) {
    const userId = account.userId ?? "local-user";
    const accountKey = providerAccountKey(account);
    await insertAccount.run(
      userId,
      accountKey,
      account.id ?? null,
      account.providerId,
      account.upstreamId ?? null,
      account.region ?? null,
      account.label ?? null,
      account.apiShape ?? null,
      account.enabled ? 1 : 0,
      account.priority ?? null,
      account.weight ?? null,
      account.createdAt ?? null,
      account.updatedAt ?? null,
    );
    for (const [credentialKey, value] of Object.entries(account.credentials ?? {})) {
      await insertCredential.run(
        userId,
        accountKey,
        credentialKey,
        encryptSecret(value, secretKey, providerCredentialAad(userId, accountKey, credentialKey)),
      );
    }
    for (const [position, modelId] of (account.supportedModelIds ?? []).entries()) {
      await insertSupportedModel.run(userId, accountKey, modelId, position);
    }
    for (const [modelId, priority] of Object.entries(account.modelPriorities ?? {})) {
      await insertModelPriority.run(userId, accountKey, modelId, priority);
    }
  }
}

async function replaceProviderOAuthUnsafe(db: SqliteDatabase, records: LocalProviderOAuthRecord[], secretKey: Buffer): Promise<void> {
  await clearProviderOAuthUnsafe(db);
  const insert = db.prepare(`
    INSERT INTO provider_oauth (
      user_id, provider_id, account_id, status, access_token, refresh_token,
      token_type, verification_uri, user_code, device_code, oauth_state, interval_seconds,
      account_label, expires_at, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const record of records) {
    const userId = record.userId ?? "local-user";
    const accountId = record.accountId ?? "";
    await insert.run(
      userId,
      record.providerId,
      accountId,
      record.status,
      record.accessToken
        ? encryptSecret(record.accessToken, secretKey, providerOAuthAad(userId, record.providerId, accountId, "access_token"))
        : null,
      record.refreshToken
        ? encryptSecret(record.refreshToken, secretKey, providerOAuthAad(userId, record.providerId, accountId, "refresh_token"))
        : null,
      record.tokenType ?? null,
      record.verificationUri ?? null,
      record.userCode
        ? encryptSecret(record.userCode, secretKey, providerOAuthAad(userId, record.providerId, accountId, "user_code"))
        : null,
      record.deviceCode
        ? encryptSecret(record.deviceCode, secretKey, providerOAuthAad(userId, record.providerId, accountId, "device_code"))
        : null,
      record.oauthState
        ? encryptSecret(record.oauthState, secretKey, providerOAuthAad(userId, record.providerId, accountId, "oauth_state"))
        : null,
      record.intervalSeconds ?? null,
      record.accountLabel ?? null,
      record.expiresAt ?? null,
      record.error ?? null,
      record.createdAt ?? null,
      record.updatedAt ?? null,
    );
  }
}

async function readProviderAccountsUnsafe(db: SqliteDatabase, secretKey: Buffer): Promise<LocalProviderAccountConfig[]> {
  const accountRows = await db.prepare(`
    SELECT user_id, account_key, id, provider_id, upstream_id, region, label, api_shape,
           enabled, priority, weight, created_at, updated_at
      FROM provider_accounts
     ORDER BY user_id, provider_id, upstream_id, region, id
  `).all();
  const credentialRows = await db.prepare(`
    SELECT user_id, account_key, credential_key, credential_value
      FROM provider_account_credentials
     ORDER BY user_id, account_key, credential_key
  `).all();
  const supportedRows = await db.prepare(`
    SELECT user_id, account_key, model_id
      FROM provider_account_supported_models
     ORDER BY user_id, account_key, position
  `).all();
  const priorityRows = await db.prepare(`
    SELECT user_id, account_key, model_id, priority
      FROM provider_account_model_priorities
     ORDER BY user_id, account_key, model_id
  `).all();

  const credentials = new Map<string, Record<string, string>>();
  for (const row of credentialRows) {
    const userId = rowString(row, "user_id");
    const accountKey = rowString(row, "account_key");
    const credentialKey = rowString(row, "credential_key");
    const key = `${userId}\n${accountKey}`;
    const values = credentials.get(key) ?? {};
    values[credentialKey] = decryptSecret(
      rowString(row, "credential_value"),
      secretKey,
      providerCredentialAad(userId, accountKey, credentialKey),
    );
    credentials.set(key, values);
  }

  const supportedModels = new Map<string, string[]>();
  for (const row of supportedRows) {
    const key = `${rowString(row, "user_id")}\n${rowString(row, "account_key")}`;
    const values = supportedModels.get(key) ?? [];
    values.push(rowString(row, "model_id"));
    supportedModels.set(key, values);
  }

  const modelPriorities = new Map<string, Record<string, number>>();
  for (const row of priorityRows) {
    const key = `${rowString(row, "user_id")}\n${rowString(row, "account_key")}`;
    const values = modelPriorities.get(key) ?? {};
    const priority = rowOptionalNumber(row, "priority");
    if (priority !== undefined) values[rowString(row, "model_id")] = priority;
    modelPriorities.set(key, values);
  }

  return accountRows.map((row) => {
    const userId = rowString(row, "user_id");
    const accountKey = rowString(row, "account_key");
    const childKey = `${userId}\n${accountKey}`;
    const account: LocalProviderAccountConfig = {
      userId,
      ...(rowOptionalString(row, "id") ? { id: rowOptionalString(row, "id") } : {}),
      providerId: rowString(row, "provider_id") as LocalProviderAccountConfig["providerId"],
      ...(rowOptionalString(row, "upstream_id") ? { upstreamId: rowOptionalString(row, "upstream_id") as LocalProviderAccountConfig["upstreamId"] } : {}),
      ...(rowOptionalString(row, "api_shape") ? { apiShape: rowOptionalString(row, "api_shape") as LocalProviderAccountConfig["apiShape"] } : {}),
      ...(rowOptionalString(row, "region") ? { region: rowOptionalString(row, "region") } : {}),
      ...(rowOptionalString(row, "label") ? { label: rowOptionalString(row, "label") } : {}),
      enabled: row.enabled !== 0,
      ...(rowOptionalNumber(row, "priority") !== undefined ? { priority: rowOptionalNumber(row, "priority") } : {}),
      ...(rowOptionalNumber(row, "weight") !== undefined ? { weight: rowOptionalNumber(row, "weight") } : {}),
      ...(rowOptionalString(row, "created_at") ? { createdAt: rowOptionalString(row, "created_at") } : {}),
      ...(rowOptionalString(row, "updated_at") ? { updatedAt: rowOptionalString(row, "updated_at") } : {}),
    };
    const accountCredentials = credentials.get(childKey);
    if (accountCredentials && Object.keys(accountCredentials).length > 0) account.credentials = accountCredentials;
    const accountSupportedModels = supportedModels.get(childKey);
    if (accountSupportedModels?.length) account.supportedModelIds = accountSupportedModels;
    const accountModelPriorities = modelPriorities.get(childKey);
    if (accountModelPriorities && Object.keys(accountModelPriorities).length > 0) account.modelPriorities = accountModelPriorities;
    return account;
  });
}

async function readModelCardConfigsUnsafe(db: SqliteDatabase): Promise<LocalUserModelCardConfig[]> {
  const bindingRows = await db.prepare(`
    SELECT user_id, model_id, provider_account_id, upstream_model
      FROM model_card_provider_bindings
     ORDER BY user_id, model_id, position
  `).all();
  const bindings = new Map<string, LocalUserModelCardConfig["providerBindings"]>();
  for (const row of bindingRows) {
    const userId = rowString(row, "user_id");
    const modelId = rowString(row, "model_id");
    const key = `${userId}\n${modelId}`;
    const values = bindings.get(key) ?? [];
    values.push({
      providerAccountId: rowString(row, "provider_account_id"),
      upstreamModel: rowString(row, "upstream_model"),
    });
    bindings.set(key, values);
  }
  return (await db.prepare(`
    SELECT user_id, model_id, custom, kind, name, description, prompt_guidance,
           created_at, updated_at
      FROM model_card_configs
     ORDER BY user_id, model_id
  `).all()).map((row) => {
    const userId = rowString(row, "user_id");
    const modelId = rowString(row, "model_id");
    return {
      userId,
      modelId,
      custom: row.custom === 1,
      kind: "text" as const,
      ...(rowOptionalString(row, "name") ? { name: rowOptionalString(row, "name") } : {}),
      ...(rowOptionalString(row, "description") ? { description: rowOptionalString(row, "description") } : {}),
      ...(rowOptionalString(row, "prompt_guidance") ? { promptGuidance: rowOptionalString(row, "prompt_guidance") } : {}),
      providerBindings: bindings.get(`${userId}\n${modelId}`) ?? [],
      ...(rowOptionalString(row, "created_at") ? { createdAt: rowOptionalString(row, "created_at") } : {}),
      ...(rowOptionalString(row, "updated_at") ? { updatedAt: rowOptionalString(row, "updated_at") } : {}),
    };
  });
}

async function replaceModelCardConfigsUnsafe(
  db: SqliteDatabase,
  configs: LocalUserModelCardConfig[],
): Promise<void> {
  await db.prepare("DELETE FROM model_card_provider_bindings").run();
  await db.prepare("DELETE FROM model_card_configs").run();
  const insertConfig = db.prepare(`
    INSERT INTO model_card_configs (
      user_id, model_id, custom, kind, name, description, prompt_guidance,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBinding = db.prepare(`
    INSERT INTO model_card_provider_bindings (
      user_id, model_id, provider_account_id, upstream_model, position
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const config of configs) {
    const userId = config.userId ?? "local-user";
    await insertConfig.run(
      userId,
      config.modelId,
      config.custom ? 1 : 0,
      config.kind,
      config.name ?? null,
      config.description ?? null,
      config.promptGuidance ?? null,
      config.createdAt ?? null,
      config.updatedAt ?? null,
    );
    for (const [position, binding] of config.providerBindings.entries()) {
      await insertBinding.run(
        userId,
        config.modelId,
        binding.providerAccountId,
        binding.upstreamModel,
        position,
      );
    }
  }
}

function decryptOAuthField(
  row: Record<string, unknown>,
  secretKey: Buffer,
  field: "access_token" | "refresh_token" | "user_code" | "device_code" | "oauth_state",
): string | undefined {
  const value = rowOptionalString(row, field);
  if (!value) return undefined;
  return decryptSecret(
    value,
    secretKey,
    providerOAuthAad(
      rowString(row, "user_id"),
      rowString(row, "provider_id"),
      rowString(row, "account_id"),
      field,
    ),
  );
}

async function readProviderOAuthUnsafe(db: SqliteDatabase, secretKey: Buffer): Promise<LocalProviderOAuthRecord[]> {
  return (await db.prepare(`
    SELECT user_id, provider_id, account_id, status, access_token, refresh_token,
           token_type, verification_uri, user_code, device_code, oauth_state, interval_seconds,
           account_label, expires_at, error, created_at, updated_at
      FROM provider_oauth
     ORDER BY user_id, provider_id, account_id
  `).all()).map((row) => {
    const accessToken = decryptOAuthField(row, secretKey, "access_token");
    const refreshToken = decryptOAuthField(row, secretKey, "refresh_token");
    const userCode = decryptOAuthField(row, secretKey, "user_code");
    const deviceCode = decryptOAuthField(row, secretKey, "device_code");
    const oauthState = decryptOAuthField(row, secretKey, "oauth_state");
    return {
      userId: rowString(row, "user_id"),
      providerId: rowString(row, "provider_id") as LocalProviderOAuthRecord["providerId"],
      ...(rowOptionalString(row, "account_id") ? { accountId: rowOptionalString(row, "account_id") } : {}),
      status: rowString(row, "status") as LocalProviderOAuthRecord["status"],
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(rowOptionalString(row, "token_type") ? { tokenType: rowOptionalString(row, "token_type") } : {}),
      ...(rowOptionalString(row, "verification_uri") ? { verificationUri: rowOptionalString(row, "verification_uri") } : {}),
      ...(userCode ? { userCode } : {}),
      ...(deviceCode ? { deviceCode } : {}),
      ...(oauthState ? { oauthState } : {}),
      ...(rowOptionalNumber(row, "interval_seconds") !== undefined ? { intervalSeconds: rowOptionalNumber(row, "interval_seconds") } : {}),
      ...(rowOptionalString(row, "account_label") ? { accountLabel: rowOptionalString(row, "account_label") } : {}),
      ...(rowOptionalString(row, "expires_at") ? { expiresAt: rowOptionalString(row, "expires_at") } : {}),
      ...(rowOptionalString(row, "error") ? { error: rowOptionalString(row, "error") } : {}),
      ...(rowOptionalString(row, "created_at") ? { createdAt: rowOptionalString(row, "created_at") } : {}),
      ...(rowOptionalString(row, "updated_at") ? { updatedAt: rowOptionalString(row, "updated_at") } : {}),
    };
  });
}

export function createLocalProviderStore(dataDir: string) {
  const path = sqlitePath(dataDir);

  async function exists(): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  const connection = createLocalSqliteConnection({ dataDir });

  async function withDb<T>(task: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    return connection.use(task);
  }

  async function ensureProviderAccountsMigrated(): Promise<void> {
    if (!(await exists())) return;
    const needsMigration = await withDb(async (db) => {
      if (await hasMigrationMarker(db, PROVIDER_ACCOUNTS_MIGRATION_ID) && !(await hasPlaintextProviderAccountSecrets(db))) return false;
      return hasProviderAccountRows(db);
    });
    if (!needsMigration) return;
    const secretKey = await resolveProviderSecretKey(dataDir);
    await withDb(async (db) => {
      if (await hasMigrationMarker(db, PROVIDER_ACCOUNTS_MIGRATION_ID) && !(await hasPlaintextProviderAccountSecrets(db))) return;
      if (!(await hasProviderAccountRows(db))) return;
      const accounts = await readProviderAccountsUnsafe(db, secretKey);
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceProviderAccountsUnsafe(db, accounts, secretKey);
        await markMigration(db, PROVIDER_ACCOUNTS_MIGRATION_ID, dataDir, "");
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async function ensureProviderOAuthMigrated(): Promise<void> {
    if (!(await exists())) return;
    const needsMigration = await withDb(async (db) => {
      if (await hasMigrationMarker(db, PROVIDER_OAUTH_MIGRATION_ID) && !(await hasPlaintextProviderOAuthSecrets(db))) return false;
      return hasProviderOAuthRows(db);
    });
    if (!needsMigration) return;
    const secretKey = await resolveProviderSecretKey(dataDir);
    await withDb(async (db) => {
      if (await hasMigrationMarker(db, PROVIDER_OAUTH_MIGRATION_ID) && !(await hasPlaintextProviderOAuthSecrets(db))) return;
      if (!(await hasProviderOAuthRows(db))) return;
      const records = await readProviderOAuthUnsafe(db, secretKey);
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceProviderOAuthUnsafe(db, records, secretKey);
        await markMigration(db, PROVIDER_OAUTH_MIGRATION_ID, dataDir, "");
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * One-shot canonicalization of legacy bare-`volcengine` ModelArk accounts.
   * Renaming changes both the account_key and the credential AAD, so this goes
   * through the existing read -> map -> replace path (which re-encrypts) rather
   * than raw SQL updates.
   */
  async function ensureVolcengineModelarkMigrated(): Promise<void> {
    if (!(await exists())) return;
    const needsMigration = await withDb(async (db) => {
      if (await hasMigrationMarker(db, VOLCENGINE_MODELARK_MIGRATION_ID)) return false;
      return hasLegacyVolcengineModelarkRows(db);
    });
    if (!needsMigration) return;
    const secretKey = await resolveProviderSecretKey(dataDir);
    await withDb(async (db) => {
      if (await hasMigrationMarker(db, VOLCENGINE_MODELARK_MIGRATION_ID)) return;
      if (!(await hasLegacyVolcengineModelarkRows(db))) return;
      const accounts = (await readProviderAccountsUnsafe(db, secretKey)).map(canonicalizeVolcengineModelarkAccount);
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceProviderAccountsUnsafe(db, accounts, secretKey);
        await markMigration(db, VOLCENGINE_MODELARK_MIGRATION_ID, dataDir, "");
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async function loadProviderAccounts(): Promise<LocalProviderAccountConfig[]> {
    if (!(await exists())) return [];
    await ensureProviderAccountsMigrated();
    await ensureVolcengineModelarkMigrated();
    if (!(await withDb((db) => hasProviderAccountRows(db)))) return [];
    const secretKey = await resolveProviderSecretKey(dataDir);
    return withDb((db) => readProviderAccountsUnsafe(db, secretKey));
  }

  async function saveProviderAccounts(accounts: LocalProviderAccountConfig[]): Promise<void> {
    if (accounts.length === 0 && !(await exists())) return;
    if (accounts.length === 0) {
      await withDb(async (db) => {
        await db.exec("BEGIN IMMEDIATE");
        try {
          await clearProviderAccountsUnsafe(db);
          await db.exec("COMMIT");
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
      });
      return;
    }
    const secretKey = await resolveProviderSecretKey(dataDir);
    await withDb(async (db) => {
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceProviderAccountsUnsafe(db, accounts, secretKey);
        if (
          accounts.length > 0 ||
          (await hasMigrationMarker(db, PROVIDER_ACCOUNTS_MIGRATION_ID))
        ) {
          await markMigration(db, PROVIDER_ACCOUNTS_MIGRATION_ID, dataDir, "");
        }
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async function loadProviderOAuth(): Promise<LocalProviderOAuthRecord[]> {
    if (!(await exists())) return [];
    await ensureProviderOAuthMigrated();
    if (!(await withDb((db) => hasProviderOAuthRows(db)))) return [];
    const secretKey = await resolveProviderSecretKey(dataDir);
    return withDb((db) => readProviderOAuthUnsafe(db, secretKey));
  }

  async function saveProviderOAuth(records: LocalProviderOAuthRecord[]): Promise<void> {
    if (records.length === 0 && !(await exists())) return;
    if (records.length === 0) {
      await withDb(async (db) => {
        await db.exec("BEGIN IMMEDIATE");
        try {
          await clearProviderOAuthUnsafe(db);
          await db.exec("COMMIT");
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
      });
      return;
    }
    const secretKey = await resolveProviderSecretKey(dataDir);
    await withDb(async (db) => {
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceProviderOAuthUnsafe(db, records, secretKey);
        if (
          records.length > 0 ||
          (await hasMigrationMarker(db, PROVIDER_OAUTH_MIGRATION_ID))
        ) {
          await markMigration(db, PROVIDER_OAUTH_MIGRATION_ID, dataDir, "");
        }
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async function loadModelCardConfigs(): Promise<LocalUserModelCardConfig[]> {
    if (!(await exists())) return [];
    return withDb((db) => readModelCardConfigsUnsafe(db));
  }

  async function saveModelCardConfigs(configs: LocalUserModelCardConfig[]): Promise<void> {
    if (configs.length === 0 && !(await exists())) return;
    await withDb(async (db) => {
      await db.exec("BEGIN IMMEDIATE");
      try {
        await replaceModelCardConfigsUnsafe(db, configs);
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async function appendProviderUsageEvent(input: ProviderUsageAuditEvent): Promise<void> {
    const event = ProviderUsageAuditEventSchema.parse(input);
    await withDb(async (db) => {
      await db.prepare(`
        INSERT OR IGNORE INTO provider_usage_audit (
          id, user_id, provider_id, provider_account_id, model_id, operation,
          task_id, project_id, node_id, actor_type, actor_user_id, actor_agent_id,
          provider_request_id, idempotency_key, status, estimated_cost_micro_usd,
          estimate_complete, currency, pricing_source, billing_basis,
          error_code, error_message, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.userId,
        event.providerId,
        event.providerAccountId ?? null,
        event.modelId,
        event.operation,
        event.taskId,
        event.projectId ?? null,
        event.nodeId ?? null,
        event.actorType ?? null,
        event.actorUserId ?? null,
        event.actorAgentId ?? null,
        event.providerRequestId ?? null,
        event.idempotencyKey,
        event.status,
        event.estimatedCostMicroUsd ?? null,
        event.estimateComplete ? 1 : 0,
        event.currency,
        event.pricingSource,
        JSON.stringify(event.billingBasis),
        event.errorCode ?? null,
        event.errorMessage ?? null,
        event.occurredAt,
      );
    });
  }

  async function listProviderUsageEvents(userId: string, limit = 100): Promise<ProviderUsageAuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    if (!(await exists())) return [];
    return (await connection.db.prepare(`
      SELECT * FROM provider_usage_audit
       WHERE user_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?
    `).all(userId, safeLimit)).map((row) => ProviderUsageAuditEventSchema.parse({
      id: rowString(row, "id"),
      userId: rowString(row, "user_id"),
      providerId: rowString(row, "provider_id"),
      ...(rowOptionalString(row, "provider_account_id") ? { providerAccountId: rowOptionalString(row, "provider_account_id") } : {}),
      modelId: rowString(row, "model_id"),
      operation: rowString(row, "operation"),
      taskId: rowString(row, "task_id"),
      ...(rowOptionalString(row, "project_id") ? { projectId: rowOptionalString(row, "project_id") } : {}),
      ...(rowOptionalString(row, "node_id") ? { nodeId: rowOptionalString(row, "node_id") } : {}),
      ...(rowOptionalString(row, "actor_type") ? { actorType: rowOptionalString(row, "actor_type") } : {}),
      ...(rowOptionalString(row, "actor_user_id") ? { actorUserId: rowOptionalString(row, "actor_user_id") } : {}),
      ...(rowOptionalString(row, "actor_agent_id") ? { actorAgentId: rowOptionalString(row, "actor_agent_id") } : {}),
      ...(rowOptionalString(row, "provider_request_id") ? { providerRequestId: rowOptionalString(row, "provider_request_id") } : {}),
      idempotencyKey: rowString(row, "idempotency_key"),
      status: rowString(row, "status"),
      ...(rowOptionalNumber(row, "estimated_cost_micro_usd") !== undefined
        ? { estimatedCostMicroUsd: rowOptionalNumber(row, "estimated_cost_micro_usd") }
        : {}),
      estimateComplete: row.estimate_complete === 1,
      currency: rowString(row, "currency"),
      pricingSource: rowString(row, "pricing_source"),
      billingBasis: JSON.parse(rowString(row, "billing_basis")) as Record<string, unknown>,
      ...(rowOptionalString(row, "error_code") ? { errorCode: rowOptionalString(row, "error_code") } : {}),
      ...(rowOptionalString(row, "error_message") ? { errorMessage: rowOptionalString(row, "error_message") } : {}),
      occurredAt: rowString(row, "occurred_at"),
    }));
  }

  return {
    path,
    exists,
    loadProviderAccounts,
    saveProviderAccounts,
    loadProviderOAuth,
    saveProviderOAuth,
    loadModelCardConfigs,
    saveModelCardConfigs,
    appendProviderUsageEvent,
    listProviderUsageEvents,
  };
}
