import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  WebTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-web";
import { LOCAL_OTLP_TRACES_PATH } from "@clash/shared-types";
import {
  readRuntimeModeAtCompositionRoot,
  runtimeApiUrl,
} from "@clash/web-ui/lib/runtimeConfig";
import { UI_TRACER_NAME } from "@clash/web-ui/lib/uiTrace";

/**
 * GUI OpenTelemetry SDK setup — the only frontend module that depends on the
 * SDK. Product code records spans through `@opentelemetry/api` (see
 * @clash/web-ui/lib/uiTrace).
 *
 * Installed in local and Desktop runtimes only. Spans go to the local Host
 * with the official OTLP/HTTP JSON exporter; the Host writes local
 * summaries and forwards them only when the user enabled telemetry export,
 * using its own endpoint and credentials. The browser never sees either.
 */

type ExportCallback = Parameters<SpanExporter["export"]>[1];

/**
 * OTLP exporter that follows the Host's current address. The Desktop Host
 * can restart on another port (see refreshRuntimeConfig), so the target is
 * resolved per batch and the official exporter is rebuilt when it changes.
 */
export class HostRoutedSpanExporter implements SpanExporter {
  private url: string | undefined;
  private delegate: SpanExporter | undefined;

  constructor(
    private readonly resolveUrl: () => string,
    private readonly create: (url: string) => SpanExporter = (url) =>
      new OTLPTraceExporter({ url }),
  ) {}

  export(spans: ReadableSpan[], done: ExportCallback): void {
    const url = this.resolveUrl();
    if (!this.delegate || url !== this.url) {
      void this.delegate?.shutdown();
      this.url = url;
      this.delegate = this.create(url);
    }
    this.delegate.export(spans, done);
  }

  forceFlush(): Promise<void> {
    return this.delegate?.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate?.shutdown() ?? Promise.resolve();
  }
}

interface RouteMatchLike {
  route: { path?: string };
}

interface RouterStateLike {
  initialized: boolean;
  navigation: { state: string };
  matches: readonly RouteMatchLike[];
}

/** Structural view of a React Router data router. */
export interface NavigationSource {
  readonly state: RouterStateLike;
  subscribe(listener: (state: RouterStateLike) => void): () => void;
}

/**
 * Route pattern of the matched branch, e.g. `/projects/:projectId`. Patterns
 * carry no ids or other parameter values.
 */
export function routePattern(matches: readonly RouteMatchLike[]): string {
  const segments = matches
    .map((match) => match.route.path?.replace(/^\/+|\/+$/g, ""))
    .filter((segment): segment is string => !!segment);
  return `/${segments.join("/")}`;
}

/**
 * `ui.page_load` from navigation start until the router first settles, then
 * one `ui.navigation` span per router transition.
 */
export function traceNavigations(
  router: NavigationSource,
  tracer: Tracer,
): () => void {
  let pageLoad: ReturnType<Tracer["startSpan"]> | undefined =
    tracer.startSpan("ui.page_load", {
      startTime: performance.timeOrigin,
    });
  let navigation: ReturnType<Tracer["startSpan"]> | undefined;

  const settle = (state: RouterStateLike) => {
    if (!state.initialized || state.navigation.state !== "idle") return false;
    const route = routePattern(state.matches);
    for (const span of [pageLoad, navigation]) {
      span?.setAttribute("clash.ui.route", route);
      span?.end();
    }
    pageLoad = undefined;
    navigation = undefined;
    return true;
  };

  settle(router.state);
  return router.subscribe((state) => {
    if (settle(state)) return;
    if (!pageLoad && !navigation && state.navigation.state !== "idle")
      navigation = tracer.startSpan("ui.navigation");
  });
}

/** `ui.error` for uncaught errors and unhandled rejections (type only). */
export function traceUncaughtErrors(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  tracer: Tracer,
): () => void {
  const record = (source: string, error: unknown) => {
    const span = tracer.startSpan("ui.error", {
      attributes: {
        "clash.ui.error.source": source,
        // Messages and stacks may echo user content; keep the type only.
        "exception.type": error instanceof Error ? error.name : typeof error,
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  const onError = (event: ErrorEvent) => record("error", event.error);
  const onRejection = (event: PromiseRejectionEvent) =>
    record("unhandledrejection", event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

export interface WebTelemetry {
  shutdown(): Promise<void>;
}

export function installWebTelemetry(options: {
  router: NavigationSource;
  serviceVersion?: string;
}): WebTelemetry | undefined {
  // Hosted Web has no local Host to receive spans.
  if (readRuntimeModeAtCompositionRoot() === "hosted") return undefined;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "clash-web",
      ...(options.serviceVersion
        ? { "service.version": options.serviceVersion }
        : {}),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new HostRoutedSpanExporter(() => runtimeApiUrl(LOCAL_OTLP_TRACES_PATH)),
      ),
    ],
  });
  provider.register();

  const tracer = trace.getTracer(UI_TRACER_NAME);
  const stopNavigations = traceNavigations(options.router, tracer);
  const stopErrors = traceUncaughtErrors(window, tracer);
  // Flush before the page goes away; the exporter uses keepalive fetch.
  const onPageHide = () => void provider.forceFlush();
  window.addEventListener("pagehide", onPageHide);

  return {
    async shutdown() {
      stopNavigations();
      stopErrors();
      window.removeEventListener("pagehide", onPageHide);
      await provider.shutdown();
    },
  };
}
