/**
 * Node adapters + composition for the platform-agnostic upload service
 * (`@clash/asset-sdk/upload-service`, issue #130). Same module as the
 * Cloudflare upload Worker; only the adapters differ:
 *
 *   identity  → existing shared-runtime authenticateApiToken (Postgres api_token)
 *   admission → Postgres project_cloud_admission (same rules as D1)
 *   index     → Postgres project_content_ref (shared-cloud-schema 0013)
 *   store     → filesystem AssetDeliveryStore with resumable multipart
 *   room      → in-process room (shared-replica content indexer + event emitter)
 *
 * Compose as part of the Node monolith (`mountContentUpload(app, …)`) or run
 * it alone as a microservice (`createUploadServer`, src/upload-server.ts).
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import {
  MultipartContentError,
  createUploadService,
  type ContentPublishedEvent,
  type ContentReferenceIndex,
  type ContentReferenceIndexWriter,
  type ContentRoomPort,
  type ProjectContentAdmission,
  type ProjectContentReferences,
  type UploadIdentityVerifier,
  type UploadServicePorts,
} from "@clash/asset-sdk/upload-service";
import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";
import { createContentReferenceIndexer } from "@clash/replica/content-index";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import { authenticateApiToken } from "@clash/shared-runtime/project-authorization";
import { createPostgresProjectAuthorizationStore } from "@clash/shared-runtime/project-authorization-postgres";

interface Pg {
  query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export function createPostgresUploadIdentity(db: Pg): UploadIdentityVerifier {
  const authority = createPostgresProjectAuthorizationStore(db as never);
  return {
    async verify(request) {
      try {
        return { userId: (await authenticateApiToken(request, authority)).userId };
      } catch {
        return null;
      }
    },
  };
}

export function createPostgresContentAdmission(db: Pg): ProjectContentAdmission {
  return {
    async authorize(input) {
      const { rows } = await db.query<{
        tenant_id: string;
        user_id: string;
        status: string;
        capabilities_json: string;
      }>(
        `SELECT a.tenant_id, a.user_id, a.status, a.capabilities_json
         FROM project_cloud_admission a JOIN project p ON p.id = a.project_id
         WHERE a.project_id = $1 AND a.local_replica_id = $2 AND p.deleted_at IS NULL
           AND p.owner_id = a.user_id AND p.tenant_id = a.tenant_id LIMIT 1`,
        [input.projectId, input.localReplicaId],
      );
      const row = rows[0];
      if (
        !row ||
        row.status === "local-only" ||
        (input.userId && input.userId !== row.user_id) ||
        (input.tenantId && input.tenantId !== row.tenant_id)
      )
        return null;
      const caps = JSON.parse(row.capabilities_json);
      return caps.canvas === true && caps.resources === true ? { tenantId: row.tenant_id } : null;
    },
  };
}

export function createPostgresContentReferenceIndex(
  db: Pg & { transaction?<T>(work: (c: Pg) => Promise<T>): Promise<T> },
): ContentReferenceIndex & ContentReferenceIndexWriter {
  const one = async (projectId: string, kind: string, key: string) =>
    (
      await db.query<{ ref_key: string; byte_length: string | number | null; content_type: string | null; asset_kind: string | null }>(
        `SELECT ref_key, byte_length, content_type, asset_kind FROM project_content_ref
         WHERE project_id=$1 AND ref_kind=$2 AND ref_key=$3 LIMIT 1`,
        [projectId, kind, key],
      )
    ).rows[0];
  return {
    async document(projectId, digest) {
      const r = await one(projectId, "document", digest);
      return r && r.byte_length !== null && r.content_type
        ? { digest: r.ref_key, byteLength: Number(r.byte_length), contentType: r.content_type }
        : undefined;
    },
    async resource(projectId, resourceId) {
      const r = await one(projectId, "resource", resourceId);
      return r?.asset_kind ? { resourceId: r.ref_key, kind: r.asset_kind as never } : undefined;
    },
    async replace(projectId, refs) {
      const work = async (c: Pg) => {
        await c.query("DELETE FROM project_content_ref WHERE project_id=$1", [projectId]);
        for (const d of refs.documents)
          await c.query(
            `INSERT INTO project_content_ref (project_id, ref_kind, ref_key, byte_length, content_type) VALUES ($1,'document',$2,$3,$4)`,
            [projectId, d.digest, d.byteLength, d.contentType],
          );
        for (const r of refs.resources)
          await c.query(
            `INSERT INTO project_content_ref (project_id, ref_kind, ref_key, asset_kind) VALUES ($1,'resource',$2,$3)`,
            [projectId, r.resourceId, r.kind],
          );
      };
      if (db.transaction) await db.transaction(work);
      else await work(db);
    },
  };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Filesystem AssetDeliveryStore with resumable multipart staging. Objects
 * become visible only via an atomic rename after digest verification. */
export function createFsAssetDeliveryStore(root: string): AssetDeliveryStore {
  const safe = (locator: string) => {
    if (!locator || locator.startsWith("/") || locator.includes("..")) throw new Error("Invalid locator");
    return join(root, "objects", locator);
  };
  type Session = Parameters<NonNullable<AssetDeliveryStore["multipart"]>["begin"]>[0];
  const dirOf = (s: Session) => {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(s.uploadId))
      throw new MultipartContentError(400, "Invalid upload session ID");
    return join(root, "staging", sha256(new TextEncoder().encode(s.target.identity)), s.uploadId);
  };
  const readState = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "state.json"), "utf8").catch(() => "null")) as
      | { target: Session["target"]; aborted?: boolean }
      | null;
  const live = async (s: Session) => {
    const dir = dirOf(s);
    const state = await readState(dir);
    if (state?.aborted) throw new MultipartContentError(410, "Upload session was aborted");
    if (state && JSON.stringify(state.target) !== JSON.stringify(s.target))
      throw new MultipartContentError(409, "Upload session target changed");
    return { dir, state };
  };
  const parts = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => /^part-\d+$/.test(n))
      .map((n) => Number(n.slice(5)))
      .sort((a, b) => a - b);
  return {
    async head(locator) {
      const s = await stat(safe(locator)).catch(() => undefined);
      return s?.isFile() ? { size: s.size } : undefined;
    },
    async get(locator, range) {
      const path = safe(locator);
      const s = await stat(path).catch(() => undefined);
      if (!s?.isFile()) return undefined;
      const stream = createReadStream(path, range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
      return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size: s.size };
    },
    async put(locator, bytes) {
      const path = safe(locator);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    },
    multipart: {
      async begin(s) {
        const { dir, state } = await live(s);
        if (!state) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "state.json"), JSON.stringify({ target: s.target }));
        }
        return {
          parts: await Promise.all(
            (await parts(dir)).map(async (partNumber) => ({
              partNumber,
              sha256: sha256(await readFile(join(dir, `part-${partNumber}`))),
            })),
          ),
        };
      },
      async part(s, partNumber, bytes) {
        const { dir, state } = await live(s);
        if (!state) throw new MultipartContentError(409, "Upload session not begun");
        const count = Math.max(1, Math.ceil(s.target.byteLength / PROJECT_CLOUD_CONTENT_PART_BYTES));
        const expected = partNumber === count ? s.target.byteLength - (count - 1) * PROJECT_CLOUD_CONTENT_PART_BYTES : PROJECT_CLOUD_CONTENT_PART_BYTES;
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count || bytes.length !== expected)
          throw new MultipartContentError(400, "Multipart part length or number does not match");
        const tmp = join(dir, `.part-${partNumber}.${Date.now()}`);
        await writeFile(tmp, bytes);
        await rename(tmp, join(dir, `part-${partNumber}`));
      },
      async complete(s, beforePublish) {
        const { dir, state } = await live(s);
        if (!state) throw new MultipartContentError(409, "Upload session not begun");
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let total = 0;
        for (const n of await parts(dir)) {
          const b = await readFile(join(dir, `part-${n}`));
          hash.update(b);
          chunks.push(b);
          total += b.length;
        }
        if (total !== s.target.byteLength) throw new MultipartContentError(409, "Multipart upload is incomplete");
        if (`sha256:${hash.digest("hex")}` !== s.target.digest)
          throw new MultipartContentError(400, "Multipart object digest mismatch");
        await beforePublish();
        const path = safe(s.target.locator);
        await mkdir(dirname(path), { recursive: true });
        const tmp = join(dir, "assembled");
        await writeFile(tmp, Buffer.concat(chunks));
        await rename(tmp, path);
        await rm(dir, { recursive: true, force: true });
      },
      async abort(s) {
        const dir = dirOf(s);
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "state.json"), JSON.stringify({ target: s.target, aborted: true }));
      },
    },
  };
}

/** In-process room port for a Node process that hosts rooms itself. `compute`
 * returns the room's current references (e.g. projectSyncContent(doc)). */
export function createInProcessContentRoom(options: {
  compute(projectId: string): ProjectContentReferences;
  index: ContentReferenceIndexWriter;
  debounceMs?: number;
}): ContentRoomPort & {
  events: EventEmitter;
  changed(projectId: string): void;
  flush(): Promise<void>;
} {
  const events = new EventEmitter();
  const indexers = new Map<string, ReturnType<typeof createContentReferenceIndexer<ProjectContentReferences>>>();
  const indexerFor = (projectId: string) => {
    let indexer = indexers.get(projectId);
    if (!indexer) {
      indexer = createContentReferenceIndexer({
        compute: () => options.compute(projectId),
        writer: { replace: (refs) => options.index.replace(projectId, refs) },
        debounceMs: options.debounceMs,
      });
      indexers.set(projectId, indexer);
    }
    return indexer;
  };
  return {
    events,
    changed: (projectId) => indexerFor(projectId).changed(),
    references: (projectId) => indexerFor(projectId).refresh(),
    async notifyPublished(event: ContentPublishedEvent) {
      events.emit("content.published", event);
    },
    async flush() {
      await Promise.all([...indexers.values()].map((i) => i.flush()));
    },
  };
}

/** Mount the upload routes on any Hono app (monolith or standalone). */
export function mountContentUpload(app: Hono<any>, ports: UploadServicePorts) {
  const service = createUploadService(ports);
  app.on(["GET", "HEAD", "PUT"], "/api/v1/projects/:id/document-bodies/:digest", (c) =>
    service.documentBody(c.req.raw, c.req.param("id"), c.req.param("digest")),
  );
  return service;
}

/** Microservice mode: a process that serves only uploads. */
export function createUploadServer(ports: UploadServicePorts) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "clash-upload" }));
  mountContentUpload(app, ports);
  return app;
}

/** Node room port over the Postgres replica log (the Node equivalent of the
 * ProjectRoom `content-refs` route): computes references from the current
 * Project document and refreshes the index. Notifications go to an emitter
 * the relay/gateway can subscribe to. */
export function createPostgresReplicaContentRoom(options: {
  db: PostgresTransactionPort;
  index: ContentReferenceIndexWriter;
}): ContentRoomPort & { events: EventEmitter } {
  const events = new EventEmitter();
  return {
    events,
    async references(projectId) {
      const owner = await options.db.query<{ owner_id: string }>(
        "SELECT owner_id FROM project WHERE id=$1 AND deleted_at IS NULL",
        [projectId],
      );
      if (!owner.rows[0]) return { resources: [], documents: [] };
      const refs = await withProjectDocument(
        options.db,
        owner.rows[0].owner_id,
        projectId,
        false,
        (doc) => projectSyncContent(doc),
      );
      await options.index.replace(projectId, refs);
      return refs;
    },
    async notifyPublished(event) {
      events.emit("content.published", event);
    },
  };
}

/** Default Node composition (Postgres + filesystem), used by the monolith and
 * by the standalone upload microservice. */
export function createNodeUploadPorts(options: {
  db: PostgresTransactionPort;
  contentDirectory: string;
  room?: ContentRoomPort;
  log?: UploadServicePorts["telemetry"];
}): UploadServicePorts {
  const index = createPostgresContentReferenceIndex(options.db);
  return {
    identity: createPostgresUploadIdentity(options.db),
    admission: createPostgresContentAdmission(options.db),
    index,
    store: createFsAssetDeliveryStore(options.contentDirectory),
    room: options.room ?? createPostgresReplicaContentRoom({ db: options.db, index }),
    telemetry: options.log,
  };
}
