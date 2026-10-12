import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveNodeTelemetrySignals,
  shutdownNodeTelemetry,
  startNodeTelemetry,
} from "./node.ts";

const sdk = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  started: 0,
}));
const loader = vi.hoisted(() => ({ registered: 0 }));

// The SDK and loader hook are process-global; the in-process tests only
// observe whether and how startNodeTelemetry reaches them. The subprocess
// tests below run the real ones.
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
    }
    start() {
      sdk.started += 1;
    }
    async shutdown() {}
  },
}));
vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  register: () => {
    loader.registered += 1;
  },
}));
// With register mocked no loader thread exists to acknowledge hook messages.
vi.mock("import-in-the-middle", () => ({
  createAddHookMessageChannel: () => ({
    registerOptions: {},
    waitForAllMessagesAcknowledged: async () => {},
  }),
}));

const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

/** Parent environment without any OTEL_* the developer's shell may carry. */
function envWithoutOtel(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_")),
  );
}

const ENDPOINT = "http://collector.example:4318";

describe("resolveNodeTelemetrySignals", () => {
  it("enables nothing without an OTLP endpoint", () => {
    expect(resolveNodeTelemetrySignals({})).toEqual({
      traces: false,
      metrics: false,
      logs: false,
    });
    expect(
      resolveNodeTelemetrySignals({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }),
    ).toEqual({ traces: false, metrics: false, logs: false });
  });

  it("enables every signal with the generic endpoint", () => {
    expect(
      resolveNodeTelemetrySignals({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }),
    ).toEqual({ traces: true, metrics: true, logs: true });
  });

  it.each([
    ["TRACES", "traces"],
    ["METRICS", "metrics"],
    ["LOGS", "logs"],
  ] as const)(
    "OTEL_EXPORTER_OTLP_%s_ENDPOINT enables only %s",
    (variable, signal) => {
      expect(
        resolveNodeTelemetrySignals({
          [`OTEL_EXPORTER_OTLP_${variable}_ENDPOINT`]: ENDPOINT,
        }),
      ).toEqual({ traces: false, metrics: false, logs: false, [signal]: true });
    },
  );

  it("OTEL_SDK_DISABLED=true wins over a configured endpoint", () => {
    expect(
      resolveNodeTelemetrySignals({
        OTEL_SDK_DISABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
        OTEL_TRACES_EXPORTER: "console",
      }),
    ).toEqual({ traces: false, metrics: false, logs: false });
  });

  it("an exporter of none stays off with an endpoint", () => {
    expect(
      resolveNodeTelemetrySignals({
        OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
        OTEL_LOGS_EXPORTER: "none",
      }),
    ).toEqual({ traces: true, metrics: true, logs: false });
  });

  it("a non-OTLP exporter needs no endpoint", () => {
    expect(
      resolveNodeTelemetrySignals({ OTEL_TRACES_EXPORTER: "console" }),
    ).toEqual({ traces: true, metrics: false, logs: false });
  });
});

describe("startNodeTelemetry environment gate", () => {
  afterEach(async () => {
    await shutdownNodeTelemetry();
    vi.unstubAllEnvs();
    sdk.options.length = 0;
    sdk.started = 0;
    loader.registered = 0;
  });

  function stubEnv(values: Record<string, string>): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OTEL_")) vi.stubEnv(key, undefined);
    }
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  }

  it("does not construct or start the SDK without an endpoint", async () => {
    stubEnv({});
    const telemetry = await startNodeTelemetry({ serviceName: "test" });
    expect(sdk.options).toEqual([]);
    expect(sdk.started).toBe(0);
    expect(loader.registered).toBe(0);
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it("starts the SDK with every signal left to the environment when an endpoint is set", async () => {
    stubEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT });
    await startNodeTelemetry({ serviceName: "test" });
    expect(sdk.started).toBe(1);
    expect(loader.registered).toBe(1);
    expect(sdk.options[0]).not.toHaveProperty("spanProcessors");
    expect(sdk.options[0]).not.toHaveProperty("metricReaders");
    expect(sdk.options[0]).not.toHaveProperty("logRecordProcessors");
  });

  it("gives signals without an endpoint no processors or readers", async () => {
    stubEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ENDPOINT });
    await startNodeTelemetry({ serviceName: "test" });
    expect(sdk.started).toBe(1);
    expect(sdk.options[0]).not.toHaveProperty("spanProcessors");
    expect(sdk.options[0]).toMatchObject({
      metricReaders: [],
      logRecordProcessors: [],
    });
  });

  it("does not start the SDK when OTEL_SDK_DISABLED=true despite an endpoint", async () => {
    stubEnv({
      OTEL_SDK_DISABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
    });
    await startNodeTelemetry({ serviceName: "test" });
    expect(sdk.options).toEqual([]);
    expect(sdk.started).toBe(0);
  });
});

describe("startNodeTelemetry", () => {
  it("exports nothing and keeps stdout JSON logs when no endpoint is set", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", `${fixtures}bootstrap.ts`, `${fixtures}http-app.ts`],
      { encoding: "utf8", timeout: 30_000, env: envWithoutOtel() },
    );
    expect(result.status, result.stderr).toBe(0);
    // No exporter: nothing to fail against localhost:4318, nothing on stderr.
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(JSON.stringify(record)).toContain("fixture.request");
    // No tracer provider, so no active span to stamp on the line.
    expect(JSON.stringify(record)).not.toContain("trace_id");
  });

  it("instruments ES-module node:http and fetch when preloaded with --import", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", `${fixtures}bootstrap.ts`, `${fixtures}http-app.ts`],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...envWithoutOtel(),
          // Standard SDK environment: print instead of exporting over OTLP.
          OTEL_TRACES_EXPORTER: "console",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout;
    // Server span from instrumentation-http, client span from undici (fetch).
    expect(out).toMatch(/instrumentationScope:\s*\{[^}]*name: '@opentelemetry\/instrumentation-http'/);
    expect(out).toMatch(/instrumentationScope:\s*\{[^}]*name: '@opentelemetry\/instrumentation-undici'/);
    expect(out).toContain("'service.name': 'clash-telemetry-fixture'");
    // The structured log line carries the active server span's trace id.
    const logLine = out.split("\n").find((line) => line.includes('"fixture.request"'));
    expect(logLine).toBeDefined();
    const record = JSON.parse(logLine!);
    expect(record.context.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(out).toContain(`traceId: '${record.context.trace_id}'`);
  });

  it("OTEL_SERVICE_NAME overrides the default service name", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", `${fixtures}bootstrap.ts`, `${fixtures}http-app.ts`],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...envWithoutOtel(),
          OTEL_SERVICE_NAME: "from-env",
          OTEL_TRACES_EXPORTER: "console",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("'service.name': 'from-env'");
  });
});
