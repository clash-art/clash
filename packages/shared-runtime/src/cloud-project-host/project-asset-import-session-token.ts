/**
 * HMAC-signed import-session tokens for the chunked Project Asset import.
 *
 * A token is the session id: it binds the owner, Project, Asset identity,
 * byte length and the private staging locator, and it expires. Both Node
 * adapters use this one codec; the signing secret and clock arrive from the
 * composition root. HMAC comes from `@noble/hashes` so the module stays free
 * of platform crypto APIs.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { AssetKind } from "@clash/shared-types";
import type { AssetImportMetadataHints } from "@clash/asset-sdk";

export const PROJECT_ASSET_IMPORT_STAGING_PREFIX = "project-content-imports/";
export const PROJECT_ASSET_IMPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const TOKEN_VERSION = 1;
const KINDS = new Set<AssetKind>(["image", "video", "audio", "model"]);

export interface ProjectAssetImportSessionClaims {
  version: typeof TOKEN_VERSION;
  ownerId: string;
  projectId: string;
  projectAssetId: string;
  kind: AssetKind;
  fileName: string;
  byteLength: number;
  /** Client-computed digest of the bytes that will be uploaded, when declared. */
  sha256?: string;
  contentType?: string;
  duplicateContent?: "allow" | "reject";
  metadataHints?: AssetImportMetadataHints;
  stagingLocator: string;
  expiresAt: string;
}

export interface ProjectAssetImportSessionTokenPort {
  sign(claims: ProjectAssetImportSessionClaims): Promise<string>;
  verify(token: string): Promise<ProjectAssetImportSessionClaims | null>;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function parseClaims(value: unknown): ProjectAssetImportSessionClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== TOKEN_VERSION ||
    !text(record.ownerId) ||
    !text(record.projectId) ||
    !text(record.projectAssetId) ||
    !text(record.fileName) ||
    !KINDS.has(record.kind as AssetKind) ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) <= 0 ||
    !text(record.stagingLocator) ||
    !record.stagingLocator.startsWith(PROJECT_ASSET_IMPORT_STAGING_PREFIX) ||
    record.stagingLocator.includes("..") ||
    record.stagingLocator.includes("\\") ||
    !text(record.expiresAt)
  )
    return null;
  if (record.contentType !== undefined && !text(record.contentType))
    return null;
  if (
    record.sha256 !== undefined &&
    (typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256))
  )
    return null;
  if (
    record.duplicateContent !== undefined &&
    record.duplicateContent !== "allow" &&
    record.duplicateContent !== "reject"
  )
    return null;
  if (
    record.metadataHints !== undefined &&
    (!record.metadataHints ||
      typeof record.metadataHints !== "object" ||
      Array.isArray(record.metadataHints))
  )
    return null;
  return {
    version: TOKEN_VERSION,
    ownerId: record.ownerId.trim(),
    projectId: record.projectId.trim(),
    projectAssetId: record.projectAssetId.trim(),
    kind: record.kind as AssetKind,
    fileName: record.fileName.trim(),
    byteLength: record.byteLength as number,
    ...(record.sha256 === undefined
      ? {}
      : { sha256: record.sha256 as string }),
    ...(record.contentType === undefined
      ? {}
      : { contentType: record.contentType as string }),
    ...(record.duplicateContent === undefined
      ? {}
      : {
          duplicateContent: record.duplicateContent as "allow" | "reject",
        }),
    ...(record.metadataHints === undefined
      ? {}
      : {
          metadataHints: record.metadataHints as AssetImportMetadataHints,
        }),
    stagingLocator: record.stagingLocator,
    expiresAt: record.expiresAt,
  };
}

/**
 * One HMAC codec for every Node host. `now` is required: the shared modules
 * never read a clock directly.
 */
export function createHmacProjectAssetImportSessionTokens(options: {
  secret: string;
  now: () => number;
}): ProjectAssetImportSessionTokenPort {
  if (!options.secret) throw new Error("Import session signing secret is required.");
  const key = utf8ToBytes(options.secret);
  // Domain-separated: hosts may reuse a receipt/provider secret, so no other
  // HMAC message signed with the same key can ever verify as a session.
  const signatureOf = (payload: string) =>
    bytesToHex(
      hmac(sha256, key, utf8ToBytes(`clash.project-asset-import-session.v1\n${payload}`)),
    );
  return {
    async sign(claims) {
      if (Date.parse(claims.expiresAt) <= options.now())
        throw new Error("Import session expiry must be in the future.");
      const payload = bytesToHex(utf8ToBytes(JSON.stringify(claims)));
      return `${payload}.${signatureOf(payload)}`;
    },
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [payload, signature] = parts as [string, string];
      if (!/^[a-f0-9]+$/.test(payload) || !/^[a-f0-9]{64}$/.test(signature))
        return null;
      let provided: Uint8Array;
      try {
        provided = hexToBytes(signature);
      } catch {
        return null;
      }
      let expected: Uint8Array;
      try {
        expected = hexToBytes(signatureOf(payload));
      } catch {
        return null;
      }
      if (!sameBytes(provided, expected)) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(hexToBytes(payload)));
      } catch {
        return null;
      }
      const claims = parseClaims(raw);
      if (!claims || Date.parse(claims.expiresAt) <= options.now()) return null;
      return claims;
    },
  };
}
