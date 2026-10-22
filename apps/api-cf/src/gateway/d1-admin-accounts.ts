/**
 * Admin accounts (`admin_accounts`, 0040; guide: apps/docs/guide/gateway-admin.md,
 * #394): the admin identity store, separate from product users. Each account
 * signs in through the admin Better Auth instance (src/admin-auth.ts); this
 * module is the console's view and its two mutations, each audited in the
 * same D1 batch:
 *
 * - create: the account and its credential (a password hash made by Better
 *   Auth's own hasher), refused for an email already taken
 *   (GATEWAY_ADMIN_ACCOUNT_EXISTS);
 * - disable: stamps `disabled_at` and deletes the account's sessions and
 *   password, so it is signed out at once and cannot sign in again. The last
 *   enabled account cannot be disabled (GATEWAY_LAST_ADMIN_ACCOUNT), so the
 *   console can never lock itself out.
 *
 * The first account cannot come from the API (nobody can sign in yet): see
 * admin-account-bootstrap.ts. There is no environment-variable grant.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, type GatewayClock } from "@clash/gateway-core";

import { newAdminAccountId } from "../services/admin-identity";
import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import { toSeconds } from "./d1-common";

export interface AdminAccountView {
  id: string;
  email: string;
  name: string;
  role: string;
  disabledAt: string | null;
  createdAt: string;
}

type AdminAccountRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
};

const iso = (ms: number) => new Date(ms).toISOString();

export function createD1AdminAccounts(db: D1Database, deps: { clock: GatewayClock }) {
  async function list(): Promise<AdminAccountView[]> {
    const { results } = await db
      .prepare(`SELECT id, email, name, role, disabled_at, created_at FROM admin_accounts ORDER BY created_at, id`)
      .all<AdminAccountRow>();
    return results.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      disabledAt: row.disabled_at === null ? null : iso(Number(row.disabled_at)),
      createdAt: iso(Number(row.created_at)),
    }));
  }

  return {
    list,

    /** Create an enabled admin account with a credential; `passwordHash` comes from Better Auth's hasher. */
    async create(input: {
      email: string;
      name: string;
      role: string;
      passwordHash: string;
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<AdminAccountView> {
      const nowMs = deps.clock.now();
      const id = newAdminAccountId();
      const email = input.email.trim().toLowerCase();
      const [inserted] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO admin_accounts (id, name, email, email_verified, role, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)`,
          )
          .bind(id, input.name, email, input.role, nowMs),
        db
          .prepare(
            `INSERT INTO admin_credentials (id, account_id, provider_id, admin_id, password, created_at, updated_at)
             SELECT ?1, ?2, 'credential', ?2, ?3, ?4, ?4 WHERE changes() = 1`,
          )
          .bind(newAdminAccountId(), id, input.passwordHash, nowMs),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "admin_account.create",
          targetType: "admin_account",
          targetId: id,
          after: { email, name: input.name, role: input.role },
          reason: input.reason ?? null,
          nowS: toSeconds(nowMs),
          when: "changes() = 1",
        }),
      ]);
      if (!inserted?.meta.changes) throw new GatewayError("GATEWAY_ADMIN_ACCOUNT_EXISTS", { details: { email } });
      const created = (await list()).find((account) => account.id === id);
      if (!created) throw new GatewayError("GATEWAY_CONFLICT");
      return created;
    },

    /**
     * Disable an account: signed out everywhere, no password left. Disabling
     * a disabled account is a no-op; the last enabled one is
     * GATEWAY_LAST_ADMIN_ACCOUNT.
     */
    async disable(input: { id: string; reason?: string; actor: GatewayAdminActor }): Promise<{ disabled: boolean }> {
      const nowMs = deps.clock.now();
      const disabledNow = `EXISTS (SELECT 1 FROM admin_accounts WHERE id = ?1 AND disabled_at = ?2)`;
      const [updated] = await db.batch([
        db
          .prepare(
            `UPDATE admin_accounts SET disabled_at = ?2, updated_at = ?2
              WHERE id = ?1 AND disabled_at IS NULL
                AND EXISTS (SELECT 1 FROM admin_accounts o WHERE o.id <> ?1 AND o.disabled_at IS NULL)`,
          )
          .bind(input.id, nowMs),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "admin_account.disable",
          targetType: "admin_account",
          targetId: input.id,
          before: { disabled: false },
          after: { disabled: true },
          reason: input.reason ?? null,
          nowS: toSeconds(nowMs),
          when: "changes() = 1",
        }),
        db.prepare(`DELETE FROM admin_sessions WHERE admin_id = ?1 AND ${disabledNow}`).bind(input.id, nowMs),
        db.prepare(`DELETE FROM admin_credentials WHERE admin_id = ?1 AND ${disabledNow}`).bind(input.id, nowMs),
      ]);
      if (updated?.meta.changes) return { disabled: true };
      const row = await db
        .prepare(`SELECT disabled_at FROM admin_accounts WHERE id = ?`)
        .bind(input.id)
        .first<{ disabled_at: number | null }>();
      if (!row) throw new GatewayError("GATEWAY_ADMIN_ACCOUNT_NOT_FOUND", { details: { id: input.id } });
      if (row.disabled_at !== null) return { disabled: false };
      throw new GatewayError("GATEWAY_LAST_ADMIN_ACCOUNT");
    },
  };
}
