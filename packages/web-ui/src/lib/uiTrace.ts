import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
} from "@opentelemetry/api";
import { formatTraceparent } from "@clash/shared-runtime/tracing";

/**
 * Typed GUI action tracing on the OpenTelemetry API.
 *
 * Product code records user actions here and never touches the SDK; the app
 * shell (apps/web/app/telemetry.ts) installs the SDK in local and Desktop
 * runtimes. Without it every call is a no-op and no traceparent is produced.
 *
 * Actions and their attributes are a closed, typed table: spans carry ids,
 * counts and flags only — never prompt text, file names or other content.
 */

export const UI_TRACER_NAME = "clash.web";

/** Every traced GUI action and the only attributes it may carry. */
export interface UiActionAttributes {
  /** A prompt frame handed to the Host for an agent turn. */
  "prompt.send": {
    "clash.prompt.chars": number;
    /** Sent from the client-side prompt queue rather than directly. */
    "clash.prompt.queued": boolean;
  };
}

export type UiAction = keyof UiActionAttributes;

export interface ActionTrace {
  /**
   * W3C traceparent of the action span, for hand-off to the Host (e.g. on a
   * prompt frame). Undefined when tracing is not installed.
   */
  readonly traceparent: string | undefined;
}

function traceparentOf(span: Span): string | undefined {
  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return undefined;
  return formatTraceparent({
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    sampled: (spanContext.traceFlags & 1) === 1,
  });
}

function fail(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  // The error type only; messages may echo user content.
  span.setAttribute(
    "exception.type",
    error instanceof Error ? error.name : typeof error,
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run `run` inside a span for `action`. The span ends when `run` returns, or
 * when its returned promise settles; a throw or rejection marks it failed
 * and is rethrown unchanged.
 */
export function withActionTrace<A extends UiAction, T>(
  action: A,
  attributes: UiActionAttributes[A],
  run: (trace: ActionTrace) => T,
): T {
  const span = trace.getTracer(UI_TRACER_NAME).startSpan(`ui.${action}`, {
    kind: SpanKind.INTERNAL,
    attributes: { "clash.ui.action": action, ...attributes },
  });
  const handle: ActionTrace = { traceparent: traceparentOf(span) };
  let result: T;
  try {
    result = context.with(trace.setSpan(context.active(), span), () =>
      run(handle),
    );
  } catch (error) {
    fail(span, error);
    span.end();
    throw error;
  }
  if (isPromiseLike(result)) {
    result.then(
      () => span.end(),
      (error: unknown) => {
        fail(span, error);
        span.end();
      },
    );
  } else {
    span.end();
  }
  return result;
}
