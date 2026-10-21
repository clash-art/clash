/**
 * Platform staff grants (`gateway_platform_role`, 0036; guide:
 * apps/docs/guide/gateway-admin.md). `platform_admin` is separate from every
 * tenant role. Grants and revocations are audited in the same batch; the last
 * platform admin cannot be revoked (GATEWAY_LAST_PLATFORM_ADMIN), so the
 * console can never lock itself out.
 *
 * The first grant cannot come from the API (nobody holds the permission yet):
 * see platform-admin-bootstrap.ts. There is no environment-variable grant.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, type GatewayClock } from "@clash/gateway-core";

import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import { toMs, toSeconds } from "./d1-common";

export { PLATFORM_ADMIN_USER_ID_PATTERN } from "./platform-admin-bootstrap";

export interface PlatformAdminView {
  userId: string;
  role: "platform_admin";
  name: string | null;
  email: string | null;
  grantedByUserId: string | null;
  grantedAt: string;
}

export function createD1PlatformRoles(db: D1Database, deps: { clock: GatewayClock }) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function list(): Promise<PlatformAdminView[]> {
    const { results } = await db
      .prepare(
        `SELECT r.user_id, r.granted_by_user_id, r.created_at, u.name, u.email
           FROM gateway_platform_role r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.role = 'platform_admin' ORDER BY r.created_at, r.user_id`,
      )
      .all<{ user_id: string; granted_by_user_id: string | null; created_at: number; name: string | null; email: string | null }>();
    return results.map((row) => ({
      userId: row.user_id,
      role: "platform_admin",
      name: row.name,
      email: row.email,
      grantedByUserId: row.granted_by_user_id,
      grantedAt: new Date(toMs(row.created_at)).toISOString(),
    }));
  }

  return {
    list,

    /** Grant platform_admin; granting an existing admin is a no-op. */
    async grant(input: { userId: string; reason?: string; actor: GatewayAdminActor }): Promise<{ granted: boolean }> {
      const nowS = nowSeconds();
      const [inserted] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO gateway_platform_role (user_id, role, granted_by_user_id, created_at)
             VALUES (?, 'platform_admin', ?, ?)`,
          )
          .bind(input.userId, input.actor.userId, nowS),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "platform_role.grant",
          targetType: "platform_role",
          targetId: input.userId,
          after: { role: "platform_admin" },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ]);
      return { granted: (inserted?.meta.changes ?? 0) > 0 };
    },

    /** Revoke platform_admin; revoking a non-admin is a no-op, the last admin is GATEWAY_LAST_PLATFORM_ADMIN. */
    async revoke(input: { userId: string; reason?: string; actor: GatewayAdminActor }): Promise<{ revoked: boolean }> {
      const nowS = nowSeconds();
      const [deleted] = await db.batch([
        db
          .prepare(
            `DELETE FROM gateway_platform_role
              WHERE user_id = ?1 AND role = 'platform_admin'
                AND EXISTS (SELECT 1 FROM gateway_platform_role o WHERE o.role = 'platform_admin' AND o.user_id <> ?1)`,
          )
          .bind(input.userId),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "platform_role.revoke",
          targetType: "platform_role",
          targetId: input.userId,
          before: { role: "platform_admin" },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (deleted?.meta.changes) return { revoked: true };
      const still = await db
        .prepare(`SELECT 1 AS found FROM gateway_platform_role WHERE user_id = ? AND role = 'platform_admin'`)
        .bind(input.userId)
        .first();
      if (still) throw new GatewayError("GATEWAY_LAST_PLATFORM_ADMIN");
      return { revoked: false };
    },
  };
}
