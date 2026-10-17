/**
 * Expiring HMAC capabilities for media URLs, shared by every server adapter.
 *
 * Signature: base64url(HMAC-SHA256(`<domain><subject>:<exp>`)) where `exp` is
 * a Unix time in seconds. `domain` separates purposes that share one secret;
 * an empty domain is the original Cloudflare `/assets/<key>` format, so its
 * existing URLs keep verifying. Web Crypto only: runs on Workers and Node.
 *
 * This is not an authorization check. Callers mint a capability only after
 * they established the caller's authority over `subject`.
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Equal-length comparison whose time does not depend on where values differ. */
function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

export async function importCapabilityKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("A capability signing secret is required.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signCapability(
  key: CryptoKey,
  subject: string,
  exp: number,
  domain = "",
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${domain}${subject}:${exp}`),
  );
  return toBase64Url(signature);
}

/** Signature check only; the caller decides what an expired `exp` means. */
export async function verifyCapability(
  key: CryptoKey,
  subject: string,
  exp: number,
  signature: string,
  domain = "",
): Promise<boolean> {
  return constantTimeEqual(
    await signCapability(key, subject, exp, domain),
    signature,
  );
}
