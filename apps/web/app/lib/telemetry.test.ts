import { describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-web";

import {
  HostRoutedSpanExporter,
  routePattern,
  traceNavigations,
  traceUncaughtErrors,
  type NavigationSource,
} from "./telemetry";

function recorder() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {
    tracer: provider.getTracer("clash.web.test"),
    spans: () => exporter.getFinishedSpans(),
  };
}

type State = NavigationSource["state"];

function fakeRouter(initial: State) {
  let state = initial;
  let listener: ((state: State) => void) | undefined;
  return {
    get state() {
      return state;
    },
    subscribe(next: (state: State) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit(next: State) {
      state = next;
      listener?.(next);
    },
  } satisfies NavigationSource & { emit(state: State): void };
}

const projectRoute = [
  { route: {} },
  { route: { path: "projects" } },
  { route: { path: ":projectId" } },
];

describe("routePattern", () => {
  it("joins matched path patterns without parameter values", () => {
    expect(routePattern(projectRoute)).toBe("/projects/:projectId");
    expect(routePattern([{ route: {} }])).toBe("/");
  });
});

describe("traceNavigations", () => {
  it("records page load until the router settles, then each navigation", () => {
    const { tracer, spans } = recorder();
    const router = fakeRouter({
      initialized: false,
      navigation: { state: "idle" },
      matches: [],
    });
    const stop = traceNavigations(router, tracer);
    expect(spans()).toHaveLength(0);

    router.emit({ initialized: true, navigation: { state: "idle" }, matches: [{ route: {} }] });
    router.emit({ initialized: true, navigation: { state: "loading" }, matches: [{ route: {} }] });
    router.emit({ initialized: true, navigation: { state: "idle" }, matches: projectRoute });
    stop();

    expect(spans().map((span) => [span.name, span.attributes["clash.ui.route"]])).toEqual([
      ["ui.page_load", "/"],
      ["ui.navigation", "/projects/:projectId"],
    ]);
  });
});

describe("traceUncaughtErrors", () => {
  it("records the error type and never the message", () => {
    const { tracer, spans } = recorder();
    const target = new EventTarget();
    const stop = traceUncaughtErrors(target as unknown as Window, tracer);
    target.dispatchEvent(
      Object.assign(new Event("error"), { error: new TypeError("secret prompt") }),
    );
    stop();
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("x") }));

    expect(spans()).toHaveLength(1);
    const [span] = spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["exception.type"]).toBe("TypeError");
    expect(JSON.stringify(span?.attributes)).not.toContain("secret prompt");
  });
});

describe("HostRoutedSpanExporter", () => {
  it("rebuilds the delegate exporter when the Host address changes", () => {
    const created: string[] = [];
    let url = "http://127.0.0.1:4100/api/v1/local/otlp/v1/traces";
    const exporter = new HostRoutedSpanExporter(
      () => url,
      (target): SpanExporter => {
        created.push(target);
        return new InMemorySpanExporter();
      },
    );
    const done = () => {};
    exporter.export([], done);
    exporter.export([], done);
    url = "http://127.0.0.1:4200/api/v1/local/otlp/v1/traces";
    exporter.export([], done);
    expect(created).toEqual([
      "http://127.0.0.1:4100/api/v1/local/otlp/v1/traces",
      "http://127.0.0.1:4200/api/v1/local/otlp/v1/traces",
    ]);
  });
});
