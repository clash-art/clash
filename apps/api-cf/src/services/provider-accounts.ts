import type {
  ModelUpstreamApiShape,
  ModelUpstreamId,
  ProviderAccountAvailability,
  ProviderAccountId,
} from "@clash/shared-types";
import {
  ModelUpstreamApiShapeSchema,
  ModelUpstreamIdSchema,
  normalizeModelId,
  ProviderAccountIdSchema,
} from "@clash/shared-types";
import {
  cleanProviderCredentials,
  decryptProviderCredentials,
  encryptProviderCredentials,
  parseConfiguredCredentials,
  providerCredentialKeys,
  requireProviderCredentialSecret,
} from "@clash/shared-runtime/provider-credentials";

export interface ProviderAccountInput {
  id?: string;
  providerId: ProviderAccountId;
  upstreamId?: ModelUpstreamId;
  apiShape?: ModelUpstreamApiShape;
  region?: string;
  label?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  supportedModelIds?: string[];
  modelPriorities?: Record<string, number>;
  credentials?: Record<string, string>;
}

export interface PublicProviderAccount extends Omit<ProviderAccountAvailability, "createdAt" | "updatedAt"> {
  id: string;
  label?: string;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface ProviderCredentialQuery {
  accountId?: string;
  providerId: ProviderAccountId;
  upstreamId?: ModelUpstreamId;
  region?: string;
  modelCode?: string;
  requiredCredentials?: string[];
}

type ProviderAccountRow = {
  id: string;
  user_id: string;
  provider_id: string;
  upstream_id: string | null;
  api_shape: string | null;
  region: string | null;
  label: string | null;
  enabled: number | null;
  priority: number | null;
  weight: number | null;
  encrypted_credentials: string | null;
  configured_credentials: string | null;
  supported_model_ids: string | null;
  model_priorities: string | null;
  created_at: number | null;
  updated_at: number | null;
};

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of value) {
    const normalized = trimString(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function cleanNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = trimString(rawKey);
    const number = numberValue(rawValue);
    if (!key || number === undefined) continue;
    entries.push([key, number]);
  }
  return Object.fromEntries(entries);
}

function defaultUpstream(providerId: ProviderAccountId): ModelUpstreamId | undefined {
  if (
    providerId === "fal" ||
    providerId === "pika" ||
    providerId === "local" ||
    providerId === "replicate" ||
    providerId === "kling" ||
    providerId === "minimax" ||
    providerId === "volcengine" ||
    providerId === "elevenlabs" ||
    providerId === "suno" ||
    providerId === "mock"
  ) {
    return providerId;
  }
  return undefined;
}

function parseSupportedModelIds(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = cleanStringArray(JSON.parse(value));
    return parsed?.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseModelPriorities(value: string | null): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = cleanNumberRecord(JSON.parse(value));
    return parsed && Object.keys(parsed).length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeProviderAccountInput(value: unknown): ProviderAccountInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const providerId = ProviderAccountIdSchema.safeParse(trimString(raw.providerId));
  if (!providerId.success) return null;
  const rawUpstreamId = trimString(raw.upstreamId);
  const parsedUpstreamId = rawUpstreamId ? ModelUpstreamIdSchema.safeParse(rawUpstreamId) : null;
  if (rawUpstreamId && !parsedUpstreamId?.success) return null;
  const upstreamId = parsedUpstreamId?.success
    ? parsedUpstreamId.data
    : defaultUpstream(providerId.data);
  const parsedApiShape = ModelUpstreamApiShapeSchema.safeParse(trimString(raw.apiShape));
  const apiShape = parsedApiShape.success ? parsedApiShape.data : undefined;
  if (
    providerId.data === "custom" &&
    (!upstreamId ||
      (apiShape !== "openai-compatible" && apiShape !== "anthropic-compatible"))
  ) {
    return null;
  }
  const region = trimString(raw.region);
  const id = trimString(raw.id);
  const label = trimString(raw.label);
  const priority = numberValue(raw.priority);
  const weight = numberValue(raw.weight);
  const supportedModelIds = cleanStringArray(raw.supportedModelIds);
  const modelPriorities = cleanNumberRecord(raw.modelPriorities);
  const credentials = cleanProviderCredentials(raw.credentials);
  return {
    providerId: providerId.data,
    ...(id ? { id } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...(apiShape ? { apiShape } : {}),
    ...(region ? { region } : {}),
    ...(label ? { label } : {}),
    enabled: raw.enabled === undefined ? true : raw.enabled !== false,
    ...(priority !== undefined ? { priority } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(supportedModelIds !== undefined ? { supportedModelIds } : {}),
    ...(modelPriorities !== undefined ? { modelPriorities } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function publicRow(row: ProviderAccountRow): PublicProviderAccount {
  const supportedModelIds = parseSupportedModelIds(row.supported_model_ids);
  const modelPriorities = parseModelPriorities(row.model_priorities);
  return {
    id: row.id,
    providerId: row.provider_id as ProviderAccountId,
    ...(row.upstream_id ? { upstreamId: row.upstream_id as ModelUpstreamId } : {}),
    ...(row.api_shape ? { apiShape: row.api_shape as ModelUpstreamApiShape } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.label ? { label: row.label } : {}),
    enabled: row.enabled !== 0,
    configuredCredentials: parseConfiguredCredentials(row.configured_credentials),
    ...(supportedModelIds ? { supportedModelIds } : {}),
    ...(modelPriorities ? { modelPriorities } : {}),
    ...(row.priority !== null && row.priority !== undefined ? { priority: row.priority } : {}),
    ...(row.weight !== null && row.weight !== undefined ? { weight: row.weight } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findExistingAccountId(db: D1Database, userId: string, input: ProviderAccountInput): Promise<string | null> {
  if (input.id) return input.id;
  const row = await db
    .prepare(
      `SELECT id FROM provider_account
       WHERE user_id = ? AND provider_id = ? AND COALESCE(upstream_id, '') = ? AND COALESCE(region, '') = ?
       ORDER BY COALESCE(priority, 1000), updated_at DESC
       LIMIT 1`,
    )
    .bind(userId, input.providerId, input.upstreamId ?? "", input.region ?? "")
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function getAccountRow(db: D1Database, userId: string, id: string): Promise<ProviderAccountRow | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
              encrypted_credentials, configured_credentials, supported_model_ids, model_priorities, created_at, updated_at
       FROM provider_account
       WHERE user_id = ? AND id = ?`,
    )
    .bind(userId, id)
    .first<ProviderAccountRow>();
  return row ?? null;
}

export async function listProviderAccounts(db: D1Database, userId: string): Promise<PublicProviderAccount[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
              encrypted_credentials, configured_credentials, supported_model_ids, model_priorities, created_at, updated_at
       FROM provider_account
       WHERE user_id = ?
       ORDER BY provider_id, COALESCE(upstream_id, ''), COALESCE(region, ''), COALESCE(priority, 1000), updated_at DESC`,
    )
    .bind(userId)
    .all<ProviderAccountRow>();
  return (result.results ?? []).map(publicRow);
}

export async function deleteProviderAccount(db: D1Database, userId: string, accountId: string): Promise<boolean> {
  const existing = await getAccountRow(db, userId, accountId);
  if (!existing) return false;
  await db
    .prepare(
      `DELETE FROM model_card_provider_binding
       WHERE user_id = ? AND provider_account_id = ?`,
    )
    .bind(userId, accountId)
    .run();
  await db
    .prepare(
      `DELETE FROM provider_account
       WHERE user_id = ? AND id = ?`,
    )
    .bind(userId, accountId)
    .run();
  return true;
}

export async function upsertProviderAccount(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  input: ProviderAccountInput,
): Promise<PublicProviderAccount> {
  const now = Math.floor(Date.now() / 1000);
  const existingId = await findExistingAccountId(env.DB, userId, input);
  const existing = existingId ? await getAccountRow(env.DB, userId, existingId) : null;
  const secret = input.credentials ? requireProviderCredentialSecret(env.ACTION_SECRET_KEY) : undefined;
  let encryptedCredentials = existing?.encrypted_credentials ?? null;
  let configuredCredentials = existing?.configured_credentials ?? null;
  const supportedModelIds = input.supportedModelIds !== undefined
    ? input.supportedModelIds.length ? JSON.stringify(input.supportedModelIds) : null
    : existing?.supported_model_ids ?? null;
  const modelPriorities = input.modelPriorities !== undefined
    ? Object.keys(input.modelPriorities).length ? JSON.stringify(input.modelPriorities) : null
    : existing?.model_priorities ?? null;
  if (input.credentials && secret) {
    const previous = await decryptProviderCredentials(existing?.encrypted_credentials ?? null, secret);
    const merged = { ...previous, ...input.credentials };
    encryptedCredentials = await encryptProviderCredentials(merged, secret);
    configuredCredentials = JSON.stringify(providerCredentialKeys(merged));
  }

  if (existing) {
    await env.DB
      .prepare(
        `UPDATE provider_account
         SET provider_id = ?, upstream_id = ?, api_shape = ?, region = ?, label = ?, enabled = ?, priority = ?, weight = ?,
             encrypted_credentials = ?, configured_credentials = ?, supported_model_ids = ?, model_priorities = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .bind(
        input.providerId,
        input.upstreamId ?? null,
        input.apiShape ?? null,
        input.region ?? null,
        input.label ?? null,
        input.enabled === false ? 0 : 1,
        input.priority ?? null,
        input.weight ?? null,
        encryptedCredentials,
        configuredCredentials,
        supportedModelIds,
        modelPriorities,
        now,
        userId,
        existing.id,
      )
      .run();
    const row = await getAccountRow(env.DB, userId, existing.id);
    if (!row) throw new Error("Provider account update failed.");
    return publicRow(row);
  }

  const id = input.id ?? crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO provider_account
       (id, user_id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
        encrypted_credentials, configured_credentials, supported_model_ids, model_priorities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      input.providerId,
      input.upstreamId ?? null,
      input.apiShape ?? null,
      input.region ?? null,
      input.label ?? null,
      input.enabled === false ? 0 : 1,
      input.priority ?? null,
      input.weight ?? null,
      encryptedCredentials,
      configuredCredentials,
      supportedModelIds,
      modelPriorities,
      now,
      now,
    )
    .run();
  const row = await getAccountRow(env.DB, userId, id);
  if (!row) throw new Error("Provider account insert failed.");
  return publicRow(row);
}

export async function upsertProviderAccounts(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  inputs: ProviderAccountInput[],
): Promise<PublicProviderAccount[]> {
  for (const input of inputs) {
    await upsertProviderAccount(env, userId, input);
  }
  return listProviderAccounts(env.DB, userId);
}

export async function getProviderCredentials(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string | undefined,
  query: ProviderCredentialQuery,
): Promise<Record<string, string>> {
  if (!userId) throw new Error("Provider credentials require an authenticated actor user.");
  const secret = requireProviderCredentialSecret(env.ACTION_SECRET_KEY);
  const result = await env.DB
    .prepare(
      `SELECT id, user_id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
              encrypted_credentials, configured_credentials, supported_model_ids, model_priorities, created_at, updated_at
       FROM provider_account
       WHERE user_id = ? AND provider_id = ? AND enabled = 1
         AND (? IS NULL OR id = ?)
         AND (? IS NULL OR upstream_id = ?)
       ORDER BY COALESCE(priority, 1000), updated_at DESC`,
    )
    .bind(
      userId,
      query.providerId,
      query.accountId ?? null,
      query.accountId ?? null,
      query.upstreamId ?? null,
      query.upstreamId ?? null,
    )
    .all<ProviderAccountRow>();

  const required = query.requiredCredentials ?? [];
  const rawModelCode = trimString(query.modelCode);
  const modelCode = normalizeModelId(rawModelCode) ?? rawModelCode;
  const rows = (result.results ?? [])
    .filter((row) => !query.region || !row.region || row.region === query.region)
    .filter((row) => {
      if (!modelCode) return true;
      const supportedModelIds = parseSupportedModelIds(row.supported_model_ids);
      return !supportedModelIds?.length ||
        supportedModelIds.map((id) => normalizeModelId(id) ?? id.trim()).includes(modelCode);
    })
    .sort((a, b) => {
      if (modelCode) {
        const priorityForModel = (priorities: Record<string, number> | undefined) =>
          priorities?.[modelCode] ?? Object.entries(priorities ?? {})
            .find(([candidate]) => (normalizeModelId(candidate) ?? candidate.trim()) === modelCode)?.[1];
        const aPriority = priorityForModel(parseModelPriorities(a.model_priorities));
        const bPriority = priorityForModel(parseModelPriorities(b.model_priorities));
        if (aPriority !== undefined || bPriority !== undefined) {
          const priority = (aPriority ?? Number.POSITIVE_INFINITY) - (bPriority ?? Number.POSITIVE_INFINITY);
          if (priority !== 0) return priority;
        }
      }
      const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
      if (priority !== 0) return priority;
      return (b.updated_at ?? 0) - (a.updated_at ?? 0);
    });
  for (const row of rows) {
    const credentials = await decryptProviderCredentials(row.encrypted_credentials, secret);
    if (required.every((key) => credentials[key]?.trim())) return credentials;
  }

  const missing = required.length ? ` Missing: ${required.join(", ")}.` : "";
  throw new Error(
    `Provider credentials not configured for ${query.providerId}${query.upstreamId ? `/${query.upstreamId}` : ""}.${missing}`,
  );
}

/** Load one exact, enabled provider account for an opaque plugin capability. */
export async function getProviderAccountCredentialsById(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  accountId: string,
): Promise<{ providerId: ProviderAccountId; accountId: string; credentials: Record<string, string> }> {
  const secret = requireProviderCredentialSecret(env.ACTION_SECRET_KEY);
  const row = await getAccountRow(env.DB, userId, accountId);
  if (!row || row.enabled !== 1) {
    throw new Error(`Provider account ${accountId} is not configured or enabled.`);
  }
  const providerId = ProviderAccountIdSchema.parse(row.provider_id);
  return {
    providerId,
    accountId: row.id,
    credentials: await decryptProviderCredentials(row.encrypted_credentials, secret),
  };
}
