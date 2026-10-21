/**
 * Gateway surface authenticated by sk_gw_ tokens only (#346), mounted at
 * /gateway outside /api/*: neither the session/clsh_ middleware nor any
 * caller header (x-user-id included) contributes identity here. The data
 * plane (/gateway/v1/*, #347) is gateway-core's createGatewayApp over the D1
 * ports in ../gateway and verifies the same way.
 */
import { Hono } from "hono";

import type { Env } from "../config";
import { createCloudflareGatewayApp } from "../gateway";
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

gatewayRoutes.all("/v1/*", (c) => {
  // Hono throws when there is no ExecutionContext (unit tests calling app.request).
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (promise) => ctx.waitUntil(promise);
  } catch {
    waitUntil = undefined;
  }
  return createCloudflareGatewayApp(c.env, waitUntil ? { waitUntil } : {}).fetch(c.req.raw);
});
