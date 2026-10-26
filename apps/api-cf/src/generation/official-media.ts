/**
 * Official media/AIGC generation through gateway-core and the ledger (#359;
 * guide: apps/docs/guide/gateway-data-plane.md#media-and-aigc).
 *
 * A hosted generation run with no route on the user's own provider accounts
 * is served by official upstream accounts when the published gateway catalog
 * has the model. Its lifecycle maps onto the hosted pipeline's hooks:
 *
 * | Pipeline step            | Gateway                                                   |
 * | ------------------------ | --------------------------------------------------------- |
 * | `resolveRoute` (enqueue) | `planGatewayMediaJob`: shared route plan, price; one `gateway_media_job` row per task |
 * | `beforeGenerate`         | `admitGatewayMediaJob`: limits lease (media job) and the prepaid exact debit on every budget (#399) |
 * | provider credentials     | the official key of the job's frozen route, for that run only |
 * | `afterGenerate`          | `settleMediaGeneration` succeeded: no money write, the debit stands |
 * | `onFailure`              | `settleMediaGeneration` failed: one journaled full-refund settle run |
 *
 * Every step is idempotent: the job row moves forward only, the debit is
 * charge-once under the job's request id, and the refund is one
 * `api-cf:gateway-settle` Durable Run per request (ledger unique on request,
 * budget and kind). A refund that could not be journaled is logged and left
 * for the hook's retry; it never fails or republishes the run.
 */
import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
import {
  admitGatewayMediaJob,
  deliveredMediaUnits,
  GatewayError,
  isGatewayError,
  isGatewayErrorCode,
  planGatewayMediaJob,
  restoreGatewayMediaAdmission,
  settleMediaGeneration,
  toGatewayError,
  type GatewayErrorCode,
  type GatewayIdentity,
  type GatewayPorts,
  type MediaGenerationResult,
} from "@clash/gateway-core";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginFailureCode } from "@clash/shared-types/executable-plugin";
import { activeModelParameterIds, type ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import type { Env } from "../config";
import { createD1GatewayPorts, workerSecrets } from "../gateway";
import { GATEWAY_UPSTREAM_ACCOUNT_ID_PREFIX } from "../gateway/d1-common";
import {
  createD1GatewayMediaJobStore,
  loadGatewayProductIdentity,
  type D1GatewayMediaJobStore,
  type StoredGatewayMediaJob,
} from "../gateway/d1-media-jobs";
import { readEffectiveTenant } from "../services/project-asset-resources";
import { generationMediaKind, mediaQuantities, measuredMediaQuantities } from "./media-usage";
import type { GenerationParams } from "./params";

export interface OfficialMediaRuntime {
  ports: GatewayPorts;
  jobs: D1GatewayMediaJobStore;
  tenantOf(projectId: string): Promise<string | null>;
  identity(input: { tenantId: string; userId: string }): Promise<GatewayIdentity>;
}

export function officialMediaRuntime(env: Env, overrides: Partial<GatewayPorts> = {}): OfficialMediaRuntime {
  const ports = {
    ...createD1GatewayPorts({
      db: env.DB,
      secrets: workerSecrets(env),
      // A failed run's refund settle run is started at once; the cron recovers a lost start.
      ...(env.GENERATION_WORKFLOW ? { workflow: env.GENERATION_WORKFLOW } : {}),
    }),
    ...overrides,
  };
  return {
    ports,
    jobs: createD1GatewayMediaJobStore(env.DB, { now: () => ports.clock.now() }),
    tenantOf: (projectId) => readEffectiveTenant(env, projectId),
    identity: (input) => loadGatewayProductIdentity(env.DB, input),
  };
}

/** Planning codes meaning "the gateway does not serve this model": the run keeps its BYOK answer. */
const NOT_SERVED: readonly GatewayErrorCode[] = ["GATEWAY_MODEL_NOT_FOUND", "GATEWAY_NO_ROUTE"];

export interface PlanOfficialMediaOptions {
  /** Whether hosted generation has an adapter for the route. */
  isRouteExecutable?: (route: ModelUpstreamRoute) => boolean;
  /** The hosted pipeline's ambiguous-submit policy, frozen into the attempt's retry class. */
  mayRetryAmbiguousSubmit?: (route: ModelUpstreamRoute) => boolean;
}

/**
 * The official route for a media run, or undefined when the gateway does
 * not serve the model (so the caller answers as before). The first plan for
 * a task wins; a repeated enqueue answers the same frozen route. A served
 * model the caller may not use refuses with its code before the run exists:
 * not a member of the Project's tenant (GATEWAY_FORBIDDEN), no budget
 * (GATEWAY_BUDGET_EXCEEDED), no price for a unit it must charge
 * (GATEWAY_PRICE_UNAVAILABLE).
 */
export async function planOfficialMediaRoute(
  runtime: OfficialMediaRuntime,
  params: GenerationParams,
  options: PlanOfficialMediaOptions = {},
): Promise<ModelUpstreamRoute | undefined> {
  const kind = generationMediaKind(params.type);
  const model = params.modelName ?? params.videoModel;
  if (!kind || !model) return undefined;
  const existing = await runtime.jobs.byTask(params.taskId);
  if (existing) return existing.job.attempt.route;
  const tenantId = await runtime.tenantOf(params.projectId);
  if (!tenantId) return undefined;
  const membership = await runtime
    .identity({ tenantId, userId: params.actorUserId })
    .catch((error: unknown) => toGatewayError(error));
  const identity: GatewayIdentity = isGatewayError(membership)
    ? { tenantId, userId: params.actorUserId, budgetIds: [], credentialScope: "official" }
    : membership;
  let job;
  try {
    job = await planGatewayMediaJob(
      runtime.ports,
      {
        identity,
        requestId: runtime.ports.ids.requestId(),
        model,
        kind,
        requestedParameterIds: activeModelParameterIds(params.modelParams),
        quantities: mediaQuantities(params),
      },
      {
        routing: {
          ...(options.isRouteExecutable ? { isRouteExecutable: options.isRouteExecutable } : {}),
          ...(options.mayRetryAmbiguousSubmit ? { mayRetryAmbiguousSubmit: options.mayRetryAmbiguousSubmit } : {}),
        },
      },
    );
  } catch (error) {
    if (isGatewayError(error) && NOT_SERVED.includes(error.code)) return undefined;
    throw error;
  }
  if (isGatewayError(membership)) throw membership;
  if (identity.budgetIds.length === 0)
    throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });
  return (await runtime.jobs.plan(params.taskId, job)).job.attempt.route;
}

/**
 * The run's official job, when its frozen route is official. Routes on the
 * user's own accounts never read the job table.
 */
async function officialJob(
  runtime: OfficialMediaRuntime,
  params: GenerationParams,
): Promise<StoredGatewayMediaJob | null> {
  const route = params.selectedRoute;
  if (!route?.accountId?.startsWith(GATEWAY_UPSTREAM_ACCOUNT_ID_PREFIX)) return null;
  const stored = await runtime.jobs.byTask(params.taskId);
  if (!stored) return null;
  // Only the run that planned the job is official: same actor, same frozen route.
  if (stored.job.identity.userId !== params.actorUserId || stored.job.attempt.route.accountId !== route.accountId)
    throw new GatewayError("GATEWAY_FORBIDDEN", {
      details: { reason: "media_job_mismatch", requestId: stored.job.requestId },
    });
  return stored;
}

export async function isOfficialMediaRun(runtime: OfficialMediaRuntime, params: GenerationParams): Promise<boolean> {
  return (await officialJob(runtime, params)) !== null;
}

/** Refusals worth retrying later: the job stays planned and the step is retried. */
const RETRYABLE_REFUSALS: readonly GatewayErrorCode[] = ["GATEWAY_RATE_LIMITED", "GATEWAY_CONCURRENCY_LIMITED"];

const REFUSAL_FAILURE: Partial<Record<GatewayErrorCode, ExecutablePluginFailureCode>> = {
  GATEWAY_BUDGET_EXCEEDED: "quota_exhausted",
  GATEWAY_RATE_LIMITED: "rate_limited",
  GATEWAY_CONCURRENCY_LIMITED: "rate_limited",
  GATEWAY_FORBIDDEN: "permission_denied",
  GATEWAY_MODEL_NOT_ALLOWED: "permission_denied",
  GATEWAY_KEY_UNAVAILABLE: "provider_unavailable",
  GATEWAY_NO_ROUTE: "provider_unavailable",
};

/** An admission refusal as a provider failure: nothing reached the provider. */
function refusal(error: GatewayError): ProviderExecutionError {
  return new ProviderExecutionError({
    code: REFUSAL_FAILURE[error.code] ?? "execution_failed",
    message: error.message,
    retryable: RETRYABLE_REFUSALS.includes(error.code),
    requestState: "rejected",
    providerCode: error.code,
  });
}

/**
 * Admit the run's job before its provider is called (the `beforeGenerate`
 * step). A job already admitted, or whose debit a crashed attempt wrote, is
 * not debited again. A refusal fails the submit with its code, debiting
 * nothing; a rate or concurrency refusal is retried.
 */
export async function admitOfficialMediaRun(runtime: OfficialMediaRuntime, params: GenerationParams): Promise<void> {
  const stored = await officialJob(runtime, params);
  if (!stored || stored.status === "admitted" || stored.status === "settled") return;
  const { job } = stored;
  if (stored.status === "refused")
    throw refusal(new GatewayError(isGatewayErrorCode(stored.errorCode) ? stored.errorCode : "GATEWAY_INTERNAL"));
  if (await runtime.jobs.debited(job)) {
    await runtime.jobs.admitted(job.requestId);
    return;
  }
  let leaseId: string;
  try {
    ({ leaseId } = await admitGatewayMediaJob(runtime.ports, job));
  } catch (caught) {
    const error = toGatewayError(caught);
    if (!RETRYABLE_REFUSALS.includes(error.code)) await runtime.jobs.refused(job.requestId, error.code);
    throw refusal(error);
  }
  await runtime.jobs.admitted(job.requestId, leaseId);
}

/** The gateway code a failed run settles with. */
export function mediaFailureCode(failure: { code: string; providerCode?: string } | undefined): GatewayErrorCode {
  if (isGatewayErrorCode(failure?.providerCode)) return failure.providerCode;
  switch (failure?.code) {
    case "transport_timeout":
    case "deadline_exceeded":
    case "task_expired":
      return "GATEWAY_UPSTREAM_TIMEOUT";
    case "invalid_request":
    case "content_rejected":
      return "GATEWAY_UPSTREAM_REJECTED";
    case "authentication_failed":
    case "permission_denied":
      return "GATEWAY_KEY_UNAVAILABLE";
    default:
      return "GATEWAY_UPSTREAM_ERROR";
  }
}

export type OfficialMediaOutcome =
  | { status: "succeeded"; run: Pick<DurableRunRecord, "stagedOutput"> }
  | { status: "failed"; failure: { code: string; providerCode?: string } | undefined };

/**
 * Settle the run's job once it ended (`afterGenerate` / `onFailure`). A
 * success keeps the prepaid debit and writes nothing; every failure
 * dispatches the full refund. A job never admitted was debited nothing and is
 * only marked refused. Resolves true when the run is official (whatever the
 * settlement's fate).
 */
export async function settleOfficialMediaRun(
  runtime: OfficialMediaRuntime,
  params: GenerationParams,
  outcome: OfficialMediaOutcome,
): Promise<boolean> {
  const stored = await officialJob(runtime, params);
  if (!stored) return false;
  const { job } = stored;
  const { ports } = runtime;
  if (stored.status === "refused" || stored.status === "settled") return true;
  if (stored.status === "planned") {
    if (!(await runtime.jobs.debited(job))) {
      if (outcome.status === "failed") await runtime.jobs.refused(job.requestId, mediaFailureCode(outcome.failure));
      // A success is never admitted after the fact: nothing was debited, nothing is charged.
      else ports.logger.error("gateway.media_unadmitted_success", { requestId: job.requestId });
      return true;
    }
    await runtime.jobs.admitted(job.requestId);
  }
  try {
    const admission = await restoreGatewayMediaAdmission(ports, job, stored.leaseId ? { leaseId: stored.leaseId } : {});
    const result: MediaGenerationResult =
      outcome.status === "succeeded"
        ? { status: "succeeded", units: deliveredMediaUnits(admission, measuredMediaQuantities(params, outcome.run)) }
        : { status: "failed", error: new GatewayError(mediaFailureCode(outcome.failure)) };
    // The refund (if any) is journaled before this resolves; its settle run applies it.
    await settleMediaGeneration(ports, admission, { attempt: job.attempt, result });
    await runtime.jobs.settled(job.requestId);
  } catch (error) {
    // Not journaled: the job stays admitted so a retried hook dispatches again.
    ports.logger.error("gateway.settle_dispatch_failed", {
      requestId: job.requestId,
      outcome: outcome.status,
      cause: toGatewayError(error).code,
    });
  }
  return true;
}

/**
 * The official key for an official run's route, or undefined when the run
 * is not official (the caller resolves the user's own account). Only an
 * admitted job resolves: a run that was never debited never reaches
 * an official account. Errors are GATEWAY_KEY_UNAVAILABLE, never key material.
 */
export async function officialMediaCredentials(
  runtime: OfficialMediaRuntime,
  params: GenerationParams,
): Promise<Record<string, string> | undefined> {
  const stored = await officialJob(runtime, params);
  if (!stored) return undefined;
  if (stored.status !== "admitted")
    throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
      details: { reason: "media_job_not_admitted", requestId: stored.job.requestId },
    });
  const credential = await runtime.ports.credentials.resolve({
    route: stored.job.attempt.route,
    scope: "official",
    tenantId: stored.job.identity.tenantId,
  });
  return { apiKey: credential.apiKey, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
}
