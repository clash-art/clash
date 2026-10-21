/**
 * Who may use the admin console (#353), under /api/v1/admin/gateway:
 *
 *   GET  /me                                 the caller's platform roles and permissions (any signed-in user)
 *   GET  /platform-admins                    platform staff grants                platform_roles.read
 *   POST /platform-admins                    grant platform_admin                 platform_roles.write
 *   POST /platform-admins/:userId/revoke     revoke (never the last one)          platform_roles.write
 *
 * The first platform admin is bootstrapped by
 * apps/api-cf/scripts/gateway-platform-admin.ts, never by an env variable.
 */
import { Hono } from "hono";

import type { Env } from "../../../config";
import { GatewayPlatformAdminGrantRequestSchema, GatewayPromptAccessRequestSchema } from "../../../domain/requests";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1PlatformRoles } from "../../../gateway/d1-platform-roles";
import { gatewayParam, readGatewayJson } from "../../../services/gateway-admin";
import {
  GATEWAY_PLATFORM_ROLE_PERMISSIONS,
  adminJson as ok,
  authorizeGatewayAccess,
  loadGatewayAccess,
  platformRoute,
  requireGatewayUserId,
} from "../../../services/gateway-authz";
import { staffPromptAccessEnabled } from "../../../gateway";
import { gatewayErrorResponse } from "../../../services/gateway-tokens";

const UserIdSchema = GatewayPlatformAdminGrantRequestSchema.shape.userId;
const RevokeRequestSchema = GatewayPromptAccessRequestSchema.partial();

export const adminAccessRoutes = new Hono<{ Bindings: Env }>();

adminAccessRoutes.get("/me", async (c) => {
  try {
    const access = await loadGatewayAccess(c.env.DB, requireGatewayUserId(c));
    const platformPermissions = [
      ...new Set(access.platformRoles.flatMap((role) => GATEWAY_PLATFORM_ROLE_PERMISSIONS[role])),
    ];
    return ok(c, {
      userId: access.userId,
      platformRoles: access.platformRoles,
      platformPermissions,
      promptAccess: staffPromptAccessEnabled(c.env) && authorizeGatewayAccess(access, "prompts.view") !== null,
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});

adminAccessRoutes.get(
  "/platform-admins",
  platformRoute("platform_roles.read", async (c) =>
    ok(c, { admins: await createD1PlatformRoles(c.env.DB, { clock: monotonicClock() }).list() }),
  ),
);

adminAccessRoutes.post(
  "/platform-admins",
  platformRoute("platform_roles.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayPlatformAdminGrantRequestSchema);
    const roles = createD1PlatformRoles(c.env.DB, { clock: monotonicClock() });
    const result = await roles.grant({ userId: body.userId, ...(body.reason ? { reason: body.reason } : {}), actor });
    return ok(c, { ...result, admins: await roles.list() }, result.granted ? 201 : 200);
  }),
);

adminAccessRoutes.post(
  "/platform-admins/:userId/revoke",
  platformRoute("platform_roles.write", async (c, actor) => {
    const userId = gatewayParam(UserIdSchema, c.req.param("userId"), "userId");
    const body = await readGatewayJson(c, RevokeRequestSchema);
    const roles = createD1PlatformRoles(c.env.DB, { clock: monotonicClock() });
    const result = await roles.revoke({ userId, ...(body.reason ? { reason: body.reason } : {}), actor });
    return ok(c, { ...result, admins: await roles.list() });
  }),
);
