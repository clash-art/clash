/**
 * Usage explorer facts every adapter shares (#355): the shape of one ledger
 * entry as the explorer shows it, what that entry charged, and the CSV export
 * encoding. Entries are metadata only: ids, money, token counts, versions and
 * codes, never a prompt or response body.
 */
import type { GatewayMediaUnit } from "./usage.js";

/** One ledger entry as the usage explorer and its CSV export present it. */
export interface GatewayUsageEntry {
  /** The ledger row id; unique, the explorer's row key and cursor tiebreak. */
  id: string;
  requestId: string;
  kind: string;
  status: string;
  /** '' for a platform entry (reconciliation adjustments). */
  tenantId: string;
  userId: string | null;
  keyId: string | null;
  budgetId: string;
  amountMicroCredits: number;
  /** Signed usage charge of this entry (ledgerChargeMicroCredits). */
  chargeMicroCredits: number;
  /** A real request settled at zero (isUnchargedSettlement): "not charged", not missing data. */
  notCharged: boolean;
  modelCode: string | null;
  /** `text`, `image`, `video`, `audio`: media/AIGC entries are charged only when completed. */
  modelKind: string | null;
  credentialScope: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  units: Partial<Record<GatewayMediaUnit, number>>;
  usageSource: string | null;
  priceVersion: string | null;
  refKind: string | null;
  refId: string | null;
  /** Operational metadata, NULLed 30 days after `occurredAt`. */
  upstreamId: string | null;
  errorCode: string | null;
  reason: string | null;
  /** ISO 8601. */
  occurredAt: string;
}

/**
 * Sign of each ledger kind in a usage charge. A settlement charges its
 * amount; a refund gives it back. Holds and releases are reservations, and
 * grants, top-ups, expiries and adjustments move the wallet or record a
 * reconciliation, never a request's charge. One table, so a new money kind
 * is added here once.
 */
const CHARGE_SIGN: Partial<Record<string, 1 | -1>> = { settle: 1, refund: -1 };

/**
 * What one ledger entry charged for usage, in signed micro-credits. A failed
 * or partial media/AIGC request settles at zero (settleMediaGeneration), so it
 * shows as a zero charge, never as its hold.
 */
export function ledgerChargeMicroCredits(entry: { kind: string; amountMicroCredits: number }): number {
  const sign = CHARGE_SIGN[entry.kind] ?? 0;
  return sign === 0 ? 0 : sign * entry.amountMicroCredits;
}

/**
 * A settle entry whose outcome was charged nothing although it is a real
 * request: a media failure, a gateway failure, an expiry. The explorer marks
 * these so a zero is read as "not charged", not as missing data.
 */
export function isUnchargedSettlement(entry: { kind: string; status: string; amountMicroCredits: number }): boolean {
  return entry.kind === "settle" && entry.status !== "settled" && entry.amountMicroCredits === 0;
}

export type CsvCell = string | number | boolean | null | undefined;

/**
 * Leading characters a spreadsheet evaluates as a formula (OWASP "CSV
 * Injection"); a text cell starting with one is prefixed with `'`. Numbers
 * are written as numbers, so a negative charge stays numeric.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  const text = FORMULA_PREFIX.test(cell) ? `'${cell}` : cell;
  // RFC 4180: quote a field holding a comma, quote or line break; double inner quotes.
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One RFC 4180 record, CRLF-terminated. */
export function csvRecord(cells: readonly CsvCell[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

type UsageColumn = readonly [name: string, value: (entry: GatewayUsageEntry) => CsvCell];

/** Columns of the usage CSV export, in order; every value is metadata. */
const USAGE_EXPORT_COLUMNS = [
  ["occurred_at", (entry) => entry.occurredAt],
  ["request_id", (entry) => entry.requestId],
  ["kind", (entry) => entry.kind],
  ["status", (entry) => entry.status],
  ["tenant_id", (entry) => entry.tenantId],
  ["user_id", (entry) => entry.userId],
  ["key_id", (entry) => entry.keyId],
  ["model_code", (entry) => entry.modelCode],
  ["model_kind", (entry) => entry.modelKind],
  ["credential_scope", (entry) => entry.credentialScope],
  ["input_tokens", (entry) => entry.inputTokens],
  ["output_tokens", (entry) => entry.outputTokens],
  ["cached_input_tokens", (entry) => entry.cachedInputTokens],
  ["cache_write_tokens", (entry) => entry.cacheWriteTokens],
  ["units", (entry) => (Object.keys(entry.units).length ? JSON.stringify(entry.units) : "")],
  ["usage_source", (entry) => entry.usageSource],
  ["amount_micro_credits", (entry) => entry.amountMicroCredits],
  ["charge_micro_credits", (entry) => entry.chargeMicroCredits],
  ["not_charged", (entry) => entry.notCharged],
  ["price_version", (entry) => entry.priceVersion],
  ["ref_kind", (entry) => entry.refKind],
  ["upstream_id", (entry) => entry.upstreamId],
  ["error_code", (entry) => entry.errorCode],
  ["reason", (entry) => entry.reason],
] as const satisfies readonly UsageColumn[];

/**
 * Who reads an export. A team (`tenant`) sees billing facts only, never the
 * upstream that served a request (gateway-teams.md); the platform sees all.
 */
export type UsageExportAudience = "platform" | "tenant";

const TENANT_HIDDEN_COLUMNS: ReadonlySet<string> = new Set(["upstream_id"]);

export function usageExportColumns(audience: UsageExportAudience): readonly UsageColumn[] {
  return audience === "platform"
    ? USAGE_EXPORT_COLUMNS
    : USAGE_EXPORT_COLUMNS.filter(([name]) => !TENANT_HIDDEN_COLUMNS.has(name));
}

export function usageCsvHeader(audience: UsageExportAudience = "platform"): string {
  return csvRecord(usageExportColumns(audience).map(([name]) => name));
}

export function usageCsvRecord(entry: GatewayUsageEntry, audience: UsageExportAudience = "platform"): string {
  return csvRecord(usageExportColumns(audience).map(([, value]) => value(entry)));
}

/** Rows one export may hold; a larger match is GATEWAY_EXPORT_TOO_LARGE before any byte is sent. */
export const GATEWAY_USAGE_EXPORT_MAX_ROWS = 100_000;
