/**
 * OpenTelemetry bootstrap for the api-node HTTP server. Load it before the
 * application (`--import ./src/telemetry.ts`) so node:http, pg and fetch are
 * instrumented as they load. Export follows the standard OTEL_* environment
 * and is off until an OTLP endpoint is set (OTEL_EXPORTER_OTLP_ENDPOINT);
 * OTEL_SDK_DISABLED=true turns it off regardless.
 */
import { startNodeTelemetry } from "@clash/shared-telemetry/node";

await startNodeTelemetry({ serviceName: "clash-api-node" });
