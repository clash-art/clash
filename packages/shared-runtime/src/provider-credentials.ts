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
