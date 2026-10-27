/**
 * Nightly usage reconciliation (#355): one UTC day of the ledger against what
 * the upstream itself reported for that day (an invoice export or AI Gateway
 * logs, imported as daily totals per upstream account and model). Each
 * difference is valued at the price book and recorded as a platform `adjust`
 * ledger entry (`tenant_id = ''`, `ref_kind = 'reconcile'`): a record of what
 * the platform metered differently from its upstream, never a charge or
 * credit on a tenant wallet. Settlement semantics are untouched (#399).
 *
 * Idempotent: a group's adjustments for a day add up to its valued difference.
 * A re-run posts only what changed since (`delta - posted`), so repeating a
 * day, or reconciling it again after a corrected report, never double counts.
 *
 * Fails visibly: a day without any upstream report is recorded as
 * `source_missing` (GATEWAY_RECONCILE_SOURCE_MISSING), never as matched; a
 * group the price book cannot value makes the run `incomplete`. A day that
 * has not ended, or whose operational ledger columns (upstream, account) are
 * past their 30-day retention, is GATEWAY_RECONCILE_WINDOW_CLOSED.
 */
import { GatewayError, toGatewayError, type GatewayErrorCode } from "./errors.js";
import type { GatewayClock, GatewayIds, GatewayLogger } from "./ports.js";
import { priceUsage, type GatewayPrice, type MicroCredits } from "./pricing.js";
import { GATEWAY_METADATA_RETENTION_MS, sha256Hex } from "./retention.js";
import type { GatewayMediaUnit, Usage } from "./usage.js";

export const GATEWAY_DAY_MS = 24 * 60 * 60 * 1000;

/** Where an upstream usage report came from. */
export const GATEWAY_RECONCILE_SOURCES = ["invoice", "ai_gateway"] as const;
export type GatewayReconcileSource = (typeof GATEWAY_RECONCILE_SOURCES)[number];

/** Preferred source when both were imported for a day: the invoice is what the platform pays. */
const SOURCE_PREFERENCE: readonly GatewayReconcileSource[] = ["invoice", "ai_gateway"];

export const GATEWAY_RECONCILE_REF_KIND = "reconcile";

/** Counted usage of one group over one day. */
export interface ReconcileUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  units: Partial<Record<GatewayMediaUnit, number>>;
}

/** What is compared: one official upstream account serving one public model code. */
export interface ReconcileGroup {
  upstreamId: string;
  accountId: string;
  modelCode: string;
}

export interface LedgerUsageGroup extends ReconcileGroup {
  usage: ReconcileUsage;
  /** What the ledger charged for these requests (one settle entry per request). */
  chargedMicroCredits: MicroCredits;
}

export interface UpstreamUsageGroup extends ReconcileGroup {
  usage: ReconcileUsage;
}

export interface ReconcileDiff extends ReconcileGroup {
  /** Stable hash of the group; part of each adjustment's request id. */
  groupKey: string;
  ledger: ReconcileUsage;
  upstream: ReconcileUsage;
  ledgerChargedMicroCredits: MicroCredits;
  /** Price version the difference was valued at; null when none applied. */
  priceVersion: string | null;
  /** Upstream value minus ledger value at the price book, signed; null when unpriced. */
  deltaMicroCredits: number | null;
  /** Signed sum of the adjustments earlier runs posted for this group and day. */
  postedMicroCredits: number;
  /** Signed amount this run posts: delta − posted (0: nothing). */
  adjustMicroCredits: number;
  /** Request id of this run's adjustment, when it posts one. */
  adjustRequestId?: string;
  errorCode?: GatewayErrorCode;
}

/**
 * `matched`: every group's usage equals the upstream's and nothing is posted.
 * `adjusted`: some group differs; its adjustments (this run's or an earlier
 * one's) carry the valued difference. `incomplete`: some group could not be
 * valued. `source_missing`: no upstream report for the day.
 */
export type ReconcileRunStatus = "matched" | "adjusted" | "incomplete" | "source_missing";

export interface ReconcileActor {
  kind: "admin" | "system";
  id: string;
}

export interface ReconcileRun {
  id: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  source: GatewayReconcileSource | null;
  status: ReconcileRunStatus;
  errorCode?: GatewayErrorCode;
  diffs: ReconcileDiff[];
  actor: ReconcileActor;
  /** Epoch ms. */
  startedAt: number;
}

export interface ReconcileRunResult extends ReconcileRun {
  /** Adjustments this run actually wrote (a concurrent run of the same day may have written them first). */
  posted: number;
}

/** One posted reconciliation adjustment, as the ledger holds it. */
export interface PostedAdjustment {
  requestId: string;
  /** Signed: positive when the upstream reported more than the ledger. */
  signedMicroCredits: number;
}

export interface GatewayReconciliationPort {
  /** Official-scope settled requests in `[from, to)` (epoch ms), one per request, grouped. */
  ledgerUsage(input: { from: number; to: number }): Promise<LedgerUsageGroup[]>;
  /** Imported upstream usage for the day, per source. */
  upstreamUsage(input: { day: string }): Promise<Array<{ source: GatewayReconcileSource; groups: UpstreamUsageGroup[] }>>;
  /** The published price for a model and upstream at `at`; rejects GATEWAY_PRICE_UNAVAILABLE. */
  price(input: { modelCode: string; upstreamId: string; at: number }): Promise<GatewayPrice>;
  /** Every reconciliation adjustment already posted for the day. */
  posted(input: { day: string }): Promise<PostedAdjustment[]>;
  /**
   * In one transaction: the run row and each diff's adjustment, an adjustment
   * written only while its group's posted sum still equals
   * `postedMicroCredits` (so two concurrent runs never both post it).
   * Answers how many adjustments were written.
   */
  record(run: ReconcileRun): Promise<{ posted: number }>;
  /** Days on or after `from`, before `before`, whose report changed since their last run (or never ran). */
  pendingDays(input: { from: string; before: string }): Promise<string[]>;
}

export interface GatewayReconcilePorts {
  reconciliation: GatewayReconciliationPort;
  /** Mints each run's id (`requestId()`): a reconciliation run is one request of the job. */
  ids: GatewayIds;
  clock: GatewayClock;
  logger: GatewayLogger;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC day containing `ms`, as `YYYY-MM-DD`. */
export function gatewayUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `[from, to)` epoch ms of a UTC day; rejects anything but a real `YYYY-MM-DD`. */
export function gatewayDayWindow(day: string): { from: number; to: number } {
  const match = DAY_PATTERN.exec(day);
  const from = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  if (!Number.isFinite(from) || gatewayUtcDay(from) !== day)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: "day" } });
  return { from, to: from + GATEWAY_DAY_MS };
}

export function emptyReconcileUsage(): ReconcileUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, units: {} };
}

function sameUsage(a: ReconcileUsage, b: ReconcileUsage): boolean {
  if (
    a.requests !== b.requests ||
    a.inputTokens !== b.inputTokens ||
    a.outputTokens !== b.outputTokens ||
    a.cachedInputTokens !== b.cachedInputTokens ||
    a.cacheWriteTokens !== b.cacheWriteTokens
  )
    return false;
  const units = new Set([...Object.keys(a.units), ...Object.keys(b.units)]) as Set<GatewayMediaUnit>;
  for (const unit of units) if ((a.units[unit] ?? 0) !== (b.units[unit] ?? 0)) return false;
  return true;
}

/** Tokens and media units as pricing sees them; requests are compared, not priced. */
function pricedUsage(usage: ReconcileUsage): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    units: Object.fromEntries(Object.entries(usage.units).filter(([unit]) => unit !== "request")),
    source: "reported",
  };
}

const groupId = (group: ReconcileGroup) => JSON.stringify([group.upstreamId, group.accountId, group.modelCode]);

export async function reconcileGroupKey(group: ReconcileGroup): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(groupId(group)))).slice(0, 24);
}

/** `reconcile:<day>:<groupKey>:<sequence>`: one id per posted adjustment, unique in the ledger. */
export function reconcileAdjustRequestId(day: string, groupKey: string, sequence: number): string {
  return `${GATEWAY_RECONCILE_REF_KIND}:${day}:${groupKey}:${sequence}`;
}

/**
 * Ledger amounts are unsigned (CHECK amount >= 0), so an adjustment's
 * direction is its status: `upstream_over` when the upstream reported more
 * than the ledger metered, `upstream_under` when less.
 */
export const GATEWAY_RECONCILE_ADJUST_STATUSES = ["upstream_over", "upstream_under"] as const;
export type GatewayReconcileAdjustStatus = (typeof GATEWAY_RECONCILE_ADJUST_STATUSES)[number];

export function reconcileAdjustEntry(signedMicroCredits: number): {
  status: GatewayReconcileAdjustStatus;
  amountMicroCredits: number;
} {
  return {
    status: signedMicroCredits >= 0 ? "upstream_over" : "upstream_under",
    amountMicroCredits: Math.abs(signedMicroCredits),
  };
}

/** The signed amount of a stored adjustment; an unknown status counts as nothing. */
export function signedReconcileAmount(entry: { status: string; amountMicroCredits: number }): number {
  if (entry.status === "upstream_over") return entry.amountMicroCredits;
  if (entry.status === "upstream_under") return -entry.amountMicroCredits;
  return 0;
}

/**
 * When the nightly job runs: the scheduled minute at 01:15 UTC, an hour and a
 * quarter after the day ends so late settlements of the previous day have
 * landed. A missed night is caught up by `pendingDays` the next night.
 */
export const GATEWAY_RECONCILE_UTC_MINUTE_OF_DAY = 75;

/** Whether a scheduled invocation at `ms` is the nightly reconciliation's. */
export function isNightlyReconcileDue(ms: number): boolean {
  const minuteOfDay = Math.floor((ms % GATEWAY_DAY_MS) / 60_000);
  return minuteOfDay === GATEWAY_RECONCILE_UTC_MINUTE_OF_DAY;
}

/** The day and group of a reconciliation adjustment's request id, or null. */
export function parseReconcileAdjustRequestId(requestId: string): { day: string; groupKey: string; sequence: number } | null {
  const match = /^reconcile:(\d{4}-\d{2}-\d{2}):([0-9a-f]{24}):(\d+)$/.exec(requestId);
  return match ? { day: match[1]!, groupKey: match[2]!, sequence: Number(match[3]) } : null;
}

/** The window a day may be reconciled in: ended, and its operational ledger columns still present. */
export function assertReconcilableDay(day: string, now: number): { from: number; to: number } {
  const window = gatewayDayWindow(day);
  if (window.to > now) throw new GatewayError("GATEWAY_RECONCILE_WINDOW_CLOSED", { details: { day, reason: "not_ended" } });
  if (window.from < now - GATEWAY_METADATA_RETENTION_MS)
    throw new GatewayError("GATEWAY_RECONCILE_WINDOW_CLOSED", { details: { day, reason: "metadata_expired" } });
  return window;
}

/**
 * Reconcile one UTC day: compare, value, and record the run and its
 * adjustments in one transaction. A missing report is recorded, not thrown.
 */
export async function reconcileGatewayUsageDay(
  ports: GatewayReconcilePorts,
  input: { day: string; source?: GatewayReconcileSource; actor?: ReconcileActor },
): Promise<ReconcileRunResult> {
  const startedAt = ports.clock.now();
  const window = assertReconcilableDay(input.day, startedAt);
  const port = ports.reconciliation;
  const base = {
    id: ports.ids.requestId(),
    day: input.day,
    actor: input.actor ?? { kind: "system" as const, id: "nightly" },
    startedAt,
  };
  const reports = await port.upstreamUsage({ day: input.day });
  const report = input.source
    ? reports.find((entry) => entry.source === input.source)
    : SOURCE_PREFERENCE.map((source) => reports.find((entry) => entry.source === source)).find(Boolean);
  if (!report) {
    const run: ReconcileRun = {
      ...base,
      source: input.source ?? null,
      status: "source_missing",
      errorCode: "GATEWAY_RECONCILE_SOURCE_MISSING",
      diffs: [],
    };
    await port.record(run);
    ports.logger.warn("gateway.reconcile_source_missing", { day: input.day, runId: run.id, code: run.errorCode });
    return { ...run, posted: 0 };
  }

  const [ledger, posted] = await Promise.all([port.ledgerUsage(window), port.posted({ day: input.day })]);
  const groups = new Map<string, { group: ReconcileGroup; ledger?: LedgerUsageGroup; upstream?: UpstreamUsageGroup }>();
  for (const entry of ledger) groups.set(groupId(entry), { group: entry, ledger: entry });
  for (const entry of report.groups) {
    const existing = groups.get(groupId(entry));
    groups.set(groupId(entry), { group: entry, ...existing, upstream: entry });
  }
  const postedByGroup = new Map<string, { sum: number; count: number }>();
  for (const adjustment of posted) {
    const parsed = parseReconcileAdjustRequestId(adjustment.requestId);
    if (!parsed || parsed.day !== input.day) continue;
    const current = postedByGroup.get(parsed.groupKey) ?? { sum: 0, count: 0 };
    postedByGroup.set(parsed.groupKey, {
      sum: current.sum + adjustment.signedMicroCredits,
      count: Math.max(current.count, parsed.sequence),
    });
  }

  const diffs: ReconcileDiff[] = [];
  for (const { group, ledger: ledgerGroup, upstream } of [...groups.values()].sort((a, b) =>
    groupId(a.group).localeCompare(groupId(b.group)),
  )) {
    const groupKey = await reconcileGroupKey(group);
    const ledgerUsage = ledgerGroup?.usage ?? emptyReconcileUsage();
    const upstreamUsage = upstream?.usage ?? emptyReconcileUsage();
    const prior = postedByGroup.get(groupKey) ?? { sum: 0, count: 0 };
    let priceVersion: string | null = null;
    let deltaMicroCredits: number | null = 0;
    let errorCode: GatewayErrorCode | undefined;
    if (!sameUsage(ledgerUsage, upstreamUsage)) {
      try {
        const price = await port.price({ modelCode: group.modelCode, upstreamId: group.upstreamId, at: window.to - 1 });
        priceVersion = price.version;
        deltaMicroCredits =
          priceUsage(pricedUsage(upstreamUsage), price).microCredits - priceUsage(pricedUsage(ledgerUsage), price).microCredits;
      } catch (error) {
        deltaMicroCredits = null;
        errorCode = toGatewayError(error).code;
      }
    }
    // An unpriced group posts nothing; a matching group reverses anything posted before.
    const adjustMicroCredits = deltaMicroCredits === null ? 0 : deltaMicroCredits - prior.sum;
    diffs.push({
      upstreamId: group.upstreamId,
      accountId: group.accountId,
      modelCode: group.modelCode,
      groupKey,
      ledger: ledgerUsage,
      upstream: upstreamUsage,
      ledgerChargedMicroCredits: ledgerGroup?.chargedMicroCredits ?? 0,
      priceVersion,
      deltaMicroCredits,
      postedMicroCredits: prior.sum,
      adjustMicroCredits,
      ...(adjustMicroCredits !== 0 ? { adjustRequestId: reconcileAdjustRequestId(input.day, groupKey, prior.count + 1) } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  const status: ReconcileRunStatus = diffs.some((diff) => diff.errorCode)
    ? "incomplete"
    : diffs.some((diff) => !sameUsage(diff.ledger, diff.upstream) || diff.adjustMicroCredits !== 0)
      ? "adjusted"
      : "matched";
  const run: ReconcileRun = { ...base, source: report.source, status, diffs };
  const { posted: written } = await port.record(run);
  const intended = diffs.filter((diff) => diff.adjustRequestId).length;
  if (written !== intended)
    ports.logger.warn("gateway.reconcile_raced", { day: input.day, runId: run.id, intended, written });
  ports.logger.info("gateway.reconciled", {
    day: input.day,
    runId: run.id,
    source: report.source,
    status,
    groups: diffs.length,
    posted: written,
  });
  return { ...run, posted: written };
}

export interface NightlyReconcileResult {
  runs: Array<{ day: string; runId: string; status: ReconcileRunStatus; posted: number }>;
  failed: number;
}

/**
 * The nightly job: yesterday (UTC), plus every earlier day still inside the
 * metadata window whose upstream report was imported or replaced after its
 * last run. Each day is its own transaction; one failing day never stops the
 * others.
 */
export async function reconcileGatewayUsage(ports: GatewayReconcilePorts): Promise<NightlyReconcileResult> {
  const now = ports.clock.now();
  const today = gatewayUtcDay(now);
  const yesterday = gatewayUtcDay(now - GATEWAY_DAY_MS);
  // The oldest day whose start is still inside the metadata window.
  const oldest = gatewayUtcDay(now - GATEWAY_METADATA_RETENTION_MS + GATEWAY_DAY_MS);
  const days = [...new Set([yesterday, ...(await ports.reconciliation.pendingDays({ from: oldest, before: today }))])].sort();
  const result: NightlyReconcileResult = { runs: [], failed: 0 };
  for (const day of days) {
    try {
      const run = await reconcileGatewayUsageDay(ports, { day });
      result.runs.push({ day, runId: run.id, status: run.status, posted: run.posted });
    } catch (error) {
      result.failed += 1;
      ports.logger.error("gateway.reconcile_failed", { day, cause: toGatewayError(error).code });
    }
  }
  return result;
}
