/**
 * OpenTelemetry bootstrap for render-server. Built as its own tsup entry and
 * loaded before the app (`node --import ./dist/telemetry.js dist/index.js`)
 * so node:http and fetch are instrumented as they load. Export follows the
 * standard OTEL_* environment and is off until an OTLP endpoint is set
 * (OTEL_EXPORTER_OTLP_ENDPOINT); OTEL_SDK_DISABLED=true turns it off
 * regardless.
 */
import { startNodeTelemetry } from "@clash/shared-telemetry/node";

await startNodeTelemetry({ serviceName: "clash-render-server" });
