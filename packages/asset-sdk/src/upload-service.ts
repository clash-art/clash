/**
 * Platform-agnostic Project content upload service (issue #130).
 *
 * Owns `GET|HEAD|PUT /api/v1/projects/:id/document-bodies/:digest` (single-shot
 * and resumable multipart `?upload=begin|part|complete|abort`) and admission of
 * Resource capability transfers. It depends ONLY on injected ports:
 *
 *  - {@link UploadIdentityVerifier}  who is calling (API token / session / trusted header)
 *  - {@link ProjectContentAdmission} replica admission (D1, Postgres, SQLite …)
 *  - {@link ContentReferenceIndex}   which digests/Resources a Project references
 *  - {@link AssetDeliveryStore}      bytes + resumable multipart (R2, S3, fs …)
 *  - {@link ContentRoomPort}         authoritative fallback + `content.published` notify
 *  - {@link UploadServiceTelemetry}  logger/clock; failures are classified with the
 *                                    shared #121 SyncErrorSeverity taxonomy
 *
 * There is no Durable Object, Loro document or platform SDK in this module, so
 * the same code runs inside a Cloudflare Worker, api-cf, or a Node process.
 * Composition happens in thin entrypoints only.
 */
import type { AssetKind } from "@clash/shared-types/assets";
import {
  classifySyncError,
  type SyncErrorSeverity,
} from "@clash/shared-types/sync-error-severity";
import type {
  AssetDeliveryMultipartSession,
  AssetDeliveryStore,
} from "./asset-delivery-store.js";
import {
  ContentTransferLimitError,
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  assertContentTransferSize,
  readBoundedContent,
} from "./content-transfer.js";

export interface DocumentBodyReference {
  digest: string;
  byteLength: number;
  contentType: string;
}
export interface ResourceReference {
  resourceId: string;
  kind: AssetKind;
}
export interface ProjectContentReferences {
  resources: ResourceReference[];
  documents: DocumentBodyReference[];
}

// ─── Ports ──────────────────────────────────────────────────────────────────

export interface UploadIdentityVerifier {
  /** Resolve the caller from the request, or null when unauthenticated. */
  verify(request: Request): Promise<{ userId: string } | null>;
}

export interface ProjectContentAdmission {
  /** Same contract as api-cf ProjectContentPorts.authorize. */
  authorize(input: {
    projectId: string;
    localReplicaId: string;
    userId?: string;
    tenantId?: string;
  }): Promise<{ tenantId: string } | null>;
}

/** Read side of the Project content-reference index the room maintains. */
export interface ContentReferenceIndex {
  document(
    projectId: string,
    digest: string,
  ): Promise<DocumentBodyReference | undefined>;
  resource(
    projectId: string,
    resourceId: string,
  ): Promise<ResourceReference | undefined>;
}

/** Write side, used by the room (any runtime) after it accepts an update. */
export interface ContentReferenceIndexWriter {
  replace(projectId: string, refs: ProjectContentReferences): Promise<void>;
}

export interface ContentPublishedEvent {
  type: "content.published";
  projectId: string;
  kind: "document" | "resource";
  digest: string;
  byteLength: number;
}

export interface ContentRoomPort {
  /** Authoritative references computed by the room (index miss fallback). The
   * room refreshes the index as a side effect. Optional: a deployment whose
   * index is written synchronously can omit it. */
  references?(projectId: string): Promise<ProjectContentReferences>;
  /** Small fire-and-forget notification; failures never fail the upload. */
  notifyPublished?(event: ContentPublishedEvent): Promise<void>;
}

export interface UploadServiceTelemetry {
  log?(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void;
  now?(): number;
}

export interface UploadServicePorts {
  identity: UploadIdentityVerifier;
  admission: ProjectContentAdmission;
  index: ContentReferenceIndex;
  store: AssetDeliveryStore;
  room?: ContentRoomPort;
  telemetry?: UploadServiceTelemetry;
  /** Locator hashing is part of the storage layout contract (unchanged from api-cf). */
  maxBytes?: number;
  /** Defer background work (Workers ctx.waitUntil); defaults to fire-and-forget. */
  defer?(work: Promise<unknown>): void;
}

// ─── Shared helpers (moved from api-cf; layout unchanged) ───────────────────

export class MultipartContentError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 410 | 501,
    message: string,
  ) {
    super(message);
  }
}

export async function contentHash(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function documentLocator(
  tenantId: string,
  digest: string,
): Promise<string> {
  return `project-content/${await contentHash(tenantId)}/documents/${digest.slice("sha256:".length)}`;
}

/** Index first; on a miss ask the room once (covers the race where an upload
 * starts before the room's index write lands, and Projects indexed before #130). */
export function createContentReferenceResolver(
  index: ContentReferenceIndex,
  room?: ContentRoomPort,
) {
  return {
    async document(projectId: string, digest: string) {
      const hit = await index.document(projectId, digest);
      if (hit || !room?.references) return hit;
      return (await room.references(projectId)).documents.find(
        (ref) => ref.digest === digest,
      );
    },
    async resource(projectId: string, resourceId: string) {
      const hit = await index.resource(projectId, resourceId);
      if (hit || !room?.references) return hit;
      return (await room.references(projectId)).resources.find(
        (ref) => ref.resourceId === resourceId,
      );
    },
  };
}

type Session = AssetDeliveryMultipartSession;

/** Resumable multipart protocol (unchanged wire contract). */
export async function handleMultipartContent(
  request: Request,
  store: AssetDeliveryStore,
  target: Session["target"],
  beforePublish: () => Promise<void>,
  beforePart: () => Promise<void> = beforePublish,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    operation = url.searchParams.get("upload");
  if (!operation) return undefined;
  if (!["begin", "part", "complete", "abort"].includes(operation))
    throw new MultipartContentError(400, "Invalid multipart upload operation");
  if (!store.multipart)
    throw new MultipartContentError(
      501,
      "This content store does not support multipart uploads",
    );
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const session = { uploadId, target };
  if (operation === "part") {
    const declared = request.headers.get("content-length");
    if (declared !== null)
      assertContentTransferSize(
        Number(declared),
        PROJECT_CLOUD_CONTENT_PART_BYTES,
      );
    const bytes = await readBoundedContent(request.body, {
      maxBytes: PROJECT_CLOUD_CONTENT_PART_BYTES,
    });
    await beforePart();
    await store.multipart.part(
      session,
      Number(url.searchParams.get("partNumber")),
      bytes,
    );
  } else {
    const bytes = await readBoundedContent(request.body, { maxBytes: 1024 });
    if (bytes.length)
      throw new MultipartContentError(
        400,
        "Multipart control requests have no body",
      );
    if (operation === "begin") {
      const begun = await store.multipart.begin(session);
      // Only part numbers and content hashes leave staging; ETags stay private.
      return Response.json({
        uploadId,
        partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
        parts: begun?.parts ?? [],
      });
    }
    if (operation === "complete")
      await store.multipart.complete(session, beforePublish);
    if (operation === "abort") await store.multipart.abort(session);
  }
  return new Response(null, { status: 204 });
}

/** Headers can reject known oversized objects. Actual-byte mismatch after response
 * start errors the stream; the receiving Host must finish integrity verification. */
export function exactLengthContentStream(
  body: ReadableStream<Uint8Array>,
  expectedLength: number,
): ReadableStream<Uint8Array> {
  let length = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        length += bytes.length;
        if (length > expectedLength)
          throw new Error("Cloud content length mismatch");
        controller.enqueue(bytes);
      },
      flush() {
        if (length !== expectedLength)
          throw new Error("Cloud content length mismatch");
      },
    }),
  );
}

// ─── Service ────────────────────────────────────────────────────────────────

const DOCUMENT_BODY_PATH =
  /^\/api\/v1\/projects\/([^/]+)\/document-bodies\/([^/]+)$/;

const json = (body: unknown, status: number) => Response.json(body, { status });

export interface UploadService {
  /** Returns undefined when the request is not an upload-service route. */
  handle(request: Request): Promise<Response | undefined>;
  /** Route-level handler for frameworks that already matched the path. */
  documentBody(
    request: Request,
    projectId: string,
    digest: string,
  ): Promise<Response>;
  references: ReturnType<typeof createContentReferenceResolver>;
}

export function createUploadService(ports: UploadServicePorts): UploadService {
  const refs = createContentReferenceResolver(ports.index, ports.room);
  const now = ports.telemetry?.now ?? Date.now;
  const defer =
    ports.defer ?? ((work: Promise<unknown>) => void work.catch(() => {}));

  function report(
    event: string,
    status: number,
    fields: Record<string, unknown>,
  ): SyncErrorSeverity | undefined {
    if (status < 400) return undefined;
    const { severity, policy } = classifySyncError({ httpStatus: status });
    ports.telemetry?.log?.(policy.log, event, { ...fields, status, severity });
    return severity;
  }

  function errorResponse(error: unknown): Response {
    if (error instanceof ContentTransferLimitError)
      return json(
        { error: error.message, code: error.code, maxBytes: error.maxBytes },
        413,
      );
    if (error instanceof MultipartContentError)
      return json({ error: error.message }, error.status);
    return json({ error: "Cloud content transport unavailable" }, 503);
  }

  async function documentBody(
    request: Request,
    projectId: string,
    digest: string,
  ): Promise<Response> {
    const started = now();
    const op =
      new URL(request.url).searchParams.get("upload") ?? request.method;
    let response: Response;
    try {
      response = await documentBodyInner(request, projectId, digest);
    } catch (error) {
      response = errorResponse(error);
      if (response.status === 503)
        ports.telemetry?.log?.("error", "upload.unavailable", {
          projectId,
          op,
          error: error instanceof Error ? error.message : String(error),
        });
    }
    report("upload.document_body", response.status, {
      projectId,
      op,
      ms: now() - started,
    });
    return response;
  }

  async function documentBodyInner(
    request: Request,
    projectId: string,
    digest: string,
  ): Promise<Response> {
    const identity = await ports.identity.verify(request);
    const localReplicaId = request.headers.get("x-local-replica-id");
    if (!identity || !localReplicaId) return json({ error: "unauthorized" }, 401);
    const userId = identity.userId;
    const admission = await ports.admission.authorize({
      projectId,
      localReplicaId,
      userId,
    });
    if (!admission) return json({ error: "not_admitted" }, 403);
    const ref = await refs.document(projectId, digest);
    if (!ref) return json({ error: "document_not_in_project" }, 404);
    const store = ports.store;
    assertContentTransferSize(ref.byteLength, ports.maxBytes);
    const key = await documentLocator(admission.tenantId, digest);
    // Revalidate admission + reference right before bytes become reachable.
    const stillPublishable = async () => {
      if (
        !(await ports.admission.authorize({ projectId, localReplicaId, userId }))
      )
        throw new MultipartContentError(403, "Document no longer admitted");
      const current = await refs.document(projectId, ref.digest);
      if (!current || current.byteLength !== ref.byteLength)
        throw new MultipartContentError(403, "Document no longer referenced");
    };
    const published = () =>
      ports.room?.notifyPublished &&
      defer(
        ports.room.notifyPublished({
          type: "content.published",
          projectId,
          kind: "document",
          digest: ref.digest,
          byteLength: ref.byteLength,
        }),
      );
    if (request.method === "PUT") {
      const response = await handleMultipartContent(
        request,
        store,
        {
          identity: JSON.stringify({
            tenantId: admission.tenantId,
            projectId,
            localReplicaId,
            digest,
          }),
          locator: key,
          digest: ref.digest,
          byteLength: ref.byteLength,
          contentType: ref.contentType,
        },
        stillPublishable,
        // Parts are private staging, idempotent and unreachable until complete;
        // admission + reference were checked at the top of this request.
        async () => {},
      );
      if (response) {
        if (
          new URL(request.url).searchParams.get("upload") === "complete" &&
          response.status === 204
        )
          published();
        return response;
      }
      const requestMaxBytes = Math.min(
        ports.maxBytes ?? PROJECT_CLOUD_CONTENT_PART_BYTES,
        PROJECT_CLOUD_CONTENT_PART_BYTES,
      );
      const declaredLength = request.headers.get("content-length");
      if (declaredLength !== null)
        assertContentTransferSize(Number(declaredLength), requestMaxBytes);
      const bytes = await readBoundedContent(request.body, {
        maxBytes: requestMaxBytes,
      });
      if (
        bytes.byteLength !== ref.byteLength ||
        `sha256:${await contentHash(bytes)}` !== ref.digest
      )
        return json({ error: "document_integrity_mismatch" }, 400);
      if (
        !(await ports.admission.authorize({ projectId, localReplicaId, userId }))
      )
        return json({ error: "not_admitted" }, 403);
      if (!(await refs.document(projectId, digest)))
        return json({ error: "document_not_in_project" }, 404);
      await store.put(key, bytes, { contentType: ref.contentType });
      published();
      return new Response(null, { status: 204 });
    }
    if (request.method === "HEAD") {
      const head = await store.head(key);
      return head && head.size === ref.byteLength
        ? new Response(null, {
            headers: {
              "Content-Length": String(head.size),
              "Cache-Control": "private, no-store",
            },
          })
        : json({ error: "document_not_replicated" }, 404);
    }
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const value = await store.get(key);
    if (!value) return json({ error: "document_not_replicated" }, 404);
    assertContentTransferSize(value.size, ports.maxBytes);
    if (value.size !== ref.byteLength)
      return json({ error: "document_integrity_mismatch" }, 502);
    return new Response(exactLengthContentStream(value.body, ref.byteLength), {
      headers: {
        "Content-Type": ref.contentType,
        "Content-Length": String(ref.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  }

  return {
    references: refs,
    documentBody,
    async handle(request) {
      const match = DOCUMENT_BODY_PATH.exec(new URL(request.url).pathname);
      if (!match) return undefined;
      let projectId: string, digest: string;
      try {
        projectId = decodeURIComponent(match[1]!);
        digest = decodeURIComponent(match[2]!);
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      return documentBody(request, projectId, digest);
    },
  };
}

// ─── In-memory adapters (tests, Node mono mode, local dev) ──────────────────

export function createInMemoryContentReferenceIndex(): ContentReferenceIndex &
  ContentReferenceIndexWriter & { rows: Map<string, ProjectContentReferences> } {
  const rows = new Map<string, ProjectContentReferences>();
  return {
    rows,
    async replace(projectId, refs) {
      rows.set(projectId, {
        resources: [...refs.resources],
        documents: [...refs.documents],
      });
    },
    async document(projectId, digest) {
      return rows.get(projectId)?.documents.find((d) => d.digest === digest);
    },
    async resource(projectId, resourceId) {
      return rows
        .get(projectId)
        ?.resources.find((r) => r.resourceId === resourceId);
    },
  };
}

/** Trusts an `x-user-id` header that an upstream gateway already validated and
 * re-set (api-cf mounts the service behind its own identity middleware). */
export const trustedHeaderIdentity: UploadIdentityVerifier = {
  async verify(request) {
    const userId = request.headers.get("x-user-id");
    return userId ? { userId } : null;
  },
};

/** Reference AssetDeliveryStore with resumable multipart, held in memory.
 * Same observable contract as the R2 adapter: digest/length verified on
 * complete, nothing reachable before publish, abort idempotent, aborted
 * sessions cannot resume (410). */
export function createInMemoryAssetDeliveryStore(): AssetDeliveryStore & {
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const sessions = new Map<
    string,
    { target: Session["target"]; parts: Map<number, Uint8Array>; aborted?: boolean }
  >();
  const keyOf = (s: Session) => `${s.target.identity}\u0000${s.uploadId}`;
  const open = (s: Session) => {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(s.uploadId))
      throw new MultipartContentError(400, "Invalid upload session ID");
    const existing = sessions.get(keyOf(s));
    if (existing?.aborted)
      throw new MultipartContentError(410, "Upload session was aborted");
    if (
      existing &&
      JSON.stringify(existing.target) !== JSON.stringify(s.target)
    )
      throw new MultipartContentError(409, "Upload session target changed");
    return existing;
  };
  return {
    objects,
    head(locator) {
      const o = objects.get(locator);
      return o && { size: o.bytes.length, contentType: o.contentType };
    },
    get(locator, range) {
      const o = objects.get(locator);
      if (!o) return undefined;
      const bytes = range
        ? o.bytes.slice(range.offset, range.offset + range.length)
        : o.bytes;
      return {
        body: new Response(new Uint8Array(bytes)).body!,
        size: o.bytes.length,
        contentType: o.contentType,
      };
    },
    put(locator, bytes, options) {
      objects.set(locator, { bytes: bytes.slice(), contentType: options?.contentType });
    },
    multipart: {
      async begin(s) {
        let session = open(s);
        if (!session) {
          session = { target: s.target, parts: new Map() };
          sessions.set(keyOf(s), session);
        }
        return {
          parts: await Promise.all(
            [...session.parts.entries()]
              .sort(([a], [b]) => a - b)
              .map(async ([partNumber, bytes]) => ({
                partNumber,
                sha256: await contentHash(bytes),
              })),
          ),
        };
      },
      async part(s, partNumber, bytes) {
        const session = open(s);
        if (!session) throw new MultipartContentError(409, "Upload session not begun");
        const count = Math.max(
          1,
          Math.ceil(s.target.byteLength / PROJECT_CLOUD_CONTENT_PART_BYTES),
        );
        const expected =
          partNumber === count
            ? s.target.byteLength - (count - 1) * PROJECT_CLOUD_CONTENT_PART_BYTES
            : PROJECT_CLOUD_CONTENT_PART_BYTES;
        if (
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > count ||
          bytes.length !== expected
        )
          throw new MultipartContentError(400, "Multipart part length or number does not match");
        session.parts.set(partNumber, bytes.slice());
      },
      async complete(s, beforePublish) {
        const session = open(s);
        if (!session) throw new MultipartContentError(409, "Upload session not begun");
        const ordered = [...session.parts.entries()].sort(([a], [b]) => a - b);
        const total = ordered.reduce((n, [, b]) => n + b.length, 0);
        if (total !== s.target.byteLength)
          throw new MultipartContentError(409, "Multipart upload is incomplete");
        const all = new Uint8Array(total);
        let offset = 0;
        for (const [, b] of ordered) {
          all.set(b, offset);
          offset += b.length;
        }
        if (
          s.target.digest !== "" &&
          `sha256:${await contentHash(all)}` !== s.target.digest
        )
          throw new MultipartContentError(400, "Multipart object digest mismatch");
        await beforePublish();
        objects.set(s.target.locator, { bytes: all, contentType: s.target.contentType });
        sessions.delete(keyOf(s));
      },
      async abort(s) {
        const k = keyOf(s);
        sessions.set(k, { target: s.target, parts: new Map(), aborted: true });
      },
    },
  };
}
