/**
 * OpenTelemetry bootstrap for the outbox worker process; same contract as
 * ./telemetry.ts with its own default service name.
 */
import { startNodeTelemetry } from "@clash/shared-telemetry/node";

await startNodeTelemetry({ serviceName: "clash-api-node-outbox" });
