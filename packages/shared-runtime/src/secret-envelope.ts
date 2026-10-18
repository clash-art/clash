/**
 * AES-GCM envelope shared by every value encrypted with ACTION_SECRET_KEY.
 *
 * The salt is a domain separator: the same deployment key may seal more than
 * one record family, but a ciphertext can only be opened by the family that
 * wrote it. Envelope format is `base64(iv[12] || ciphertext)`.
 */

async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function requireSecretEnvelopeKey(
  secretKey: string | undefined,
  message: string,
): string {
  if (!secretKey) throw new Error(message);
  return secretKey;
}

/** Seal one JSON value. The caller owns the schema of what it puts inside. */
export async function encryptSecretJson(
  value: unknown,
  secretKey: string,
  salt: string,
): Promise<string> {
  const key = await deriveKey(secretKey, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/** Open one JSON value; `undefined` for an absent envelope. */
export async function decryptSecretJson(
  encrypted: string | null,
  secretKey: string,
  salt: string,
): Promise<unknown> {
  if (!encrypted) return undefined;
  const key = await deriveKey(secretKey, salt);
  const combined = Uint8Array.from(atob(encrypted), (char) =>
    char.charCodeAt(0),
  );
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
