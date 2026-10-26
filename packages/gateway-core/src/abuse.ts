/**
 * Abuse signals and suspension (#356; guide:
 * apps/docs/guide/gateway-admin.md#abuse). The adapter (the `abuse` port)
 * counts observations, measures each signal over a window and stores
 * thresholds, alerts and suspensions; the core owns what a signal means, the
 * one schema every threshold is validated with, the decision a measurement
 * leads to, and when the data plane refuses a suspended caller:
 *
 * | Signal          | Subject                 | Value over the window                       |
 * | --------------- | ----------------------- | ------------------------------------------- |
 * | `spend`         | tenant                  | micro-credits settled (top spenders)        |
 * | `auth_failures` | tenant, else client     | 401 answers (unknown, expired, revoked)     |
 * | `shared_key`    | key                     | distinct client fingerprints using the key  |
 * | `velocity`      | key                     | authenticated requests                      |
 *
 * Thresholds are configuration with no built-in default: a signal without
 * one is shown, never acted on. Crossing `alertAt` raises an alert; crossing
 * `suspendAt` (when set) suspends the subject. A client (no recognized
 * credential) cannot be suspended, so it is only ever alerted on.
 *
 * A key is the credential a caller's token belongs to (`abuseKeyOf`): the
 * virtual key or long-lived parent it was minted from, else the token. The
 * data plane refuses a caller while its tenant, its key or its token is
 * suspended, with GATEWAY_SUSPENDED (403), before anything is reserved or
 * sent upstream.
 */
import { z } from "zod";

import { GatewayError, isGatewayError, toGatewayError } from "./errors.js";
import type { GatewayIdentity, GatewayPorts } from "./ports.js";

export const GATEWAY_ABUSE_SIGNALS = ["spend", "auth_failures", "shared_key", "velocity"] as const;
export type GatewayAbuseSignal = (typeof GATEWAY_ABUSE_SIGNALS)[number];

/** What a signal is counted per. `client` is a fingerprint of a caller that presented no recognized credential. */
export type GatewayAbuseSubjectKind = "tenant" | "key" | "client";

/** What can be suspended: a whole tenant, or one key (a virtual key, a token's parent credential, or a gateway token). */
export const GATEWAY_SUSPENSION_SUBJECTS = ["tenant", "key"] as const;
export type GatewaySuspensionSubject = (typeof GATEWAY_SUSPENSION_SUBJECTS)[number];

export function isSuspendableSubject(kind: GatewayAbuseSubjectKind): kind is GatewaySuspensionSubject {
  return (GATEWAY_SUSPENSION_SUBJECTS as readonly string[]).includes(kind);
}

/** The longest window a threshold may measure; adapters keep raw observations this long. */
export const GATEWAY_ABUSE_MAX_WINDOW_MINUTES = 1440;

const count = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * One signal's threshold, as written by an API: a window, the value that
 * raises an alert, and the value that suspends (`null`: alert only). No
 * unknown fields, so a typo never silently disables a suspension.
 */
export const GatewayAbuseThresholdSchema = z
  .object({
    windowMinutes: z.number().int().min(1).max(GATEWAY_ABUSE_MAX_WINDOW_MINUTES),
    alertAt: count(),
    suspendAt: count().nullable(),
  })
  .strict()
  .refine((threshold) => threshold.suspendAt === null || threshold.suspendAt >= threshold.alertAt, {
    message: "suspendAt must be at least alertAt",
    path: ["suspendAt"],
  });
export type GatewayAbuseThreshold = z.infer<typeof GatewayAbuseThresholdSchema>;

export type GatewayAbuseThresholds = Partial<Record<GatewayAbuseSignal, GatewayAbuseThreshold>>;

/** One measured subject of one signal. */
export interface GatewayAbuseObservation {
  signal: GatewayAbuseSignal;
  subjectKind: GatewayAbuseSubjectKind;
  subjectId: string;
  /** The subject's tenant, when known (never for a client). */
  tenantId: string | null;
  value: number;
}

export interface GatewayAbuseDecision extends GatewayAbuseObservation {
  action: "alert" | "suspend";
  /** The threshold value the observation reached. */
  threshold: number;
  windowMinutes: number;
}

/**
 * One data-plane observation, counted per minute by the adapter:
 * `request` for every authenticated request (velocity, shared-key
 * fingerprints), `auth_failure` for every 401 answer.
 */
export interface GatewayAbuseEvent {
  kind: "request" | "auth_failure";
  /** The caller's tenant; absent for an auth failure (the adapter may know the credential's). */
  tenantId?: string;
  /**
   * The caller's key (`abuseKeyOf`). For an auth failure, the credential the
   * identity port recognized but refused (`details.keyId`), when any.
   */
  keyId?: string;
  /** `gatewayClientFingerprint` of the caller; never its address. */
  fingerprint: string;
  /** Epoch ms. */
  at: number;
}

/** Who suspends or lifts: an admin account, or a threshold (`system`). */
export interface GatewayAbuseActor {
  kind: "admin" | "system";
  id: string;
  role: string;
}

export interface GatewaySuspension {
  id: string;
  subjectKind: GatewaySuspensionSubject;
  subjectId: string;
  tenantId: string;
  /** `manual` (an admin account) or `auto` (a threshold's `suspendAt`, with its signal). */
  source: "manual" | "auto";
  signal: GatewayAbuseSignal | null;
  reason: string;
  actorKind: GatewayAbuseActor["kind"];
  actorId: string;
  /** Epoch ms. */
  createdAt: number;
  liftedAt: number | null;
  liftedBy: string | null;
  liftReason: string | null;
}

export interface GatewaySuspendInput {
  subjectKind: GatewaySuspensionSubject;
  subjectId: string;
  tenantId: string;
  reason: string;
  actor: GatewayAbuseActor;
  /** Epoch ms. */
  at: number;
}

export interface GatewaySetThresholdInput {
  signal: GatewayAbuseSignal;
  /** Parsed with `GatewayAbuseThresholdSchema`; `null` clears it (the signal is then shown, never acted on). */
  threshold: GatewayAbuseThreshold | null;
  actor: GatewayAbuseActor;
  reason?: string;
  /** Epoch ms. */
  at: number;
}

export interface GatewayRaiseInput {
  decision: GatewayAbuseDecision;
  /** `abuseWindowStart` of the decision's window (epoch ms): one alert per signal, subject, window and action. */
  windowStart: number;
  /** Epoch ms. */
  at: number;
}

export interface GatewayAbusePort {
  /**
   * The active suspension refusing a caller: of `tenantId`, or of any of
   * `keyIds`. Null when none.
   */
  activeSuspension(input: { tenantId: string; keyIds: readonly string[] }): Promise<GatewaySuspension | null>;
  /** Count one observation in its minute. */
  observe(event: GatewayAbuseEvent): Promise<void>;
  /** Subjects of `signal` measured since `since` (epoch ms) at `atLeast` or more, highest first, at most `limit`. */
  measure(input: { signal: GatewayAbuseSignal; since: number; atLeast: number; limit: number }): Promise<GatewayAbuseObservation[]>;
  /** The configured thresholds; a signal without one is absent. */
  thresholds(): Promise<GatewayAbuseThresholds>;
  /**
   * Configure (or, with `null`, clear) one signal's threshold, with its audit
   * row in the same transaction. Answers whether anything changed.
   */
  setThreshold(input: GatewaySetThresholdInput): Promise<{ changed: boolean }>;
  /**
   * Record one decision once per signal, subject, window and action: in one
   * transaction, the alert and, for `suspend` (when the subject is not
   * suspended already), the `auto` suspension with its audit row (actor
   * `system`). `raised: false` when the window already has this alert.
   */
  raise(input: GatewayRaiseInput): Promise<{ raised: boolean; suspension: GatewaySuspension | null }>;
  /** Suspend a subject, with its audit row in the same transaction. Rejects with GATEWAY_SUSPENSION_EXISTS while one is active. */
  suspend(input: GatewaySuspendInput): Promise<GatewaySuspension>;
  /** Lift an active suspension, with its audit row. Rejects with GATEWAY_SUSPENSION_NOT_FOUND unless it is active. */
  lift(input: { suspensionId: string; reason: string; actor: GatewayAbuseActor; at: number }): Promise<GatewaySuspension>;
  /** Delete observations older than `before` (epoch ms); answers how many. */
  prune(input: { before: number }): Promise<number>;
}

/**
 * What each observation leads to under `thresholds`: `suspend` at or above
 * `suspendAt` for a suspendable subject, else `alert` at or above `alertAt`,
 * else nothing. Observations of a signal without a threshold lead to nothing.
 */
export function decideGatewayAbuse(
  observations: readonly GatewayAbuseObservation[],
  thresholds: GatewayAbuseThresholds,
): GatewayAbuseDecision[] {
  const decisions: GatewayAbuseDecision[] = [];
  for (const observation of observations) {
    const threshold = thresholds[observation.signal];
    if (!threshold) continue;
    const { windowMinutes, alertAt, suspendAt } = threshold;
    if (suspendAt !== null && observation.value >= suspendAt && isSuspendableSubject(observation.subjectKind))
      decisions.push({ ...observation, action: "suspend", threshold: suspendAt, windowMinutes });
    else if (observation.value >= alertAt) decisions.push({ ...observation, action: "alert", threshold: alertAt, windowMinutes });
  }
  return decisions;
}

/**
 * The window an alert belongs to (epoch ms, floored to the threshold's
 * window): one alert per signal, subject and window, however often the
 * signal is evaluated inside it.
 */
export function abuseWindowStart(now: number, windowMinutes: number): number {
  const width = windowMinutes * 60_000;
  return Math.floor(now / width) * width;
}

const FINGERPRINT_DOMAIN = "clash-gateway-client-fingerprint\0";

/**
 * A caller's client fingerprint: the first 16 hex characters of the SHA-256
 * of its address and user agent. Neither is stored; the fingerprint only
 * tells requests from one client apart from another's.
 */
export async function gatewayClientFingerprint(client: { address?: string | null; userAgent?: string | null }): Promise<string> {
  const material = `${FINGERPRINT_DOMAIN}${client.address?.trim() ?? ""}\0${client.userAgent?.trim() ?? ""}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key a caller is counted and suspended as: the credential its token belongs to, else the token. */
export function abuseKeyOf(identity: Pick<GatewayIdentity, "keyId" | "abuseKeyId">): string | undefined {
  return identity.abuseKeyId ?? identity.keyId;
}

const unavailable = (error: unknown) => isGatewayError(error) && error.code === "GATEWAY_CAPABILITY_UNAVAILABLE";

/**
 * Refuse a suspended caller: GATEWAY_SUSPENDED (403) while its tenant, key
 * or token is suspended. A deployment without the abuse port admits (it has
 * no suspensions); any other failure of the check refuses.
 */
export async function assertGatewayCallerActive(ports: Pick<GatewayPorts, "abuse">, identity: GatewayIdentity): Promise<void> {
  const keyIds = [...new Set([identity.keyId, identity.abuseKeyId].filter((id): id is string => !!id))];
  let suspension: GatewaySuspension | null;
  try {
    suspension = await ports.abuse.activeSuspension({ tenantId: identity.tenantId, keyIds });
  } catch (error) {
    if (unavailable(error)) return;
    throw toGatewayError(error);
  }
  if (suspension)
    throw new GatewayError("GATEWAY_SUSPENDED", {
      details: { subjectKind: suspension.subjectKind, suspensionId: suspension.id },
    });
}

/** Count one observation; never throws (a failure is logged, the request is unaffected). */
export async function recordGatewayAbuse(ports: Pick<GatewayPorts, "abuse" | "logger">, event: GatewayAbuseEvent): Promise<void> {
  try {
    await ports.abuse.observe(event);
  } catch (error) {
    if (!unavailable(error)) ports.logger.warn("gateway.abuse_observe_failed", { kind: event.kind, code: toGatewayError(error).code });
  }
}

export interface AbuseEvaluation {
  /** Alerts raised (including those that suspended). */
  alerts: number;
  /** Subjects suspended by a threshold. */
  suspended: number;
  /** Decisions that could not be recorded; retried on the next run. */
  failed: number;
  /** Observations deleted past the longest window. */
  pruned: number;
}

/** Subjects measured per signal and run; the highest first. */
export const GATEWAY_ABUSE_EVALUATION_LIMIT = 200;

/**
 * Measure every signal that has a threshold over its window, raise each
 * decision once per window (`raise`), log every alert as
 * `gateway.abuse_alert` (`gateway.abuse_suspended` when it suspended), and
 * drop observations past the longest window. Idempotent inside a window.
 */
export async function evaluateGatewayAbuse(
  ports: Pick<GatewayPorts, "abuse" | "clock" | "logger">,
  options: { limit?: number } = {},
): Promise<AbuseEvaluation> {
  const now = ports.clock.now();
  const limit = options.limit ?? GATEWAY_ABUSE_EVALUATION_LIMIT;
  const thresholds = await ports.abuse.thresholds();
  const result: AbuseEvaluation = { alerts: 0, suspended: 0, failed: 0, pruned: 0 };
  for (const signal of GATEWAY_ABUSE_SIGNALS) {
    const threshold = thresholds[signal];
    if (!threshold) continue;
    let observations: GatewayAbuseObservation[];
    try {
      observations = await ports.abuse.measure({
        signal,
        since: now - threshold.windowMinutes * 60_000,
        atLeast: threshold.alertAt,
        limit,
      });
    } catch (error) {
      result.failed += 1;
      ports.logger.error("gateway.abuse_measure_failed", { signal, code: toGatewayError(error).code });
      continue;
    }
    for (const decision of decideGatewayAbuse(observations, { [signal]: threshold })) {
      try {
        const raised = await ports.abuse.raise({ decision, windowStart: abuseWindowStart(now, decision.windowMinutes), at: now });
        if (!raised.raised) continue;
        result.alerts += 1;
        if (raised.suspension) result.suspended += 1;
        ports.logger.warn(raised.suspension ? "gateway.abuse_suspended" : "gateway.abuse_alert", {
          signal,
          action: decision.action,
          subjectKind: decision.subjectKind,
          subjectId: decision.subjectId,
          tenantId: decision.tenantId,
          value: decision.value,
          threshold: decision.threshold,
          windowMinutes: decision.windowMinutes,
          suspensionId: raised.suspension?.id ?? null,
        });
      } catch (error) {
        result.failed += 1;
        ports.logger.error("gateway.abuse_raise_failed", { signal, subjectKind: decision.subjectKind, code: toGatewayError(error).code });
      }
    }
  }
  result.pruned = await ports.abuse.prune({ before: now - GATEWAY_ABUSE_MAX_WINDOW_MINUTES * 60_000 });
  return result;
}
