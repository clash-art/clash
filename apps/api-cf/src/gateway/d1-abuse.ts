/**
 * D1 abuse port (#356; guide: apps/docs/guide/gateway-admin.md#abuse, tables:
 * 0046). Implements gateway-core's GatewayAbusePort:
 *
 * - observations: one counter row per kind, tenant, key, client fingerprint
 *   and minute (`gateway_abuse_observation`, an upsert per request);
 * - signals: `spend` from the usage ledger (one settle row per request),
 *   the rest from the observations;
 * - thresholds, alerts and suspensions, each mutation with its
 *   `gateway_admin_audit` row in the same D1 batch.
 *
 * D1 columns are unix seconds; the port speaks epoch milliseconds.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  evaluateGatewayAbuse,
  GATEWAY_ABUSE_SIGNALS,
  GatewayAbuseThresholdSchema,
  GatewayError,
  type AbuseEvaluation,
  type GatewayAbuseActor,
  type GatewayAbuseObservation,
  type GatewayAbusePort,
  type GatewayAbuseSignal,
  type GatewayAbuseSubjectKind,
  type GatewayAbuseThresholds,
  type GatewayClock,
  type GatewayLogger,
  type GatewaySuspension,
  type GatewaySuspensionSubject,
} from "@clash/gateway-core";

import type { Env } from "../config";
import { gatewayAbuseKeySql } from "../services/gateway-tokens";
import { adminAuditStatement } from "./d1-admin-audit";
import { ONE_SETTLE_PER_REQUEST } from "./d1-budgets";
import { monotonicClock, toMs, toSeconds } from "./d1-common";
import { workersLogger } from "./workers-logger";

const minuteStart = (ms: number) => Math.floor(toSeconds(ms) / 60) * 60;
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

interface SuspensionRow {
  id: string;
  subject_kind: GatewaySuspensionSubject;
  subject_id: string;
  tenant_id: string;
  source: GatewaySuspension["source"];
  signal: GatewayAbuseSignal | null;
  reason: string;
  actor_kind: GatewayAbuseActor["kind"];
  actor_id: string;
  created_at: number;
  lifted_at: number | null;
  lifted_by: string | null;
  lift_reason: string | null;
}

export const toSuspension = (row: SuspensionRow): GatewaySuspension => ({
  id: row.id,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  tenantId: row.tenant_id,
  source: row.source,
  signal: row.signal,
  reason: row.reason,
  actorKind: row.actor_kind,
  actorId: row.actor_id,
  createdAt: toMs(row.created_at),
  liftedAt: row.lifted_at === null ? null : toMs(row.lifted_at),
  liftedBy: row.lifted_by,
  liftReason: row.lift_reason,
});

const SUSPENSION_COLUMNS = `id, subject_kind, subject_id, tenant_id, source, signal, reason, actor_kind, actor_id,
  created_at, lifted_at, lifted_by, lift_reason`;

/** The audit target of a suspended subject: a tenant, or a key (virtual key, `clsh_` parent or gateway token id). */
const auditTarget = (kind: GatewaySuspensionSubject) => (kind === "tenant" ? "tenant" : "gateway_key");

interface MeasureRow {
  subject_kind: GatewayAbuseSubjectKind;
  subject_id: string;
  tenant_id: string;
  value: number;
}

/** Per signal: subject kind, subject id, tenant ('' unknown) and value, over `?1` (unix seconds) onward. */
const MEASURE_SQL: Record<GatewayAbuseSignal, string> = {
  spend: `SELECT 'tenant' AS subject_kind, l.tenant_id AS subject_id, l.tenant_id, SUM(l.amount_micro_credits) AS value
            FROM gateway_usage_ledger l
           WHERE l.kind = 'settle' AND l.occurred_at >= ?1 AND ${ONE_SETTLE_PER_REQUEST}
           GROUP BY l.tenant_id`,
  auth_failures: `SELECT CASE WHEN tenant_id = '' THEN 'client' ELSE 'tenant' END AS subject_kind,
                         CASE WHEN tenant_id = '' THEN fingerprint ELSE tenant_id END AS subject_id,
                         tenant_id, SUM(count) AS value
                    FROM gateway_abuse_observation
                   WHERE kind = 'auth_failure' AND window_start >= ?1
                   GROUP BY 1, 2, 3`,
  velocity: `SELECT 'key' AS subject_kind, key_id AS subject_id, tenant_id, SUM(count) AS value
               FROM gateway_abuse_observation
              WHERE kind = 'request' AND key_id <> '' AND window_start >= ?1
              GROUP BY key_id, tenant_id`,
  shared_key: `SELECT 'key' AS subject_kind, key_id AS subject_id, tenant_id, COUNT(DISTINCT fingerprint) AS value
                 FROM gateway_abuse_observation
                WHERE kind = 'request' AND key_id <> '' AND window_start >= ?1
                GROUP BY key_id, tenant_id`,
};

export function createD1GatewayAbusePort(db: D1Database): GatewayAbusePort {
  const suspensionById = async (id: string) => {
    const row = await db
      .prepare(`SELECT ${SUSPENSION_COLUMNS} FROM gateway_suspension WHERE id = ?`)
      .bind(id)
      .first<SuspensionRow>();
    return row ? toSuspension(row) : null;
  };

  /** Configured thresholds; a row that no longer parses is ignored (shown, never acted on). */
  const thresholds = async (): Promise<GatewayAbuseThresholds> => {
    const { results } = await db
      .prepare(`SELECT signal, window_minutes, alert_at, suspend_at FROM gateway_abuse_threshold`)
      .all<{ signal: string; window_minutes: number; alert_at: number; suspend_at: number | null }>();
    const configured: GatewayAbuseThresholds = {};
    for (const row of results) {
      if (!(GATEWAY_ABUSE_SIGNALS as readonly string[]).includes(row.signal)) continue;
      const parsed = GatewayAbuseThresholdSchema.safeParse({
        windowMinutes: row.window_minutes,
        alertAt: row.alert_at,
        suspendAt: row.suspend_at,
      });
      if (parsed.success) configured[row.signal as GatewayAbuseSignal] = parsed.data;
    }
    return configured;
  };

  /**
   * Insert a suspension unless the subject has an active one, and its audit
   * row only when the insert happened (both in the caller's batch).
   */
  const suspensionStatements = (input: {
    id: string;
    subjectKind: GatewaySuspensionSubject;
    subjectId: string;
    tenantId: string;
    source: GatewaySuspension["source"];
    signal: GatewayAbuseSignal | null;
    reason: string;
    actor: GatewayAbuseActor;
    nowS: number;
    after?: Record<string, unknown>;
    when?: string;
  }): D1PreparedStatement[] => [
    db
      .prepare(
        `INSERT INTO gateway_suspension (${SUSPENSION_COLUMNS})
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL
          WHERE ${input.when ?? "1"}
            AND NOT EXISTS (SELECT 1 FROM gateway_suspension
                             WHERE subject_kind = ?2 AND subject_id = ?3 AND lifted_at IS NULL)`,
      )
      .bind(
        input.id,
        input.subjectKind,
        input.subjectId,
        input.tenantId,
        input.source,
        input.signal,
        input.reason,
        input.actor.kind,
        input.actor.id,
        input.nowS,
      ),
    adminAuditStatement(db, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: "abuse.suspend",
      targetType: auditTarget(input.subjectKind),
      targetId: input.subjectId,
      after: { suspensionId: input.id, source: input.source, signal: input.signal, ...input.after },
      reason: input.reason,
      nowS: input.nowS,
      // The id is generated here (`gws_` + hex), never caller input.
      when: `EXISTS (SELECT 1 FROM gateway_suspension WHERE id = '${input.id}')`,
    }),
  ];

  return {
    async activeSuspension({ tenantId, keyIds }) {
      const row = await db
        .prepare(
          `SELECT ${SUSPENSION_COLUMNS} FROM gateway_suspension
            WHERE lifted_at IS NULL
              AND ((subject_kind = 'tenant' AND subject_id = ?1)
                OR (subject_kind = 'key' AND subject_id IN (SELECT value FROM json_each(?2))))
            ORDER BY created_at LIMIT 1`,
        )
        .bind(tenantId, JSON.stringify(keyIds))
        .first<SuspensionRow>();
      return row ? toSuspension(row) : null;
    },

    async observe(event) {
      const windowStart = minuteStart(event.at);
      if (event.kind === "request") {
        await db
          .prepare(
            `INSERT INTO gateway_abuse_observation (kind, tenant_id, key_id, fingerprint, window_start, count)
             VALUES ('request', ?1, ?2, ?3, ?4, 1)
             ON CONFLICT (kind, tenant_id, key_id, fingerprint, window_start) DO UPDATE SET count = count + 1`,
          )
          .bind(event.tenantId ?? "", event.keyId ?? "", event.fingerprint, windowStart)
          .run();
        return;
      }
      // A refused credential the identity port named (a revoked or expired
      // token): counted against its tenant and key, as the token row says.
      await db
        .prepare(
          `INSERT INTO gateway_abuse_observation (kind, tenant_id, key_id, fingerprint, window_start, count)
           SELECT 'auth_failure', COALESCE(t.tenant_id, ''), COALESCE(${gatewayAbuseKeySql("t")}, ''), ?2, ?3, 1
             FROM (SELECT 1) LEFT JOIN gateway_token t ON t.id = ?1
            WHERE 1
           ON CONFLICT (kind, tenant_id, key_id, fingerprint, window_start) DO UPDATE SET count = count + 1`,
        )
        .bind(event.keyId ?? null, event.fingerprint, windowStart)
        .run();
    },

    async measure({ signal, since, atLeast, limit }) {
      const { results } = await db
        .prepare(`SELECT * FROM (${MEASURE_SQL[signal]}) WHERE value >= ?2 ORDER BY value DESC, subject_id LIMIT ?3`)
        .bind(signal === "spend" ? toSeconds(since) : minuteStart(since), atLeast, limit)
        .all<MeasureRow>();
      return results.map(
        (row): GatewayAbuseObservation => ({
          signal,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          tenantId: row.subject_kind === "client" || row.tenant_id === "" ? null : row.tenant_id,
          value: row.value,
        }),
      );
    },

    thresholds,

    async setThreshold({ signal, threshold, actor, reason, at }) {
      const before = (await thresholds())[signal] ?? null;
      if (JSON.stringify(before) === JSON.stringify(threshold)) return { changed: false };
      const nowS = toSeconds(at);
      const write = threshold
        ? db
            .prepare(
              `INSERT INTO gateway_abuse_threshold (signal, window_minutes, alert_at, suspend_at, updated_at, updated_by)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT (signal) DO UPDATE SET window_minutes = ?2, alert_at = ?3, suspend_at = ?4,
                 updated_at = ?5, updated_by = ?6`,
            )
            .bind(signal, threshold.windowMinutes, threshold.alertAt, threshold.suspendAt, nowS, actor.id)
        : db.prepare(`DELETE FROM gateway_abuse_threshold WHERE signal = ?`).bind(signal);
      const [result] = await db.batch([
        write,
        adminAuditStatement(db, {
          tenantId: "",
          actor,
          action: "abuse.threshold",
          targetType: "abuse_signal",
          targetId: signal,
          ...(before ? { before } : {}),
          ...(threshold ? { after: threshold } : {}),
          reason: reason ?? null,
          nowS,
          when: "changes() > 0",
        }),
      ]);
      return { changed: (result?.meta.changes ?? 0) > 0 };
    },

    async raise({ decision, windowStart, at }) {
      const nowS = toSeconds(at);
      const alertId = newId("gwab");
      const suspensionId = newId("gws");
      const suspend = decision.action === "suspend" && decision.subjectKind !== "client";
      const alertInserted = `EXISTS (SELECT 1 FROM gateway_abuse_alert WHERE id = '${alertId}')`;
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO gateway_abuse_alert
               (id, signal, subject_kind, subject_id, tenant_id, value, threshold, window_minutes, window_start,
                action, suspension_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)`,
          )
          .bind(
            alertId,
            decision.signal,
            decision.subjectKind,
            decision.subjectId,
            decision.tenantId ?? "",
            decision.value,
            decision.threshold,
            decision.windowMinutes,
            toSeconds(windowStart),
            decision.action,
            nowS,
          ),
        ...(suspend
          ? [
              ...suspensionStatements({
                id: suspensionId,
                subjectKind: decision.subjectKind as GatewaySuspensionSubject,
                subjectId: decision.subjectId,
                tenantId: decision.tenantId ?? "",
                source: "auto",
                signal: decision.signal,
                reason: `${decision.signal} ${decision.value} >= ${decision.threshold} in ${decision.windowMinutes} min`,
                actor: { kind: "system", id: `threshold:${decision.signal}`, role: "abuse_threshold" },
                nowS,
                after: { value: decision.value, threshold: decision.threshold, windowMinutes: decision.windowMinutes },
                when: alertInserted,
              }),
              db
                .prepare(
                  `UPDATE gateway_abuse_alert SET suspension_id = ?1
                    WHERE id = ?2 AND EXISTS (SELECT 1 FROM gateway_suspension WHERE id = ?1)`,
                )
                .bind(suspensionId, alertId),
            ]
          : []),
      ]);
      const alert = await db
        .prepare(`SELECT suspension_id FROM gateway_abuse_alert WHERE id = ?`)
        .bind(alertId)
        .first<{ suspension_id: string | null }>();
      if (!alert) return { raised: false, suspension: null };
      return { raised: true, suspension: alert.suspension_id ? await suspensionById(alert.suspension_id) : null };
    },

    async suspend(input) {
      const id = newId("gws");
      await db.batch(
        suspensionStatements({
          id,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          tenantId: input.tenantId,
          source: "manual",
          signal: null,
          reason: input.reason,
          actor: input.actor,
          nowS: toSeconds(input.at),
        }),
      );
      const suspension = await suspensionById(id);
      if (!suspension)
        throw new GatewayError("GATEWAY_SUSPENSION_EXISTS", { details: { subjectKind: input.subjectKind, subjectId: input.subjectId } });
      return suspension;
    },

    async lift({ suspensionId, reason, actor, at }) {
      const nowS = toSeconds(at);
      const current = await suspensionById(suspensionId);
      if (!current || current.liftedAt !== null)
        throw new GatewayError("GATEWAY_SUSPENSION_NOT_FOUND", { details: { suspensionId } });
      const [lifted] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_suspension SET lifted_at = ?2, lifted_by = ?3, lift_reason = ?4
              WHERE id = ?1 AND lifted_at IS NULL`,
          )
          .bind(suspensionId, nowS, actor.id, reason),
        adminAuditStatement(db, {
          tenantId: current.tenantId,
          actor,
          action: "abuse.lift",
          targetType: auditTarget(current.subjectKind),
          targetId: current.subjectId,
          before: { suspensionId, source: current.source, signal: current.signal },
          reason,
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (!lifted?.meta.changes) throw new GatewayError("GATEWAY_SUSPENSION_NOT_FOUND", { details: { suspensionId } });
      return (await suspensionById(suspensionId))!;
    },

    async prune({ before }) {
      const result = await db
        .prepare(`DELETE FROM gateway_abuse_observation WHERE window_start < ?`)
        .bind(toSeconds(before))
        .run();
      return result.meta.changes ?? 0;
    },
  };
}

/**
 * The tenant a suspendable subject belongs to, or GATEWAY_ABUSE_SUBJECT_NOT_FOUND.
 * A key is a virtual key (`gateway_key`), a gateway token (`gateway_token`),
 * or a `clsh_` parent that has minted a gateway token (its latest tenant).
 */
export async function abuseSubjectTenant(
  db: D1Database,
  subject: { subjectKind: GatewaySuspensionSubject; subjectId: string },
): Promise<string> {
  const row =
    subject.subjectKind === "tenant"
      ? await db.prepare(`SELECT id AS tenant_id FROM tenant WHERE id = ?`).bind(subject.subjectId).first<{ tenant_id: string }>()
      : await db
          .prepare(
            `SELECT tenant_id FROM (
               SELECT tenant_id, 0 AS rank, 0 AS created_at FROM gateway_key WHERE id = ?1
               UNION ALL SELECT tenant_id, 1, 0 FROM gateway_token WHERE id = ?1
               UNION ALL SELECT tenant_id, 2, created_at FROM gateway_token WHERE parent_kind = 'api_token' AND parent_id = ?1)
             ORDER BY rank, created_at DESC LIMIT 1`,
          )
          .bind(subject.subjectId)
          .first<{ tenant_id: string }>();
  if (!row) throw new GatewayError("GATEWAY_ABUSE_SUBJECT_NOT_FOUND", { details: { subjectKind: subject.subjectKind } });
  return row.tenant_id;
}

/** What the console shows: thresholds, each signal's top subjects, recent alerts and suspensions. */
export async function readGatewayAbuse(
  db: D1Database,
  options: { now: number; defaultWindowMinutes: number; limit: number },
) {
  const port = createD1GatewayAbusePort(db);
  const thresholds = await port.thresholds();
  const signals = await Promise.all(
    GATEWAY_ABUSE_SIGNALS.map(async (signal) => {
      const threshold = thresholds[signal] ?? null;
      const windowMinutes = threshold?.windowMinutes ?? options.defaultWindowMinutes;
      const top = await port.measure({ signal, since: options.now - windowMinutes * 60_000, atLeast: 1, limit: options.limit });
      return { signal, windowMinutes, threshold, top };
    }),
  );
  const [alerts, suspensions] = await db.batch([
    db
      .prepare(
        `SELECT id, signal, subject_kind, subject_id, tenant_id, value, threshold, window_minutes, window_start,
                action, suspension_id, created_at
           FROM gateway_abuse_alert ORDER BY created_at DESC, id LIMIT ?`,
      )
      .bind(options.limit),
    db
      .prepare(
        `SELECT ${SUSPENSION_COLUMNS} FROM gateway_suspension
          ORDER BY lifted_at IS NOT NULL, COALESCE(lifted_at, created_at) DESC, id LIMIT ?`,
      )
      .bind(options.limit),
  ]);
  const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();
  return {
    signals,
    alerts: (
      (alerts?.results ?? []) as Array<{
        id: string;
        signal: GatewayAbuseSignal;
        subject_kind: GatewayAbuseSubjectKind;
        subject_id: string;
        tenant_id: string;
        value: number;
        threshold: number;
        window_minutes: number;
        window_start: number;
        action: "alert" | "suspend";
        suspension_id: string | null;
        created_at: number;
      }>
    ).map((row) => ({
      id: row.id,
      signal: row.signal,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      tenantId: row.tenant_id || null,
      value: row.value,
      threshold: row.threshold,
      windowMinutes: row.window_minutes,
      windowStart: iso(row.window_start),
      action: row.action,
      suspensionId: row.suspension_id,
      createdAt: iso(row.created_at),
    })),
    suspensions: ((suspensions?.results ?? []) as SuspensionRow[]).map((row) => ({
      ...toSuspension(row),
      createdAt: iso(row.created_at),
      liftedAt: row.lifted_at === null ? null : iso(row.lifted_at),
    })),
  };
}

/**
 * Abuse evaluation for the Worker `scheduled` handler: gateway-core's
 * evaluateGatewayAbuse over the D1 port. Idempotent inside a threshold window.
 */
export function evaluateGatewayAbuseNow(
  env: Pick<Env, "DB">,
  options: { clock?: GatewayClock; logger?: GatewayLogger } = {},
): Promise<AbuseEvaluation> {
  return evaluateGatewayAbuse({
    abuse: createD1GatewayAbusePort(env.DB),
    clock: options.clock ?? monotonicClock(),
    logger: options.logger ?? workersLogger(),
  });
}
