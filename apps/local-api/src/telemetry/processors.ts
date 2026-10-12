import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { LogRecord } from "@clash/shared-runtime/logging";
import { spanSnapshotToLogRecord } from "@clash/shared-runtime/tracing";

type HrTime = [number, number];

function hrTimeToUnixNano([seconds, nanos]: HrTime): string {
  return (BigInt(seconds) * 1_000_000_000n + BigInt(nanos)).toString();
}

function hrTimeToMs([seconds, nanos]: HrTime): number {
  return seconds * 1000 + nanos / 1_000_000;
}

/**
 * Summarises every finished span as a `span.end` LogRecord in the Host's
 * local JSONL logs, so `clash logs` can correlate by trace id without any
 * collector.
 */
export class SpanLogProcessor implements SpanProcessor {
  constructor(private readonly emit: (record: LogRecord) => void) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    try {
      const { traceId, spanId } = span.spanContext();
      this.emit(
        spanSnapshotToLogRecord(
          {
            name: span.name,
            kind: span.kind,
            traceId,
            spanId,
            ...(span.parentSpanContext
              ? { parentSpanId: span.parentSpanContext.spanId }
              : {}),
            startTimeUnixNano: hrTimeToUnixNano(span.startTime),
            endTimeUnixNano: hrTimeToUnixNano(span.endTime),
            durationMs: hrTimeToMs(span.duration),
            attributes: { ...span.attributes },
            events: span.events.map((event) => ({
              name: event.name,
              timeUnixNano: hrTimeToUnixNano(event.time),
              ...(event.attributes
                ? { attributes: { ...event.attributes } }
                : {}),
            })),
            status: {
              code: span.status.code,
              ...(span.status.message ? { message: span.status.message } : {}),
            },
          },
          span.instrumentationScope.name,
        ),
      );
    } catch {
      // Local summaries must never break the traced code path.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** A span processor slot whose occupant can be swapped while running. */
export class SwitchableSpanProcessor implements SpanProcessor {
  private delegate: SpanProcessor | undefined;

  get active(): boolean {
    return this.delegate !== undefined;
  }

  /** Install `next`; the previous processor is flushed and shut down. */
  async replace(next: SpanProcessor | undefined): Promise<void> {
    const previous = this.delegate;
    this.delegate = next;
    await previous?.shutdown().catch(() => undefined);
  }

  onStart(span: Span, parentContext: Context): void {
    this.delegate?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.delegate?.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.replace(undefined);
  }
}
