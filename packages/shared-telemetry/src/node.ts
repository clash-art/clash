import { register } from "node:module";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { createAddHookMessageChannel } from "import-in-the-middle";

/**
 * OpenTelemetry for Clash Node services (api-node, render-server), on the
 * official NodeSDK and its standard environment configuration.
 *
 * Everything about export is the SDK's documented environment behaviour:
 * `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`
 * default to `otlp`, `OTEL_EXPORTER_OTLP_*` select endpoint, protocol and
 * headers, `OTEL_SDK_DISABLED=true` turns it all off, and `OTEL_SERVICE_NAME`
 * / `OTEL_RESOURCE_ATTRIBUTES` override the defaults passed here.
 *
 * Load this before application code (`node --import <bootstrap>`): the
 * instrumentations patch `node:http`, `pg` and fetch (undici) as they load,
 * which for ES modules needs the official loader hook registered first.
 */

export interface NodeTelemetryOptions {
  /** Default `service.name`; `OTEL_SERVICE_NAME` takes precedence. */
  serviceName: string;
  serviceVersion?: string;
}

export interface NodeTelemetry {
  /** Flush and stop all providers; call from the service's shutdown path. */
  shutdown(): Promise<void>;
}

// The SDK handle lives on a global symbol, not module state: a bundled
// service can inline this module into both its --import bootstrap and its
// app entry, and shutdown from the app must reach the bootstrap's SDK.
const RUNNING = Symbol.for("clash.shared-telemetry.node");
type TelemetryGlobal = { [RUNNING]?: NodeTelemetry };
const registry = globalThis as TelemetryGlobal;

/**
 * Start the SDK. Await it in the bootstrap (top-level await) so the ESM
 * loader knows every instrumented module before application code imports.
 */
export async function startNodeTelemetry(
  options: NodeTelemetryOptions,
): Promise<NodeTelemetry> {
  const existing = registry[RUNNING];
  if (existing) return existing;
  // ESM loader hook limited to modules an instrumentation actually hooks
  // (import-in-the-middle "Only Intercepting Hooked modules"). The default
  // hook wraps every module, which costs startup time and fails noisily on
  // TypeScript sources loaded through tsx.
  const { registerOptions, waitForAllMessagesAcknowledged } =
    createAddHookMessageChannel();
  register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions);

  const sdk = new NodeSDK({
    // Merged under detected resources, so OTEL_SERVICE_NAME and
    // OTEL_RESOURCE_ATTRIBUTES win over these defaults.
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      ...(options.serviceVersion
        ? { "service.version": options.serviceVersion }
        : {}),
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new PgInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  await waitForAllMessagesAcknowledged();
  const running: NodeTelemetry = {
    shutdown: async () => {
      if (registry[RUNNING] === running) delete registry[RUNNING];
      await sdk.shutdown();
    },
  };
  registry[RUNNING] = running;
  return running;
}

/** Shut down the running SDK, if any (idempotent). */
export async function shutdownNodeTelemetry(): Promise<void> {
  await registry[RUNNING]?.shutdown();
}
