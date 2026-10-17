/**
 * Text revision history (`clash text apply` → index → history → content) for
 * every server adapter. Same rules as the local Host: a revision is immutable
 * metadata keyed by `revisionId`; its Markdown body is a content-addressed
 * blob keyed by the sha256-64 `contentHash`. Re-indexing identical metadata
 * or content is idempotent, a different one under the same key is a 409.
 *
 * Storage arrives through ports: the Cloudflare adapter uses D1 + R2, the
 * Node adapter Postgres + disk. Nothing here knows which.
 */
import {
  TextAppliedRevisionSchema,
  type TextAppliedRevision,
  type TextRevisionContentDescriptor,
  type TextRevisionHistoryEntry,
} from "@clash/shared-types";
import { sha256Hex } from "../sha256-hex.js";

export interface TextRevisionListFilter {
  projectId: string;
  nodeId?: string;
  /** Already clamped to 1..200 by `textRevisionLimit`. */
  limit: number;
}

export interface TextRevisionStorePort {
  /** Keyed per Project, so one tenant's ids never collide with another's. */
  get(projectId: string, revisionId: string): Promise<TextAppliedRevision | null>;
  /** Insert or replace (only called with identical or new metadata). */
  put(revision: TextAppliedRevision): Promise<void>;
  /** Newest first: `createdAt` desc, then `revisionId` desc. */
  list(filter: TextRevisionListFilter): Promise<TextAppliedRevision[]>;
}

/**
 * Bodies are scoped per Project. A revision row may name any contentHash
 * without uploading a body, so a store shared across tenants would let one
 * Project read another's text by guessing or copying a 64-bit hash.
 */
export interface TextRevisionBlobPort {
  read(projectId: string, contentHash: string): Promise<string | null>;
  /** Existence only (R2 HEAD / stat): history lists never fetch bodies. */
  has(projectId: string, contentHash: string): Promise<boolean>;
  write(projectId: string, contentHash: string, content: string): Promise<void>;
}

export interface TextRevisionPorts {
  store: TextRevisionStorePort;
  blobs: TextRevisionBlobPort;
  /** Whether the caller may read/write this Project (live and owned). */
  canAccessProject(projectId: string): Promise<boolean>;
}

export type TextRevisionResult<T = Record<string, unknown>> = {
  status: 200 | 400 | 404 | 409;
  body: T | { error: string; code?: string };
};

const HASH = /^[a-f0-9]{16}$/;

export function textRevisionContentHash(content: string): string {
  return sha256Hex(content).slice(0, 16);
}

export function textRevisionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function isSafeProjectRelativePath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  )
    return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function parseTextRevisionForIndex(
  value: unknown,
): { ok: true; revision: TextAppliedRevision } | { ok: false; error: string } {
  const parsed = TextAppliedRevisionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "Invalid text revision" };
  const revision = parsed.data;
  if (!HASH.test(revision.contentHash) || !HASH.test(revision.sourceFileHash))
    return {
      ok: false,
      error: "Text revision hashes must be sha256-64 hex strings",
    };
  if (revision.sourceFileHash !== revision.contentHash)
    return {
      ok: false,
      error: "Text revision source file hash must match content hash",
    };
  if (!isSafeProjectRelativePath(revision.sourceFilePath))
    return {
      ok: false,
      error: "Text revision source file path must be project-relative",
    };
  return { ok: true, revision };
}

export function textRevisionContentUrl(revision: TextAppliedRevision): string {
  return `/api/v1/projects/${encodeURIComponent(revision.projectId)}/text-revisions/${encodeURIComponent(revision.revisionId)}/content`;
}

export function textRevisionContentDescriptor(
  revision: TextAppliedRevision,
  options: { stored?: true } = {},
): TextRevisionContentDescriptor {
  return {
    kind: "text-revision-content",
    ...(options.stored ? { stored: true as const } : {}),
    contentHash: revision.contentHash,
    mediaType: "text/markdown",
    url: textRevisionContentUrl(revision),
    immutable: true,
    storage: {
      kind: "content-addressed-revision-blob",
      registry: "text_revisions",
      mediaAsset: false,
      agentWritable: false,
    },
  };
}

const sameRevision = (left: TextAppliedRevision, right: TextAppliedRevision) =>
  JSON.stringify(TextAppliedRevisionSchema.parse(left)) ===
  JSON.stringify(TextAppliedRevisionSchema.parse(right));

const PROJECT_NOT_FOUND = {
  status: 404 as const,
  body: { error: "Project not found", code: "PROJECT_NOT_FOUND" },
};

/** `POST /api/v1/text-revisions` with `{ revision, content? }`. */
export async function indexTextRevision(
  body: unknown,
  ports: TextRevisionPorts,
): Promise<
  TextRevisionResult<{
    revision: TextAppliedRevision;
    content?: TextRevisionContentDescriptor;
  }>
> {
  const input = (body ?? {}) as { revision?: unknown; content?: unknown };
  const parsed = parseTextRevisionForIndex(input.revision);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const { revision } = parsed;
  if (!(await ports.canAccessProject(revision.projectId)))
    return PROJECT_NOT_FOUND;
  const content = typeof input.content === "string" ? input.content : undefined;
  if (content !== undefined) {
    if (textRevisionContentHash(content) !== revision.contentHash)
      return {
        status: 400,
        body: { error: "text revision contentHash does not match content" },
      };
    const existing = await ports.blobs.read(
      revision.projectId,
      revision.contentHash,
    );
    if (existing !== null && existing !== content)
      return {
        status: 409,
        body: {
          error:
            "text revision content blob already exists with different content",
        },
      };
  }
  const stored = await ports.store.get(
    revision.projectId,
    revision.revisionId,
  );
  if (stored && !sameRevision(stored, revision))
    return {
      status: 409,
      body: {
        error: `Text revision ${revision.revisionId} already exists with different metadata`,
      },
    };
  // Blob before row: a listed revision never points at a missing body.
  if (content !== undefined)
    await ports.blobs.write(revision.projectId, revision.contentHash, content);
  if (!stored) await ports.store.put(revision);
  return {
    status: 200,
    body: {
      revision,
      ...(content !== undefined
        ? { content: textRevisionContentDescriptor(revision, { stored: true }) }
        : {}),
    },
  };
}

/** `GET /api/v1/projects/:projectId/text-revisions?nodeId&limit`. */
export async function listTextRevisionHistory(
  input: { projectId: string; nodeId?: string; limit?: number },
  ports: TextRevisionPorts,
): Promise<TextRevisionResult<{ revisions: TextRevisionHistoryEntry[] }>> {
  if (!(await ports.canAccessProject(input.projectId)))
    return PROJECT_NOT_FOUND;
  const nodeId = input.nodeId?.trim();
  const revisions = await ports.store.list({
    projectId: input.projectId,
    ...(nodeId ? { nodeId } : {}),
    limit: textRevisionLimit(input.limit),
  });
  const hashes = [...new Set(revisions.map((r) => r.contentHash))];
  const present = new Set(
    (
      await Promise.all(
        hashes.map(async (hash) =>
          (await ports.blobs.has(input.projectId, hash)) ? hash : null,
        ),
      )
    ).filter((hash): hash is string => hash !== null),
  );
  return {
    status: 200,
    body: {
      revisions: revisions.map((revision) =>
        present.has(revision.contentHash)
          ? {
              ...revision,
              content: textRevisionContentDescriptor(revision, { stored: true }),
            }
          : revision,
      ),
    },
  };
}

/** `GET …/text-revisions/:revisionId/content`: the verified Markdown body. */
export async function readTextRevisionContent(
  input: { projectId: string; revisionId: string },
  ports: TextRevisionPorts,
): Promise<
  | { status: 200; content: string; contentHash: string }
  | { status: 404 | 409; body: { error: string; code?: string } }
> {
  if (!(await ports.canAccessProject(input.projectId)))
    return PROJECT_NOT_FOUND;
  const revision = await ports.store.get(input.projectId, input.revisionId);
  if (!revision)
    return { status: 404, body: { error: "text revision not found" } };
  const content = await ports.blobs.read(
    input.projectId,
    revision.contentHash,
  );
  if (content === null)
    return { status: 404, body: { error: "text revision content not found" } };
  if (textRevisionContentHash(content) !== revision.contentHash)
    return {
      status: 409,
      body: { error: "text revision content blob hash mismatch" },
    };
  return { status: 200, content, contentHash: revision.contentHash };
}

/** Headers for a content response: immutable, but private to the caller. */
export function textRevisionContentHeaders(contentHash: string) {
  return {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "private, max-age=31536000, immutable",
    "x-clash-content-hash": contentHash,
  };
}
