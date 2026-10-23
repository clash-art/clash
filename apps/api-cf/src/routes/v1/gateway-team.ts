/**
 * Team settings (#354), mounted at /api/v1/gateway beside tenant billing.
 * Product routes: the caller is the product user the `/api/*` middleware
 * verified (Better Auth session or `clsh_` token); admin accounts never reach
 * them (#394) and only view teams in the console. Authorization is
 * services/gateway-authz.ts: the team owner holds every tenant permission, a
 * member reads only their own usage and budget (`/me`). Every mutation is one
 * D1 batch with its audit row (gateway/d1-tenant-admin.ts). Guide:
 * apps/docs/guide/gateway-teams.md.
 *
 *   GET    /teams                                      the caller's teams and roles     signed in
 *   POST   /teams                                      create a team (caller = owner)   signed in
 *   POST   /invites/lookup                             what an invite link offers       signed in
 *   POST   /invites/accept                             join with an invite              signed in, invited email
 *   GET    /tenants/:t                                 team and tenant rate limit       tenant.read
 *   PUT    /tenants/:t/rate-limit                      tenant-wide rate limit           limits.write
 *   GET    /tenants/:t/members                         members, roles, member limits    team.members.read
 *   PUT    /tenants/:t/members/:userId/role            owner or member                  team.members.manage
 *   PUT    /tenants/:t/members/:userId/rate-limit      per-member rate limit            limits.write
 *   DELETE /tenants/:t/members/:userId                 remove (keys revoked)            team.members.manage
 *   GET    /tenants/:t/invites                         pending invites                  team.members.read
 *   POST   /tenants/:t/invites                         invite an email (link once)      team.members.manage
 *   DELETE /tenants/:t/invites/:inviteId               revoke                           team.members.manage
 *   GET    /tenants/:t/budgets                         wallet, budgets, notifications   budgets.read
 *   PUT    /tenants/:t/budgets/:scope/:scopeId         allocate a member/key budget     team.budgets.allocate
 *   GET    /tenants/:t/keys                            virtual keys (no hashes)         keys.read
 *   PUT    /tenants/:t/keys/:keyId/rate-limit          key rate limit                   limits.write
 *   GET    /tenants/:t/usage                           team usage (?userId=)            usage.read
 *   GET    /tenants/:t/audit                           the team's audit log             audit.read
 *   GET    /tenants/:t/billing/offers                  packages and top-up packs        billing.read
 *   GET    /tenants/:t/me                              own role, budget, keys, usage    usage.read_own + budgets.read_own
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { Env } from "../../config";
import {
  GatewayBudgetSetRequestSchema,
  GatewayInviteCreateRequestSchema,
  GatewayInviteTokenRequestSchema,
  GatewayMemberRoleRequestSchema,
  GatewayRateLimitUpdateRequestSchema,
  GatewayTeamCreateRequestSchema,
} from "../../domain/requests";
import { createD1AdminReads } from "../../gateway/d1-admin-reads";
import { createD1Billing } from "../../gateway/d1-billing";
import { createD1GatewayBudgetPorts } from "../../gateway/d1-budgets";
import { monotonicClock } from "../../gateway/d1-common";
import { createD1TenantAdmin } from "../../gateway/d1-tenant-admin";
import { gatewayParam, gatewayQuery, readGatewayJson } from "../../services/gateway-admin";
import { requireGatewayUserId, requireTenantPermission, tenantRoute } from "../../services/gateway-authz";
import { gatewayErrorResponse } from "../../services/gateway-tokens";

type TeamContext = Context<{ Bindings: Env }>;

const NO_STORE = { "cache-control": "no-store" };
const ok = (c: TeamContext, body: unknown, status: 200 | 201 = 200) => c.json(body, status, NO_STORE);

const SubjectIdSchema = z.string().regex(/^[A-Za-z0-9._:@-]{1,256}$/);
const InviteIdSchema = z.string().regex(/^gwi_[0-9a-f]{24}$/);
const BudgetScopeSchema = z.enum(["user", "key"]);
const UsageQuerySchema = z
  .object({ userId: SubjectIdSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const LimitQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();

/** Where the web app serves an invite link; the secret travels in the fragment-free query once. */
export const TEAM_INVITE_PATH = "/team/invite";

const teams = (c: TeamContext) => createD1TenantAdmin(c.env.DB, { clock: monotonicClock() });
const billing = (c: TeamContext) => createD1Billing(c.env.DB, { clock: monotonicClock() });
const param = (c: TeamContext, name: string, schema: z.ZodType<string> = SubjectIdSchema) =>
  gatewayParam(schema, c.req.param(name), name);

/** A signed-in product user's route outside any tenant role. */
const userRoute =
  (handler: (c: TeamContext, userId: string) => Promise<Response>) =>
  async (c: TeamContext) => {
    try {
      return await handler(c, requireGatewayUserId(c));
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

/** Usage as a team sees it: billing facts only, never the upstream or account that served it. */
async function usageFor(c: TeamContext, tenantId: string, filter: { userId?: string; limit: number }) {
  const { ledger } = createD1GatewayBudgetPorts(c.env.DB, { clock: monotonicClock() });
  const events = await ledger.query({ tenantId, ...(filter.userId ? { userId: filter.userId } : {}), limit: filter.limit });
  return events.map((event) => ({
    requestId: event.requestId,
    userId: event.userId,
    keyId: event.keyId ?? null,
    modelCode: event.modelCode,
    status: event.status,
    costMicroCredits: event.costMicroCredits,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    usageSource: event.usage.source,
    errorCode: event.errorCode ?? null,
    occurredAt: new Date(event.occurredAt).toISOString(),
  }));
}

export const gatewayTeamRoutes = new Hono<{ Bindings: Env }>();

// ─── Teams and invites (signed-in product user) ──────────────────────────

gatewayTeamRoutes.get(
  "/teams",
  userRoute(async (c, userId) => ok(c, { teams: await teams(c).listTeams(userId) })),
);

gatewayTeamRoutes.post(
  "/teams",
  userRoute(async (c, userId) => {
    const body = await readGatewayJson(c, GatewayTeamCreateRequestSchema);
    return ok(c, { team: await teams(c).createTeam({ userId, name: body.name }) }, 201);
  }),
);

gatewayTeamRoutes.post(
  "/invites/lookup",
  userRoute(async (c) => {
    const body = await readGatewayJson(c, GatewayInviteTokenRequestSchema);
    return ok(c, await teams(c).lookupInvite(body.token));
  }),
);

gatewayTeamRoutes.post(
  "/invites/accept",
  userRoute(async (c, userId) => {
    const body = await readGatewayJson(c, GatewayInviteTokenRequestSchema);
    return ok(c, { team: await teams(c).acceptInvite({ token: body.token, userId }) });
  }),
);

// ─── Team settings (tenant roles) ────────────────────────────────────────

gatewayTeamRoutes.get(
  "/tenants/:tenantId",
  tenantRoute("tenant.read", async (c, _actor, tenantId) => ok(c, { tenant: await teams(c).tenant(tenantId) })),
);

gatewayTeamRoutes.put(
  "/tenants/:tenantId/rate-limit",
  tenantRoute("limits.write", async (c, actor, tenantId) => {
    const body = await readGatewayJson(c, GatewayRateLimitUpdateRequestSchema);
    const tenant = await teams(c).setTenantRateLimit({
      tenantId,
      rateLimit: body.rateLimit,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { tenant });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/members",
  tenantRoute("team.members.read", async (c, _actor, tenantId) => ok(c, { members: await teams(c).listMembers(tenantId) })),
);

gatewayTeamRoutes.put(
  "/tenants/:tenantId/members/:userId/role",
  tenantRoute("team.members.manage", async (c, actor, tenantId) => {
    const body = await readGatewayJson(c, GatewayMemberRoleRequestSchema);
    const member = await teams(c).setMemberRole({
      tenantId,
      userId: param(c, "userId"),
      role: body.role,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { member });
  }),
);

gatewayTeamRoutes.put(
  "/tenants/:tenantId/members/:userId/rate-limit",
  tenantRoute("limits.write", async (c, actor, tenantId) => {
    const body = await readGatewayJson(c, GatewayRateLimitUpdateRequestSchema);
    const member = await teams(c).setMemberRateLimit({
      tenantId,
      userId: param(c, "userId"),
      rateLimit: body.rateLimit,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { member });
  }),
);

gatewayTeamRoutes.delete(
  "/tenants/:tenantId/members/:userId",
  tenantRoute("team.members.manage", async (c, actor, tenantId) => {
    await teams(c).removeMember({ tenantId, userId: param(c, "userId"), actor });
    return ok(c, { removed: true });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/invites",
  tenantRoute("team.members.read", async (c, _actor, tenantId) => ok(c, { invites: await teams(c).listInvites(tenantId) })),
);

gatewayTeamRoutes.post(
  "/tenants/:tenantId/invites",
  tenantRoute("team.members.manage", async (c, actor, tenantId) => {
    const body = await readGatewayJson(c, GatewayInviteCreateRequestSchema);
    const { invite, token } = await teams(c).createInvite({ tenantId, email: body.email, role: body.role, actor });
    // The secret is returned once, for the owner to share; only its hash is stored.
    return ok(c, { invite, token, acceptPath: `${TEAM_INVITE_PATH}?token=${encodeURIComponent(token)}` }, 201);
  }),
);

gatewayTeamRoutes.delete(
  "/tenants/:tenantId/invites/:inviteId",
  tenantRoute("team.members.manage", async (c, actor, tenantId) => {
    await teams(c).revokeInvite({ tenantId, inviteId: param(c, "inviteId", InviteIdSchema), actor });
    return ok(c, { revoked: true });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/budgets",
  tenantRoute("budgets.read", async (c, _actor, tenantId) => {
    const admin = teams(c);
    const [budgets, summary, events] = await Promise.all([
      admin.listBudgets(tenantId),
      billing(c).walletSummary(tenantId, 0),
      admin.listBudgetEvents(tenantId),
    ]);
    return ok(c, { budgets, wallet: summary.wallet, subscription: summary.subscription, events });
  }),
);

gatewayTeamRoutes.put(
  "/tenants/:tenantId/budgets/:scope/:scopeId",
  tenantRoute("team.budgets.allocate", async (c, actor, tenantId) => {
    const scope = gatewayParam(BudgetScopeSchema, c.req.param("scope"), "scope");
    const body = await readGatewayJson(c, GatewayBudgetSetRequestSchema);
    const budget = await teams(c).setBudget({
      tenantId,
      scope,
      scopeId: param(c, "scopeId"),
      limitMicroCredits: body.limitMicroCredits,
      ...(body.status ? { status: body.status } : {}),
      ...(body.enforcement ? { enforcement: body.enforcement } : {}),
      ...(body.alertThresholdPct !== undefined ? { alertThresholdPct: body.alertThresholdPct } : {}),
      ...(body.override ? { override: true } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { budget });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/keys",
  tenantRoute("keys.read", async (c, _actor, tenantId) => ok(c, { keys: await teams(c).listKeys(tenantId) })),
);

gatewayTeamRoutes.put(
  "/tenants/:tenantId/keys/:keyId/rate-limit",
  tenantRoute("limits.write", async (c, actor, tenantId) => {
    const body = await readGatewayJson(c, GatewayRateLimitUpdateRequestSchema);
    return ok(c, { key: await teams(c).setKeyRateLimit({ tenantId, keyId: param(c, "keyId"), rateLimit: body.rateLimit, actor }) });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/usage",
  tenantRoute("usage.read", async (c, _actor, tenantId) => {
    const query = gatewayQuery(c, UsageQuerySchema);
    return ok(c, { usage: await usageFor(c, tenantId, { ...(query.userId ? { userId: query.userId } : {}), limit: query.limit }) });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/audit",
  tenantRoute("audit.read", async (c, _actor, tenantId) => {
    const query = gatewayQuery(c, LimitQuerySchema);
    return ok(c, { entries: await createD1AdminReads(c.env.DB, { clock: monotonicClock() }).audit({ tenantId, limit: query.limit }) });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/billing/offers",
  tenantRoute("billing.read", async (c) => {
    const ledger = billing(c);
    const [packages, packs] = await Promise.all([ledger.listPackages(), ledger.listTopupPacks()]);
    return ok(c, {
      packages: packages.filter((entry) => entry.status === "active"),
      packs: packs.filter((entry) => entry.status === "active"),
    });
  }),
);

gatewayTeamRoutes.get(
  "/tenants/:tenantId/me",
  tenantRoute("usage.read_own", async (c, actor, tenantId) => {
    await requireTenantPermission(c, "budgets.read_own", tenantId);
    const admin = teams(c);
    const [tenant, member, budgets, keys, usage] = await Promise.all([
      admin.tenant(tenantId),
      admin.member(tenantId, actor.id),
      admin.ownBudgets(tenantId, actor.id),
      admin.listKeys(tenantId, { userId: actor.id }),
      usageFor(c, tenantId, { userId: actor.id, limit: 50 }),
    ]);
    const events = await admin.listBudgetEvents(tenantId, { budgetIds: budgets.map((budget) => budget.id) });
    return ok(c, {
      tenant: { id: tenant.id, name: tenant.name, kind: tenant.kind },
      member,
      budgets,
      keys,
      usage,
      events,
    });
  }),
);
