import type { ProjectAuthorizationStore } from "./project-authorization.js";

/** Implemented by a PostgreSQL client/pool; connection lifetime belongs to the host. */
export interface PostgresQueryPort {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export function createPostgresProjectAuthorizationStore(
  db: PostgresQueryPort,
): ProjectAuthorizationStore {
  return {
    async readProject(projectId) {
      const { rows } = await db.query<{
        owner_id: string;
        deleted_at: number | null;
      }>(
        `SELECT owner_id, (EXTRACT(EPOCH FROM deleted_at) * 1000)::double precision AS deleted_at
           FROM project WHERE id = $1 LIMIT 1`,
        [projectId],
      );
      const row = rows[0];
      return row ? { ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
    },
    async readApiToken(tokenHash) {
      const { rows } = await db.query<{ user_id: string; name: string | null }>(
        "SELECT user_id, name FROM api_token WHERE token_hash = $1 LIMIT 1",
        [tokenHash],
      );
      const row = rows[0];
      return row ? { userId: row.user_id, name: row.name ?? undefined } : null;
    },
    async touchApiToken(tokenHash) {
      await db.query(
        "UPDATE api_token SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = $1",
        [tokenHash],
      );
    },
    async readSession(sessionId) {
      const { rows } = await db.query<{ user_id: string; expires_at: number }>(
        `SELECT "userId" AS user_id, (EXTRACT(EPOCH FROM "expiresAt") * 1000)::double precision AS expires_at
           FROM auth_session WHERE id = $1 LIMIT 1`,
        [sessionId],
      );
      const row = rows[0];
      return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
    },
  };
}
