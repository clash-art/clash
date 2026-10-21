/**
 * Official upstream credentials (`gateway_upstream_account`), server-owned and
 * disjoint from tenant BYOK `provider_account`. A row's secret is either
 *
 * - `secret_ref`: the name of a Worker secret. Only names starting with
 *   `GATEWAY_UPSTREAM_` resolve, so a row can never point the gateway at an
 *   unrelated deployment secret (auth, signing, encryption keys). The value is
 *   the API key, or a JSON object `{ "apiKey", "baseUrl"? }`.
 * - `encrypted_credentials`: a JSON credential object sealed with the shared
 *   secret envelope under `GATEWAY_ENCRYPTION_KEY`, a key-encryption key
 *   distinct from ACTION_SECRET_KEY (0032), with its own domain salt.
 *
 * Every failure is GATEWAY_KEY_UNAVAILABLE (fail closed). Errors carry the
 * account id and a reason, never key material.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GatewayError,
  type GatewayCredentialPort,
  type GatewayUpstreamCredential,
} from "@clash/gateway-core";
import {
  cleanProviderCredentials,
  type ProviderCredentials,
} from "@clash/shared-runtime/provider-credentials";
import { decryptSecretJson, encryptSecretJson } from "@clash/shared-runtime/secret-envelope";

import { parseJson } from "./d1-common";

/** Domain separator for official gateway credential envelopes. */
export const GATEWAY_UPSTREAM_CREDENTIALS_SALT = "clash-gateway-upstream-credentials";

export const GATEWAY_UPSTREAM_SECRET_PREFIX = "GATEWAY_UPSTREAM_";
export const GATEWAY_UPSTREAM_SECRET_REF_PATTERN = /^GATEWAY_UPSTREAM_[A-Z0-9_]+$/;
const SECRET_REF_PATTERN = GATEWAY_UPSTREAM_SECRET_REF_PATTERN;

export interface GatewayCredentialSecrets {
  /** GATEWAY_ENCRYPTION_KEY, when sealed envelopes are used. */
  encryptionKey?: string;
  /** Reads one Worker secret by name. */
  secret(name: string): string | undefined;
}

/** Seal official credentials for `gateway_upstream_account.encrypted_credentials`. */
export function sealGatewayUpstreamCredentials(
  credentials: ProviderCredentials,
  encryptionKey: string,
): Promise<string> {
  return encryptSecretJson(credentials, encryptionKey, GATEWAY_UPSTREAM_CREDENTIALS_SALT);
}

interface AccountRow {
  id: string;
  provider_id: string;
  upstream_id: string;
  secret_ref: string | null;
  encrypted_credentials: string | null;
  key_version: string;
}

function unavailable(accountId: string | undefined, reason: string, cause?: unknown): GatewayError {
  return new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
    details: { ...(accountId ? { accountId } : {}), reason },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function secretRefCredentials(value: string): ProviderCredentials | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed.startsWith("{") ? parseJson(trimmed) : undefined;
  return parsed !== undefined ? cleanProviderCredentials(parsed) : { apiKey: trimmed };
}

export function createD1GatewayCredentialPort(
  db: D1Database,
  secrets: GatewayCredentialSecrets,
): GatewayCredentialPort {
  async function credentialsOf(row: AccountRow): Promise<ProviderCredentials | undefined> {
    if (row.secret_ref) {
      if (!SECRET_REF_PATTERN.test(row.secret_ref)) throw unavailable(row.id, "secret_ref_not_allowed");
      const value = secrets.secret(row.secret_ref);
      if (!value) throw unavailable(row.id, "secret_missing");
      return secretRefCredentials(value);
    }
    if (!secrets.encryptionKey) throw unavailable(row.id, "encryption_key_missing");
    try {
      return cleanProviderCredentials(
        await decryptSecretJson(row.encrypted_credentials, secrets.encryptionKey, GATEWAY_UPSTREAM_CREDENTIALS_SALT),
      );
    } catch (cause) {
      throw unavailable(row.id, "decrypt_failed", cause);
    }
  }

  return {
    async resolve({ route, scope }): Promise<GatewayUpstreamCredential> {
      // Official keys never serve tenant traffic (and BYOK is not served here).
      if (scope !== "official") throw unavailable(route.accountId, "scope");
      if (!route.accountId) throw unavailable(undefined, "no_account");
      const row = await db
        .prepare(
          `SELECT id, provider_id, upstream_id, secret_ref, encrypted_credentials, key_version
             FROM gateway_upstream_account WHERE id = ? AND enabled = 1 LIMIT 1`,
        )
        .bind(route.accountId)
        .first<AccountRow>();
      if (!row) throw unavailable(route.accountId, "account_unavailable");
      if (
        (route.providerId && row.provider_id !== route.providerId) ||
        (row.upstream_id && row.upstream_id !== route.upstreamId)
      )
        throw unavailable(row.id, "route_mismatch");
      const credentials = await credentialsOf(row);
      const apiKey = credentials?.apiKey;
      if (!apiKey) throw unavailable(row.id, "api_key_missing");
      return {
        apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        keyId: row.id,
        keyVersion: row.key_version,
      };
    },
  };
}
