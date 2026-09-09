import type {
  AssetDeliveryOperation,
  AssetDeliveryPurpose,
  AssetDeliveryScope,
  AssetDeliverySigner,
  AssetDeliverySignerInput,
  AssetDeliverySignerResult,
} from "./asset-delivery.js";

export interface AssetDeliveryCapabilityClaims extends AssetDeliverySignerInput {
  version: 1;
}

export interface HmacAssetDeliverySignerOptions {
  secret: string;
  /** Origin of the standalone capability endpoint, not an object-store origin. */
  origin: string;
  now?: () => number;
}

export interface VerifyHmacAssetDeliveryCapabilityOptions {
  secret: string;
  token: string;
  now?: () => number;
}

const TOKEN_VERSION = "v1";
const TOKEN_PREFIX = `${TOKEN_VERSION}.`;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function keyFor(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Asset delivery signing secret is required.");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signatureFor(key: CryptoKey, signed: string): Promise<string> {
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signed),
  );
  return toBase64Url(new Uint8Array(bytes));
}

function originOf(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Asset delivery origin must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Asset delivery origin must use HTTP or HTTPS.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function claimsPayload(
  input: AssetDeliverySignerInput,
): AssetDeliveryCapabilityClaims {
  return {
    version: 1,
    operation: input.operation,
    method: input.method,
    resourceId: input.resourceId,
    scope: {
      tenantId: input.scope.tenantId,
      ...(input.scope.projectId === undefined
        ? {}
        : { projectId: input.scope.projectId }),
    },
    purpose: input.purpose,
    expiresAt: input.expiresAt,
    ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    ...(input.contentType === undefined
      ? {}
      : { contentType: input.contentType }),
  };
}

function encodeClaims(claims: AssetDeliveryCapabilityClaims): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseClaims(value: unknown): AssetDeliveryCapabilityClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const method = record.method;
  const purpose = record.purpose;
  const scopeValue = record.scope;
  if (
    record.version !== 1 ||
    (operation !== "read" && operation !== "upload") ||
    (method !== "GET" && method !== "PUT") ||
    (purpose !== "preview" &&
      purpose !== "provider-input" &&
      purpose !== "download" &&
      purpose !== "host-staging") ||
    !validString(record.resourceId) ||
    !validString(record.expiresAt) ||
    !scopeValue ||
    typeof scopeValue !== "object" ||
    Array.isArray(scopeValue)
  ) {
    return null;
  }
  const scope = scopeValue as Record<string, unknown>;
  if (!validString(scope.tenantId)) return null;
  if (
    (operation === "read" && method !== "GET") ||
    (operation === "upload" && method !== "PUT") ||
    (operation === "read" && purpose === "host-staging") ||
    (operation === "upload" && purpose !== "host-staging")
  ) {
    return null;
  }
  if (scope.projectId !== undefined && !validString(scope.projectId)) {
    return null;
  }
  if (
    record.byteLength !== undefined &&
    (!Number.isSafeInteger(record.byteLength) ||
      (record.byteLength as number) < 0)
  ) {
    return null;
  }
  if (
    record.digest !== undefined &&
    (typeof record.digest !== "string" || !SHA256_DIGEST.test(record.digest))
  ) {
    return null;
  }
  if (record.contentType !== undefined && !validString(record.contentType)) {
    return null;
  }

  return {
    version: 1,
    operation: operation as AssetDeliveryOperation,
    method: method as "GET" | "PUT",
    resourceId: record.resourceId as string,
    scope: {
      tenantId: scope.tenantId as string,
      ...(scope.projectId === undefined
        ? {}
        : { projectId: scope.projectId as string }),
    },
    purpose: purpose as AssetDeliveryPurpose,
    expiresAt: record.expiresAt as string,
    ...(record.byteLength === undefined
      ? {}
      : { byteLength: record.byteLength as number }),
    ...(record.digest === undefined ? {} : { digest: record.digest as string }),
    ...(record.contentType === undefined
      ? {}
      : { contentType: record.contentType as string }),
  };
}

export function createHmacAssetDeliverySigner(
  options: HmacAssetDeliverySignerOptions,
): AssetDeliverySigner {
  const origin = originOf(options.origin);
  const now = options.now ?? Date.now;
  const keyPromise = keyFor(options.secret);

  return {
    async sign(input): Promise<AssetDeliverySignerResult> {
      const expiresAt = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        throw new Error(
          "Asset delivery capability expiry must be in the future.",
        );
      }
      const claims = claimsPayload(input);
      const payload = encodeClaims(claims);
      const signed = `${TOKEN_PREFIX}${payload}`;
      const signature = await signatureFor(await keyPromise, signed);
      return {
        url: `${origin}/assets/capability/${signed}.${signature}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
  };
}

/**
 * Verify a capability at the standalone delivery endpoint. The returned claims
 * contain no provider locator; the endpoint resolves `resourceId` privately.
 */
export async function verifyHmacAssetDeliveryCapability(
  options: VerifyHmacAssetDeliveryCapabilityOptions,
): Promise<AssetDeliveryCapabilityClaims | null> {
  const now = options.now ?? Date.now;
  const parts = options.token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const payload = parts[1];
  const providedSignature = fromBase64Url(parts[2]);
  if (!payload || !providedSignature) return null;
  const decoded = fromBase64Url(payload);
  if (!decoded) return null;

  const signed = `${TOKEN_PREFIX}${payload}`;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await keyFor(options.secret),
    cryptoBytes(providedSignature),
    new TextEncoder().encode(signed),
  );
  if (!valid) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  const claims = parseClaims(raw);
  if (!claims || Date.parse(claims.expiresAt) <= now()) return null;
  return claims;
}
