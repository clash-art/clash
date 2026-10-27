/**
 * gateway-core `retention` over D1 `gateway_request_retention` (0037): the
 * metadata of retained request/response bodies, whose bytes are R2 objects
 * (r2-blobs.ts). Columns are unix seconds; the core is epoch ms. A streamed
 * answer's copy cut at the cap is `response_truncated = 1` with
 * `response_observed_bytes` (0039).
 *
 * Also the purge entry point for the Worker `scheduled` handler and the admin
 * purge route: `purgeGatewayRetention(env)` deletes expired bodies and marks
 * their rows purged, idempotently. Purge runs whatever
 * GATEWAY_STAFF_PROMPT_ACCESS says, so switching the flag off never strands
 * bodies past their 30 days.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GATEWAY_LEDGER_RETENTION_MS,
  gatewayRetentionCutoffs,
  gatewayUtcDay,
  purgeExpiredGatewayBodies,
  unavailablePort,
  type GatewayClock,
  type GatewayDataRetentionResult,
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

/** Rows one retention statement may touch per run; a backlog drains over later runs. */
export const GATEWAY_DATA_RETENTION_LIMIT = 2000;

/**
 * Metadata and ledger retention (#355; decision 2026-10-20, gateway-usage.md):
 * 30 days for usage metadata, 13 months for the ledger. One D1 batch:
 *
 * - ledger operational columns (`upstream_id`, `account_id`,
 *   `provider_request_id`, `error_code`) NULLed 30 days after `occurred_at`;
 * - ledger rows deleted 13 months after `occurred_at`;
 * - ended `gateway_token` rows and terminal `tenant_invite` rows deleted 30
 *   days after they ended; purged `gateway_request_retention` markers 30 days
 *   after storage;
 * - upstream reports, their groups and reconciliation runs after 13 months;
 * - admin audit rows after 13 months. The 0036 trigger refuses deleting a
 *   younger row by the database's own clock, so the cutoff is also bounded by
 *   that clock: a skewed caller clock can never abort the batch.
 *
 * A hold still reserving (`open`, `settle_failed`) is never touched: it is
 * live budget state, not history. Idempotent and bounded per statement.
 */
export async function enforceGatewayDataRetention(
  db: D1Database,
  options: { clock?: GatewayClock; limit?: number } = {},
): Promise<GatewayDataRetentionResult> {
  const now = (options.clock ?? monotonicClock()).now();
  const limit = options.limit ?? GATEWAY_DATA_RETENTION_LIMIT;
  const { metadataBefore, ledgerBefore } = gatewayRetentionCutoffs(now);
  const metaS = toSeconds(metadataBefore);
  const ledgerS = toSeconds(ledgerBefore);
  const ledgerDay = gatewayUtcDay(ledgerBefore);
  const notLiveHold = `NOT (kind = 'hold' AND status IN ('open', 'settle_failed'))`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE gateway_usage_ledger
            SET upstream_id = NULL, account_id = NULL, provider_request_id = NULL, error_code = NULL
          WHERE id IN (SELECT id FROM gateway_usage_ledger
                        WHERE occurred_at < ?1 AND ${notLiveHold}
                          AND (upstream_id IS NOT NULL OR account_id IS NOT NULL
                               OR provider_request_id IS NOT NULL OR error_code IS NOT NULL)
                        ORDER BY occurred_at LIMIT ?2)`,
      )
      .bind(metaS, limit),
    db
      .prepare(
        `DELETE FROM gateway_usage_ledger
          WHERE id IN (SELECT id FROM gateway_usage_ledger
                        WHERE occurred_at < ?1 AND ${notLiveHold} ORDER BY occurred_at LIMIT ?2)`,
      )
      .bind(ledgerS, limit),
    db
      .prepare(
        `DELETE FROM gateway_token
          WHERE id IN (SELECT id FROM gateway_token
                        WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?1) LIMIT ?2)`,
      )
      .bind(metaS, limit),
    db
      .prepare(
        `DELETE FROM tenant_invite
          WHERE id IN (SELECT id FROM tenant_invite
                        WHERE (status <> 'pending' AND updated_at < ?1) OR expires_at < ?1 LIMIT ?2)`,
      )
      .bind(metaS, limit),
    db
      .prepare(
        `DELETE FROM gateway_request_retention
          WHERE request_id IN (SELECT request_id FROM gateway_request_retention
                                WHERE status = 'purged' AND stored_at < ?1 LIMIT ?2)`,
      )
      .bind(metaS, limit),
    db
      .prepare(
        `DELETE FROM gateway_upstream_usage
          WHERE id IN (SELECT id FROM gateway_upstream_usage WHERE day < ?1 LIMIT ?2)`,
      )
      .bind(ledgerDay, limit),
    db
      .prepare(
        `DELETE FROM gateway_upstream_report
          WHERE id IN (SELECT id FROM gateway_upstream_report WHERE day < ?1 LIMIT ?2)`,
      )
      .bind(ledgerDay, limit),
    db
      .prepare(
        `DELETE FROM gateway_reconciliation_run
          WHERE id IN (SELECT id FROM gateway_reconciliation_run WHERE day < ?1 LIMIT ?2)`,
      )
      .bind(ledgerDay, limit),
    db
      .prepare(
        `DELETE FROM gateway_admin_audit
          WHERE id IN (SELECT id FROM gateway_admin_audit
                        WHERE occurred_at < MIN(?1, CAST(strftime('%s', 'now') AS INTEGER) - ?2)
                        ORDER BY occurred_at LIMIT ?3)`,
      )
      .bind(ledgerS, Math.ceil(GATEWAY_LEDGER_RETENTION_MS / 1000), limit),
  ]);
  const changes = results.map((result) => result.meta.changes ?? 0);
  const [cleared, deleted, tokens, invites, markers, usageRows, reports, runs, audits] = changes as [
    number, number, number, number, number, number, number, number, number,
  ];
  return {
    ledgerMetadataCleared: cleared,
    ledgerDeleted: deleted,
    tokensDeleted: tokens,
    invitesDeleted: invites,
    retentionMarkersDeleted: markers,
    reconciliationDeleted: usageRows + reports + runs,
    auditDeleted: audits,
    more: changes.some((count) => count >= limit),
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
