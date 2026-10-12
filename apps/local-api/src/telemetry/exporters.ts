import { OTLPTraceExporter as OtlpJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OtlpProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { OtlpProtocol } from "@clash/shared-types";

import type { TelemetryExportResolution } from "./resolve.js";

/** Explicit exporter options; nothing is read from the environment. */
export interface OtlpTraceExporterConfig {
  url: string;
  headers: Record<string, string>;
}

export type OtlpTraceExporterFactory = (
  config: OtlpTraceExporterConfig,
) => SpanExporter;

/** One official OTel exporter per supported OTLP transport. */
export const OTLP_TRACE_EXPORTERS: Readonly<
  Record<OtlpProtocol, OtlpTraceExporterFactory>
> = {
  "http/protobuf": (config) => new OtlpProtoTraceExporter(config),
  "http/json": (config) => new OtlpJsonTraceExporter(config),
};

const OTLP_ENV_OVERRIDES =
  /^OTEL_EXPORTER_OTLP_(?:TRACES_)?(?:ENDPOINT|HEADERS)$/;

/**
 * The official OTLP exporters merge `OTEL_EXPORTER_OTLP_*` endpoint and
 * header variables from `process.env` into explicit options when they are
 * constructed. Settings must win over the environment, and environment
 * credentials must never reach an endpoint chosen in Settings, so build the
 * exporter with those variables hidden. Construction is synchronous, so no
 * other code can observe the masked environment.
 */
function withoutOtlpEnvOverrides<T>(construct: () => T): T {
  const hidden: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && OTLP_ENV_OVERRIDES.test(key)) {
      hidden.push([key, value]);
      delete process.env[key];
    }
  }
  try {
    return construct();
  } finally {
    for (const [key, value] of hidden) process.env[key] = value;
  }
}

export function createOtlpTraceExporter(
  resolution: Extract<TelemetryExportResolution, { enabled: true }>,
  factories: Readonly<
    Record<OtlpProtocol, OtlpTraceExporterFactory>
  > = OTLP_TRACE_EXPORTERS,
): SpanExporter {
  const factory = factories[resolution.protocol];
  return withoutOtlpEnvOverrides(() =>
    factory({ url: resolution.endpoint, headers: resolution.headers }),
  );
}
