import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { LogRecord } from "@clash/shared-runtime/logging";

import { createOtlpTraceExporter } from "./exporters.js";
import { SpanLogProcessor, SwitchableSpanProcessor } from "./processors.js";
import type { TelemetryExportResolution } from "./resolve.js";

/** The Host's OpenTelemetry pipeline, as seen by the rest of the Host. */
export interface HostTelemetry {
  /** Start, retarget or stop OTLP export for a new resolution. */
  applyExport(resolution: TelemetryExportResolution): Promise<void>;
  /**
   * Hand finished spans recorded by a local client (decoded from OTLP) to
   * the same processors as Host spans: local summary, then export if on.
   */
  ingest(spans: readonly ReadableSpan[]): void;
  readonly exporting: boolean;
  shutdown(): Promise<void>;
}

export interface HostTelemetryOptions {
  emitLog: (record: LogRecord) => void;
  serviceVersion?: string;
  createExporter?: (
    resolution: Extract<TelemetryExportResolution, { enabled: true }>,
  ) => SpanExporter;
  /** Register as the process-global provider (default true). */
  register?: boolean;
}

/**
 * Provider with two processors:
 * - `SpanLogProcessor`, always on: local `span.end` summaries;
 * - a switchable `BatchSpanProcessor` + OTLP exporter, present only while
 *   export is enabled.
 */
export function createHostTelemetry(
  options: HostTelemetryOptions,
): HostTelemetry & { readonly provider: NodeTracerProvider } {
  const exportSlot = new SwitchableSpanProcessor();
  const processors: readonly SpanProcessor[] = [
    new SpanLogProcessor(options.emitLog),
    exportSlot,
  ];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "clash-host",
      ...(options.serviceVersion
        ? { "service.version": options.serviceVersion }
        : {}),
    }),
    spanProcessors: [...processors],
  });
  if (options.register !== false) provider.register();
  const createExporter = options.createExporter ?? createOtlpTraceExporter;
  // Serialise swaps so a slow flush cannot reorder two updates.
  let pending = Promise.resolve();

  return {
    provider,
    get exporting() {
      return exportSlot.active;
    },
    ingest(spans) {
      for (const span of spans)
        for (const processor of processors) processor.onEnd(span);
    },
    applyExport(resolution) {
      pending = pending.then(() =>
        exportSlot.replace(
          resolution.enabled
            ? new BatchSpanProcessor(createExporter(resolution))
            : undefined,
        ),
      );
      return pending;
    },
    async shutdown() {
      await pending.catch(() => undefined);
      await provider.shutdown();
    },
  };
}

let processTelemetry: HostTelemetry | undefined;

/**
 * Process-wide Host telemetry. Summaries go to stdout as structured lines,
 * which the Host entry's stdio capture persists under logs/local-api.
 */
export function installHostTelemetry(
  options: Partial<HostTelemetryOptions> = {},
): HostTelemetry {
  processTelemetry ??= createHostTelemetry({
    emitLog: (record) => console.log(JSON.stringify(record)),
    ...options,
  });
  return processTelemetry;
}
