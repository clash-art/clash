import { TraceFlags, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type Span,
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
  /** Finished spans not yet confirmed exported; best effort, for shutdown diagnostics. */
  readonly pendingSpans?: number;
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

/** Counts spans handed to the batch processor before they reach the exporter. */
class PendingSpanCounter implements SpanProcessor {
  constructor(
    private readonly next: SpanProcessor,
    private readonly count: () => void,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0)
      this.count();
    this.next.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/** Counts spans only once the exporter acknowledges (success or failure). */
function countExportedSpans(
  exporter: SpanExporter,
  count: (spans: number) => void,
): SpanExporter {
  return {
    export(spans, resultCallback) {
      exporter.export(spans, (result) => {
        count(spans.length);
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    ...(exporter.forceFlush
      ? { forceFlush: () => exporter.forceFlush!() }
      : {}),
  };
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
  let queuedSpans = 0;
  let exportedSpans = 0;
  let shutdownPromise: Promise<void> | undefined;

  return {
    provider,
    get exporting() {
      return exportSlot.active;
    },
    get pendingSpans() {
      return Math.max(0, queuedSpans - exportedSpans);
    },
    ingest(spans) {
      for (const span of spans)
        for (const processor of processors) processor.onEnd(span);
    },
    applyExport(resolution) {
      // Any previous swap may have rejected (for example the exporter factory
      // threw). Recover before chaining so one bad change cannot silently
      // disable every later change, including turning export back off.
      const swap = pending
        .catch(() => undefined)
        .then(async () => {
          const next = resolution.enabled
            ? new PendingSpanCounter(
                new BatchSpanProcessor(
                  countExportedSpans(createExporter(resolution), (spans) => {
                    exportedSpans += spans;
                  }),
                ),
                () => {
                  queuedSpans += 1;
                },
              )
            : undefined;
          await exportSlot.replace(next);
          if (!next) {
            queuedSpans = 0;
            exportedSpans = 0;
          }
        });
      pending = swap;
      return swap;
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        await pending.catch(() => undefined);
        // Flush the live export slot explicitly. `provider.shutdown()` routes
        // through `exportSlot.shutdown()`, which swallows a failing exporter;
        // flushing here keeps an export failure visible to the caller (the
        // server logs it as TELEMETRY_FLUSH_FAILED) while still shutting the
        // provider down.
        let failure: unknown;
        try {
          await exportSlot.forceFlush();
        } catch (error) {
          failure = error;
        }
        try {
          await provider.shutdown();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      })();
      return shutdownPromise;
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
