/**
 * Chunked Project Asset import for the Node hosts (local-api, api-node).
 *
 * Mirrors the Cloudflare transport contract the Asset SDK already drives:
 *
 *   POST /assets/import-sessions
 *     { kind, projectAssetId, fileName, byteLength, contentType,
 *       duplicateContent?, metadataHints? }
 *     → 201 { sessionId, upload: { url } }
 *   PUT  upload.url?upload=begin|part|complete|abort&uploadId&partNumber
 *     (the shared `handleMultipartContent` protocol over an
 *      `AssetDeliveryStore` whose multipart adapter does not verify a digest
 *      when the staging target has none)
 *   POST /assets/import-sessions/:sessionId/finalize
 *     → 201 ResolvedAsset
 *
 * Everything platform-specific arrives through ports: the token codec, clock,
 * ids, Project access, the staging store and the adapter's existing single-shot
 * import commit path. The session id is the HMAC token; it binds owner,
 * Project, Asset id, byte length and the private staging locator, and expires.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AssetKindSchema, type ResolvedAsset } from "@clash/shared-types";
import {
  PROJECT_ASSET_IMPORT_MAX_BYTES,
  sanitizeAssetImportMetadataHints,
  type AssetImportMetadataHints,
} from "@clash/asset-sdk";
import {
  ContentTransferLimitError,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";
import {
  MultipartContentError,
  handleMultipartContent,
} from "@clash/asset-sdk/upload-service";
import { normalizeProjectAssetContentType } from "./project-assets.js";
import {
  PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  type ProjectAssetImportSessionClaims,
  type ProjectAssetImportSessionTokenPort,
} from "./project-asset-import-session-token.js";

export {
  createHmacProjectAssetImportSessionTokens,
  PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  type ProjectAssetImportSessionClaims,
  type ProjectAssetImportSessionTokenPort,
} from "./project-asset-import-session-token.js";

export interface ProjectAssetImportStagingPort {
  store: AssetDeliveryStore;
  /** Delete staged bytes after a successful finalize. */
  delete(locator: string): Promise<void>;
}

export interface ProjectAssetImportCommitInput {
  ownerId: string;
  projectId: string;
  projectAssetId: string;
  kind: ProjectAssetImportSessionClaims["kind"];
  fileName: string;
  contentType?: string;
  byteLength: number;
  /** Lowercase hex SHA-256 of the staged bytes. */
  digest: string;
  duplicateContent?: "allow" | "reject";
  metadataHints?: AssetImportMetadataHints;
  /** Re-open the staged bytes; the adapter's single-shot commit path consumes it. */
  openSource(): Promise<ReadableStream<Uint8Array>>;
}

export interface ProjectAssetImportSessionPorts {
  clock: { now(): number };
  newId(): string;
  tokens: ProjectAssetImportSessionTokenPort;
  access: {
    /** Live Project owned by `ownerId` (the local Host has one implicit owner). */
    canAccessProject(input: {
      projectId: string;
      ownerId: string;
    }): Promise<boolean>;
  };
  staging: ProjectAssetImportStagingPort;
  /** Absolute same-app URL serving the multipart protocol for this session. */
  uploadUrl(sessionId: string): string;
  /** Reuse the adapter's existing single-shot import commit path. */
  commit(input: ProjectAssetImportCommitInput): Promise<ResolvedAsset>;
  /** Existing Asset for an idempotent finalize retry after staging was deleted. */
  resolveCommitted(input: {
    projectId: string;
    ownerId: string;
    projectAssetId: string;
  }): Promise<ResolvedAsset | null>;
}

export type ProjectAssetImportSessionResult =
  | {
      status: 201;
      body: { sessionId: string; upload: { url: string } };
    }
  | {
      status: 400 | 403 | 404 | 409 | 413;
      body: Record<string, unknown>;
    };

export type ProjectAssetImportFinalizeResult =
  | { status: 201; body: ResolvedAsset }
  | {
      status: 400 | 403 | 404 | 409;
      body: Record<string, unknown>;
    };

const invalid = (error: string): ProjectAssetImportSessionResult => ({
  status: 400,
  body: { error, code: "INVALID_PROJECT_ASSET_IMPORT" },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, label: string): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
};

function parseDuplicateContent(
  value: unknown,
): "allow" | "reject" | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return value === "allow" || value === "reject" ? value : null;
}

/** Read a staged object once and return its lowercase hex SHA-256. */
async function stagedDigest(
  store: AssetDeliveryStore,
  locator: string,
): Promise<string | null> {
  const object = await store.get(locator);
  if (!object) return null;
  const hash = sha256.create();
  const reader = object.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return bytesToHex(hash.digest());
}

const importSessionError = (
  status: 403 | 404 | 409,
  error: string,
): ProjectAssetImportFinalizeResult => ({ status, body: { error } });

/**
 * `POST /assets/import-sessions`. The returned upload URL is served by the same
 * app and carries the same HMAC session token as its final path segment.
 */
export async function createProjectAssetImportSession(
  input: { projectId: string; ownerId: string; body: unknown },
  ports: ProjectAssetImportSessionPorts,
): Promise<ProjectAssetImportSessionResult> {
  if (!isRecord(input.body))
    return invalid("Invalid import session");
  const kind = AssetKindSchema.safeParse(input.body.kind);
  if (!kind.success)
    return invalid("A named, non-empty media file and kind are required");
  const projectAssetId = requiredString(input.body.projectAssetId, "Asset ID");
  if (!projectAssetId) return invalid("Asset ID is required");
  const fileName = requiredString(input.body.fileName, "file name");
  if (!fileName) return invalid("file name is required");
  const byteLength = input.body.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) <= 0)
    return invalid("Invalid import byte length");
  if ((byteLength as number) > PROJECT_ASSET_IMPORT_MAX_BYTES)
    return {
      status: 413,
      body: {
        error: new ContentTransferLimitError(PROJECT_ASSET_IMPORT_MAX_BYTES)
          .message,
        code: "CLOUD_CONTENT_TOO_LARGE",
        maxBytes: PROJECT_ASSET_IMPORT_MAX_BYTES,
      },
    };
  const duplicateContent = parseDuplicateContent(input.body.duplicateContent);
  if (duplicateContent === null)
    return invalid("duplicateContent must be allow or reject");
  const contentType = normalizeProjectAssetContentType({
    contentType:
      typeof input.body.contentType === "string"
        ? input.body.contentType
        : undefined,
    fileName,
    kind: kind.data,
  });
  const metadataHints = sanitizeAssetImportMetadataHints(
    input.body.metadataHints,
  );
  if (
    !(await ports.access.canAccessProject({
      projectId: input.projectId,
      ownerId: input.ownerId,
    }))
  )
    return { status: 404, body: { error: "Project not found" } };

  const stagingLocator = `${PROJECT_ASSET_IMPORT_STAGING_PREFIX}${ports.newId()}`;
  const sessionId = await ports.tokens.sign({
    version: 1,
    ownerId: input.ownerId,
    projectId: input.projectId,
    projectAssetId,
    kind: kind.data,
    fileName,
    byteLength: byteLength as number,
    ...(contentType === undefined ? {} : { contentType }),
    ...(duplicateContent === undefined ? {} : { duplicateContent }),
    ...(Object.keys(metadataHints).length
      ? { metadataHints }
      : {}),
    stagingLocator,
    expiresAt: new Date(
      ports.clock.now() + PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
    ).toISOString(),
  });
  return {
    status: 201,
    body: { sessionId, upload: { url: ports.uploadUrl(sessionId) } },
  };
}

/**
 * `POST /assets/import-sessions/:sessionId/finalize`. Re-checks the token,
 * Project access and the staged size, hashes the staged bytes, commits through
 * the adapter's single-shot path, then deletes staging. A repeat after a
 * successful finalize returns the same Asset instead of a 404.
 */
export async function finalizeProjectAssetImportSession(
  input: { projectId: string; sessionId: string; ownerId: string },
  ports: ProjectAssetImportSessionPorts,
): Promise<ProjectAssetImportFinalizeResult> {
  const claims = await ports.tokens.verify(input.sessionId);
  if (
    !claims ||
    claims.projectId !== input.projectId ||
    claims.ownerId !== input.ownerId
  )
    return importSessionError(403, "Invalid import session");
  if (
    !(await ports.access.canAccessProject({
      projectId: claims.projectId,
      ownerId: claims.ownerId,
    }))
  )
    return importSessionError(404, "Project not found");

  const staged = await ports.staging.store.head(claims.stagingLocator);
  if (!staged) {
    // Staging is deleted only after a successful commit, so an existing Asset
    // means this is an idempotent retry of the same finalize.
    const existing = await ports.resolveCommitted({
      projectId: claims.projectId,
      ownerId: claims.ownerId,
      projectAssetId: claims.projectAssetId,
    });
    return existing
      ? { status: 201, body: existing }
      : importSessionError(404, "Import session staging not found");
  }
  if (staged.size !== claims.byteLength)
    return importSessionError(
      409,
      "Import session byte length does not match",
    );
  const digest = await stagedDigest(ports.staging.store, claims.stagingLocator);
  if (digest === null)
    return importSessionError(404, "Import session staging not found");
  const asset = await ports.commit({
    ownerId: claims.ownerId,
    projectId: claims.projectId,
    projectAssetId: claims.projectAssetId,
    kind: claims.kind,
    fileName: claims.fileName,
    byteLength: claims.byteLength,
    digest,
    ...(claims.contentType === undefined
      ? {}
      : { contentType: claims.contentType }),
    ...(claims.duplicateContent === undefined
      ? {}
      : { duplicateContent: claims.duplicateContent }),
    ...(claims.metadataHints === undefined
      ? {}
      : { metadataHints: claims.metadataHints }),
    async openSource() {
      const object = await ports.staging.store.get(claims.stagingLocator);
      if (!object)
        throw new Error("Staged Project Asset bytes are missing");
      return object.body;
    },
  });
  // The Asset is committed; staging is transport-private from here on.
  await ports.staging.delete(claims.stagingLocator).catch(() => undefined);
  return { status: 201, body: asset };
}

/**
 * Serve `PUT …/import-sessions/:sessionId/content` with the shared multipart
 * protocol. The same auth and token check apply to begin, part and complete.
 */
export async function handleProjectAssetImportSessionContent(
  request: Request,
  input: { projectId: string; sessionId: string; ownerId: string },
  ports: ProjectAssetImportSessionPorts,
): Promise<Response> {
  const claims = await ports.tokens.verify(input.sessionId);
  if (
    !claims ||
    claims.projectId !== input.projectId ||
    claims.ownerId !== input.ownerId
  )
    return Response.json({ error: "Invalid import session" }, { status: 403 });
  const revalidate = async () => {
    const current = await ports.tokens.verify(input.sessionId);
    if (
      !current ||
      current.stagingLocator !== claims.stagingLocator ||
      !(await ports.access.canAccessProject({
        projectId: current.projectId,
        ownerId: current.ownerId,
      }))
    )
      throw new MultipartContentError(403, "Import session is no longer admitted");
  };
  try {
    const response = await handleMultipartContent(
      request,
      ports.staging.store,
      {
        identity: JSON.stringify({
          projectId: claims.projectId,
          ownerId: claims.ownerId,
          projectAssetId: claims.projectAssetId,
          stagingLocator: claims.stagingLocator,
        }),
        locator: claims.stagingLocator,
        // Import staging has no digest until finalize; the fs store skips the
        // check when the target carries none (same convention as R2).
        digest: "",
        byteLength: claims.byteLength,
        ...(claims.contentType === undefined
          ? {}
          : { contentType: claims.contentType }),
      },
      revalidate,
      revalidate,
    );
    return (
      response ??
      Response.json({ error: "Invalid multipart upload operation" }, { status: 400 })
    );
  } catch (error) {
    if (error instanceof ContentTransferLimitError)
      return Response.json(
        { error: error.message, code: error.code, maxBytes: error.maxBytes },
        { status: 413 },
      );
    if (error instanceof MultipartContentError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Project Asset import transport unavailable" },
      { status: 503 },
    );
  }
}
