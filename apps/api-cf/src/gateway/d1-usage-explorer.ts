/**
 * Usage explorer over D1 `gateway_usage_ledger` (#355; guide:
 * apps/docs/guide/gateway-usage.md): filtered, cursor-paged ledger entries
 * with per-model totals, and the same filter as a streamed CSV export.
 * Platform reads come from admin accounts (`usage.read_all`); team reads are
 * pinned to one tenant by the route (`usage.read`, or `usage.read_own` with
 * the caller's own user id) and never carry the upstream.
 *
 * A request settles once per budget it held on (d1-budgets.ts), with the same
 * amount on each row; the explorer shows one settle entry per request (the
 * row on the lowest budget id, as the ledger port does), so totals never
 * double count. Metadata only: no prompt or response body is read here.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GATEWAY_USAGE_EXPORT_MAX_ROWS,
  GatewayError,
  isUnchargedSettlement,
  ledgerChargeMicroCredits,
  usageCsvHeader,
  usageCsvRecord,
  type GatewayMediaUnit,
  type GatewayUsageEntry,
  type UsageExportAudience,
} from "@clash/gateway-core";

import { numberRecord, toMs, toSeconds } from "./d1-common";

export interface UsageExplorerFilter {
  tenantId?: string;
  userId?: string;
  keyId?: string;
  modelCode?: string;
  /** A ledger kind; without one, every kind but holds and releases. */
  kind?: string;
  /** The entry's status (`settled`, `upstream_failed`, ...). */
  status?: string;
  /** Epoch ms bounds, inclusive from, exclusive to. */
  from?: number;
  to?: number;
}

export interface UsageExplorerPage {
  entries: GatewayUsageEntry[];
  byModel: Array<{
    modelCode: string;
    requests: number;
    amountMicroCredits: number;
    inputTokens: number;
    outputTokens: number;
    /** Requests settled at zero (failed or not completed): visible, never charged. */
    notCharged: number;
  }>;
  /** Opaque; pass back as `cursor` for the next, older page. Null on the last page. */
  nextCursor: string | null;
}

interface LedgerRow {
  id: string;
  request_id: string;
  kind: string;
  status: string;
  tenant_id: string;
  user_id: string | null;
  key_id: string | null;
  budget_id: string;
  amount_micro_credits: number;
  model_code: string | null;
  model_kind: string | null;
  credential_scope: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  units_json: string;
  usage_source: string | null;
  price_version: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  upstream_id: string | null;
  error_code: string | null;
  reason: string | null;
  occurred_at: number;
}

const COLUMNS = `l.id, l.request_id, l.kind, l.status, l.tenant_id, l.user_id, l.key_id, l.budget_id,
  l.amount_micro_credits, l.model_code, l.model_kind, l.credential_scope, l.input_tokens, l.output_tokens,
  l.cached_input_tokens, l.cache_write_tokens, l.units_json, l.usage_source, l.price_version,
  l.ref_kind, l.ref_id, l.upstream_id, l.error_code, l.reason, l.occurred_at`;

/** One settle entry per request (the lowest budget id), as GatewayLedgerPort.query reads them. */
const ONE_SETTLE_PER_REQUEST = `(l.kind <> 'settle' OR l.budget_id = (SELECT MIN(s.budget_id) FROM gateway_usage_ledger s
  WHERE s.request_id = l.request_id AND s.kind = 'settle'))`;

const WHERE = `(?1 IS NULL OR l.tenant_id = ?1) AND (?2 IS NULL OR l.user_id = ?2) AND (?3 IS NULL OR l.key_id = ?3)
  AND (?4 IS NULL OR l.model_code = ?4)
  AND (CASE WHEN ?5 IS NULL THEN l.kind NOT IN ('hold', 'release') ELSE l.kind = ?5 END)
  AND (?6 IS NULL OR l.status = ?6) AND (?7 IS NULL OR l.occurred_at >= ?7) AND (?8 IS NULL OR l.occurred_at < ?8)
  AND ${ONE_SETTLE_PER_REQUEST}`;

/** Keyset position: newest first by (occurred_at, id). */
interface Cursor {
  at: number;
  id: string;
}

export function encodeUsageCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.at, cursor.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The cursor a page handed out; anything else is GATEWAY_INVALID_REQUEST. */
export function decodeUsageCursor(value: string): Cursor {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as unknown;
    if (Array.isArray(parsed) && Number.isInteger(parsed[0]) && typeof parsed[1] === "string" && parsed[1])
      return { at: parsed[0] as number, id: parsed[1] };
  } catch {
    // Falls through to the coded refusal.
  }
  throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: "cursor" } });
}

function binds(filter: UsageExplorerFilter) {
  return [
    filter.tenantId ?? null,
    filter.userId ?? null,
    filter.keyId ?? null,
    filter.modelCode ?? null,
    filter.kind ?? null,
    filter.status ?? null,
    filter.from !== undefined ? toSeconds(filter.from) : null,
    // Exclusive upper bound in whole seconds: a bound inside a second keeps that second.
    filter.to !== undefined ? Math.ceil(filter.to / 1000) : null,
  ];
}

function entryView(row: LedgerRow): GatewayUsageEntry {
  const entry = { kind: row.kind, status: row.status, amountMicroCredits: row.amount_micro_credits };
  return {
    id: row.id,
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    tenantId: row.tenant_id,
    userId: row.user_id,
    keyId: row.key_id,
    budgetId: row.budget_id,
    amountMicroCredits: row.amount_micro_credits,
    chargeMicroCredits: ledgerChargeMicroCredits(entry),
    notCharged: isUnchargedSettlement(entry),
    modelCode: row.model_code,
    modelKind: row.model_kind,
    credentialScope: row.credential_scope,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    units: (numberRecord(row.units_json) ?? {}) as Partial<Record<GatewayMediaUnit, number>>,
    usageSource: row.usage_source,
    priceVersion: row.price_version,
    refKind: row.ref_kind,
    refId: row.ref_id,
    upstreamId: row.upstream_id,
    errorCode: row.error_code,
    reason: row.reason,
    occurredAt: new Date(toMs(row.occurred_at)).toISOString(),
  };
}

/** Rows read per page of an export stream. */
const EXPORT_PAGE = 1000;

export function createD1UsageExplorer(db: D1Database) {
  function page(filter: UsageExplorerFilter, input: { limit: number; cursor?: Cursor }) {
    return db
      .prepare(
        `SELECT ${COLUMNS} FROM gateway_usage_ledger l
          WHERE ${WHERE} AND (?9 IS NULL OR l.occurred_at < ?9 OR (l.occurred_at = ?9 AND l.id < ?10))
          ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?11`,
      )
      .bind(...binds(filter), input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit);
  }

  return {
    /** Entries newest first, `limit` per page, with per-model settle totals for the whole filter. */
    async list(filter: UsageExplorerFilter, input: { limit: number; cursor?: string }): Promise<UsageExplorerPage> {
      const cursor = input.cursor ? decodeUsageCursor(input.cursor) : undefined;
      const [entries, summary] = await db.batch([
        page(filter, { limit: input.limit + 1, ...(cursor ? { cursor } : {}) }),
        db
          .prepare(
            `SELECT COALESCE(l.model_code, '') AS model_code, COUNT(*) AS requests,
                    SUM(l.amount_micro_credits) AS amount, SUM(l.input_tokens) AS input_tokens,
                    SUM(l.output_tokens) AS output_tokens,
                    SUM(CASE WHEN l.status <> 'settled' AND l.amount_micro_credits = 0 THEN 1 ELSE 0 END) AS not_charged
               FROM gateway_usage_ledger l
              WHERE ${WHERE} AND l.kind = 'settle'
              GROUP BY l.model_code ORDER BY amount DESC, requests DESC LIMIT 50`,
          )
          .bind(...binds(filter)),
      ]);
      const rows = (entries?.results ?? []) as LedgerRow[];
      const shown = rows.slice(0, input.limit);
      const last = shown.at(-1);
      return {
        entries: shown.map(entryView),
        byModel: (
          (summary?.results ?? []) as Array<{
            model_code: string;
            requests: number;
            amount: number | null;
            input_tokens: number | null;
            output_tokens: number | null;
            not_charged: number | null;
          }>
        ).map((row) => ({
          modelCode: row.model_code,
          requests: row.requests,
          amountMicroCredits: row.amount ?? 0,
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          notCharged: row.not_charged ?? 0,
        })),
        nextCursor: rows.length > input.limit && last ? encodeUsageCursor({ at: last.occurred_at, id: last.id }) : null,
      };
    },

    /**
     * The filter as RFC 4180 CSV, newest first, streamed page by page. A
     * match larger than one export may hold is GATEWAY_EXPORT_TOO_LARGE
     * before any byte is sent; `audience: "tenant"` drops platform columns.
     */
    async exportCsv(
      filter: UsageExplorerFilter,
      audience: UsageExportAudience,
    ): Promise<{ rows: number; body: ReadableStream<Uint8Array> }> {
      const counted = await db
        .prepare(`SELECT COUNT(*) AS n FROM gateway_usage_ledger l WHERE ${WHERE}`)
        .bind(...binds(filter))
        .first<{ n: number }>();
      const rows = counted?.n ?? 0;
      if (rows > GATEWAY_USAGE_EXPORT_MAX_ROWS)
        throw new GatewayError("GATEWAY_EXPORT_TOO_LARGE", { details: { rows, maxRows: GATEWAY_USAGE_EXPORT_MAX_ROWS } });
      const encoder = new TextEncoder();
      let cursor: Cursor | undefined;
      let header = true;
      let done = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (header) {
            header = false;
            controller.enqueue(encoder.encode(usageCsvHeader(audience)));
            return;
          }
          if (done) {
            controller.close();
            return;
          }
          const { results } = await page(filter, { limit: EXPORT_PAGE, ...(cursor ? { cursor } : {}) }).all<LedgerRow>();
          const last = results.at(-1);
          if (results.length < EXPORT_PAGE || !last) done = true;
          if (last) cursor = { at: last.occurred_at, id: last.id };
          if (results.length)
            controller.enqueue(encoder.encode(results.map((row) => usageCsvRecord(entryView(row), audience)).join("")));
        },
      });
      return { rows, body };
    },
  };
}

/**
 * The explorer filter of a validated usage query (ISO instants): tenant,
 * user, key, model, kind, status, time. A `to` not after `from` is refused.
 */
export function usageFilterOf(query: {
  tenantId?: string | undefined;
  userId?: string | undefined;
  keyId?: string | undefined;
  modelCode?: string | undefined;
  kind?: string | undefined;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): UsageExplorerFilter {
  const from = query.from === undefined ? undefined : Date.parse(query.from);
  const to = query.to === undefined ? undefined : Date.parse(query.to);
  if (from !== undefined && to !== undefined && to <= from)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: "to", reason: "not_after_from" } });
  return {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.keyId ? { keyId: query.keyId } : {}),
    ...(query.modelCode ? { modelCode: query.modelCode } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/** `Content-Disposition` file name of an export: `gateway-usage[-<scope>]-<from>-<to>.csv`, ASCII only. */
export function usageExportFileName(input: { scope?: string; from?: number; to?: number }): string {
  const day = (ms: number | undefined) => (ms === undefined ? "all" : new Date(ms).toISOString().slice(0, 10));
  const scope = input.scope ? `-${input.scope.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64)}` : "";
  return `gateway-usage${scope}-${day(input.from)}-${day(input.to)}.csv`;
}

/** The CSV download response; never cached. */
export function usageCsvResponse(input: { body: ReadableStream<Uint8Array>; rows: number; fileName: string }): Response {
  return new Response(input.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${input.fileName}"`,
      "cache-control": "no-store",
      "x-gateway-export-rows": String(input.rows),
    },
  });
}
