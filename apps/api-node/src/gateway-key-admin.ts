/**
 * Audited admin rotation of the gateway encryption key ring (#366).
 *
 * Admin identity is the separate admin system (#394): the host injects
 * `verifyAdmin`, which resolves an admin session (never a product user or
 * token) to an admin account. The single platform role, `platform_admin`, may
 * rotate. Every mutation writes its `gateway_admin_audit` row in the same
 * transaction as the change, so both commit or neither does.
 *
 *   GET  /api/v1/admin/gateway/encryption          current kid, ring kids, envelope counts
 *   POST /api/v1/admin/gateway/encryption/rotate   { kid }   switch the current kid
 *   POST /api/v1/admin/gateway/encryption/reencrypt { limit? } reseal old envelopes
 *
 * Responses and audit rows hold key ids and counts only, never key material
 * or credential plaintext.
 */

import { randomUUID } from "node:crypto";
import {
  GatewayError,
  gatewayErrorResponseInit,
  toGatewayError,
} from "@clash/gateway-core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  currentEncryptionKid,
  GATEWAY_ENCRYPTION_CURRENT_CONFIG_KEY,
  type GatewayCredentialStore,
} from "./gateway-credentials.ts";
import type { GatewayKeyRing } from "./gateway-keyring.ts";

export const GATEWAY_PLATFORM_ADMIN_ROLE = "platform_admin";
export const GATEWAY_KEY_ADMIN_PREFIX = "/api/v1/admin/gateway/encryption";

export interface GatewayAdminIdentity {
  /** admin account id (`adm_…`). */
  id: string;
  role: string;
}

export interface GatewayAdminAuditRow {
  tenantId?: string;
  actor: { kind: "admin"; id: string; role: string };
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

export async function appendGatewayAdminAudit(
  tx: GatewayBudgetSqlClient,
  row: GatewayAdminAuditRow,
  at: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO gateway_admin_audit
       (id, tenant_id, actor_kind, actor_id, actor_role, action, target_type, target_id,
        before_json, after_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [
      `gaa_${randomUUID().replaceAll("-", "")}`,
      row.tenantId ?? "",
      row.actor.kind,
      row.actor.id,
      row.actor.role,
      row.action,
      row.targetType,
      row.targetId,
      row.before === undefined ? null : JSON.stringify(row.before),
      row.after === undefined ? null : JSON.stringify(row.after),
      at,
    ],
  );
}

const RotateSchema = z.object({ kid: z.string().min(1).max(64) }).strict();
const ReencryptSchema = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();

export function createGatewayKeyAdminRoutes(deps: {
  db: GatewayBudgetDatabase;
  ring: GatewayKeyRing;
  store: GatewayCredentialStore;
  verifyAdmin: (request: Request) => Promise<GatewayAdminIdentity | null>;
  now?: () => number;
}): Hono {
  const { db, ring, store } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  const fail = (c: Context, error: unknown) => {
    const init = gatewayErrorResponseInit(toGatewayError(error), "openai");
    return c.json(init.body, init.status as 400, init.headers);
  };
  async function admin(c: Context) {
    const identity = await deps.verifyAdmin(c.req.raw);
    if (!identity) throw new GatewayError("GATEWAY_ADMIN_SESSION_REQUIRED");
    if (identity.role !== GATEWAY_PLATFORM_ADMIN_ROLE)
      throw new GatewayError("GATEWAY_FORBIDDEN");
    return { kind: "admin" as const, id: identity.id, role: identity.role };
  }
  async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
    const json = await c.req.json().catch(() => ({}));
    const parsed = schema.safeParse(json ?? {});
    if (!parsed.success)
      throw new GatewayError("GATEWAY_INVALID_REQUEST", {
        details: { reason: "body" },
      });
    return parsed.data;
  }

  app.get(GATEWAY_KEY_ADMIN_PREFIX, async (c) => {
    try {
      await admin(c);
      const current = await currentEncryptionKid(db, ring);
      const { rows } = await db.query<{
        kid: string;
        scope: string;
        n: string;
      }>(
        `SELECT CASE WHEN encrypted_credentials LIKE 'v2.%' THEN split_part(encrypted_credentials, '.', 2)
                     ELSE 'v1' END AS kid, scope, count(*)::text AS n
           FROM gateway_upstream_credential GROUP BY 1, 2 ORDER BY 1, 2`,
      );
      return c.json({
        current: current ?? null,
        ringKids: ring.kids,
        envelopes: rows.map((r) => ({
          kid: r.kid,
          scope: r.scope,
          count: Number(r.n),
        })),
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post(`${GATEWAY_KEY_ADMIN_PREFIX}/rotate`, async (c) => {
    try {
      const actor = await admin(c);
      const { kid } = await body(c, RotateSchema);
      // This node must hold the new key; deploy the ring everywhere first.
      if (!ring.has(kid))
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          details: { reason: "kid_not_in_ring" },
        });
      const at = now();
      const result = await db.transaction(async (tx) => {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtext('clash:gateway:encryption.current'))",
        );
        const before = await currentEncryptionKid(tx, ring);
        const { rows } = await tx.query<{ version: string }>(
          `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ($1, $2::jsonb, 1, $3)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value,
             version = gateway_config.version + 1, updated_at = excluded.updated_at
           RETURNING version::text AS version`,
          [GATEWAY_ENCRYPTION_CURRENT_CONFIG_KEY, JSON.stringify({ kid }), at],
        );
        await appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: "gateway.encryption.rotate",
            targetType: "gateway_encryption_key",
            targetId: kid,
            before: { kid: before ?? null },
            after: { kid, configVersion: Number(rows[0]!.version) },
          },
          at,
        );
        return {
          previous: before ?? null,
          current: kid,
          configVersion: Number(rows[0]!.version),
        };
      });
      return c.json(result);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post(`${GATEWAY_KEY_ADMIN_PREFIX}/reencrypt`, async (c) => {
    try {
      const actor = await admin(c);
      const { limit } = await body(c, ReencryptSchema);
      const result = await store.reencrypt(limit ? { limit } : {});
      const current = await currentEncryptionKid(db, ring);
      await db.transaction((tx) =>
        appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: "gateway.encryption.reencrypt",
            targetType: "gateway_encryption_key",
            targetId: current ?? "",
            after: result,
          },
          now(),
        ),
      );
      return c.json({ current: current ?? null, ...result });
    } catch (error) {
      return fail(c, error);
    }
  });

  return app;
}
