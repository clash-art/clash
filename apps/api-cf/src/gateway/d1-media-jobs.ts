/**
 * Official media/AIGC jobs over D1 (`gateway_media_job`, 0049, #359; guide:
 * apps/docs/guide/gateway-data-plane.md#media-and-aigc). A hosted generation
 * run served by official upstream accounts has exactly one row, keyed by its
 * ledger request id and unique per task. The row is the server-side proof
 * that the run is official: official credentials resolve only for the run
 * whose row froze that route (`../generation/official-media.ts`).
 *
 * Identity: a product user acting in a Project's tenant, never a header. The
 * user must be a member of that tenant (their own personal workspace counts);
 * the budgets are the tenant wallet and the member's budget, as for a
 * gateway token without a virtual key.
 *
 * Status moves forward only (`planned -> admitted -> settled`, or
 * `planned -> refused`); every transition is one conditional UPDATE, so a
 * replayed step is a no-op.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, type GatewayIdentity, type GatewayMediaJob } from "@clash/gateway-core";
import type { GatewayMediaJobStatus } from "@clash/shared-cloud-schema/gateway";

import { personalTenantId } from "../services/gateway-tokens";
import { parseJson, toSeconds } from "./d1-common";

export interface StoredGatewayMediaJob {
  taskId: string;
  status: GatewayMediaJobStatus;
  job: GatewayMediaJob;
  leaseId?: string;
  errorCode?: string;
}

interface MediaJobRow {
  request_id: string;
  task_id: string;
  status: GatewayMediaJobStatus;
  job_json: string;
  lease_id: string | null;
  error_code: string | null;
}

/**
 * The gateway identity of a product user acting in `tenantId`, official
 * scope. GATEWAY_FORBIDDEN when the user is not a member (their personal
 * workspace is theirs before its row exists). Budgets: the tenant wallet and
 * the member's own budget; an empty list is refused at admission.
 */
export async function loadGatewayProductIdentity(
  db: D1Database,
  input: { tenantId: string; userId: string },
): Promise<GatewayIdentity> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM tenant_member WHERE tenant_id = ?1 AND user_id = ?2) AS member,
              (SELECT json_group_array(id) FROM gateway_budget
                WHERE tenant_id = ?1
                  AND ((scope = 'tenant' AND scope_id = ?1) OR (scope = 'user' AND scope_id = ?2))) AS budget_ids`,
    )
    .bind(input.tenantId, input.userId)
    .first<{ member: number; budget_ids: string }>();
  if (!row?.member && input.tenantId !== personalTenantId(input.userId))
    throw new GatewayError("GATEWAY_FORBIDDEN", { details: { reason: "tenant_membership" } });
  const budgetIds = parseJson(row?.budget_ids ?? "[]");
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    budgetIds: Array.isArray(budgetIds) ? budgetIds.filter((id): id is string => typeof id === "string") : [],
    credentialScope: "official",
  };
}

function stored(row: MediaJobRow): StoredGatewayMediaJob {
  const job = parseJson(row.job_json) as GatewayMediaJob | undefined;
  if (!job || job.requestId !== row.request_id || !job.attempt?.route)
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: "A stored media job does not parse.",
      details: { requestId: row.request_id },
    });
  return {
    taskId: row.task_id,
    status: row.status,
    job,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

const COLUMNS = "request_id, task_id, status, job_json, lease_id, error_code";

export function createD1GatewayMediaJobStore(db: D1Database, deps: { now: () => number }) {
  const nowS = () => toSeconds(deps.now());

  async function byTask(taskId: string): Promise<StoredGatewayMediaJob | null> {
    const row = await db
      .prepare(`SELECT ${COLUMNS} FROM gateway_media_job WHERE task_id = ? LIMIT 1`)
      .bind(taskId)
      .first<MediaJobRow>();
    return row ? stored(row) : null;
  }

  async function transition(
    requestId: string,
    from: GatewayMediaJobStatus,
    to: GatewayMediaJobStatus,
    fields: { leaseId?: string; errorCode?: string } = {},
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `UPDATE gateway_media_job
            SET status = ?3, lease_id = COALESCE(?4, lease_id), error_code = COALESCE(?5, error_code), updated_at = ?6
          WHERE request_id = ?1 AND status = ?2`,
      )
      .bind(requestId, from, to, fields.leaseId ?? null, fields.errorCode ?? null, nowS())
      .run();
    return result.meta.changes === 1;
  }

  return {
    byTask,

    /**
     * Record a planned job for `taskId`. The first plan for a task wins: a
     * concurrent or repeated plan answers the stored job, so a task never
     * has two ledger requests.
     */
    async plan(taskId: string, job: GatewayMediaJob): Promise<StoredGatewayMediaJob> {
      const now = nowS();
      await db
        .prepare(
          `INSERT INTO gateway_media_job
             (request_id, task_id, tenant_id, user_id, model_code, kind, status, job_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planned', ?7, ?8, ?8)
           ON CONFLICT(task_id) DO NOTHING`,
        )
        .bind(
          job.requestId,
          taskId,
          job.identity.tenantId,
          job.identity.userId,
          job.modelCode,
          job.kind,
          JSON.stringify(job),
          now,
        )
        .run();
      const winner = await byTask(taskId);
      if (!winner)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "A planned media job was not recorded.",
          details: { taskId },
        });
      return winner;
    },

    /** Whether the job's request holds anything (a reservation made before a crash). */
    async held(job: GatewayMediaJob): Promise<boolean> {
      const row = await db
        .prepare(
          `SELECT 1 AS held FROM gateway_usage_ledger
            WHERE request_id = ? AND tenant_id = ? AND kind = 'hold' LIMIT 1`,
        )
        .bind(job.requestId, job.identity.tenantId)
        .first<{ held: number }>();
      return row !== null;
    },

    admitted: (requestId: string, leaseId?: string) =>
      transition(requestId, "planned", "admitted", leaseId ? { leaseId } : {}),
    refused: (requestId: string, errorCode: string) => transition(requestId, "planned", "refused", { errorCode }),
    settled: (requestId: string) => transition(requestId, "admitted", "settled"),
  };
}

export type D1GatewayMediaJobStore = ReturnType<typeof createD1GatewayMediaJobStore>;
