/**
 * Cloudflare adapters for the platform-agnostic upload service
 * (`@clash/asset-sdk/upload-service`, issue #130): D1 admission, D1
 * content-reference index, R2 Resource registry and a ProjectRoom notifier.
 *
 * Deliberately free of loro-crdt and of any Durable Object class so the
 * stateless upload Worker (src/upload-worker.ts) bundles small and starts fast.
 * The ROOM binding is only used for the rare index-miss fallback and the
 * `content.published` notification; no snapshot crosses it.
 */
import { ResourceSchema, type Resource } from "@clash/shared-types/assets";
import type {
  ContentReferenceIndex,
  ContentReferenceIndexWriter,
  ContentRoomPort,
  ProjectContentAdmission,
  ProjectContentReferences,
} from "@clash/asset-sdk/upload-service";
import { contentHash } from "@clash/asset-sdk/upload-service";

export class ProjectContentConflictError extends Error {}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
  batch?(statements: unknown[]): Promise<unknown>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: any): { fetch(request: Request): Promise<Response> };
}
interface R2Like {
  put(key: string, value: string, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export function createD1ProjectContentAdmission(
  db: D1Like,
): ProjectContentAdmission {
  return {
    async authorize(input) {
      const row = await db
        .prepare(
          `SELECT a.tenant_id, a.user_id, a.status, a.capabilities_json
        FROM project_cloud_admission a JOIN project p ON p.id = a.project_id
        WHERE a.project_id = ? AND a.local_replica_id = ? AND p.deleted_at IS NULL
          AND p.owner_id = a.user_id AND p.tenant_id = a.tenant_id LIMIT 1`,
        )
        .bind(input.projectId, input.localReplicaId)
        .first<{
          tenant_id: string;
          user_id: string;
          status: string;
          capabilities_json: string;
        }>();
      if (
        !row ||
        row.status === "local-only" ||
        (input.userId && input.userId !== row.user_id) ||
        (input.tenantId && input.tenantId !== row.tenant_id)
      )
        return null;
      const capabilities = JSON.parse(row.capabilities_json);
      return capabilities.canvas === true && capabilities.resources === true
        ? { tenantId: row.tenant_id }
        : null;
    },
  };
}

type RefRow = {
  ref_key: string;
  byte_length: number | null;
  content_type: string | null;
  asset_kind: string | null;
};

export function createD1ContentReferenceIndex(
  db: D1Like,
): ContentReferenceIndex & ContentReferenceIndexWriter {
  const one = (projectId: string, kind: string, key: string) =>
    db
      .prepare(
        `SELECT ref_key, byte_length, content_type, asset_kind FROM project_content_ref
         WHERE project_id = ? AND ref_kind = ? AND ref_key = ? LIMIT 1`,
      )
      .bind(projectId, kind, key)
      .first<RefRow>();
  return {
    async document(projectId, digest) {
      const row = await one(projectId, "document", digest);
      return row && row.byte_length !== null && row.content_type
        ? {
            digest: row.ref_key,
            byteLength: row.byte_length,
            contentType: row.content_type,
          }
        : undefined;
    },
    async resource(projectId, resourceId) {
      const row = await one(projectId, "resource", resourceId);
      return row && row.asset_kind
        ? { resourceId: row.ref_key, kind: row.asset_kind as never }
        : undefined;
    },
    async replace(projectId, refs) {
      const statements = [
        db.prepare("DELETE FROM project_content_ref WHERE project_id = ?").bind(projectId),
        ...refs.documents.map((d) =>
          db
            .prepare(
              `INSERT OR REPLACE INTO project_content_ref (project_id, ref_kind, ref_key, byte_length, content_type, asset_kind)
               VALUES (?, 'document', ?, ?, ?, NULL)`,
            )
            .bind(projectId, d.digest, d.byteLength, d.contentType),
        ),
        ...refs.resources.map((r) =>
          db
            .prepare(
              `INSERT OR REPLACE INTO project_content_ref (project_id, ref_kind, ref_key, byte_length, content_type, asset_kind)
               VALUES (?, 'resource', ?, NULL, NULL, ?)`,
            )
            .bind(projectId, r.resourceId, r.kind),
        ),
      ];
      if (db.batch) await db.batch(statements);
      else for (const s of statements) await s.run();
    },
  };
}

/** ProjectRoom-backed room port: computes refs inside the room (no snapshot
 * transfer) and receives the small `content.published` notification. */
export function createDurableObjectContentRoomPort(
  room: DurableObjectNamespaceLike,
): ContentRoomPort {
  const call = (projectId: string, op: string, init?: RequestInit) =>
    room.get(room.idFromName(projectId)).fetch(
      new Request(
        `http://internal/loro/${encodeURIComponent(projectId)}/${op}`,
        {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            "x-internal-loro": "true",
            "x-loro-project-id": projectId,
          },
        },
      ),
    );
  return {
    async references(projectId) {
      const response = await call(projectId, "content-refs");
      if (!response.ok)
        throw new Error(`Project content references unavailable (${response.status})`);
      return (await response.json()) as ProjectContentReferences;
    },
    async notifyPublished(event) {
      await call(event.projectId, "content-published", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    },
  };
}

export async function resourceLocator(
  tenantId: string,
  resource: Resource,
): Promise<string> {
  return `project-content/${await contentHash(tenantId)}/resources/${resource.digest.value}`;
}

/** Tenant-scoped immutable Resource registry in R2 (unchanged layout). */
export function createR2ResourceRegistry(bucket: R2Like) {
  return async function resource(
    tenantId: string,
    resourceId: string,
    claim?: Resource,
  ): Promise<Resource | null> {
    const key = `project-content/${await contentHash(tenantId)}/registry/${await contentHash(resourceId)}.json`;
    if (claim) {
      const parsed = ResourceSchema.parse(claim);
      if (parsed.id !== resourceId) throw new Error("Resource identity mismatch");
      // First immutable fact wins, even with simultaneous publications. Tenant
      // scoping prevents an unrelated tenant from claiming another's identity.
      await bucket.put(key, JSON.stringify(parsed), {
        onlyIf: { etagDoesNotMatch: "*" },
      });
    }
    const existing = await bucket.get(key);
    if (!existing) return null;
    const resource = ResourceSchema.parse(await existing.json());
    if (
      claim &&
      (resource.id !== claim.id ||
        resource.kind !== claim.kind ||
        resource.digest.value !== claim.digest.value ||
        resource.byteLength !== claim.byteLength ||
        resource.contentType !== claim.contentType)
    )
      throw new ProjectContentConflictError("Conflicting immutable Resource facts");
    return resource;
  };
}

export interface ResolverPorts {
  authorize: ProjectContentAdmission["authorize"];
  resource(tenantId: string, resourceId: string, claim?: Resource): Promise<Resource | null>;
}

/** Capability resolver shared by api-cf and the upload Worker. */
export function createCapabilityResolver<P extends ResolverPorts, E>(
  portsFor: (env: E) => P,
  referencesFor: (ports: P) => { resource(projectId: string, resourceId: string): Promise<{ kind: string } | undefined> },
) {
  return async (
    claims: {
      scope: { projectId?: string; localReplicaId?: string; tenantId: string };
      resourceId: string;
      operation: string;
      digest?: string;
      byteLength?: number;
    },
    env: E,
  ) => {
    const { projectId, localReplicaId, tenantId } = claims.scope;
    if (!projectId || !localReplicaId) return undefined;
    const ports = portsFor(env);
    if (!(await ports.authorize({ projectId, localReplicaId, tenantId })))
      return undefined;
    const reference = await referencesFor(ports).resource(projectId, claims.resourceId);
    if (!reference) return undefined;
    const resource = await ports.resource(tenantId, claims.resourceId);
    if (!resource || resource.kind !== reference.kind) return undefined;
    if (
      claims.operation === "upload" &&
      (claims.digest !== `sha256:${resource.digest.value}` ||
        claims.byteLength !== resource.byteLength)
    )
      return undefined;
    return {
      storageKey: await resourceLocator(tenantId, resource),
      contentType: resource.contentType,
      byteLength: resource.byteLength,
    };
  };
}
