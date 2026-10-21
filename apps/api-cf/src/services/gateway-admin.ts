/**
 * Coded request parsing for the model gateway control plane. Authorization is
 * services/gateway-authz.ts (D1-stored roles and the permission matrix).
 */
import type { Context } from "hono";
import { GatewayError } from "@clash/gateway-core";
import type { z } from "zod";

import type { Env } from "../config";

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

/** Parse the whole query string with `schema`; failures are GATEWAY_INVALID_REQUEST naming the fields. */
export function gatewayQuery<T>(c: AdminContext, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  return parsed.data;
}
