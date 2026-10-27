/**
 * Tenant administration over D1 (guides: apps/docs/guide/gateway-teams.md,
 * apps/docs/guide/gateway-admin.md): teams and their members, roles and
 * invites (`tenant`, `tenant_member`, `tenant_invite`; roles are owner or
 * member, 0038), member and key budgets with their enforcement
 * (`gateway_budget`, 0041), budget notifications (`gateway_budget_event`),
 * and configurable rate limits on keys, members and the tenant
 * (`rate_limit_json`).
 *
 * Every mutation is one D1 batch holding the change and its
 * `gateway_admin_audit` row, chained on `changes()`, so both are written or
 * neither is. Writes compare-and-set on the state they read; a lost race is
 * GATEWAY_CONFLICT. The tenant wallet itself changes only through purchases
 * and platform corrections (d1-billing.ts).
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  walletAvailable,
  type BudgetEnforcement,
  type GatewayClock,
  type GatewayRateLimit,
} from "@clash/gateway-core";

import type { GATEWAY_TENANT_ROLES } from "../domain/requests";
import { sha256Hex } from "../services/api-token";
import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import type { RateLimitConfig } from "./d1-billing";
import { parseJson, stringList, toMs, toSeconds } from "./d1-common";

export type AllocatedBudgetScope = "user" | "key";
type GatewayTenantRole = (typeof GATEWAY_TENANT_ROLES)[number];

/** How long an invite link stays valid. */
export const TEAM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_PREFIX = "gwi_";

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
  /** hard (refuse), soft (admit and flag), alert (admit and notify). */
  enforcement: BudgetEnforcement;
  /** Percent of the limit an alert is raised at; null: none (an `alert` budget alerts at 100%). */
  alertThresholdPct: number | null;
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
  /** Owner-configured per-member rate limit. */
  rateLimit: RateLimitConfig | null;
}

export interface TeamView {
  tenantId: string;
  name: string;
  kind: string;
  role: string;
  members: number;
}

export interface TenantView {
  id: string;
  name: string;
  kind: string;
  ownerUserId: string;
  /** Owner-configured tenant-wide rate limit (the subscription's applies as well). */
  rateLimit: RateLimitConfig | null;
}

export interface InviteView {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: string;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
}

export interface BudgetEventView {
  id: string;
  budgetId: string;
  scope: string;
  scopeId: string;
  kind: "soft_exceeded" | "alert_threshold";
  enforcement: string;
  requestId: string | null;
  limitMicroCredits: number;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  thresholdPct: number | null;
  occurredAt: string;
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
  enforcement: BudgetEnforcement;
  alert_threshold_pct: number | null;
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

interface TenantRow {
  id: string;
  name: string;
  kind: string;
  owner_user_id: string;
  rate_limit_json: string | null;
}

interface InviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  status: string;
  invited_by_user_id: string;
  expires_at: number;
  created_at: number;
}

const BUDGET_COLUMNS = `id, tenant_id, scope, scope_id, period, status, limit_micro_credits, spent_micro_credits,
  reserved_micro_credits, enforcement, alert_threshold_pct, allocated_by_user_id, version, updated_at`;
/** Every column but `token_hash`. */
const KEY_COLUMNS = `id, user_id, name, token_prefix, scopes_json, model_allowlist_json, credential_scope,
  budget_id, rate_limit_json, expires_at, revoked_at, last_used_at, created_at`;
/** Every column but `token_hash`. */
const INVITE_COLUMNS = `id, tenant_id, email, role, status, invited_by_user_id, expires_at, created_at`;

const iso = (seconds: number | null) => (seconds === null ? null : new Date(toMs(seconds)).toISOString());
const rateLimitOf = (raw: string | null) => (parseJson(raw) as RateLimitConfig | undefined) ?? null;

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
    enforcement: row.enforcement,
    alertThresholdPct: row.alert_threshold_pct,
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
    rateLimit: rateLimitOf(row.rate_limit_json),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at)!,
  };
}

function inviteView(row: InviteRow): InviteView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedByUserId: row.invited_by_user_id,
    expiresAt: iso(row.expires_at)!,
    createdAt: iso(row.created_at)!,
  };
}

const budgetSnapshot = (row: Pick<BudgetRow, "limit_micro_credits" | "status" | "enforcement" | "alert_threshold_pct">) => ({
  limitMicroCredits: row.limit_micro_credits,
  status: row.status,
  enforcement: row.enforcement,
  alertThresholdPct: row.alert_threshold_pct,
});

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Run a mutation batch; a batch D1 refused (a trigger, a constraint, a lost race) is GATEWAY_CONFLICT. */
async function runBatch(db: D1Database, statements: D1PreparedStatement[], details: Record<string, unknown>) {
  try {
    return await db.batch(statements);
  } catch (cause) {
    throw new GatewayError("GATEWAY_CONFLICT", { details, cause });
  }
}

export function createD1TenantAdmin(db: D1Database, deps: { clock: GatewayClock }) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function tenantRow(tenantId: string): Promise<TenantRow> {
    const tenant = await db
      .prepare(`SELECT id, name, kind, owner_user_id, rate_limit_json FROM tenant WHERE id = ?`)
      .bind(tenantId)
      .first<TenantRow>();
    if (!tenant) throw new GatewayError("GATEWAY_TENANT_NOT_FOUND", { details: { tenantId } });
    return tenant;
  }
  async function requireTenant(tenantId: string): Promise<void> {
    await tenantRow(tenantId);
  }
  /** Members, invites and removals are for teams; a personal workspace has one owner. */
  async function requireTeam(tenantId: string): Promise<TenantRow> {
    const tenant = await tenantRow(tenantId);
    if (tenant.kind !== "team") throw new GatewayError("GATEWAY_TENANT_NOT_TEAM", { details: { tenantId } });
    return tenant;
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
  async function memberRow(tenantId: string, userId: string) {
    return db
      .prepare(`SELECT role, rate_limit_json FROM tenant_member WHERE tenant_id = ? AND user_id = ?`)
      .bind(tenantId, userId)
      .first<{ role: string; rate_limit_json: string | null }>();
  }
  async function memberRole(tenantId: string, userId: string): Promise<string | null> {
    return (await memberRow(tenantId, userId))?.role ?? null;
  }
  async function listMembers(tenantId: string): Promise<MemberView[]> {
    await requireTenant(tenantId);
    const { results } = await db
      .prepare(
        `SELECT m.user_id, m.role, m.created_at, m.rate_limit_json, u.name, u.email
           FROM tenant_member m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = ?
          ORDER BY m.role <> 'owner', m.user_id`,
      )
      .bind(tenantId)
      .all<{
        user_id: string;
        role: string;
        created_at: number | null;
        rate_limit_json: string | null;
        name: string | null;
        email: string | null;
      }>();
    return results.map((row) => ({
      userId: row.user_id,
      role: row.role,
      name: row.name,
      email: row.email,
      joinedAt: typeof row.created_at === "number" ? iso(row.created_at) : null,
      rateLimit: rateLimitOf(row.rate_limit_json),
    }));
  }
  async function member(tenantId: string, userId: string): Promise<MemberView> {
    const found = (await listMembers(tenantId)).find((entry) => entry.userId === userId);
    if (!found) throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId, userId } });
    return found;
  }
  const belowUsage = (row: BudgetRow) =>
    new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
      details: {
        budgetId: row.id,
        spentMicroCredits: row.spent_micro_credits,
        reservedMicroCredits: row.reserved_micro_credits,
      },
    });
  async function inviteByToken(token: string): Promise<InviteRow & { token_hash: string }> {
    const row = await db
      .prepare(`SELECT ${INVITE_COLUMNS}, token_hash FROM tenant_invite WHERE token_hash = ?`)
      .bind(await sha256Hex(token))
      .first<InviteRow & { token_hash: string }>();
    if (!row) throw new GatewayError("GATEWAY_INVITE_NOT_FOUND");
    return row;
  }
  /** A pending, unexpired invite; anything else is a coded refusal. */
  function requirePending(row: InviteRow): void {
    if (row.status !== "pending") throw new GatewayError("GATEWAY_INVITE_NOT_FOUND", { details: { inviteId: row.id, status: row.status } });
    if (row.expires_at <= nowSeconds()) throw new GatewayError("GATEWAY_INVITE_EXPIRED", { details: { inviteId: row.id } });
  }

  /** Set (or clear with null) one `rate_limit_json`, audited, compare-and-set on the value read. */
  async function setRateLimit(input: {
    tenantId: string;
    table: "tenant" | "tenant_member";
    where: string;
    whereArgs: unknown[];
    before: string | null;
    rateLimit: RateLimitConfig | null;
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    actor: GatewayAdminActor;
  }): Promise<void> {
    const next = input.rateLimit ? JSON.stringify(input.rateLimit) : null;
    if (next === input.before) return;
    const nowS = nowSeconds();
    const offset = input.whereArgs.length;
    const [updated] = await runBatch(
      db,
      [
        db
          .prepare(
            `UPDATE ${input.table} SET rate_limit_json = ?${offset + 1}, updated_at = ?${offset + 2}
              WHERE ${input.where} AND rate_limit_json IS ?${offset + 3}`,
          )
          .bind(...input.whereArgs, next, nowS, input.before),
        adminAuditStatement(db, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          before: { rateLimit: parseJson(input.before) ?? null },
          after: { rateLimit: input.rateLimit },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ],
      { tenantId: input.tenantId, target: input.targetId },
    );
    if (!updated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, target: input.targetId } });
  }

  /** The caller's teams and personal workspace, with their role in each. */
  async function listTeams(userId: string): Promise<TeamView[]> {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.name, t.kind, m.role,
                (SELECT COUNT(*) FROM tenant_member c WHERE c.tenant_id = t.id) AS members
           FROM tenant_member m JOIN tenant t ON t.id = m.tenant_id
          WHERE m.user_id = ?
          ORDER BY t.kind <> 'team', t.name, t.id`,
      )
      .bind(userId)
      .all<{ id: string; name: string; kind: string; role: string; members: number }>();
    return results.map((row) => ({ tenantId: row.id, name: row.name, kind: row.kind, role: row.role, members: row.members }));
  }

  return {
    // ─── Teams ──────────────────────────────────────────────────────────

    listTeams,

    /** Create a team tenant with the caller as its owner, audited, in one batch. */
    async createTeam(input: { userId: string; name: string }): Promise<TeamView> {
      const tenantId = `team:${hex(12)}`;
      const nowS = nowSeconds();
      const actor: GatewayAdminActor = { kind: "user", id: input.userId, role: "owner" };
      await runBatch(
        db,
        [
          db
            .prepare(`INSERT INTO tenant (id, owner_user_id, name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, 'team', ?4, ?4)`)
            .bind(tenantId, input.userId, input.name, nowS),
          db
            .prepare(`INSERT INTO tenant_member (tenant_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'owner', ?3, ?3)`)
            .bind(tenantId, input.userId, nowS),
          adminAuditStatement(db, {
            tenantId,
            actor,
            action: "team.create",
            targetType: "tenant",
            targetId: tenantId,
            after: { name: input.name, kind: "team" },
            nowS,
            when: "changes() = 1",
          }),
        ],
        { tenantId },
      );
      return { tenantId, name: input.name, kind: "team", role: "owner", members: 1 };
    },

    async tenant(tenantId: string): Promise<TenantView> {
      const row = await tenantRow(tenantId);
      return { id: row.id, name: row.name, kind: row.kind, ownerUserId: row.owner_user_id, rateLimit: rateLimitOf(row.rate_limit_json) };
    },

    // ─── Members and roles ─────────────────────────────────────────────

    listMembers,
    member,

    /**
     * Change a member's role (`team.members.manage`, team settings). A tenant
     * always keeps one owner (GATEWAY_LAST_OWNER).
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
        const [updated] = await runBatch(
          db,
          [
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
          ],
          { tenantId: input.tenantId, userId: input.userId },
        );
        if (!updated?.meta.changes) {
          const now = await memberRole(input.tenantId, input.userId);
          if (now === "owner" && before === "owner")
            throw new GatewayError("GATEWAY_LAST_OWNER", { details: { tenantId: input.tenantId } });
          throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, userId: input.userId } });
        }
      }
      return member(input.tenantId, input.userId);
    },

    /**
     * Remove a member from a team (`team.members.manage`). The last owner
     * stays (GATEWAY_LAST_OWNER). In the same batch the member's virtual keys
     * in this team are revoked; their tokens already stop verifying once the
     * membership is gone. Budgets and ledger rows stay as history.
     */
    async removeMember(input: { tenantId: string; userId: string; reason?: string; actor: GatewayAdminActor }): Promise<void> {
      await requireTeam(input.tenantId);
      const before = await memberRole(input.tenantId, input.userId);
      if (!before)
        throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.userId } });
      const nowS = nowSeconds();
      const [deleted] = await runBatch(
        db,
        [
          db
            .prepare(
              `DELETE FROM tenant_member
                WHERE tenant_id = ?1 AND user_id = ?2 AND role = ?3
                  AND (?3 <> 'owner' OR EXISTS (SELECT 1 FROM tenant_member o
                        WHERE o.tenant_id = ?1 AND o.role = 'owner' AND o.user_id <> ?2))`,
            )
            .bind(input.tenantId, input.userId, before),
          adminAuditStatement(db, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "member.remove",
            targetType: "tenant_member",
            targetId: input.userId,
            before: { role: before },
            reason: input.reason ?? null,
            nowS,
            when: "changes() = 1",
          }),
          db
            .prepare(
              `UPDATE gateway_key SET revoked_at = ?3, updated_at = ?3
                WHERE tenant_id = ?1 AND user_id = ?2 AND revoked_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM tenant_member WHERE tenant_id = ?1 AND user_id = ?2)`,
            )
            .bind(input.tenantId, input.userId, nowS),
        ],
        { tenantId: input.tenantId, userId: input.userId },
      );
      if (!deleted?.meta.changes) {
        const now = await memberRole(input.tenantId, input.userId);
        if (now === "owner" && before === "owner")
          throw new GatewayError("GATEWAY_LAST_OWNER", { details: { tenantId: input.tenantId } });
        if (now === null) throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.userId } });
        throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, userId: input.userId } });
      }
    },

    // ─── Invites ───────────────────────────────────────────────────────

    async listInvites(tenantId: string): Promise<InviteView[]> {
      await requireTenant(tenantId);
      const { results } = await db
        .prepare(
          `SELECT ${INVITE_COLUMNS} FROM tenant_invite
            WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?
            ORDER BY created_at DESC, id`,
        )
        .bind(tenantId, nowSeconds())
        .all<InviteRow>();
      return results.map(inviteView);
    },

    /**
     * Invite an email to a team. Returns the invite secret once: only its
     * SHA-256 is stored. An email that is already a member is
     * GATEWAY_MEMBER_EXISTS; a second pending invite GATEWAY_INVITE_EXISTS.
     */
    async createInvite(input: {
      tenantId: string;
      email: string;
      role: GatewayTenantRole;
      actor: GatewayAdminActor;
    }): Promise<{ invite: InviteView; token: string }> {
      await requireTeam(input.tenantId);
      const email = input.email.toLowerCase();
      const existingMember = await db
        .prepare(
          `SELECT 1 AS found FROM tenant_member m JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ? AND lower(u.email) = ?`,
        )
        .bind(input.tenantId, email)
        .first();
      if (existingMember) throw new GatewayError("GATEWAY_MEMBER_EXISTS", { details: { tenantId: input.tenantId } });
      const publicId = hex(12);
      const token = `${INVITE_PREFIX}${publicId}.${hex(32)}`;
      const id = `${INVITE_PREFIX}${publicId}`;
      const nowS = nowSeconds();
      const expiresS = toSeconds(deps.clock.now() + TEAM_INVITE_TTL_MS);
      const [inserted] = await runBatch(
        db,
        [
          db
            .prepare(
              `INSERT INTO tenant_invite
                 (id, tenant_id, email, role, token_hash, invited_by_user_id, status, expires_at, created_at, updated_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?8
                WHERE NOT EXISTS (SELECT 1 FROM tenant_invite
                                   WHERE tenant_id = ?2 AND email = ?3 AND status = 'pending' AND expires_at > ?8)`,
            )
            .bind(id, input.tenantId, email, input.role, await sha256Hex(token), input.actor.id, expiresS, nowS),
          adminAuditStatement(db, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "invite.create",
            targetType: "tenant_invite",
            targetId: id,
            after: { email, role: input.role, expiresAt: iso(expiresS) },
            nowS,
            when: "changes() = 1",
          }),
        ],
        { tenantId: input.tenantId },
      );
      if (!inserted?.meta.changes) throw new GatewayError("GATEWAY_INVITE_EXISTS", { details: { tenantId: input.tenantId } });
      return {
        invite: inviteView({
          id,
          tenant_id: input.tenantId,
          email,
          role: input.role,
          status: "pending",
          invited_by_user_id: input.actor.id,
          expires_at: expiresS,
          created_at: nowS,
        }),
        token,
      };
    },

    /** Revoke a pending invite; its link stops working. */
    async revokeInvite(input: { tenantId: string; inviteId: string; actor: GatewayAdminActor }): Promise<void> {
      await requireTenant(input.tenantId);
      const nowS = nowSeconds();
      const [updated] = await runBatch(
        db,
        [
          db
            .prepare(
              `UPDATE tenant_invite SET status = 'revoked', updated_at = ?3
                WHERE id = ?1 AND tenant_id = ?2 AND status = 'pending'`,
            )
            .bind(input.inviteId, input.tenantId, nowS),
          adminAuditStatement(db, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "invite.revoke",
            targetType: "tenant_invite",
            targetId: input.inviteId,
            before: { status: "pending" },
            after: { status: "revoked" },
            nowS,
            when: "changes() = 1",
          }),
        ],
        { inviteId: input.inviteId },
      );
      if (!updated?.meta.changes) throw new GatewayError("GATEWAY_INVITE_NOT_FOUND", { details: { inviteId: input.inviteId } });
    },

    /** What an invite link offers, for the accept page: the team and the role, never the secret. */
    async lookupInvite(token: string): Promise<{ invite: InviteView; team: { tenantId: string; name: string } }> {
      const row = await inviteByToken(token);
      requirePending(row);
      const tenant = await tenantRow(row.tenant_id);
      return { invite: inviteView(row), team: { tenantId: tenant.id, name: tenant.name } };
    },

    /**
     * Accept an invite as the signed-in user, whose account email must be the
     * invited one (GATEWAY_INVITE_EMAIL_MISMATCH). One batch: the membership,
     * the invite marked accepted, and the audit row (actor: the new member).
     */
    async acceptInvite(input: { token: string; userId: string }): Promise<TeamView> {
      const row = await inviteByToken(input.token);
      requirePending(row);
      const account = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind(input.userId).first<{ email: string | null }>();
      if (!account?.email || account.email.toLowerCase() !== row.email)
        throw new GatewayError("GATEWAY_INVITE_EMAIL_MISMATCH", { details: { inviteId: row.id } });
      if (await memberRole(row.tenant_id, input.userId))
        throw new GatewayError("GATEWAY_MEMBER_EXISTS", { details: { tenantId: row.tenant_id } });
      const nowS = nowSeconds();
      const [inserted] = await runBatch(
        db,
        [
          db
            .prepare(
              `INSERT INTO tenant_member (tenant_id, user_id, role, created_at, updated_at)
               SELECT ?1, ?2, ?3, ?5, ?5
                WHERE EXISTS (SELECT 1 FROM tenant_invite
                               WHERE id = ?4 AND status = 'pending' AND expires_at > ?5)
                  AND NOT EXISTS (SELECT 1 FROM tenant_member WHERE tenant_id = ?1 AND user_id = ?2)`,
            )
            .bind(row.tenant_id, input.userId, row.role, row.id, nowS),
          db
            .prepare(
              `UPDATE tenant_invite SET status = 'accepted', accepted_by_user_id = ?2, accepted_at = ?3, updated_at = ?3
                WHERE id = ?1 AND status = 'pending' AND changes() = 1`,
            )
            .bind(row.id, input.userId, nowS),
          adminAuditStatement(db, {
            tenantId: row.tenant_id,
            actor: { kind: "user", id: input.userId, role: row.role },
            action: "invite.accept",
            targetType: "tenant_invite",
            targetId: row.id,
            before: { status: "pending" },
            after: { status: "accepted", role: row.role },
            nowS,
            when: "changes() = 1",
          }),
        ],
        { inviteId: row.id },
      );
      if (!inserted?.meta.changes) {
        if (await memberRole(row.tenant_id, input.userId))
          throw new GatewayError("GATEWAY_MEMBER_EXISTS", { details: { tenantId: row.tenant_id } });
        requirePending(await inviteByToken(input.token));
        throw new GatewayError("GATEWAY_CONFLICT", { details: { inviteId: row.id } });
      }
      const team = (await listTeams(input.userId)).find((entry) => entry.tenantId === row.tenant_id);
      if (!team) throw new GatewayError("GATEWAY_INTERNAL", { message: "The membership is missing after accepting." });
      return team;
    },

    // ─── Budgets ───────────────────────────────────────────────────────

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

    /** One member's own budget and their keys' budgets (members see only these). */
    async ownBudgets(tenantId: string, userId: string): Promise<BudgetView[]> {
      await requireTenant(tenantId);
      const { results } = await db
        .prepare(
          `SELECT ${BUDGET_COLUMNS} FROM gateway_budget b
            WHERE b.tenant_id = ?1
              AND ((b.scope = 'user' AND b.scope_id = ?2)
                OR (b.scope = 'key' AND b.scope_id IN (SELECT k.id FROM gateway_key k WHERE k.tenant_id = ?1 AND k.user_id = ?2)))
            ORDER BY b.scope <> 'user', b.scope_id`,
        )
        .bind(tenantId, userId)
        .all<BudgetRow>();
      return results.map(budgetView);
    },

    /**
     * Set a member (`user`) or key budget: create it under the tenant wallet,
     * or change its limit, status, enforcement or alert threshold. A limit
     * below spend is GATEWAY_BUDGET_BELOW_USAGE unless the owner
     * overrides it with a reason (`budget.override` in the audit). null is
     * explicitly unlimited (the wallet still caps it).
     */
    async setBudget(input: {
      tenantId: string;
      scope: AllocatedBudgetScope;
      scopeId: string;
      limitMicroCredits: number | null;
      status?: "active" | "suspended";
      enforcement?: BudgetEnforcement;
      alertThresholdPct?: number | null;
      override?: boolean;
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<BudgetView> {
      await requireTenant(input.tenantId);
      if (input.override && !input.reason)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", { message: "An override needs a reason.", details: { param: "reason" } });
      if (input.scope === "user" && !(await memberRole(input.tenantId, input.scopeId)))
        throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.scopeId } });
      if (input.scope === "key" && !(await keyRow(input.tenantId, input.scopeId)))
        throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { tenantId: input.tenantId, keyId: input.scopeId } });
      const before = await budgetRow(input.tenantId, input.scope, input.scopeId);
      const limit = input.limitMicroCredits;
      const status = input.status ?? before?.status ?? "active";
      const enforcement = input.enforcement ?? before?.enforcement ?? "hard";
      const alertThresholdPct = input.alertThresholdPct !== undefined ? input.alertThresholdPct : (before?.alert_threshold_pct ?? null);
      const override = input.override === true;
      if (before && !override && limit !== null && limit < before.spent_micro_credits + before.reserved_micro_credits)
        throw belowUsage(before);
      const nowS = nowSeconds();
      const id = before?.id ?? `gwb_${input.scope[0]}_${crypto.randomUUID().replaceAll("-", "")}`;
      const target = `${input.scope}:${input.scopeId}`;
      const after = { limitMicroCredits: limit, status, enforcement, alertThresholdPct };
      const write = before
        ? db
            .prepare(
              `UPDATE gateway_budget
                  SET limit_micro_credits = ?2, status = ?3, enforcement = ?6, alert_threshold_pct = ?7,
                      version = version + 1, updated_at = ?4
                WHERE id = ?1 AND version = ?5
                  AND (?8 = 1 OR ?2 IS NULL OR ?2 >= spent_micro_credits + reserved_micro_credits)`,
            )
            .bind(id, limit, status, nowS, before.version, enforcement, alertThresholdPct, override ? 1 : 0)
        : db
            .prepare(
              `INSERT INTO gateway_budget
                 (id, tenant_id, scope, scope_id, parent_budget_id, allocated_by_user_id, period,
                  limit_micro_credits, status, enforcement, alert_threshold_pct, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4,
                       (SELECT id FROM gateway_budget WHERE tenant_id = ?2 AND scope = 'tenant' AND scope_id = ?2),
                       ?5, 'none', ?6, ?7, ?9, ?10, ?8, ?8)`,
            )
            .bind(id, input.tenantId, input.scope, input.scopeId, input.actor.id, limit, status, nowS, enforcement, alertThresholdPct);
      const statements = [
        write,
        adminAuditStatement(db, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: override ? "budget.override" : before ? "budget.update" : "budget.create",
          targetType: "budget",
          targetId: target,
          ...(before ? { before: { ...budgetSnapshot(before), spentMicroCredits: before.spent_micro_credits, reservedMicroCredits: before.reserved_micro_credits } } : {}),
          after,
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ];
      // Linked only when the budget write (and so its audit row) happened: all or nothing.
      if (input.scope === "key")
        statements.push(
          db
            .prepare(
              `UPDATE gateway_key SET budget_id = ?1, updated_at = ?3
                WHERE id = ?2 AND budget_id IS NOT ?1 AND changes() = 1`,
            )
            .bind(id, input.scopeId, nowS),
        );
      const [result] = await runBatch(db, statements, { tenantId: input.tenantId, target });
      const written = result?.meta.changes ?? 0;
      const current = await budgetRow(input.tenantId, input.scope, input.scopeId);
      if (!written) {
        if (current && !override && limit !== null && limit < current.spent_micro_credits + current.reserved_micro_credits)
          throw belowUsage(current);
        throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId, target } });
      }
      if (!current) throw new GatewayError("GATEWAY_INTERNAL", { message: "The budget is missing after a write." });
      return budgetView(current);
    },

    /** Budget notifications, newest first; `scopes` narrows them (a member's own budgets). */
    async listBudgetEvents(tenantId: string, options: { budgetIds?: readonly string[]; limit?: number } = {}): Promise<BudgetEventView[]> {
      await requireTenant(tenantId);
      if (options.budgetIds && options.budgetIds.length === 0) return [];
      const filter = options.budgetIds ? ` AND budget_id IN (${options.budgetIds.map(() => "?").join(", ")})` : "";
      const { results } = await db
        .prepare(
          `SELECT id, budget_id, scope, scope_id, kind, enforcement, request_id, limit_micro_credits,
                  spent_micro_credits, reserved_micro_credits, threshold_pct, occurred_at
             FROM gateway_budget_event WHERE tenant_id = ?${filter}
            ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        )
        .bind(tenantId, ...(options.budgetIds ?? []), options.limit ?? 50)
        .all<{
          id: string;
          budget_id: string;
          scope: string;
          scope_id: string;
          kind: BudgetEventView["kind"];
          enforcement: string;
          request_id: string | null;
          limit_micro_credits: number;
          spent_micro_credits: number;
          reserved_micro_credits: number;
          threshold_pct: number | null;
          occurred_at: number;
        }>();
      return results.map((row) => ({
        id: row.id,
        budgetId: row.budget_id,
        scope: row.scope,
        scopeId: row.scope_id,
        kind: row.kind,
        enforcement: row.enforcement,
        requestId: row.request_id,
        limitMicroCredits: row.limit_micro_credits,
        spentMicroCredits: row.spent_micro_credits,
        reservedMicroCredits: row.reserved_micro_credits,
        thresholdPct: row.threshold_pct,
        occurredAt: iso(row.occurred_at)!,
      }));
    },

    // ─── Keys and rate limits ──────────────────────────────────────────

    async listKeys(tenantId: string, options: { userId?: string } = {}): Promise<GatewayKeyView[]> {
      await requireTenant(tenantId);
      const { results } = await db
        .prepare(
          `SELECT ${KEY_COLUMNS} FROM gateway_key WHERE tenant_id = ?1 AND (?2 IS NULL OR user_id = ?2)
            ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
        )
        .bind(tenantId, options.userId ?? null)
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
        const [updated] = await runBatch(
          db,
          [
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
          ],
          { keyId: input.keyId },
        );
        if (!updated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { keyId: input.keyId } });
      }
      const row = await keyRow(input.tenantId, input.keyId);
      if (!row) throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { keyId: input.keyId } });
      return keyView(row);
    },

    /** Set (or clear with null) one member's rate limit, counted per tenant and member. */
    async setMemberRateLimit(input: {
      tenantId: string;
      userId: string;
      rateLimit: Partial<GatewayRateLimit> | null;
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<MemberView> {
      await requireTenant(input.tenantId);
      const row = await memberRow(input.tenantId, input.userId);
      if (!row) throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: input.tenantId, userId: input.userId } });
      await setRateLimit({
        tenantId: input.tenantId,
        table: "tenant_member",
        where: "tenant_id = ?1 AND user_id = ?2",
        whereArgs: [input.tenantId, input.userId],
        before: row.rate_limit_json,
        rateLimit: input.rateLimit,
        action: "member.rate_limit",
        targetType: "tenant_member",
        targetId: input.userId,
        ...(input.reason ? { reason: input.reason } : {}),
        actor: input.actor,
      });
      return member(input.tenantId, input.userId);
    },

    /** Set (or clear with null) the tenant-wide rate limit; the subscription's limit applies as well (tightest wins). */
    async setTenantRateLimit(input: {
      tenantId: string;
      rateLimit: Partial<GatewayRateLimit> | null;
      reason?: string;
      actor: GatewayAdminActor;
    }): Promise<TenantView> {
      const row = await tenantRow(input.tenantId);
      await setRateLimit({
        tenantId: input.tenantId,
        table: "tenant",
        where: "id = ?1",
        whereArgs: [input.tenantId],
        before: row.rate_limit_json,
        rateLimit: input.rateLimit,
        action: "tenant.rate_limit",
        targetType: "tenant",
        targetId: input.tenantId,
        ...(input.reason ? { reason: input.reason } : {}),
        actor: input.actor,
      });
      const next = await tenantRow(input.tenantId);
      return { id: next.id, name: next.name, kind: next.kind, ownerUserId: next.owner_user_id, rateLimit: rateLimitOf(next.rate_limit_json) };
    },
  };
}

export type D1TenantAdmin = ReturnType<typeof createD1TenantAdmin>;
