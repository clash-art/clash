import {
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Exception,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";

/**
 * OpenTelemetry API on top of Cloudflare Workers' native tracing.
 *
 * Workers trace fetch, bindings, Durable Object and RPC calls themselves and
 * export through the platform's OTLP destinations (wrangler
 * `[observability.traces]`). Installing this provider makes spans created by
 * shared code through `@opentelemetry/api` native custom spans, so they nest
 * under the platform spans in one trace instead of forming a second tree.
 *
 * Native custom spans currently lack span ids, status and events
 * (developers.cloudflare.com/workers/observability/traces/custom-spans,
 * "Limitations"). Accordingly:
 * - `spanContext()` is the invalid context (no manual propagation);
 * - status maps to the OTel non-OTLP convention `otel.status_code` /
 *   `otel.status_description` attributes;
 * - events and links are dropped;
 * - nesting follows the runtime's async context; an explicit parent
 *   `Context` argument is ignored.
 */

/** The subset of `cloudflare:workers` `tracing` this adapter relies on. */
export interface WorkersNativeSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: string | number | boolean): void;
  end(): void;
  recordException?(exception: unknown): void;
}

export interface WorkersNativeTracing {
  startActiveSpan<T>(name: string, callback: (span: WorkersNativeSpan) => T): T;
}

function nativeValue(value: AttributeValue): string | number | boolean {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

class WorkersSpan implements Span {
  constructor(private readonly native: WorkersNativeSpan) {}

  spanContext(): SpanContext {
    return INVALID_SPAN_CONTEXT;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (value !== undefined && value !== null)
      this.native.setAttribute(key, nativeValue(value));
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes))
      if (value !== undefined) this.setAttribute(key, value);
    return this;
  }

  addEvent(): this {
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (status.code === SpanStatusCode.UNSET) return this;
    this.native.setAttribute(
      "otel.status_code",
      status.code === SpanStatusCode.ERROR ? "ERROR" : "OK",
    );
    if (status.message)
      this.native.setAttribute("otel.status_description", status.message);
    return this;
  }

  updateName(): this {
    return this;
  }

  end(): void {
    this.native.end();
  }

  isRecording(): boolean {
    return this.native.isTraced;
  }

  recordException(exception: Exception): void {
    if (this.native.recordException) {
      this.native.recordException(exception);
      return;
    }
    if (typeof exception === "string") {
      this.native.setAttribute("exception.message", exception);
      return;
    }
    if (exception.name) this.native.setAttribute("exception.type", exception.name);
    if (exception.message)
      this.native.setAttribute("exception.message", exception.message);
  }
}

type ActiveCallback<F> = (span: Span) => F;

class WorkersTracer implements Tracer {
  constructor(
    private readonly tracing: WorkersNativeTracing,
    private readonly scope: string,
  ) {}

  private open<F>(
    name: string,
    options: SpanOptions | undefined,
    run: (span: WorkersSpan) => F,
  ): F {
    return this.tracing.startActiveSpan(name, (native) => {
      const span = new WorkersSpan(native);
      span.setAttribute("otel.scope.name", this.scope);
      if (options?.attributes) span.setAttributes(options.attributes);
      return run(span);
    });
  }

  startSpan(name: string, options?: SpanOptions, _context?: Context): Span {
    // Active only for the (empty) callback: an open span nothing nests under,
    // which is the OTel `startSpan` contract.
    return this.open(name, options, (span) => span);
  }

  startActiveSpan<F extends ActiveCallback<unknown>>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends ActiveCallback<unknown>>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends ActiveCallback<unknown>>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends ActiveCallback<unknown>>(
    name: string,
    ...args: [F] | [SpanOptions, F] | [SpanOptions, Context, F]
  ): ReturnType<F> {
    const fn = args[args.length - 1] as F;
    const options = args.length > 1 ? (args[0] as SpanOptions) : undefined;
    return this.open(name, options, (span) => fn(span) as ReturnType<F>);
  }
}

export class WorkersTracerProvider implements TracerProvider {
  constructor(private readonly tracing: WorkersNativeTracing) {}

  getTracer(name: string): Tracer {
    return new WorkersTracer(this.tracing, name);
  }
}

/**
 * Register the adapter as the global OTel tracer provider. Returns false
 * when the runtime has no native tracing (older workerd) or a provider is
 * already registered in this isolate.
 */
export function installWorkersTracing(
  tracing: Partial<WorkersNativeTracing> | undefined,
): boolean {
  if (typeof tracing?.startActiveSpan !== "function") return false;
  return trace.setGlobalTracerProvider(
    new WorkersTracerProvider(tracing as WorkersNativeTracing),
  );
}
