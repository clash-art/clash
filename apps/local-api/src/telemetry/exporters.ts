import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { OtlpProtocol } from "@clash/shared-types";

import { createHostLazyModule } from "../host-lazy-module.js";
import type { TelemetryExportResolution } from "./resolve.js";

/** Explicit exporter options; nothing is read from the environment. */
export interface OtlpTraceExporterConfig {
  url: string;
  headers: Record<string, string>;
}

export type OtlpTraceExporterFactory = (
  config: OtlpTraceExporterConfig,
) => SpanExporter;

/**
 * One official OTel exporter per supported OTLP transport.
 *
 * Export is off by default, so the exporter packages are imported when export is first enabled
 * rather than at Host startup.
 */
export const loadOtlpTraceExporters = createHostLazyModule(
  "@opentelemetry/exporter-trace-otlp",
  async (): Promise<Readonly<Record<OtlpProtocol, OtlpTraceExporterFactory>>> => {
    const [json, proto] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-trace-otlp-proto"),
    ]);
    return {
      "http/protobuf": (config) => new proto.OTLPTraceExporter(config),
      "http/json": (config) => new json.OTLPTraceExporter(config),
    };
  },
);

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

export async function createOtlpTraceExporter(
  resolution: Extract<TelemetryExportResolution, { enabled: true }>,
  factories?: Readonly<Record<OtlpProtocol, OtlpTraceExporterFactory>>,
): Promise<SpanExporter> {
  const factory = (factories ?? (await loadOtlpTraceExporters()))[
    resolution.protocol
  ];
  return withoutOtlpEnvOverrides(() =>
    factory({ url: resolution.endpoint, headers: resolution.headers }),
  );
}
