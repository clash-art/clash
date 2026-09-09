import {
  ProjectMetadataSchema,
  type ProjectMetadata,
} from "@clash/shared-types";

export interface CloudProjectMetadataStore {
  read(projectId: string): Promise<ProjectMetadata | null>;
  /** Returns false when the hosted Project has not been admitted. */
  write(metadata: ProjectMetadata): Promise<boolean>;
}

interface ProjectMetadataRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  deleted_at: number | string | null;
}

function timestampToIso(value: number | string | null, field: string): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Hosted Project ${field} timestamp is invalid`);
  }
  return new Date(numeric * 1_000).toISOString();
}

function isoToEpochSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

export function createD1ProjectMetadataStore(
  db: D1Database,
): CloudProjectMetadataStore {
  return {
    async read(projectId) {
      const row = await db
        .prepare(
          `SELECT id, name, description, created_at, updated_at, deleted_at
             FROM project
            WHERE id = ?
            LIMIT 1`,
        )
        .bind(projectId)
        .first<ProjectMetadataRow>();
      if (!row) return null;
      return ProjectMetadataSchema.parse({
        projectId: row.id,
        name: row.name,
        description: row.description,
        createdAt: timestampToIso(row.created_at, "created_at"),
        updatedAt: timestampToIso(row.updated_at, "updated_at"),
        deletedAt:
          row.deleted_at === null
            ? null
            : timestampToIso(row.deleted_at, "deleted_at"),
      });
    },

    async write(metadata) {
      const parsed = ProjectMetadataSchema.parse(metadata);
      const result = await db
        .prepare(
          `UPDATE project
              SET name = ?, description = ?, updated_at = ?, deleted_at = ?
            WHERE id = ?`,
        )
        .bind(
          parsed.name,
          parsed.description,
          isoToEpochSeconds(parsed.updatedAt),
          parsed.deletedAt === null
            ? null
            : isoToEpochSeconds(parsed.deletedAt),
          parsed.projectId,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
  };
}
