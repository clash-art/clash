/**
 * Short-lived gateway token lifecycle (#346), mounted at /api/v1/gateway.
 *
 *   POST   /tokens            mint from a Better Auth session or clsh_ token
 *   POST   /tokens/:id/renew  extend by one TTL with the same parent credential
 *   DELETE /tokens/:id        revoke one of the caller's tokens
 *
 * An sk_gw_ token is never a parent: it cannot mint, renew or revoke. The
 * token itself is only in the mint response (no-store); errors are coded.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { GatewayError } from "@clash/gateway-core";

import type { Env } from "../../config";
import { MintGatewayTokenRequestSchema } from "../../domain/requests";
import { getApiTokenIdentity } from "../../services/api-token";
import {
  createGatewayTokenStore,
  gatewayErrorResponse,
  type GatewayTokenParent,
} from "../../services/gateway-tokens";
import { publicOrigin } from "../../services/public-origin";
import { getResolvedIdentity } from "../../services/request-identity";
import { getSessionIdentity } from "../../services/session";

type GatewayContext = Context<{ Bindings: Env }>;

/**
 * The parent credential, resolved with the same precedence as the /api/*
 * middleware (clsh_ bearer, then session). It needs the credential id, which
 * the middleware does not keep, so it is looked up again here.
 */
async function parentCredential(
  c: GatewayContext,
): Promise<{ userId: string; parent: GatewayTokenParent }> {
  const resolved = getResolvedIdentity(c);
  if (resolved?.via === "none") throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  if (resolved?.via !== "session") {
    const token = await getApiTokenIdentity(c.req.raw, c.env);
    if (token)
      return { userId: token.userId, parent: { kind: "api_token", id: token.id } };
  }
  if (resolved?.via !== "api-token") {
    const session = await getSessionIdentity(
      c.req.raw,
      c.env as never,
      c.req.raw.cf as never,
    );
    if (session?.sessionId)
      return {
        userId: session.userId,
        parent: { kind: "session", id: session.sessionId },
      };
  }
  throw new GatewayError("GATEWAY_AUTH_REQUIRED");
}

async function jsonBody(c: GatewayContext): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: { reason: "json" },
    });
  }
}

const iso = (epochMs: number) => new Date(epochMs).toISOString();

export const gatewayTokenRoutes = new Hono<{ Bindings: Env }>();

gatewayTokenRoutes.post("/tokens", async (c) => {
  try {
    const { userId, parent } = await parentCredential(c);
    const parsed = MintGatewayTokenRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success)
      throw new GatewayError("GATEWAY_INVALID_REQUEST", {
        details: {
          fields: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
      });
    const minted = await createGatewayTokenStore(c.env.DB).mint({
      userId,
      parent,
      ...(parsed.data.tenantId ? { tenantId: parsed.data.tenantId } : {}),
      ...(parsed.data.scopes ? { scopes: parsed.data.scopes } : {}),
      modelAllowlist: parsed.data.modelAllowlist ?? null,
    });
    return c.json(
      {
        token: minted.token,
        tokenType: "Bearer",
        expiresAt: iso(minted.expiresAt),
        baseUrl: `${publicOrigin(c.req.raw, c.env)}/gateway`,
        keyId: minted.keyId,
        tenantId: minted.tenantId,
        scopes: minted.scopes,
        modelAllowlist: minted.modelAllowlist,
      },
      201,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});

gatewayTokenRoutes.post("/tokens/:id/renew", async (c) => {
  try {
    const { userId, parent } = await parentCredential(c);
    const renewed = await createGatewayTokenStore(c.env.DB).renew({
      keyId: c.req.param("id"),
      userId,
      parent,
    });
    return c.json(
      { keyId: renewed.keyId, expiresAt: iso(renewed.expiresAt) },
      200,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});

gatewayTokenRoutes.delete("/tokens/:id", async (c) => {
  try {
    const { userId } = await parentCredential(c);
    await createGatewayTokenStore(c.env.DB).revoke({
      keyId: c.req.param("id"),
      userId,
    });
    return c.body(null, 204);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
});
