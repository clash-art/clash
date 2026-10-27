/**
 * Request/response body retention (#353; product decision 2026-10-20): when a
 * deployment enables it, every admitted data-plane request stores the
 * normalized request body and the exact response bytes the caller received,
 * for 30 days, so platform staff can view them through the audited admin
 * endpoint. Bodies go to `blobs`; `retention` holds metadata only (sizes,
 * SHA-256, keys, expiry), never content.
 *
 * Only bodies are stored, never headers: the caller's credential and the
 * upstream key (both headers) cannot reach storage.
 *
 * Streamed answers (#348) are retained the same way: the bytes the caller was
 * handed, copied beside the stream (createRetainedBodyCopy) up to a cap. A
 * copy cut at the cap ends in a GATEWAY_RETENTION_TRUNCATED marker, its
 * metadata says `truncated` with the size actually delivered, and
 * `gateway.retention_truncated` is logged.
 *
 * A storage failure never changes the answer or its billing (retention runs
 * after settlement): it is recorded as a `failed` row, logged as
 * `gateway.retention_failed` and reported on the answer with
 * `x-gateway-retention: failed; code=GATEWAY_RETENTION_FAILED; request_id=<id>`.
 */
import { GatewayError, toGatewayError, type GatewayErrorCode } from "./errors.js";
import type {
  GatewayIdentity,
  GatewayPorts,
  GatewayRetainedBodyMeta,
  GatewayRetentionEntry,
} from "./ports.js";

/** Present only when retention failed: `failed; code=GATEWAY_RETENTION_FAILED; request_id=<id>`. */
export const GATEWAY_RETENTION_HEADER = "x-gateway-retention";

/** Bodies are kept 30 days from storage, then unreadable and purged. */
export const GATEWAY_BODY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Usage metadata (#355; product decision 2026-10-20): operational ledger
 * columns (upstream, account, provider request id, error code), ended tokens,
 * settled invites and body-retention markers are kept 30 days.
 */
export const GATEWAY_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The ledger (money, kind, status, model, versions, token counts) and the
 * admin audit are kept 13 months: 396 days, the window the 0036 audit
 * trigger enforces, so both age out on the same day.
 */
export const GATEWAY_LEDGER_RETENTION_MS = 396 * 24 * 60 * 60 * 1000;

/** Instants (epoch ms) before which each class of retained data is due for removal. */
export function gatewayRetentionCutoffs(now: number): { metadataBefore: number; ledgerBefore: number } {
  return { metadataBefore: now - GATEWAY_METADATA_RETENTION_MS, ledgerBefore: now - GATEWAY_LEDGER_RETENTION_MS };
}

/**
 * The metadata/ledger retention job runs from the every-minute scheduled
 * handler once an hour, at this minute; each run is bounded and idempotent,
 * so a backlog drains over the following hours.
 */
export const GATEWAY_RETENTION_ENFORCE_MINUTE = 45;

export function isRetentionEnforcementDue(ms: number): boolean {
  return Math.floor(ms / 60_000) % 60 === GATEWAY_RETENTION_ENFORCE_MINUTE;
}

/** What one metadata/ledger retention run removed; every count is rows. */
export interface GatewayDataRetentionResult {
  /** Ledger rows whose operational columns were NULLed (older than 30 days). */
  ledgerMetadataCleared: number;
  /** Ledger rows deleted (older than 13 months). */
  ledgerDeleted: number;
  /** Ended (expired or revoked) gateway tokens deleted 30 days after they ended. */
  tokensDeleted: number;
  /** Accepted, revoked or expired invites deleted 30 days after they ended. */
  invitesDeleted: number;
  /** Purged body-retention markers deleted 30 days after storage. */
  retentionMarkersDeleted: number;
  /** Upstream reports, their groups and reconciliation runs deleted after 13 months. */
  reconciliationDeleted: number;
  /** Admin audit rows deleted after 13 months (the 0036 trigger refuses anything younger). */
  auditDeleted: number;
  /** True when some statement hit its row limit: more is due on the next run. */
  more: boolean;
}

export const GATEWAY_RETENTION_KEY_PREFIX = "gateway-retention/";

export function gatewayRetentionKeys(requestId: string): { request: string; response: string } {
  const base = `${GATEWAY_RETENTION_KEY_PREFIX}${encodeURIComponent(requestId)}`;
  return { request: `${base}/request.json`, response: `${base}/response.json` };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const encoder = new TextEncoder();

/** Default cap on a streamed answer's retained copy; the stream itself is never capped. */
export const GATEWAY_STREAM_RETENTION_MAX_BYTES = 8 * 1024 * 1024;

/** Line appended to a retained copy cut at the cap (an SSE comment, so the copy still parses). */
export function retentionTruncationMarker(input: { storedBytes: number; observedBytes: number }): string {
  return `\n\n: x-gateway-retention: truncated; code=GATEWAY_RETENTION_TRUNCATED; stored_bytes=${input.storedBytes}; observed_bytes=${input.observedBytes}\n\n`;
}

export interface RetainedBodyCopy {
  /** Copy a chunk the caller was handed; past the cap only its size is counted. */
  append(chunk: Uint8Array): void;
  /** Every byte appended so far, kept or not. */
  readonly observedBytes: number;
  /** The copy to store: the first `maxBytes` and, if cut, the truncation marker. */
  result(): { body: Uint8Array; truncated?: { observedBytes: number } };
}

/**
 * Side copy of a streamed answer for retention. The caller's stream is never
 * held back for it: chunks are copied after they are handed over, and at most
 * `maxBytes` are kept. A copy cut at the cap is stored with a coded marker and
 * recorded as truncated, never silently shortened.
 */
export function createRetainedBodyCopy(maxBytes: number): RetainedBodyCopy {
  const parts: Uint8Array[] = [];
  let kept = 0;
  let observed = 0;
  return {
    append(chunk) {
      observed += chunk.byteLength;
      const room = maxBytes - kept;
      if (room <= 0) return;
      const part = chunk.byteLength <= room ? chunk.slice() : chunk.slice(0, room);
      parts.push(part);
      kept += part.byteLength;
    },
    get observedBytes() {
      return observed;
    },
    result() {
      const truncated = observed > kept;
      const marker = truncated ? encoder.encode(retentionTruncationMarker({ storedBytes: kept, observedBytes: observed })) : new Uint8Array(0);
      const body = new Uint8Array(kept + marker.byteLength);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      body.set(marker, offset);
      return truncated ? { body, truncated: { observedBytes: observed } } : { body };
    },
  };
}

export interface RetainExchangeInput {
  requestId: string;
  identity: Pick<GatewayIdentity, "tenantId" | "userId" | "keyId">;
  /** The normalized request body (JSON). */
  request: { body: Uint8Array; contentType: string };
  /**
   * The answer exactly as the caller receives it. `truncated`: a streamed
   * answer cut at the retention cap (createRetainedBodyCopy), with the size
   * the caller actually received.
   */
  response: { status: number; body: Uint8Array; contentType: string; truncated?: { observedBytes: number } };
  ttlMs?: number;
}

export type RetainOutcome =
  | { status: "stored"; truncated?: true }
  | {
      status: "failed";
      code: Extract<GatewayErrorCode, "GATEWAY_RETENTION_FAILED">;
      /** Code of what failed (blob write, metadata write). */
      cause: GatewayErrorCode;
      /** `failed` when the failed row was written, `unrecorded` when even that failed. */
      marker: "failed" | "unrecorded";
      markCause?: GatewayErrorCode;
    };

export function retentionHeaderValue(requestId: string): string {
  return `failed; code=GATEWAY_RETENTION_FAILED; request_id=${requestId}`;
}

/**
 * Store one exchange: both bodies, then the `stored` row. Never throws. On any
 * failure the blobs already written are deleted (no body outlives its
 * metadata, so purge can always find it) and a `failed` row is recorded.
 */
export async function retainGatewayExchange(
  ports: Pick<GatewayPorts, "blobs" | "retention" | "clock" | "logger">,
  input: RetainExchangeInput,
): Promise<RetainOutcome> {
  const keys = gatewayRetentionKeys(input.requestId);
  const storedAt = ports.clock.now();
  const meta = async (
    key: string,
    part: { body: Uint8Array; contentType: string; truncated?: { observedBytes: number } },
  ): Promise<GatewayRetainedBodyMeta> => ({
    key,
    bytes: part.body.byteLength,
    sha256: await sha256Hex(part.body),
    contentType: part.contentType,
    ...(part.truncated ? { truncated: true as const, observedBytes: part.truncated.observedBytes } : {}),
  });
  let cause: GatewayError;
  let base: Omit<GatewayRetentionEntry, "status"> | undefined;
  try {
    base = {
      requestId: input.requestId,
      tenantId: input.identity.tenantId,
      userId: input.identity.userId,
      ...(input.identity.keyId ? { keyId: input.identity.keyId } : {}),
      request: await meta(keys.request, input.request),
      response: await meta(keys.response, input.response),
      responseStatus: input.response.status,
      storedAt,
      expiresAt: storedAt + (input.ttlMs ?? GATEWAY_BODY_RETENTION_MS),
    };
    // Both settle before any cleanup, so a late write can never land after the delete below.
    const writes = await Promise.allSettled([
      ports.blobs.put(keys.request, { body: input.request.body, contentType: input.request.contentType }),
      ports.blobs.put(keys.response, { body: input.response.body, contentType: input.response.contentType }),
    ]);
    const rejected = writes.find((write): write is PromiseRejectedResult => write.status === "rejected");
    if (rejected) throw rejected.reason;
    await ports.retention.record({ ...base, status: "stored" });
    if (!input.response.truncated) return { status: "stored" };
    ports.logger.warn("gateway.retention_truncated", {
      requestId: input.requestId,
      code: "GATEWAY_RETENTION_TRUNCATED",
      storedBytes: base.response.bytes,
      observedBytes: input.response.truncated.observedBytes,
    });
    return { status: "stored", truncated: true };
  } catch (error) {
    cause = toGatewayError(error);
  }
  await Promise.allSettled([ports.blobs.delete(keys.request), ports.blobs.delete(keys.response)]);
  let marker: "failed" | "unrecorded" = "failed";
  let markCause: GatewayErrorCode | undefined;
  try {
    if (!base) throw cause;
    await ports.retention.record({ ...base, status: "failed", errorCode: cause.code });
  } catch (error) {
    marker = "unrecorded";
    markCause = toGatewayError(error).code;
  }
  const code = "GATEWAY_RETENTION_FAILED" as const;
  ports.logger.error("gateway.retention_failed", {
    requestId: input.requestId,
    code,
    cause: cause.code,
    marker,
    markCause,
  });
  return { status: "failed", code, cause: cause.code, marker, ...(markCause ? { markCause } : {}) };
}

export interface RetainedBody extends GatewayRetainedBodyMeta {
  /** The stored bytes, unchanged. */
  body: Uint8Array;
}

export interface RetainedExchange {
  entry: GatewayRetentionEntry;
  request: RetainedBody;
  response: RetainedBody;
}

/**
 * Read one request's bodies. Rejects with GATEWAY_PROMPT_NOT_RETAINED (no row,
 * or storage had failed), GATEWAY_PROMPT_EXPIRED (past `expiresAt`, whether or
 * not purge has run yet) or GATEWAY_RETENTION_FAILED (a stored body is missing
 * or does not match its SHA-256).
 */
export async function readRetainedExchange(
  ports: Pick<GatewayPorts, "blobs" | "retention" | "clock">,
  input: { requestId: string },
): Promise<RetainedExchange> {
  const { requestId } = input;
  const entry = await ports.retention.get({ requestId });
  if (!entry) throw new GatewayError("GATEWAY_PROMPT_NOT_RETAINED", { details: { requestId, retention: "none" } });
  if (entry.status === "purged" || entry.expiresAt <= ports.clock.now())
    throw new GatewayError("GATEWAY_PROMPT_EXPIRED", {
      details: { requestId, expiredAt: new Date(entry.expiresAt).toISOString() },
    });
  if (entry.status === "failed")
    throw new GatewayError("GATEWAY_PROMPT_NOT_RETAINED", {
      details: { requestId, retention: "failed", ...(entry.errorCode ? { errorCode: entry.errorCode } : {}) },
    });
  const read = async (part: "request" | "response"): Promise<RetainedBody> => {
    const meta = entry[part];
    const blob = await ports.blobs.get(meta.key);
    if (!blob) throw new GatewayError("GATEWAY_RETENTION_FAILED", { details: { requestId, part, reason: "missing" } });
    if ((await sha256Hex(blob.body)) !== meta.sha256)
      throw new GatewayError("GATEWAY_RETENTION_FAILED", { details: { requestId, part, reason: "integrity" } });
    return { ...meta, body: blob.body };
  };
  return { entry, request: await read("request"), response: await read("response") };
}

export interface PurgeResult {
  /** Rows purged by this call. */
  purged: number;
  /** Rows whose purge failed; they stay expired (unreadable) and are retried next run. */
  failed: number;
}

/**
 * Delete the bodies of every expired, not yet purged row (up to `limit`, oldest
 * first) and mark it purged. Idempotent: a purged row is never selected again,
 * and deleting an absent blob resolves. Safe to run from a schedule and an
 * admin action concurrently.
 */
export async function purgeExpiredGatewayBodies(
  ports: Pick<GatewayPorts, "blobs" | "retention" | "clock" | "logger">,
  options: { limit?: number } = {},
): Promise<PurgeResult> {
  const now = ports.clock.now();
  const entries = await ports.retention.expired({ before: now, limit: options.limit ?? 200 });
  let purged = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await ports.blobs.delete(entry.request.key);
      await ports.blobs.delete(entry.response.key);
      await ports.retention.markPurged({ requestId: entry.requestId, at: now });
      purged += 1;
    } catch (error) {
      failed += 1;
      ports.logger.warn("gateway.retention_purge_failed", {
        requestId: entry.requestId,
        cause: toGatewayError(error).code,
      });
    }
  }
  if (purged || failed) ports.logger.info("gateway.retention_purged", { purged, failed });
  return { purged, failed };
}
