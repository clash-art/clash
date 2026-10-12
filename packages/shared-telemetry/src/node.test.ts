import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

describe("startNodeTelemetry", () => {
  it("instruments ES-module node:http and fetch when preloaded with --import", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", `${fixtures}bootstrap.ts`, `${fixtures}http-app.ts`],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
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
          ...process.env,
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
