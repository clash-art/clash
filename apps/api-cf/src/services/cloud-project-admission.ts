import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  ProjectCloudAdmissionSchema,
  type ProjectCloudAdmission,
  type ProjectCloudAdmissionRequest,
  type ProjectCloudAdmissionResponse,
} from "@clash/shared-types";
import type { Env } from "../config";

export interface CloudProjectAdmissionStore {
  admit(input: {
    userId: string;
    request: ProjectCloudAdmissionRequest;
    syncBaseUrl: string;
  }): Promise<ProjectCloudAdmissionResponse>;
  read(input: {
    userId: string;
    projectId: string;
    localReplicaId: string;
  }): Promise<ProjectCloudAdmission | null>;
}

type ProjectRow = {
  id: string;
  owner_id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  deleted_at: number | string | null;
};

function epoch(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: number | string | null): string {
  return new Date(epoch(value) * 1_000).toISOString();
}

function personalTenantId(userId: string): string {
  return `personal:${userId}`;
}

function capabilities() {
  return { canvas: true, projectMetadata: true, resources: true } as const;
}

function admissionFromRow(row: Record<string, unknown>): ProjectCloudAdmission {
  return ProjectCloudAdmissionSchema.parse({
    schemaVersion: 1,
    projectId: String(row.project_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    localReplicaId: String(row.local_replica_id),
    syncBaseUrl: String(row.sync_base_url),
    status: String(row.status),
    capabilities: JSON.parse(String(row.capabilities_json)),
    admittedAt:
      row.admitted_at === null || row.admitted_at === undefined
        ? null
        : iso(row.admitted_at as number | string),
    updatedAt: iso(row.updated_at as number | string),
    lastError: row.last_error === null ? null : String(row.last_error),
  });
}

export function createD1CloudProjectAdmissionStore(
  db: D1Database,
): CloudProjectAdmissionStore {
  return {
    async admit({ userId, request, syncBaseUrl }) {
      const parsed = ProjectCloudAdmissionRequestSchema.parse(request);
      const tenantId = personalTenantId(userId);
      const now = Math.floor(Date.now() / 1_000);
      const existing = await db
        .prepare(
          `SELECT id, owner_id, tenant_id, name, description, created_at,
                  updated_at, deleted_at
             FROM project WHERE id = ? LIMIT 1`,
        )
        .bind(parsed.projectId)
        .first<ProjectRow>();
      if (existing && existing.owner_id !== userId) {
        throw new Error("Forbidden");
      }

      const statements = [
        db
          .prepare(
            `INSERT OR IGNORE INTO tenant
               (id, owner_user_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(tenantId, userId, "Personal workspace", now, now),
        db
          .prepare(
            `INSERT OR IGNORE INTO tenant_member
               (tenant_id, user_id, role, created_at, updated_at)
             VALUES (?, ?, 'owner', ?, ?)`,
          )
          .bind(tenantId, userId, now, now),
      ];
      if (!existing) {
        statements.push(
          db
            .prepare(
              `INSERT INTO project
                 (id, owner_id, tenant_id, name, description, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              parsed.projectId,
              userId,
              tenantId,
              parsed.metadata.name,
              parsed.metadata.description,
              Math.floor(Date.parse(parsed.metadata.createdAt) / 1_000),
              Math.floor(Date.parse(parsed.metadata.updatedAt) / 1_000),
            ),
        );
      } else {
        statements.push(
          db
            .prepare(
              `UPDATE project
                  SET tenant_id = COALESCE(tenant_id, ?)
                WHERE id = ? AND owner_id = ?`,
            )
            .bind(tenantId, parsed.projectId, userId),
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO project_cloud_admission
               (project_id, tenant_id, user_id, local_replica_id, status,
                sync_base_url, capabilities_json, admitted_at, updated_at, last_error)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL)
             ON CONFLICT(project_id, local_replica_id) DO UPDATE SET
               tenant_id = excluded.tenant_id,
               user_id = excluded.user_id,
               status = CASE
                 WHEN project_cloud_admission.status = 'ready' THEN 'ready'
                 ELSE 'pending'
               END,
               capabilities_json = excluded.capabilities_json,
               updated_at = excluded.updated_at,
               last_error = NULL`,
          )
          .bind(
            parsed.projectId,
            tenantId,
            userId,
            parsed.localReplicaId,
            syncBaseUrl.replace(/\/+$/u, ""),
            JSON.stringify(capabilities()),
            now,
          ),
      );
      await db.batch(statements);

      const row = await db
        .prepare(
          `SELECT project_id, tenant_id, user_id, local_replica_id, sync_base_url,
                  status, capabilities_json, admitted_at, updated_at, last_error
             FROM project_cloud_admission
            WHERE project_id = ? AND local_replica_id = ? LIMIT 1`,
        )
        .bind(parsed.projectId, parsed.localReplicaId)
        .first<Record<string, unknown>>();
      if (!row) throw new Error("Cloud admission was not persisted");
      return ProjectCloudAdmissionResponseSchema.parse({
        schemaVersion: 1,
        admission: admissionFromRow(row),
        syncBaseUrl: syncBaseUrl.replace(/\/+$/u, ""),
      });
    },

    async read({ userId, projectId, localReplicaId }) {
      const row = await db
        .prepare(
          `SELECT a.project_id, a.tenant_id, a.user_id, a.local_replica_id,
                  a.sync_base_url, a.status, a.capabilities_json, a.admitted_at,
                  a.updated_at, a.last_error
             FROM project_cloud_admission a
             JOIN project p ON p.id = a.project_id
            WHERE a.project_id = ? AND a.local_replica_id = ?
              AND p.owner_id = ? LIMIT 1`,
        )
        .bind(projectId, localReplicaId, userId)
        .first<Record<string, unknown>>();
      return row ? admissionFromRow(row) : null;
    },
  };
}

export function cloudSyncBaseUrl(request: Request, env: Env): string {
  return (env.WORKER_PUBLIC_URL ?? new URL(request.url).origin).replace(
    /\/+$/u,
    "",
  );
}
