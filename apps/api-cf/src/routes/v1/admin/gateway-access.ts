/**
 * Who may use the admin console (#353, #394), under /api/v1/admin/gateway.
 * Every route here, like every /api/v1/admin/* route, runs only for a signed-in
 * admin account (services/admin-identity.ts); product sessions and tokens are
 * refused before any of them.
 *
 *   GET  /me                               the signed-in admin account, its permissions
 *   GET  /admin-accounts                   admin accounts                          admin_accounts.read
 *   POST /admin-accounts                   create one (email, name, password,      admin_accounts.write
 *                                          role: platform_admin by default)
 *   POST /admin-accounts/:id/disable       sign out and lock (never the last       admin_accounts.write
 *                                          enabled platform_admin)
 *
 * The first admin account is bootstrapped by
 * apps/api-cf/scripts/gateway-admin-account.ts, never by an env variable.
 */
import { Hono } from "hono";
import { GATEWAY_KEY_RING_PERMISSIONS, adminConsolePermissions } from "@clash/gateway-core";

import type { Env } from "../../../config";
import {
  GatewayAdminAccountCreateRequestSchema,
  GatewayAdminAccountIdSchema,
  GatewayPromptAccessRequestSchema,
} from "../../../domain/requests";
import { staffPromptAccessEnabled } from "../../../gateway";
import { createD1AdminAccounts } from "../../../gateway/d1-admin-accounts";
import { monotonicClock } from "../../../gateway/d1-common";
import { requireAdminIdentity } from "../../../services/admin-identity";
import { gatewayParam, readGatewayJson } from "../../../services/gateway-admin";
import {
  adminJson as ok,
  authorizeAdminAccess,
  platformRoute,
} from "../../../services/gateway-authz";
import { gatewayErrorResponse } from "../../../services/gateway-tokens";

const DisableRequestSchema = GatewayPromptAccessRequestSchema.partial();

export const adminAccessRoutes = new Hono<{ Bindings: Env }>();

adminAccessRoutes.get("/me", async (c) => {
  try {
    const admin = requireAdminIdentity(c);
    return ok(c, {
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      // The role's permissions this Worker serves: it has no encryption key ring (api-node's, #366).
      permissions: adminConsolePermissions(admin.role, (permission) => !GATEWAY_KEY_RING_PERMISSIONS.includes(permission)),
      promptAccess: staffPromptAccessEnabled(c.env) && authorizeAdminAccess(admin, "prompts.view") !== null,
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});

const accounts = (env: Env) => createD1AdminAccounts(env.DB, { clock: monotonicClock() });

adminAccessRoutes.get(
  "/admin-accounts",
  platformRoute("admin_accounts.read", async (c) => ok(c, { accounts: await accounts(c.env).list() })),
);

adminAccessRoutes.post(
  "/admin-accounts",
  platformRoute("admin_accounts.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayAdminAccountCreateRequestSchema);
    // Better Auth's own hasher, the one admin sign-in verifies with.
    const { createAdminAuth } = await import("../../../admin-auth");
    const passwordHash = await (await createAdminAuth(c.env).$context).password.hash(body.password);
    const store = accounts(c.env);
    const account = await store.create({
      email: body.email,
      name: body.name,
      role: body.role ?? "platform_admin",
      passwordHash,
      ...(body.reason ? { reason: body.reason } : {}),
      actor,
    });
    return ok(c, { account, accounts: await store.list() }, 201);
  }),
);

adminAccessRoutes.post(
  "/admin-accounts/:id/disable",
  platformRoute("admin_accounts.write", async (c, actor) => {
    const id = gatewayParam(GatewayAdminAccountIdSchema, c.req.param("id"), "id");
    const body = await readGatewayJson(c, DisableRequestSchema);
    const store = accounts(c.env);
    const result = await store.disable({ id, ...(body.reason ? { reason: body.reason } : {}), actor });
    return ok(c, { ...result, accounts: await store.list() });
  }),
);
