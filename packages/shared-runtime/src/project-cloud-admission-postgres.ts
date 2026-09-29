import { ProjectCloudAdmissionSchema } from "@clash/shared-types";
import { createCloudProjectAdmissionStore } from "./project-cloud-admission.js";
import type { PostgresQueryPort } from "./project-authorization-postgres.js";

/** Host must reserve ONE connection for the callback and commit/rollback as a unit.
 * Never implement this with BEGIN/COMMIT issued on an unpinned pool. */
export interface PostgresTransactionPort extends PostgresQueryPort {
  transaction<T>(
    work: (connection: PostgresQueryPort) => Promise<T>,
  ): Promise<T>;
}

function fromRow(row: Record<string, unknown>) {
  const iso = (value: unknown) =>
    new Date(value as string | number | Date).toISOString();
  return ProjectCloudAdmissionSchema.parse({
    schemaVersion: 1,
    projectId: row.project_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    localReplicaId: row.local_replica_id,
    syncBaseUrl: row.sync_base_url,
    status: row.status,
    capabilities: JSON.parse(String(row.capabilities_json)),
    admittedAt: row.admitted_at == null ? null : iso(row.admitted_at),
    updatedAt: iso(row.updated_at),
    lastError: row.last_error,
  });
}

export function createPostgresCloudProjectAdmissionStore(
  db: PostgresTransactionPort,
) {
  return createCloudProjectAdmissionStore({
    async persist({ userId, request, syncBaseUrl, tenantId, capabilities }) {
      return db.transaction(async (tx) => {
        // Unique-key arbitration serializes simultaneous first claims, including different owners.
        const claim = await tx.query(
          `INSERT INTO project (id,owner_id,tenant_id,name,description,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET tenant_id=COALESCE(project.tenant_id,excluded.tenant_id)
           WHERE project.owner_id=excluded.owner_id AND project.deleted_at IS NULL
             AND (project.tenant_id IS NULL OR project.tenant_id=excluded.tenant_id)
           RETURNING id`,
          [
            request.projectId,
            userId,
            tenantId,
            request.metadata.name,
            request.metadata.description,
            request.metadata.createdAt,
            request.metadata.updatedAt,
          ],
        );
        if (!claim.rows[0]) throw new Error("Forbidden");
        const tenant = await tx.query(
          `INSERT INTO tenant (id,owner_user_id,name) VALUES ($1,$2,'Personal workspace')
          ON CONFLICT (id) DO UPDATE SET id=excluded.id WHERE tenant.owner_user_id=excluded.owner_user_id RETURNING id`,
          [tenantId, userId],
        );
        if (!tenant.rows[0]) throw new Error("Forbidden");
        await tx.query(
          `INSERT INTO tenant_member (tenant_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
          [tenantId, userId],
        );
        const { rows } = await tx.query(
          `INSERT INTO project_cloud_admission
          (project_id,tenant_id,user_id,local_replica_id,sync_base_url,status,capabilities_json)
          VALUES ($1,$2,$3,$4,$5,'pending',$6)
          ON CONFLICT (project_id,local_replica_id) DO UPDATE SET
            tenant_id=excluded.tenant_id, user_id=excluded.user_id,
            status=CASE WHEN project_cloud_admission.status='ready' THEN 'ready' ELSE 'pending' END,
            capabilities_json=excluded.capabilities_json, updated_at=CURRENT_TIMESTAMP,last_error=NULL
          RETURNING *`,
          [
            request.projectId,
            tenantId,
            userId,
            request.localReplicaId,
            syncBaseUrl,
            JSON.stringify(capabilities),
          ],
        );
        return fromRow(rows[0]!);
      });
    },
    async read({ userId, projectId, localReplicaId }) {
      const { rows } = await db.query(
        `SELECT a.* FROM project_cloud_admission a JOIN project p ON p.id=a.project_id
        WHERE a.project_id=$1 AND a.local_replica_id=$2 AND a.user_id=$3 AND p.owner_id=$3
          AND p.deleted_at IS NULL AND p.tenant_id=a.tenant_id`,
        [projectId, localReplicaId, userId],
      );
      return rows[0] ? fromRow(rows[0]) : null;
    },
  });
}
