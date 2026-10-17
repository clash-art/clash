/** D1 adapter for the shared project transport authorization store. Kept free
 * of better-auth so the lean metadata Worker (#138) can import it. */
import {
  TOKEN_TOUCH_INTERVAL_S,
  type ProjectAuthorizationStore,
} from "@clash/shared-runtime/project-authorization";
import type { Env } from "../config";

export function createD1ProjectAuthorizationStore(
  env: Pick<Env, "DB">,
): ProjectAuthorizationStore {
  return {
    async readProject(projectId) {
      if (!env.DB) throw new Error("Project authority unavailable");
      const { results } = await env.DB.prepare(
        "SELECT owner_id, deleted_at FROM project WHERE id = ? LIMIT 1",
      )
        .bind(projectId)
        .all<{ owner_id: string; deleted_at: number | null }>();
      const row = results?.[0];
      return row ? { ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
    },
    async readApiToken(tokenHash) {
      const { results } = await env.DB.prepare(
        `SELECT t.user_id, t.name, u.name AS user_name, u.image AS user_image,
                t.last_used_at
           FROM api_token t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ? LIMIT 1`,
      )
        .bind(tokenHash)
        .all<{
          user_id: string;
          name: string;
          user_name: string | null;
          user_image: string | null;
          last_used_at: number | null;
        }>();
      const row = results?.[0];
      return row
        ? {
            userId: row.user_id,
            name: row.name,
            userName: row.user_name ?? undefined,
            userAvatar: row.user_image ?? undefined,
            lastUsedAt:
              row.last_used_at == null ? null : row.last_used_at * 1000,
          }
        : null;
    },
    async touchApiToken(tokenHash) {
      await env.DB.prepare(
        `UPDATE api_token SET last_used_at = unixepoch()
          WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < unixepoch() - ?)`,
      )
        .bind(tokenHash, TOKEN_TOUCH_INTERVAL_S)
        .run();
    },
    async readSession(sessionId) {
      const { results } = await env.DB.prepare(
        "SELECT user_id, expires_at FROM sessions WHERE id = ? LIMIT 1",
      )
        .bind(sessionId)
        .all<{ user_id: string; expires_at: number }>();
      const row = results?.[0];
      return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
    },
  };
}

