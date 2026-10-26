/**
 * Workers/D1 adapter for the model gateway data plane (#347, streaming #348). Builds
 * gateway-core's GatewayPorts over D1 and mounts `createGatewayApp` at
 * `/gateway/v1/*` (registered in routes/gateway.ts beside `/gateway/me`).
 *
 * Identity: the sk_gw_ token only (services/gateway-tokens.ts); no header,
 * x-user-id included, is read as identity. `blobs` is R2 (`R2_BUCKET`) and
 * `retention` is D1 metadata; together they retain request/response bodies
 * for 30 days when the hosted-only GATEWAY_STAFF_PROMPT_ACCESS flag is on.
 * `abuse` (#356) counts requests and 401s, and refuses suspended tenants and
 * keys (d1-abuse.ts). Ports this deployment does not implement yet
 * (scheduler, audit) are explicit `unavailablePort`s that answer
 * GATEWAY_CAPABILITY_UNAVAILABLE.
 *
 * Money (#399): media is prepaid at admission and text is postpaid under
 * GATEWAY_CREDIT_FLOOR; follow-up charges and refunds are `settlement`, the
 * `api-cf:gateway-settle` Durable Runs of settle-runs.ts on the Workflow
 * binding (GENERATION_WORKFLOW, the shared Durable Run Workflow).
 * Guide: apps/docs/guide/gateway-data-plane.md.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  createGatewayApp,
  GATEWAY_SETTLEMENT_DEFAULTS,
  unavailablePort,
  type GatewayApp,
  type GatewayClock,
  type GatewayCreditFloor,
  type GatewayLogger,
  type GatewayPorts,
  type GatewayUpstreamPort,
} from "@clash/gateway-core";

import type { CloudDurableWorkflowBinding } from "../cloud-runs/cloud-durable-dispatcher";
import type { Env } from "../config";
import { createGatewayTokenStore } from "../services/gateway-tokens";
import { createD1GatewayAbusePort } from "./d1-abuse";
import { createD1GatewayBudgetPorts } from "./d1-budgets";
import { createD1GatewaySettlementPort } from "./settle-runs";
import { monotonicClock } from "./d1-common";
import {
  createD1GatewayCredentialPort,
  gatewayEncryptionKey,
  readSecretBinding,
  type GatewayCredentialSecrets,
} from "./d1-credentials";
import { createD1GatewayLimitPort } from "./d1-limits";
import { createD1GatewayRetentionPort } from "./d1-retention";
import { createD1GatewayRoutesPort } from "./d1-routes";
import { createD1GatewayUpstreamHealthPort } from "./d1-upstream-health";
import { createR2GatewayBlobPort, type GatewayBlobBucket } from "./r2-blobs";
import { workersLogger } from "./workers-logger";

export const GATEWAY_BASE_PATH = "/gateway";

/**
 * Hosted-only switch for staff prompt access (#353): `"enabled"` turns on both
 * body retention in the data plane and the audited staff view. Anything else,
 * including unset (the OSS default and every self-host), is off.
 */
export function staffPromptAccessEnabled(env: Pick<Env, "GATEWAY_STAFF_PROMPT_ACCESS">): boolean {
  return env.GATEWAY_STAFF_PROMPT_ACCESS === "enabled";
}

export interface D1GatewayPortsInput {
  db: D1Database;
  secrets: GatewayCredentialSecrets;
  /** Blob storage (R2); without it `blobs` is unavailable and retention records failures. */
  bucket?: GatewayBlobBucket;
  clock?: GatewayClock;
  logger?: GatewayLogger;
  upstream?: GatewayUpstreamPort;
  /** Schedules settle runs; without it they are journaled and left to cron recovery. */
  workflow?: CloudDurableWorkflowBinding;
}

/**
 * The text/LLM credit floor of this deployment (#399): a postpaid request is
 * admitted while every hard budget is above `-floor`. A product knob in code;
 * GatewayAppOptions.creditFloor also takes a per-caller function when a
 * tenant-level floor is needed.
 */
export const GATEWAY_CREDIT_FLOOR = GATEWAY_SETTLEMENT_DEFAULTS.creditFloorMicroCredits satisfies GatewayCreditFloor;

export function createD1GatewayPorts(input: D1GatewayPortsInput): GatewayPorts {
  const clock = input.clock ?? monotonicClock();
  const logger = input.logger ?? workersLogger();
  const ids = { requestId: () => `gwr_${crypto.randomUUID().replaceAll("-", "")}` };
  const tokens = createGatewayTokenStore(input.db, { clock });
  return {
    clock,
    ids,
    // The data plane invokes models: a token without that scope is GATEWAY_FORBIDDEN.
    identity: { authenticate: (request) => tokens.verify(request, { scope: "models:invoke" }) },
    routes: createD1GatewayRoutesPort(input.db, { clock, logger }),
    credentials: createD1GatewayCredentialPort(input.db, input.secrets),
    upstreamHealth: createD1GatewayUpstreamHealthPort(input.db),
    ...createD1GatewayBudgetPorts(input.db, { clock }),
    settlement: createD1GatewaySettlementPort({
      db: input.db,
      clock,
      logger,
      ...(input.workflow ? { workflow: input.workflow } : {}),
    }),
    limits: createD1GatewayLimitPort(input.db, { clock, ids }),
    blobs: input.bucket ? createR2GatewayBlobPort(input.bucket) : unavailablePort("blobs"),
    retention: createD1GatewayRetentionPort(input.db),
    scheduler: unavailablePort("scheduler"),
    audit: unavailablePort("audit"),
    abuse: createD1GatewayAbusePort(input.db),
    logger,
    upstream: input.upstream ?? { fetch: (request) => fetch(request) },
  };
}

/**
 * Worker secrets as the credential port sees them: by name, a Worker secret
 * or a Secrets Store binding. GATEWAY_ENCRYPTION_KEY is the official KEK only
 * while it differs from the BYOK key (`gatewayEncryptionKey`).
 */
export function workerSecrets(env: Env): GatewayCredentialSecrets {
  return {
    ...gatewayEncryptionKey(env),
    secret: (name) => readSecretBinding(env, name),
  };
}

/**
 * The data plane for one request's bindings. Cheap: ports are plain closures.
 * `waitUntil` (the request's `ctx.waitUntil`) keeps a stream's settlement and
 * retention alive after its caller disconnects.
 */
export function createCloudflareGatewayApp(
  env: Env,
  options: { upstream?: GatewayUpstreamPort; waitUntil?: (promise: Promise<unknown>) => void } = {},
): GatewayApp {
  const { waitUntil, ...ports } = options;
  return createGatewayApp(
    createD1GatewayPorts({
      db: env.DB,
      secrets: workerSecrets(env),
      ...(env.R2_BUCKET ? { bucket: env.R2_BUCKET } : {}),
      ...(env.GENERATION_WORKFLOW ? { workflow: env.GENERATION_WORKFLOW } : {}),
      ...ports,
    }),
    {
      basePath: GATEWAY_BASE_PATH,
      creditFloor: GATEWAY_CREDIT_FLOOR,
      retention: { enabled: staffPromptAccessEnabled(env) },
      // Hashed into the abuse client fingerprint only (#356); never stored.
      clientAddress: (request) => request.headers.get("cf-connecting-ip"),
      ...(waitUntil ? { waitUntil } : {}),
    },
  );
}
