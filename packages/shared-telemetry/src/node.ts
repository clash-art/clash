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
 * Export is the SDK's documented environment behaviour with one deliberate
 * difference: an OTLP exporter needs an explicit endpoint. The SDK's own
 * default is `http://localhost:4318`, which in a deployment without a
 * collector means endless failed exports and retry noise, so a signal whose
 * exporter is `otlp` (the default) stays off until
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or its own
 * `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` is set. With no signal
 * on, the SDK is not started at all. Otherwise `OTEL_TRACES_EXPORTER` /
 * `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_*`
 * protocol and headers, `OTEL_SDK_DISABLED=true`, and `OTEL_SERVICE_NAME` /
 * `OTEL_RESOURCE_ATTRIBUTES` (overriding the defaults passed here) apply
 * unchanged.
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

export interface NodeTelemetrySignals {
  traces: boolean;
  metrics: boolean;
  logs: boolean;
}

type TelemetryEnv = Record<string, string | undefined>;

function envValue(env: TelemetryEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function exportsSignal(
  env: TelemetryEnv,
  signal: "TRACES" | "METRICS" | "LOGS",
): boolean {
  const exporters = (envValue(env, `OTEL_${signal}_EXPORTER`) ?? "otlp")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (exporters.includes("none")) return false;
  // console, prometheus and zipkin do not use the OTLP endpoint.
  if (!exporters.includes("otlp")) return true;
  return (
    envValue(env, `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`) !== undefined ||
    envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT") !== undefined
  );
}

/**
 * Which signals the environment asks to export. `OTEL_SDK_DISABLED=true`
 * wins over everything; an `otlp` exporter without an endpoint is off.
 */
export function resolveNodeTelemetrySignals(
  env: TelemetryEnv = process.env,
): NodeTelemetrySignals {
  if (envValue(env, "OTEL_SDK_DISABLED")?.toLowerCase() === "true") {
    return { traces: false, metrics: false, logs: false };
  }
  return {
    traces: exportsSignal(env, "TRACES"),
    metrics: exportsSignal(env, "METRICS"),
    logs: exportsSignal(env, "LOGS"),
  };
}

const NOT_STARTED: NodeTelemetry = { shutdown: async () => {} };

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
  const signals = resolveNodeTelemetrySignals();
  // Nothing to export: no SDK, no loader hook, no instrumentation. The
  // @opentelemetry/api no-op providers stay in place and stdout logs work.
  if (!signals.traces && !signals.metrics && !signals.logs) return NOT_STARTED;
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
    // An explicit empty list keeps the SDK from building that signal's
    // environment default (an OTLP exporter aimed at localhost:4318);
    // leaving the option out hands the signal to the OTEL_* environment.
    ...(signals.traces ? {} : { spanProcessors: [] }),
    ...(signals.metrics ? {} : { metricReaders: [] }),
    ...(signals.logs ? {} : { logRecordProcessors: [] }),
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
