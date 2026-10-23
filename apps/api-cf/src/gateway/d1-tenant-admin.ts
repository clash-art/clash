/**
 * Tenant administration over D1 (guide: apps/docs/guide/gateway-admin.md):
 * member and key budgets (`gateway_budget`), virtual key rate limits
 * (`gateway_key.rate_limit_json`) and tenant roles (`tenant_member.role`:
 * owner or member, 0038).
 *
 * Every mutation is one D1 batch holding the change and its
 * `gateway_admin_audit` row, chained on `changes()`, so both are written or
 * neither is. Writes compare-and-set on the state they read; a lost race is
 * GATEWAY_CONFLICT. The tenant wallet itself changes only through purchases
 * and platform corrections (d1-billing.ts).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, walletAvailable, type GatewayClock } from "@clash/gateway-core";

import type { GATEWAY_TENANT_ROLES } from "../domain/requests";
import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import type { RateLimitConfig } from "./d1-billing";
import { parseJson, stringList, toMs, toSeconds } from "./d1-common";

export type AllocatedBudgetScope = "user" | "key";
type GatewayTenantRole = (typeof GATEWAY_TENANT_ROLES)[number];

export interface BudgetView {
  id: string;
  tenantId: string;
  scope: "tenant" | "user" | "key";
  scopeId: string;
  period: string;
  status: string;
  /** null: explicitly unlimited. */
  limitMicroCredits: number | null;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  availableMicroCredits: number | null;
  allocatedByUserId: string | null;
  updatedAt: string;
}

export interface GatewayKeyView {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  modelAllowlist: string[] | null;
  credentialScope: string;
  budgetId: string | null;
  rateLimit: RateLimitConfig | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface MemberView {
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  joinedAt: string | null;
}

interface BudgetRow {
  id: string;
  tenant_id: string;
  scope: BudgetView["scope"];
  scope_id: string;
  period: string;
  status: string;
  limit_micro_credits: number | null;
  spent_micro_credits: number;
  reserved_micro_credits: number;
  allocated_by_user_id: string | null;
  version: number;
  updated_at: number;
}

interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  model_allowlist_json: string | null;
  credential_scope: string;
  budget_id: string | null;
  rate_limit_json: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

const BUDGET_COLUMNS = `id, tenant_id, scope, scope_id, period, status, limit_micro_credits, spent_micro_credits,
  reserved_micro_credits, allocated_by_user_id, version, updated_at`;
/** Every column but `token_hash`. */
const KEY_COLUMNS = `id, user_id, name, token_prefix, scopes_json, model_allowlist_json, credential_scope,
  budget_id, rate_limit_json, expires_at, revoked_at, last_used_at, created_at`;

const iso = (seconds: number | null) => (seconds === null ? null : new Date(toMs(seconds)).toISOString());

function budgetView(row: BudgetRow): BudgetView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    scopeId: row.scope_id,
    period: row.period,
    status: row.status,
    limitMicroCredits: row.limit_micro_credits,
    spentMicroCredits: row.spent_micro_credits,
    reservedMicroCredits: row.reserved_micro_credits,
    availableMicroCredits:
      row.limit_micro_credits === null
        ? null
        : walletAvailable({
            limitMicroCredits: row.limit_micro_credits,
            spentMicroCredits: row.spent_micro_credits,
            reservedMicroCredits: row.reserved_micro_credits,
          }),
    allocatedByUserId: row.allocated_by_user_id,
    updatedAt: iso(row.updated_at)!,
  };
}

function keyView(row: KeyRow): GatewayKeyView {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: stringList(row.scopes_json) ?? [],
    modelAllowlist: stringList(row.model_allowlist_json) ?? null,
    credentialScope: row.credential_scope,
    budgetId: row.budget_id,
    rateLimit: (parseJson(row.rate_limit_json) as RateLimitConfig | undefined) ?? null,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at)!,
  };
}

const budgetSnapshot = (row: Pick<BudgetRow, "limit_micro_credits" | "status">) => ({
  limitMicroCredits: row.limit_micro_credits,
  status: row.status,
});

export function createD1TenantAdmin(db: D1Database, deps: { clock: GatewayClock }) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function requireTenant(tenantId: string): Promise<void> {
    const tenant = await db.prepare(`SELECT 1 AS found FROM tenant WHERE id = ?`).bind(tenantId).first();
    if (!tenant) throw new GatewayError("GATEWAY_TENANT_NOT_FOUND", { details: { tenantId } });
  }
  async function budgetRow(tenantId: string, scope: string, scopeId: string): Promise<BudgetRow | null> {
    return db
      .prepare(`SELECT ${BUDGET_COLUMNS} FROM gateway_budget WHERE tenant_id = ? AND scope = ? AND scope_id = ?`)
      .bind(tenantId, scope, scopeId)
      .first<BudgetRow>();
  }
  async function keyRow(tenantId: string, keyId: string): Promise<KeyRow | null> {
    return db
      .prepare(`SELECT ${KEY_COLUMNS} FROM gateway_key WHERE id = ? AND tenant_id = ?`)
      .bind(keyId, tenantId)
      .first<KeyRow>();
  }
  async function memberRole(tenantId: string, userId: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT role FROM tenant_member WHERE tenant_id = ? AND user_id = ?`)
      .bind(tenantId, userId)
      .first<{ role: string }>();
    return row?.role ?? null;
  }
  async function listMembers(tenantId: string): Promise<MemberView[]> {
    await requireTenant(tenantId);
    const { results } = await db
      .prepare(
        `SELECT m.user_id, m.role, m.created_at, u.name, u.email
           FROM tenant_member m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = ?
          ORDER BY m.role <> 'owner', m.user_id`,
      )
      .bind(tenantId)
      .all<{ user_id: string; role: string; created_at: number | null; name: string | null; email: string | null }>();
    return results.map((row) => ({
      userId: row.user_id,
      role: row.role,
      name: row.name,
      email: row.email,
      joinedAt: typeof row.created_at === "number" ? iso(row.created_at) : null,
    }));
  }
  const belowUsage = (row: BudgetRow) =>
    new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
      details: {
        budgetId: row.id,
        spentMicroCredits: row.spent_micro_credits,
        reservedMicroCredits: row.reserved_micro_credits,
      },
    });

  return {
    async listBudgets(tenantId: string): Promise<BudgetView[]> {
      await requireTenant(tenantId);
      const { results } = await db
        .prepare(
          `SELECT ${BUDGET_COLUMNS} FROM gateway_budget WHERE tenant_id = ?
            ORDER BY CASE scope WHEN 'tenant' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, scope_id`,
        )
        .bind(tenantId)
        .all<BudgetRow>();
      return results.map(budgetView);
    },

    /**
     * Set a member (`user`) or key budget: create it under the tenant wallet,
     * or change its limit/status. A limit below spend + open holds is
     * GATEWAY_BUDGET_BELOW_USAGE; null is explicitly unlimited (the wallet
     * still caps it).
     */
    async setBudget(input: {
      tenantId: string;
      scope: AllocatedBudgetScope;
      scopeId: string;
      limitMicroCredits: number | null;
      status?: "active" | "suspended";
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<BudgetView> {
      await requireTenant(input.tenantId);
      if (input.scope === "user" && !(await memberRole(input.tenantId, input.scopeId)))
        throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.scopeId } });
      if (input.scope === "key" && !(await keyRow(input.tenantId, input.scopeId)))
        throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { tenantId: input.tenantId, keyId: input.scopeId } });
      const before = await budgetRow(input.tenantId, input.scope, input.scopeId);
      const limit = input.limitMicroCredits;
      const status = input.status ?? before?.status ?? "active";
      if (before && limit !== null && limit < before.spent_micro_credits + before.reserved_micro_credits)
        throw belowUsage(before);
      const nowS = nowSeconds();
      const id = before?.id ?? `gwb_${input.scope[0]}_${crypto.randomUUID().replaceAll("-", "")}`;
      const target = `${input.scope}:${input.scopeId}`;
      const after = { limitMicroCredits: limit, status };
      const write = before
        ? db
            .prepare(
              `UPDATE gateway_budget
                  SET limit_micro_credits = ?2, status = ?3, version = version + 1, updated_at = ?4
                WHERE id = ?1 AND version = ?5
                  AND (?2 IS NULL OR ?2 >= spent_micro_credits + reserved_micro_credits)`,
            )
            .bind(id, limit, status, nowS, before.version)
        : db
            .prepare(
              `INSERT INTO gateway_budget
                 (id, tenant_id, scope, scope_id, parent_budget_id, allocated_by_user_id, period,
                  limit_micro_credits, status, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4,
                       (SELECT id FROM gateway_budget WHERE tenant_id = ?2 AND scope = 'tenant' AND scope_id = ?2),
                       ?5, 'none', ?6, ?7, ?8, ?8)`,
            )
            .bind(id, input.tenantId, input.scope, input.scopeId, input.actor.id, limit, status, nowS);
      const statements = [
        write,
        adminAuditStatement(db, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: before ? "budget.update" : "budget.create",
          targetType: "budget",
          targetId: target,
          ...(before ? { before: budgetSnapshot(before) } : {}),
          after,
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ];
      if (input.scope === "key")
        statements.push(
          db
            .prepare(`UPDATE gateway_key SET budget_id = ?1, updated_at = ?3 WHERE id = ?2 AND budget_id IS NOT ?1`)
            .bind(id, input.scopeId, nowS),
        );
      let written = 0;
      try {
        const [result] = await db.batch(statements);
        written = result?.meta.changes ?? 0;
      } catch (cause) {
        throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, target }, cause });
      }
      const current = await budgetRow(input.tenantId, input.scope, input.scopeId);
      if (!written) {
        if (current && limit !== null && limit < current.spent_micro_credits + current.reserved_micro_credits)
          throw belowUsage(current);
        throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, target } });
      }
      if (!current) throw new GatewayError("GATEWAY_INTERNAL", { message: "The budget is missing after a write." });
      return budgetView(current);
    },

    async listKeys(tenantId: string): Promise<GatewayKeyView[]> {
      await requireTenant(tenantId);
      const { results } = await db
        .prepare(`SELECT ${KEY_COLUMNS} FROM gateway_key WHERE tenant_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC, id`)
        .bind(tenantId)
        .all<KeyRow>();
      return results.map(keyView);
    },

    /** Set (or clear with null) a virtual key's rate limits. */
    async setKeyRateLimit(input: {
      tenantId: string;
      keyId: string;
      rateLimit: RateLimitConfig | null;
      actor: GatewayAdminActor;
    }): Promise<GatewayKeyView> {
      const before = await keyRow(input.tenantId, input.keyId);
      if (!before) throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { tenantId: input.tenantId, keyId: input.keyId } });
      const next = input.rateLimit ? JSON.stringify(input.rateLimit) : null;
      if (next !== before.rate_limit_json) {
        const nowS = nowSeconds();
        const [updated] = await db.batch([
          db
            .prepare(
              `UPDATE gateway_key SET rate_limit_json = ?3, updated_at = ?4
                WHERE id = ?1 AND tenant_id = ?2 AND rate_limit_json IS ?5`,
            )
            .bind(input.keyId, input.tenantId, next, nowS, before.rate_limit_json),
          adminAuditStatement(db, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "key.rate_limit",
            targetType: "gateway_key",
            targetId: input.keyId,
            before: { rateLimit: parseJson(before.rate_limit_json) ?? null },
            after: { rateLimit: input.rateLimit },
            nowS,
            when: "changes() = 1",
          }),
        ]);
        if (!updated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { keyId: input.keyId } });
      }
      const row = await keyRow(input.tenantId, input.keyId);
      if (!row) throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { keyId: input.keyId } });
      return keyView(row);
    },

    listMembers,

    /**
     * Change a member's role (`team.members.manage`; the team settings UI is
     * #354, the admin console has no role changes). A tenant always keeps one
     * owner (GATEWAY_LAST_OWNER).
     */
    async setMemberRole(input: {
      tenantId: string;
      userId: string;
      role: GatewayTenantRole;
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<MemberView> {
      await requireTenant(input.tenantId);
      const before = await memberRole(input.tenantId, input.userId);
      if (!before)
        throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.userId } });
      if (before !== input.role) {
        const nowS = nowSeconds();
        const [updated] = await db.batch([
          db
            .prepare(
              `UPDATE tenant_member SET role = ?3, updated_at = ?5
                WHERE tenant_id = ?1 AND user_id = ?2 AND role = ?4
                  AND (?4 <> 'owner' OR EXISTS (SELECT 1 FROM tenant_member o
                        WHERE o.tenant_id = ?1 AND o.role = 'owner' AND o.user_id <> ?2))`,
            )
            .bind(input.tenantId, input.userId, input.role, before, nowS),
          adminAuditStatement(db, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "member.role",
            targetType: "tenant_member",
            targetId: input.userId,
            before: { role: before },
            after: { role: input.role },
            reason: input.reason ?? null,
            nowS,
            when: "changes() = 1",
          }),
        ]);
        if (!updated?.meta.changes) {
          const now = await memberRole(input.tenantId, input.userId);
          if (now === "owner" && before === "owner")
            throw new GatewayError("GATEWAY_LAST_OWNER", { details: { tenantId: input.tenantId } });
          throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, userId: input.userId } });
        }
      }
      const member = (await listMembers(input.tenantId)).find((entry) => entry.userId === input.userId);
      if (!member) throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { userId: input.userId } });
      return member;
    },
  };
}

export type D1TenantAdmin = ReturnType<typeof createD1TenantAdmin>;
