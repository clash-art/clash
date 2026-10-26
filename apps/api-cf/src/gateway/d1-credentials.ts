/**
 * Official upstream credentials (`gateway_upstream_account`), server-owned and
 * disjoint from tenant BYOK `provider_account`. A key version's secret is
 * either
 *
 * - `secret_ref`: the name of a Worker secret or a Cloudflare Secrets Store
 *   binding. Only names starting with `GATEWAY_UPSTREAM_` resolve, so a row
 *   can never point the gateway at an unrelated deployment secret (auth,
 *   signing, encryption keys). The value is the API key, or a JSON object
 *   `{ "apiKey", "baseUrl"? }`.
 * - `encrypted_credentials`: a JSON credential object sealed with the shared
 *   secret envelope under `GATEWAY_ENCRYPTION_KEY`, a key-encryption key
 *   distinct from ACTION_SECRET_KEY (tenant BYOK), with its own domain salt.
 *   A deployment that configures the same value for both has no official KEK
 *   (`gatewayEncryptionKey`): sealed keys fail closed.
 *
 * An account holds its active version and, while a rotation drains (0043),
 * the previous one (`draining_*`); see `resolve` in gateway-core ports.
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
  /** GATEWAY_ENCRYPTION_KEY, when sealed envelopes are used and it is a distinct KEK. */
  encryptionKey?: string;
  /** Why there is no usable `encryptionKey` although one is configured. */
  encryptionKeyProblem?: "shared_with_byok";
  /** Reads one Worker secret or Secrets Store binding by name; undefined when absent. */
  secret(name: string): Promise<string | undefined> | string | undefined;
}

/**
 * The official vault's KEK: GATEWAY_ENCRYPTION_KEY, only while it differs from
 * the tenant BYOK key (ACTION_SECRET_KEY). Sharing one key would let either
 * vault's holder open the other's envelopes, so a shared value is refused.
 */
export function gatewayEncryptionKey(env: {
  GATEWAY_ENCRYPTION_KEY?: string;
  ACTION_SECRET_KEY?: string;
}): Pick<GatewayCredentialSecrets, "encryptionKey" | "encryptionKeyProblem"> {
  const key = env.GATEWAY_ENCRYPTION_KEY;
  if (!key) return {};
  if (key === env.ACTION_SECRET_KEY) return { encryptionKeyProblem: "shared_with_byok" };
  return { encryptionKey: key };
}

/** A Cloudflare Secrets Store binding: its value is read on demand. */
interface SecretsStoreBinding {
  get(): Promise<string>;
}

const isSecretsStoreBinding = (value: unknown): value is SecretsStoreBinding =>
  typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function";

/** One secret binding of a Worker's env by name: a Worker secret (a string) or a Secrets Store binding. */
export function readSecretBinding(env: object, name: string): Promise<string | undefined> | string | undefined {
  const value = (env as Record<string, unknown>)[name];
  if (typeof value === "string") return value;
  return isSecretsStoreBinding(value) ? value.get() : undefined;
}

/** Seal official credentials for `gateway_upstream_account.encrypted_credentials`. */
export function sealGatewayUpstreamCredentials(
  credentials: ProviderCredentials,
  encryptionKey: string,
): Promise<string> {
  return encryptSecretJson(credentials, encryptionKey, GATEWAY_UPSTREAM_CREDENTIALS_SALT);
}

/** Credentials from a secret's value: the API key, or a `{ apiKey, baseUrl? }` object. */
export function secretRefCredentials(value: string): ProviderCredentials | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed.startsWith("{") ? parseJson(trimmed) : undefined;
  return parsed !== undefined ? cleanProviderCredentials(parsed) : { apiKey: trimmed };
}

interface AccountRow {
  id: string;
  provider_id: string;
  upstream_id: string;
  secret_ref: string | null;
  encrypted_credentials: string | null;
  key_version: string;
  draining_key_version: string | null;
  draining_secret_ref: string | null;
  draining_encrypted_credentials: string | null;
}

/** One usable key version of an account. */
interface KeyVersionRow {
  version: string;
  secretRef: string | null;
  sealed: string | null;
}

function unavailable(accountId: string | undefined, reason: string, cause?: unknown): GatewayError {
  return new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
    details: { ...(accountId ? { accountId } : {}), reason },
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function createD1GatewayCredentialPort(
  db: D1Database,
  secrets: GatewayCredentialSecrets,
): GatewayCredentialPort {
  async function credentialsOf(accountId: string, key: KeyVersionRow): Promise<ProviderCredentials | undefined> {
    if (key.secretRef) {
      if (!SECRET_REF_PATTERN.test(key.secretRef)) throw unavailable(accountId, "secret_ref_not_allowed");
      let value: string | undefined;
      try {
        value = await secrets.secret(key.secretRef);
      } catch (cause) {
        throw unavailable(accountId, "secret_store_failed", cause);
      }
      if (!value) throw unavailable(accountId, "secret_missing");
      return secretRefCredentials(value);
    }
    if (secrets.encryptionKeyProblem) throw unavailable(accountId, `encryption_key_${secrets.encryptionKeyProblem}`);
    if (!secrets.encryptionKey) throw unavailable(accountId, "encryption_key_missing");
    try {
      return cleanProviderCredentials(
        await decryptSecretJson(key.sealed, secrets.encryptionKey, GATEWAY_UPSTREAM_CREDENTIALS_SALT),
      );
    } catch (cause) {
      throw unavailable(accountId, "decrypt_failed", cause);
    }
  }

  return {
    async resolve({ route, scope, excludeKeyVersions = [] }): Promise<GatewayUpstreamCredential> {
      // Official keys never serve tenant traffic (and BYOK is not served here).
      if (scope !== "official") throw unavailable(route.accountId, "scope");
      if (!route.accountId) throw unavailable(undefined, "no_account");
      const row = await db
        .prepare(
          `SELECT id, provider_id, upstream_id, secret_ref, encrypted_credentials, key_version,
                  draining_key_version, draining_secret_ref, draining_encrypted_credentials
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
      // Active first, then the draining version a rotation keeps until it is revoked.
      const versions: KeyVersionRow[] = [
        { version: row.key_version, secretRef: row.secret_ref, sealed: row.encrypted_credentials },
        ...(row.draining_key_version
          ? [{ version: row.draining_key_version, secretRef: row.draining_secret_ref, sealed: row.draining_encrypted_credentials }]
          : []),
      ];
      const key = versions.find((candidate) => !excludeKeyVersions.includes(candidate.version));
      if (!key) throw unavailable(row.id, "no_key_version");
      const credentials = await credentialsOf(row.id, key);
      const apiKey = credentials?.apiKey;
      if (!apiKey) throw unavailable(row.id, "api_key_missing");
      return {
        apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        keyId: row.id,
        keyVersion: key.version,
      };
    },
  };
}
