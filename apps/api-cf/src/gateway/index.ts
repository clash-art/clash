/**
 * Workers/D1 adapter for the model gateway data plane (#347). Builds
 * gateway-core's GatewayPorts over D1 and mounts `createGatewayApp` at
 * `/gateway/v1/*` (registered in routes/gateway.ts beside `/gateway/me`).
 *
 * Identity: the sk_gw_ token only (services/gateway-tokens.ts); no header,
 * x-user-id included, is read as identity. Ports this deployment does not
 * implement yet (blobs, scheduler, audit) are explicit `unavailablePort`s that
 * answer GATEWAY_CAPABILITY_UNAVAILABLE. Guide: apps/docs/guide/gateway-data-plane.md.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  createGatewayApp,
  unavailablePort,
  type GatewayApp,
  type GatewayClock,
  type GatewayLogger,
  type GatewayPorts,
  type GatewayUpstreamPort,
} from "@clash/gateway-core";

import type { Env } from "../config";
import { serverLog } from "../logger";
import { createGatewayTokenStore } from "../services/gateway-tokens";
import { createD1GatewayBudgetPorts } from "./d1-budgets";
import { monotonicClock } from "./d1-common";
import { createD1GatewayCredentialPort, type GatewayCredentialSecrets } from "./d1-credentials";
import { createD1GatewayLimitPort } from "./d1-limits";
import { createD1GatewayRoutesPort } from "./d1-routes";

export const GATEWAY_BASE_PATH = "/gateway";

export interface D1GatewayPortsInput {
  db: D1Database;
  secrets: GatewayCredentialSecrets;
  clock?: GatewayClock;
  logger?: GatewayLogger;
  upstream?: GatewayUpstreamPort;
}

function workersLogger(): GatewayLogger {
  const log = serverLog.child("gateway");
  const safe =
    (level: "info" | "warn" | "error"): GatewayLogger["info"] =>
    (event, fields) => {
      try {
        log[level](event, fields ?? {});
      } catch {
        // GatewayLogger must never throw.
      }
    };
  return { info: safe("info"), warn: safe("warn"), error: safe("error") };
}

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
    ...createD1GatewayBudgetPorts(input.db, { clock }),
    limits: createD1GatewayLimitPort(input.db, { clock, ids }),
    blobs: unavailablePort("blobs"),
    scheduler: unavailablePort("scheduler"),
    audit: unavailablePort("audit"),
    logger,
    upstream: input.upstream ?? { fetch: (request) => fetch(request) },
  };
}

/** Worker secrets as the credential port sees them: by name, strings only. */
export function workerSecrets(env: Env): GatewayCredentialSecrets {
  const bindings = env as unknown as Record<string, unknown>;
  return {
    ...(env.GATEWAY_ENCRYPTION_KEY ? { encryptionKey: env.GATEWAY_ENCRYPTION_KEY } : {}),
    secret: (name) => {
      const value = bindings[name];
      return typeof value === "string" ? value : undefined;
    },
  };
}

/** The data plane for one request's bindings. Cheap: ports are plain closures. */
export function createCloudflareGatewayApp(
  env: Env,
  options: { upstream?: GatewayUpstreamPort } = {},
): GatewayApp {
  return createGatewayApp(
    createD1GatewayPorts({ db: env.DB, secrets: workerSecrets(env), ...options }),
    { basePath: GATEWAY_BASE_PATH },
  );
}
