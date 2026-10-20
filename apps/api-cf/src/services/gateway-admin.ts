/**
 * Authorization for the model gateway control plane (#352). Identity is the
 * user the `/api/*` middleware verified (Better Auth session or `clsh_`
 * token); no caller header is ever read as identity.
 *
 * - Platform admin: a user id listed in `GATEWAY_ADMIN_USER_IDS`. This is a
 *   platform grant, not a tenant role; unset means nobody. It manages the
 *   price book, packages, top-up packs and billing periods, and may record a
 *   purchase for any tenant.
 * - Tenant owner: `tenant_member.role = 'owner'` of the tenant. It may record
 *   its own tenant's purchases (team purchases fund the team wallet).
 *
 * Failures are coded: GATEWAY_AUTH_REQUIRED (401), GATEWAY_FORBIDDEN (403).
 */
import type { Context } from "hono";
import { GatewayError } from "@clash/gateway-core";
import type { z } from "zod";

import type { Env } from "../config";
import type { BillingActor } from "../gateway/d1-billing";
import { getResolvedIdentity } from "./request-identity";

type AdminContext = Context<{ Bindings: Env }>;

/** Parse a JSON body (an empty body is `{}`) with `schema`; failures are GATEWAY_INVALID_REQUEST. */
export async function readGatewayJson<T>(c: AdminContext, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim())
    try {
      body = JSON.parse(raw);
    } catch {
      throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { reason: "json" } });
    }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  return parsed.data;
}

/** A coded value check for a path or query parameter. */
export function gatewayParam<T>(schema: z.ZodType<T>, value: unknown, param: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param } });
  return parsed.data;
}

export function isGatewayPlatformAdmin(env: Pick<Env, "GATEWAY_ADMIN_USER_IDS">, userId: string): boolean {
  return (env.GATEWAY_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .some((id) => id !== "" && id === userId);
}

function requireUserId(c: AdminContext): string {
  const resolved = getResolvedIdentity(c);
  if (!resolved?.userId) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  return resolved.userId;
}

export function requireGatewayPlatformAdmin(c: AdminContext): BillingActor {
  const userId = requireUserId(c);
  if (!isGatewayPlatformAdmin(c.env, userId))
    throw new GatewayError("GATEWAY_FORBIDDEN", { details: { reason: "platform_admin" } });
  return { userId, role: "platform_admin" };
}

/** A platform admin, or the owner of `tenantId`. */
export async function requireTenantBillingActor(c: AdminContext, tenantId: string): Promise<BillingActor> {
  const userId = requireUserId(c);
  if (isGatewayPlatformAdmin(c.env, userId)) return { userId, role: "platform_admin" };
  const member = await c.env.DB.prepare(
    `SELECT role FROM tenant_member WHERE tenant_id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(tenantId, userId)
    .first<{ role: string }>();
  if (member?.role !== "owner")
    throw new GatewayError("GATEWAY_FORBIDDEN", { details: { reason: "tenant_owner" } });
  return { userId, role: "owner" };
}
