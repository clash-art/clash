import { normalizeModelId } from "@clash/shared-types";
import {
  decryptSecretJson,
  encryptSecretJson,
  requireSecretEnvelopeKey,
} from "./secret-envelope.js";

/** Domain separator for provider-account credential envelopes. */
export const PROVIDER_ACCOUNT_CREDENTIALS_SALT =
  "clash-provider-account-credentials";

export type ProviderCredentials = Record<string, string>;

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Keep only non-empty string credentials; never persist empty placeholders. */
export function cleanProviderCredentials(
  value: unknown,
): ProviderCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, raw]) => [key.trim(), trimString(raw)] as const)
    .filter(
      (entry): entry is readonly [string, string] => !!entry[0] && !!entry[1],
    );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function providerCredentialKeys(
  credentials: ProviderCredentials | undefined,
): string[] {
  return Object.entries(credentials ?? {})
    .filter(([, value]) => value.trim().length > 0)
    .map(([key]) => key)
    .sort();
}

/** Parse the JSON key-name list stored beside the encrypted envelope. */
export function parseConfiguredCredentials(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
          .sort()
      : [];
  } catch {
    return [];
  }
}

export function requireProviderCredentialSecret(
  secretKey: string | undefined,
): string {
  return requireSecretEnvelopeKey(
    secretKey,
    "Provider credential encryption key is not configured.",
  );
}

export async function encryptProviderCredentials(
  credentials: ProviderCredentials,
  secretKey: string,
): Promise<string> {
  return encryptSecretJson(
    credentials,
    secretKey,
    PROVIDER_ACCOUNT_CREDENTIALS_SALT,
  );
}

export async function decryptProviderCredentials(
  encrypted: string | null,
  secretKey: string,
): Promise<ProviderCredentials> {
  const parsed = await decryptSecretJson(
    encrypted,
    secretKey,
    PROVIDER_ACCOUNT_CREDENTIALS_SALT,
  );
  return cleanProviderCredentials(parsed) ?? {};
}

/** The provider-account columns credential selection reads; both hosted stores share them. */
export interface ProviderCredentialCandidateRow {
  region: string | null;
  priority: number | null;
  encrypted_credentials: string | null;
  supported_model_ids: string | null;
  model_priorities: string | null;
  updated_at: number | string | null;
}

export interface ProviderCredentialSelection {
  providerId: string;
  upstreamId?: string;
  region?: string;
  modelCode?: string;
  requiredCredentials?: string[];
}

function parseJsonStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        ).map((item) => item.trim())
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonNumberRecord(
  value: string | null,
): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entries: Array<[string, number]> = [];
    for (const [rawKey, rawValue] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const key = rawKey.trim();
      const number =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim()
            ? Number(rawValue)
            : Number.NaN;
      if (key && Number.isFinite(number)) entries.push([key, number]);
    }
    return entries.length ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the credentials for one Provider call from the enabled accounts a store
 * already narrowed by user, provider, account id and upstream.
 *
 * Region, per-model support and per-model priority are applied here so the
 * Cloudflare (D1) and Node (PostgreSQL) adapters choose the same account.
 */
export async function selectProviderCredentials(
  rows: readonly ProviderCredentialCandidateRow[],
  secretKey: string,
  query: ProviderCredentialSelection,
): Promise<ProviderCredentials> {
  const required = query.requiredCredentials ?? [];
  const rawModelCode = trimString(query.modelCode);
  const modelCode = normalizeModelId(rawModelCode) ?? rawModelCode;
  const priorityForModel = (priorities: Record<string, number> | undefined) =>
    modelCode
      ? (priorities?.[modelCode] ??
        Object.entries(priorities ?? {}).find(
          ([candidate]) =>
            (normalizeModelId(candidate) ?? candidate.trim()) === modelCode,
        )?.[1])
      : undefined;
  const candidates = rows
    .filter(
      (row) => !query.region || !row.region || row.region === query.region,
    )
    .filter((row) => {
      if (!modelCode) return true;
      const supported = parseJsonStringArray(row.supported_model_ids);
      return (
        !supported?.length ||
        supported
          .map((id) => normalizeModelId(id) ?? id.trim())
          .includes(modelCode)
      );
    })
    .sort((a, b) => {
      const aPriority = priorityForModel(parseJsonNumberRecord(a.model_priorities));
      const bPriority = priorityForModel(parseJsonNumberRecord(b.model_priorities));
      if (aPriority !== undefined || bPriority !== undefined) {
        const priority =
          (aPriority ?? Number.POSITIVE_INFINITY) -
          (bPriority ?? Number.POSITIVE_INFINITY);
        if (priority !== 0) return priority;
      }
      const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
      if (priority !== 0) return priority;
      return Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0);
    });
  for (const row of candidates) {
    const credentials = await decryptProviderCredentials(
      row.encrypted_credentials,
      secretKey,
    );
    if (required.every((key) => credentials[key]?.trim())) return credentials;
  }
  const missing = required.length ? ` Missing: ${required.join(", ")}.` : "";
  throw new Error(
    `Provider credentials not configured for ${query.providerId}${query.upstreamId ? `/${query.upstreamId}` : ""}.${missing}`,
  );
}
