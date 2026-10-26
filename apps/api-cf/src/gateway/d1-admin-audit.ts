/**
 * The one writer of `gateway_admin_audit` (guide: apps/docs/guide/gateway-admin.md).
 *
 * Every admin mutation appends one row as a statement in the same D1 batch as
 * the mutation, so both commit or neither does. The row is usually chained on
 * the mutation with `when` (e.g. `changes() = 1`): a mutation that changed
 * nothing records nothing. Rows are append-only: there is no update or delete
 * API, and the 0036 triggers refuse UPDATE and DELETE inside retention.
 *
 * Snapshots are redacted before they are stored: keys that name secret
 * material and values shaped like credentials become "[redacted]", whatever
 * the caller passed. Callers still build snapshots without secrets; this is
 * the second line.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

/**
 * Who performed an admin action (#394): an admin account (`admin`, its
 * `adm_…` id, its account role) or a product user acting through a team role
 * (`user`, the user id, `owner`/`member`). The bootstrap script and
 * migrations write `bootstrap` / `migration` rows in SQL.
 */
export interface GatewayAdminActor {
  kind: "admin" | "user";
  id: string;
  role: string;
}

/**
 * The identity an audit row records: an admin actor, or a payment provider
 * webhook (`payment`, id `payment:<provider>`, role the provider; #419).
 */
export interface AuditActor {
  kind: GatewayAdminActor["kind"] | "payment";
  id: string;
  role: string;
}

export const AUDIT_REDACTED = "[redacted]";

/** Keys whose values are secret material, wherever they appear in a snapshot. */
const SECRET_KEY =
  /(secret|password|passphrase|api[-_]?key|authorization|cookie|encrypted|private[-_]?key|ciphertext|credentials$|token$|hash$)/i;
/** Values shaped like credentials, whatever their key. */
const SECRET_VALUE = /^(sk[-_]|clsh_|sk_gw_|bearer\s|basic\s|ghp_|xox[abp]-|AIza|v1\.[A-Za-z0-9_-]{16,})/i;
/** A Worker secret *binding name* is configuration, not secret material. */
const SECRET_BINDING_NAME = /^GATEWAY_UPSTREAM_[A-Z0-9_]+$/;
const MAX_DEPTH = 8;

export function redactAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (key === "secretRef" && typeof value === "string" && SECRET_BINDING_NAME.test(value)) return value;
  if (key && SECRET_KEY.test(key)) return value === null || value === undefined ? value : AUDIT_REDACTED;
  if (typeof value === "string") return SECRET_VALUE.test(value.trim()) ? AUDIT_REDACTED : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return AUDIT_REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactAuditValue(entry, "", depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([entryKey, entry]) => [entryKey, redactAuditValue(entry, entryKey, depth + 1)]),
  );
}

export interface AdminAuditInput {
  /** '' for platform-wide changes (catalog, price book, upstreams, platform roles). */
  tenantId: string;
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  /** Operator note for overrides, rotations and role changes; never request content. */
  reason?: string | null;
  /** Gateway request the action concerns (a staff prompt view). */
  requestId?: string;
  nowS: number;
  /** SQL condition the row is written under, usually chained on the mutation; default always. */
  when?: string;
}

const snapshot = (value: unknown) => (value === undefined ? null : JSON.stringify(redactAuditValue(value)));

export function adminAuditStatement(db: D1Database, input: AdminAuditInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO gateway_admin_audit
         (id, tenant_id, actor_id, actor_kind, actor_role, action, target_type, target_id,
          before_json, after_json, reason, request_id, occurred_at)
       SELECT ?1, ?2, ?3, ?13, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE ${input.when ?? "1"}`,
    )
    .bind(
      `gwa_${crypto.randomUUID().replaceAll("-", "")}`,
      input.tenantId,
      input.actor.id,
      input.actor.role,
      input.action,
      input.targetType,
      input.targetId,
      snapshot(input.before),
      snapshot(input.after),
      input.reason ?? null,
      input.requestId ?? null,
      input.nowS,
      input.actor.kind,
    );
}
