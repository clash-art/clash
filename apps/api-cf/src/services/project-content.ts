import { LoroDoc } from "loro-crdt";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import { ResourceSchema, type Resource } from "@clash/shared-types/assets";
import type { AssetDeliveryCapabilityClaims } from "@clash/asset-sdk/delivery";
import type { Env } from "../config";

export class ProjectContentConflictError extends Error {}

export interface ProjectContentPorts {
  /** Both issuance and capability consumption check current admission/deletion. */
  authorize(input: {
    projectId: string;
    localReplicaId: string;
    userId?: string;
    tenantId?: string;
  }): Promise<{ tenantId: string } | null>;
  snapshot(projectId: string): Promise<Uint8Array>;
  resource(
    tenantId: string,
    resourceId: string,
    claim?: Resource,
  ): Promise<Resource | null>;
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

export async function resourceLocator(
  tenantId: string,
  resource: Resource,
): Promise<string> {
  return `project-content/${await contentHash(tenantId)}/resources/${resource.digest.value}`;
}
export async function documentLocator(
  tenantId: string,
  digest: string,
): Promise<string> {
  return `project-content/${await contentHash(tenantId)}/documents/${digest.slice("sha256:".length)}`;
}
export async function projectContentReferences(
  ports: ProjectContentPorts,
  projectId: string,
) {
  const doc = new LoroDoc();
  try {
    doc.import(await ports.snapshot(projectId));
    return projectSyncContent(doc);
  } finally {
    doc.free();
  }
}

export function createCloudProjectContentPorts(env: Env): ProjectContentPorts {
  return {
    async authorize(input) {
      const row = await env.DB.prepare(
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
    async snapshot(projectId) {
      const room = env.ROOM.get(env.ROOM.idFromName(projectId));
      const response = await room.fetch(
        new Request(
          `http://internal/loro/${encodeURIComponent(projectId)}/snapshot`,
          {
            headers: {
              "x-internal-loro": "true",
              "x-loro-project-id": projectId,
            },
          },
        ),
      );
      if (!response.ok)
        throw new Error(`Project snapshot unavailable (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async resource(tenantId, resourceId, claim) {
      const key = `project-content/${await contentHash(tenantId)}/registry/${await contentHash(resourceId)}.json`;
      if (claim) {
        const parsed = ResourceSchema.parse(claim);
        if (parsed.id !== resourceId)
          throw new Error("Resource identity mismatch");
        // First immutable fact wins, even with simultaneous publications. Tenant
        // scoping prevents an unrelated tenant from claiming another's identity.
        await env.R2_BUCKET.put(key, JSON.stringify(parsed), {
          onlyIf: { etagDoesNotMatch: "*" },
        });
      }
      const existing = await env.R2_BUCKET.get(key);
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
        throw new ProjectContentConflictError(
          "Conflicting immutable Resource facts",
        );
      return resource;
    },
  };
}

export function createProjectContentResolver(
  portsFor: (env: Env) => ProjectContentPorts = createCloudProjectContentPorts,
) {
  return async (claims: AssetDeliveryCapabilityClaims, env: Env) => {
    const { projectId, localReplicaId, tenantId } = claims.scope;
    if (!projectId || !localReplicaId) return undefined;
    const ports = portsFor(env);
    if (!(await ports.authorize({ projectId, localReplicaId, tenantId })))
      return undefined;
    const refs = await projectContentReferences(ports, projectId);
    const reference = refs.resources.find(
      (ref) => ref.resourceId === claims.resourceId,
    );
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
