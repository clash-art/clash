/**
 * Gateway credential encryption key ring + envelope v2 (#366).
 *
 * Extends the shared AES-GCM secret envelope (shared-runtime/secret-envelope,
 * "v1": `base64(iv || ct)`, PBKDF2 of GATEWAY_ENCRYPTION_KEY with the
 * gateway salt) with a versioned, key-identified format:
 *
 *   v2.<kid>.<base64url iv[12]>.<base64url ciphertext||tag>
 *
 * - Ring: `GATEWAY_ENCRYPTION_KEYS` is a JSON map `{ kid: base64(>=32 bytes) }`
 *   and `GATEWAY_ENCRYPTION_CURRENT` names the kid new envelopes use. The
 *   current kid may be overridden at runtime through Postgres (`gateway_config`
 *   key `encryption.current`) by the audited admin rotation; see
 *   gateway-credentials.ts. Retired kids stay in the ring to keep decrypting.
 * - Derivation: AES-256-GCM key = HKDF-SHA256(ring key, salt = gateway domain,
 *   info = "clash-gateway-cred/v2/<scope>"), so official and tenant envelopes
 *   are sealed under different derived keys, and the additional data binds
 *   version, kid, scope, tenant and credential id: an envelope copied to
 *   another row or scope fails to open. Derived keys are cached per
 *   (kid, scope); the cache holds non-extractable CryptoKeys only.
 * - v1 envelopes still open (official scope only, with the legacy key) and
 *   report `needsReseal`, so the store re-encrypts them lazily under v2.
 *
 * Errors never carry key material or plaintext.
 */

import type { GatewayCredentialScope } from "@clash/gateway-core";
import { decryptSecretJson } from "@clash/shared-runtime/secret-envelope";
import { z } from "zod";

/** Same domain separator as the v1 (D1) official credential envelopes. */
export const GATEWAY_CREDENTIALS_SALT = "clash-gateway-upstream-credentials";
const V2 = "v2";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_KEY_BYTES = 32;

export class GatewayKeyRingError extends Error {
  constructor(readonly reason: string) {
    super(`gateway key ring: ${reason}`);
    this.name = "GatewayKeyRingError";
  }
}

/** Which row an envelope belongs to; bound into the AES-GCM additional data. */
export interface EnvelopeContext {
  scope: GatewayCredentialScope;
  /** '' for official credentials. */
  tenantKey: string;
  credentialId: string;
}

export interface OpenedEnvelope {
  value: unknown;
  /** Format of the stored envelope. */
  format: "v1" | "v2";
  /** v2 key id; undefined for v1. */
  kid?: string;
}

export interface GatewayKeyRing {
  /** Key ids this node can open, sorted. Never the key material. */
  readonly kids: readonly string[];
  /** The configured default current kid (env), if any. */
  readonly defaultCurrent: string | undefined;
  has(kid: string): boolean;
  seal(value: unknown, context: EnvelopeContext, kid: string): Promise<string>;
  open(envelope: string, context: EnvelopeContext): Promise<OpenedEnvelope>;
}

const KeysSchema = z.record(z.string().regex(KID_PATTERN), z.string().min(1));

export interface GatewayKeyRingEnv {
  GATEWAY_ENCRYPTION_KEYS?: string;
  GATEWAY_ENCRYPTION_CURRENT?: string;
  /** Legacy v1 key (decrypt only). */
  GATEWAY_ENCRYPTION_KEY?: string;
  /** Tenant BYOK key; must not equal any gateway key. */
  ACTION_SECRET_KEY?: string;
}

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(text, "base64url"));

function additionalData(
  kid: string,
  context: EnvelopeContext,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      V2,
      kid,
      context.scope,
      context.tenantKey,
      context.credentialId,
    ]),
  );
}

/** Parse the v2 header without opening it; undefined for a non-v2 envelope. */
export function envelopeKid(envelope: string): string | undefined {
  const parts = envelope.split(".");
  return parts.length === 4 && parts[0] === V2 && KID_PATTERN.test(parts[1]!)
    ? parts[1]
    : undefined;
}

export function createGatewayKeyRing(input: {
  keys: Record<string, Uint8Array>;
  current?: string;
  legacyKey?: string;
}): GatewayKeyRing {
  const keys = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [kid, bytes] of Object.entries(input.keys)) {
    if (!KID_PATTERN.test(kid)) throw new GatewayKeyRingError("invalid_kid");
    if (bytes.byteLength < MIN_KEY_BYTES)
      throw new GatewayKeyRingError("key_too_short");
    keys.set(kid, Uint8Array.from(bytes));
  }
  if (input.current !== undefined && !keys.has(input.current))
    throw new GatewayKeyRingError("current_kid_unknown");
  const derived = new Map<string, Promise<CryptoKey>>();

  function derive(
    kid: string,
    scope: GatewayCredentialScope,
  ): Promise<CryptoKey> {
    const cacheKey = `${kid}\u0000${scope}`;
    let key = derived.get(cacheKey);
    if (!key) {
      const raw = keys.get(kid);
      if (!raw) throw new GatewayKeyRingError("kid_unknown");
      key = crypto.subtle
        .importKey("raw", raw, "HKDF", false, ["deriveKey"])
        .then((material) =>
          crypto.subtle.deriveKey(
            {
              name: "HKDF",
              hash: "SHA-256",
              salt: encoder.encode(GATEWAY_CREDENTIALS_SALT),
              info: encoder.encode(`clash-gateway-cred/v2/${scope}`),
            },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          ),
        );
      key.catch(() => derived.delete(cacheKey));
      derived.set(cacheKey, key);
    }
    return key;
  }

  return {
    kids: [...keys.keys()].sort(),
    defaultCurrent: input.current,
    has: (kid) => keys.has(kid),
    async seal(value, context, kid) {
      const key = await derive(kid, context.scope);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(kid, context) },
        key,
        encoder.encode(JSON.stringify(value)),
      );
      return [V2, kid, b64url(iv), b64url(new Uint8Array(ciphertext))].join(
        ".",
      );
    },
    async open(envelope, context) {
      if (envelope.startsWith(`${V2}.`)) {
        const kid = envelopeKid(envelope);
        if (!kid) throw new GatewayKeyRingError("malformed_envelope");
        if (!keys.has(kid)) throw new GatewayKeyRingError("kid_unknown");
        const [, , iv, body] = envelope.split(".");
        let plaintext: ArrayBuffer;
        try {
          plaintext = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: fromB64url(iv!),
              additionalData: additionalData(kid, context),
            },
            await derive(kid, context.scope),
            fromB64url(body!),
          );
        } catch {
          throw new GatewayKeyRingError("decrypt_failed");
        }
        return {
          value: JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
          format: "v2",
          kid,
        };
      }
      // v1: only official credentials were ever sealed under the legacy key.
      if (context.scope !== "official")
        throw new GatewayKeyRingError("v1_scope");
      if (!input.legacyKey) throw new GatewayKeyRingError("legacy_key_missing");
      try {
        return {
          value: await decryptSecretJson(
            envelope,
            input.legacyKey,
            GATEWAY_CREDENTIALS_SALT,
          ),
          format: "v1",
        };
      } catch {
        throw new GatewayKeyRingError("decrypt_failed");
      }
    },
  };
}

/** Build the ring from deployment env; refuses keys shared with tenant BYOK. */
export function gatewayKeyRingFromEnv(env: GatewayKeyRingEnv): GatewayKeyRing {
  let parsed: Record<string, string> = {};
  if (env.GATEWAY_ENCRYPTION_KEYS?.trim()) {
    let json: unknown;
    try {
      json = JSON.parse(env.GATEWAY_ENCRYPTION_KEYS);
    } catch {
      throw new GatewayKeyRingError("keys_not_json");
    }
    const result = KeysSchema.safeParse(json);
    if (!result.success) throw new GatewayKeyRingError("keys_invalid");
    parsed = result.data;
  }
  const byok = env.ACTION_SECRET_KEY;
  if (
    byok &&
    (env.GATEWAY_ENCRYPTION_KEY === byok ||
      Object.values(parsed).includes(byok))
  )
    throw new GatewayKeyRingError("shared_with_byok");
  const keys = Object.fromEntries(
    Object.entries(parsed).map(([kid, b64]) => [
      kid,
      new Uint8Array(Buffer.from(b64, "base64")),
    ]),
  );
  const current = env.GATEWAY_ENCRYPTION_CURRENT?.trim() || undefined;
  return createGatewayKeyRing({
    keys,
    ...(current ? { current } : {}),
    ...(env.GATEWAY_ENCRYPTION_KEY
      ? { legacyKey: env.GATEWAY_ENCRYPTION_KEY }
      : {}),
  });
}
