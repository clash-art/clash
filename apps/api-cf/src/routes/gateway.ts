/**
 * Gateway surface authenticated by sk_gw_ tokens only (#346), mounted at
 * /gateway outside /api/*: neither the session/clsh_ middleware nor any
 * caller header (x-user-id included) contributes identity here. The data
 * plane (/gateway/v1/*) joins this router and verifies the same way.
 */
import { Hono } from "hono";

import type { Env } from "../config";
import {
  createGatewayTokenStore,
  gatewayErrorResponse,
} from "../services/gateway-tokens";

export const gatewayRoutes = new Hono<{ Bindings: Env }>();

gatewayRoutes.get("/me", async (c) => {
  try {
    const identity = await createGatewayTokenStore(c.env.DB).verify(c.req.raw);
    return c.json(
      {
        userId: identity.userId,
        tenantId: identity.tenantId,
        keyId: identity.keyId,
        scopes: identity.scopes,
        modelAllowlist: identity.modelAllowlist ?? null,
        credentialScope: identity.credentialScope,
        expiresAt: new Date(identity.expiresAt).toISOString(),
      },
      200,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});
