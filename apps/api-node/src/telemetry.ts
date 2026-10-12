/**
 * OpenTelemetry bootstrap for the api-node HTTP server. Load it before the
 * application (`--import ./src/telemetry.ts`) so node:http, pg and fetch are
 * instrumented as they load. Export follows the standard OTEL_* environment
 * (OTLP to localhost:4318 by default; OTEL_SDK_DISABLED=true turns it off).
 */
import { startNodeTelemetry } from "@clash/shared-telemetry/node";

await startNodeTelemetry({ serviceName: "clash-api-node" });
