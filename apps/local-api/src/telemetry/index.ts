/**
 * Host OpenTelemetry: the only Host module that depends on the OTel SDK.
 * Instrumented code depends on `@opentelemetry/api` alone.
 */
export {
  createTelemetryConfigResource,
  type TelemetryConfigResource,
} from "./config-store.js";
export {
  createOtlpTraceExporter,
  OTLP_TRACE_EXPORTERS,
  type OtlpTraceExporterConfig,
  type OtlpTraceExporterFactory,
} from "./exporters.js";
export {
  createHostTelemetry,
  installHostTelemetry,
  type HostTelemetry,
  type HostTelemetryOptions,
} from "./pipeline.js";
export { SpanLogProcessor, SwitchableSpanProcessor } from "./processors.js";
export {
  parseOtlpHeaders,
  resolveTelemetryExport,
  resolveTelemetryValues,
  type TelemetryEnv,
  type TelemetryExportResolution,
  type TelemetrySettings,
} from "./resolve.js";
export {
  DEFAULT_OTLP_INGEST_LIMITS,
  decodeOtlpJsonTraces,
  type OtlpDecodeResult,
  type OtlpIngestLimits,
} from "./otlp-ingest.js";
