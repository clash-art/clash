/**
 * Node/PostgreSQL provider settings and usage audit.
 *
 * The read-only store mirrors the D1 tables the Cloudflare adapter uses:
 * provider accounts hold AES-GCM credential envelopes, model-card configs
 * optionally bind models to accounts, and usage audit rows are append-only.
 * Node has no settings UI for creating accounts yet; rows may be provisioned
 * administratively.
 */
import {
  MODEL_CARDS,
  ProviderUsageAuditEventSchema,
  buildEffectiveModelCards,
  listModelCatalogEntries,
  modelCardVisibleToConsumer,
  normalizeModelId,
  type ModelCatalogEntry,
  type ModelUpstreamApiShape,
  type ModelUpstreamId,
  type ModelCard,
  type ProviderAccountAvailability,
  type ProviderAccountId,
  type ProviderUsageAuditEvent,
  type UserModelCardConfig,
} from "@clash/shared-types";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import {
  decryptProviderCredentials,
  parseConfiguredCredentials,
  requireProviderCredentialSecret,
} from "@clash/shared-runtime/provider-credentials";

export interface PublicNodeProviderAccount extends Omit<
  ProviderAccountAvailability,
  "createdAt" | "updatedAt"
> {
  id: string;
  label?: string;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface NodeProviderCredentialQuery {
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
  enabled: number | string | null;
  priority: number | null;
  weight: number | null;
  encrypted_credentials: string | null;
  configured_credentials: string | null;
  supported_model_ids: string | null;
  model_priorities: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type ModelCardConfigRow = {
  model_id: string;
  custom: number | string;
  name: string | null;
  description: string | null;
  prompt_guidance: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type ModelCardBindingRow = {
  model_id: string;
  provider_account_id: string;
  upstream_model: string;
};

const PROVIDER_ACCOUNT_COLUMNS = `id, user_id, provider_id, upstream_id, api_shape, region, label, enabled,
  priority, weight, encrypted_credentials, configured_credentials, supported_model_ids, model_priorities,
  created_at, updated_at`;

const timestamp = (value: number | string | null | undefined) =>
  value === null || value === undefined ? undefined : Number(value);

function parseStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : undefined;
  } catch {
    return undefined;
  }
}

function parseNumberRecord(
  value: string | null,
): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        !!entry[0].trim() && typeof entry[1] === "number",
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

function isoTimestamp(
  value: number | string | null | undefined,
): string | undefined {
  const seconds = timestamp(value);
  return seconds === undefined
    ? undefined
    : new Date(seconds * 1000).toISOString();
}

function publicAccount(row: ProviderAccountRow): PublicNodeProviderAccount {
  const supportedModelIds = parseStringArray(row.supported_model_ids);
  const modelPriorities = parseNumberRecord(row.model_priorities);
  return {
    id: row.id,
    providerId: row.provider_id as ProviderAccountId,
    ...(row.upstream_id
      ? { upstreamId: row.upstream_id as ModelUpstreamId }
      : {}),
    ...(row.api_shape
      ? { apiShape: row.api_shape as ModelUpstreamApiShape }
      : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.label ? { label: row.label } : {}),
    enabled: Number(row.enabled ?? 1) !== 0,
    configuredCredentials: parseConfiguredCredentials(
      row.configured_credentials,
    ),
    ...(supportedModelIds ? { supportedModelIds } : {}),
    ...(modelPriorities ? { modelPriorities } : {}),
    ...(row.priority !== null ? { priority: row.priority } : {}),
    ...(row.weight !== null ? { weight: row.weight } : {}),
    createdAt: timestamp(row.created_at) ?? null,
    updatedAt: timestamp(row.updated_at) ?? null,
  };
}

export async function listNodeProviderAccounts(
  db: PostgresQueryPort,
  userId: string,
): Promise<PublicNodeProviderAccount[]> {
  const result = await db.query<ProviderAccountRow>(
    `SELECT ${PROVIDER_ACCOUNT_COLUMNS}
       FROM provider_account
      WHERE user_id = $1
      ORDER BY provider_id, COALESCE(upstream_id, ''), COALESCE(region, ''),
               COALESCE(priority, 1000), updated_at DESC`,
    [userId],
  );
  return result.rows.map(publicAccount);
}

export async function listNodeModelCardConfigs(
  db: PostgresQueryPort,
  userId: string,
): Promise<UserModelCardConfig[]> {
  const [configs, bindings] = await Promise.all([
    db.query<ModelCardConfigRow>(
      `SELECT model_id, custom, name, description, prompt_guidance, created_at, updated_at
         FROM model_card_config
        WHERE user_id = $1
        ORDER BY model_id`,
      [userId],
    ),
    db.query<ModelCardBindingRow>(
      `SELECT model_id, provider_account_id, upstream_model
         FROM model_card_provider_binding
        WHERE user_id = $1
        ORDER BY model_id, position, provider_account_id`,
      [userId],
    ),
  ]);
  const bindingsByModel = new Map<
    string,
    UserModelCardConfig["providerBindings"]
  >();
  for (const row of bindings.rows) {
    const current = bindingsByModel.get(row.model_id) ?? [];
    current.push({
      providerAccountId: row.provider_account_id,
      upstreamModel: row.upstream_model,
    });
    bindingsByModel.set(row.model_id, current);
  }
  return configs.rows.map((row) => ({
    modelId: row.model_id,
    custom: Number(row.custom) !== 0,
    kind: "text",
    ...(row.name ? { name: row.name } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.prompt_guidance ? { promptGuidance: row.prompt_guidance } : {}),
    providerBindings: bindingsByModel.get(row.model_id) ?? [],
    ...(isoTimestamp(row.created_at)
      ? { createdAt: isoTimestamp(row.created_at) }
      : {}),
    ...(isoTimestamp(row.updated_at)
      ? { updatedAt: isoTimestamp(row.updated_at) }
      : {}),
  }));
}

function configuredProviders(
  accounts: readonly PublicNodeProviderAccount[],
  excludeProviderIds: readonly string[] | undefined,
): ProviderAccountAvailability[] {
  return accounts
    .filter((account) => !excludeProviderIds?.includes(account.providerId))
    .map(
      ({ createdAt: _createdAt, updatedAt: _updatedAt, ...account }) => account,
    );
}

function baseModelCards(): ModelCard[] {
  return MODEL_CARDS.filter((model) =>
    modelCardVisibleToConsumer(model, undefined),
  );
}

export async function loadNodeHostedModelCards(
  db: PostgresQueryPort,
  userId: string,
  options: { excludeProviderIds?: readonly string[] } = {},
): Promise<{
  models: ReturnType<typeof buildEffectiveModelCards>;
  configuredProviders: ProviderAccountAvailability[];
}> {
  const [accounts, configs] = await Promise.all([
    listNodeProviderAccounts(db, userId),
    listNodeModelCardConfigs(db, userId),
  ]);
  const providers = configuredProviders(accounts, options.excludeProviderIds);
  return {
    models: buildEffectiveModelCards({
      configs,
      providers,
      baseModels: baseModelCards(),
    }),
    configuredProviders: providers,
  };
}

/** Hosted catalog for the shared voice-input selection/readiness rules. */
export async function loadNodeVoiceInputCatalog(
  db: PostgresQueryPort,
  userId: string,
): Promise<ModelCatalogEntry[]> {
  const { models, configuredProviders: providers } =
    await loadNodeHostedModelCards(db, userId, {
      excludeProviderIds: ["mock"],
    });
  return listModelCatalogEntries({ models, configuredProviders: providers });
}

function modelCodeForQuery(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  return normalizeModelId(raw) ?? raw;
}

function priorityForModel(
  priorities: Record<string, number> | undefined,
  modelCode: string,
): number | undefined {
  if (!priorities) return undefined;
  return (
    priorities[modelCode] ??
    Object.entries(priorities).find(
      ([candidate]) =>
        (normalizeModelId(candidate) ?? candidate.trim()) === modelCode,
    )?.[1]
  );
}

export async function getNodeProviderCredentials(
  db: PostgresQueryPort,
  secretKey: string | undefined,
  userId: string,
  query: NodeProviderCredentialQuery,
): Promise<Record<string, string>> {
  const result = await db.query<ProviderAccountRow>(
    `SELECT ${PROVIDER_ACCOUNT_COLUMNS}
       FROM provider_account
      WHERE user_id = $1 AND provider_id = $2 AND enabled = 1
        AND ($3::text IS NULL OR id = $3)
        AND ($4::text IS NULL OR upstream_id = $4)
      ORDER BY COALESCE(priority, 1000), updated_at DESC`,
    [
      userId,
      query.providerId,
      query.accountId ?? null,
      query.upstreamId ?? null,
    ],
  );
  const required = query.requiredCredentials ?? [];
  const modelCode = modelCodeForQuery(query.modelCode);
  const rows = result.rows
    .filter(
      (row) => !query.region || !row.region || row.region === query.region,
    )
    .filter((row) => {
      if (!modelCode) return true;
      const supported = parseStringArray(row.supported_model_ids);
      return (
        !supported?.length ||
        supported
          .map((id) => normalizeModelId(id) ?? id.trim())
          .includes(modelCode)
      );
    })
    .sort((a, b) => {
      if (modelCode) {
        const aPriority = priorityForModel(
          parseNumberRecord(a.model_priorities),
          modelCode,
        );
        const bPriority = priorityForModel(
          parseNumberRecord(b.model_priorities),
          modelCode,
        );
        if (aPriority !== undefined || bPriority !== undefined) {
          const priority =
            (aPriority ?? Number.POSITIVE_INFINITY) -
            (bPriority ?? Number.POSITIVE_INFINITY);
          if (priority !== 0) return priority;
        }
      }
      const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
      if (priority !== 0) return priority;
      return Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0);
    });

  const secret = requireProviderCredentialSecret(secretKey);
  for (const row of rows) {
    const credentials = await decryptProviderCredentials(
      row.encrypted_credentials,
      secret,
    );
    if (required.every((key) => credentials[key]?.trim())) {
      return credentials;
    }
  }

  const missing = required.length ? ` Missing: ${required.join(", ")}.` : "";
  throw new Error(
    `Provider credentials not configured for ${query.providerId}${query.upstreamId ? `/${query.upstreamId}` : ""}.${missing}`,
  );
}

/** Append-only usage audit; the shared event id makes provider retries idempotent. */
export async function appendNodeProviderUsageEvent(
  db: PostgresQueryPort,
  input: ProviderUsageAuditEvent,
): Promise<void> {
  const event = ProviderUsageAuditEventSchema.parse(input);
  await db.query(
    `INSERT INTO provider_usage_audit
      (id, user_id, provider_id, provider_account_id, model_id, operation,
       task_id, project_id, node_id, actor_type, actor_user_id, actor_agent_id,
       provider_request_id, idempotency_key, status, estimated_cost_micro_usd,
       estimate_complete, currency, pricing_source, billing_basis, error_code,
       error_message, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23)
     ON CONFLICT (id) DO NOTHING`,
    [
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
      Date.parse(event.occurredAt),
    ],
  );
}
