/**
 * gateway-core `retention` over D1 `gateway_request_retention` (0037): the
 * metadata of retained request/response bodies, whose bytes are R2 objects
 * (r2-blobs.ts). Columns are unix seconds; the core is epoch ms. A streamed
 * answer's copy cut at the cap is `response_truncated = 1` with
 * `response_observed_bytes` (0038).
 *
 * Also the purge entry point for the Worker `scheduled` handler and the admin
 * purge route: `purgeGatewayRetention(env)` deletes expired bodies and marks
 * their rows purged, idempotently. Purge runs whatever
 * GATEWAY_STAFF_PROMPT_ACCESS says, so switching the flag off never strands
 * bodies past their 30 days.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  purgeExpiredGatewayBodies,
  unavailablePort,
  type GatewayPorts,
  type GatewayRetentionEntry,
  type GatewayRetentionPort,
  type GatewayRetentionStatus,
  type PurgeResult,
} from "@clash/gateway-core";

import type { Env } from "../config";
import { monotonicClock, toMs, toSeconds } from "./d1-common";
import { createR2GatewayBlobPort, type GatewayBlobBucket } from "./r2-blobs";
import { workersLogger } from "./workers-logger";

interface RetentionRow {
  request_id: string;
  tenant_id: string;
  user_id: string;
  key_id: string | null;
  status: GatewayRetentionStatus;
  error_code: string | null;
  request_key: string;
  request_bytes: number;
  request_sha256: string;
  request_type: string;
  response_key: string;
  response_bytes: number;
  response_sha256: string;
  response_type: string;
  response_status: number;
  response_truncated: number;
  response_observed_bytes: number | null;
  stored_at: number;
  expires_at: number;
  purged_at: number | null;
}

function fromRow(row: RetentionRow): GatewayRetentionEntry {
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    ...(row.key_id ? { keyId: row.key_id } : {}),
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    request: { key: row.request_key, bytes: row.request_bytes, sha256: row.request_sha256, contentType: row.request_type },
    response: {
      key: row.response_key,
      bytes: row.response_bytes,
      sha256: row.response_sha256,
      contentType: row.response_type,
      ...(row.response_truncated
        ? { truncated: true as const, ...(row.response_observed_bytes !== null ? { observedBytes: row.response_observed_bytes } : {}) }
        : {}),
    },
    responseStatus: row.response_status,
    storedAt: toMs(row.stored_at),
    expiresAt: toMs(row.expires_at),
    ...(row.purged_at !== null ? { purgedAt: toMs(row.purged_at) } : {}),
  };
}

export function createD1GatewayRetentionPort(db: D1Database): GatewayRetentionPort {
  return {
    async record(entry) {
      await db
        .prepare(
          `INSERT INTO gateway_request_retention
             (request_id, tenant_id, user_id, key_id, status, error_code,
              request_key, request_bytes, request_sha256, request_type,
              response_key, response_bytes, response_sha256, response_type,
              response_status, stored_at, expires_at, response_truncated, response_observed_bytes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
           ON CONFLICT (request_id) DO NOTHING`,
        )
        .bind(
          entry.requestId,
          entry.tenantId,
          entry.userId,
          entry.keyId ?? null,
          entry.status,
          entry.errorCode ?? null,
          entry.request.key,
          entry.request.bytes,
          entry.request.sha256,
          entry.request.contentType,
          entry.response.key,
          entry.response.bytes,
          entry.response.sha256,
          entry.response.contentType,
          entry.responseStatus,
          toSeconds(entry.storedAt),
          toSeconds(entry.expiresAt),
          entry.response.truncated ? 1 : 0,
          entry.response.observedBytes ?? null,
        )
        .run();
    },
    async get({ requestId }) {
      const row = await db
        .prepare(`SELECT * FROM gateway_request_retention WHERE request_id = ?`)
        .bind(requestId)
        .first<RetentionRow>();
      return row ? fromRow(row) : null;
    },
    async expired({ before, limit }) {
      const { results } = await db
        .prepare(
          `SELECT * FROM gateway_request_retention
            WHERE status IN ('stored', 'failed') AND expires_at <= ?
            ORDER BY expires_at, request_id LIMIT ?`,
        )
        .bind(toSeconds(before), limit)
        .all<RetentionRow>();
      return results.map(fromRow);
    },
    async markPurged({ requestId, at }) {
      await db
        .prepare(
          `UPDATE gateway_request_retention SET status = 'purged', purged_at = ?2
            WHERE request_id = ?1 AND status <> 'purged'`,
        )
        .bind(requestId, toSeconds(at))
        .run();
    },
  };
}

export type GatewayRetentionPorts = Pick<GatewayPorts, "blobs" | "retention" | "clock" | "logger">;

/** The ports retention reads and purges need, for one request's bindings. */
export function gatewayRetentionPorts(
  env: Pick<Env, "DB"> & { R2_BUCKET?: GatewayBlobBucket },
  overrides: Partial<GatewayRetentionPorts> = {},
): GatewayRetentionPorts {
  return {
    blobs: env.R2_BUCKET ? createR2GatewayBlobPort(env.R2_BUCKET) : unavailablePort("blobs"),
    retention: createD1GatewayRetentionPort(env.DB),
    clock: monotonicClock(),
    logger: workersLogger(),
    ...overrides,
  };
}

/** Scheduled/admin purge of expired retained bodies; idempotent. */
export function purgeGatewayRetention(
  env: Pick<Env, "DB"> & { R2_BUCKET?: GatewayBlobBucket },
  options: { limit?: number; ports?: Partial<GatewayRetentionPorts> } = {},
): Promise<PurgeResult> {
  return purgeExpiredGatewayBodies(gatewayRetentionPorts(env, options.ports), {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}
