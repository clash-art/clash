import { describe, expect, it } from "vitest";

import { parseOtlpHeaders, resolveTelemetryExport } from "./resolve.js";

const ON = { CLASH_ENABLE_TELEMETRY: "1" };

describe("resolveTelemetryExport", () => {
  it("stays off without the master switch, even with OTEL_* present", () => {
    const resolution = resolveTelemetryExport(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
      {},
    );
    expect(resolution).toMatchObject({
      enabled: false,
      reason: "telemetry_disabled",
    });
  });

  it("uses the OTel specification defaults when only the switch is on", () => {
    // Spec: OTLP/HTTP on localhost:4318, /v1/traces appended, http/protobuf.
    expect(resolveTelemetryExport(ON, {})).toMatchObject({
      enabled: true,
      endpoint: "http://localhost:4318/v1/traces",
      protocol: "http/protobuf",
    });
  });

  it("appends the signal path to the generic endpoint only", () => {
    expect(
      resolveTelemetryExport(
        { ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com:4318/" },
        {},
      ).endpoint,
    ).toBe("https://c.example.com:4318/v1/traces");
    expect(
      resolveTelemetryExport(
        {
          ...ON,
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example.com",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://t.example.com/ingest",
        },
        {},
      ).endpoint,
    ).toBe("https://t.example.com/ingest");
  });

  it("lets Settings win over the environment and records each source", () => {
    const resolution = resolveTelemetryExport(
      {
        ...ON,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://env-collector:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=env-token",
      },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://settings-collector:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "",
      },
    );
    expect(resolution.endpoint).toBe("http://settings-collector:4318/v1/traces");
    // An empty Settings value cancels the environment credential.
    expect(resolution.headers).toEqual({});
    expect(resolution.sources).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "config",
      OTEL_EXPORTER_OTLP_HEADERS: "config",
      CLASH_ENABLE_TELEMETRY: "env",
      OTEL_TRACES_EXPORTER: "default",
    });
  });

  it("lets Settings turn export off when the environment turns it on", () => {
    expect(
      resolveTelemetryExport(ON, { CLASH_ENABLE_TELEMETRY: "0" }).enabled,
    ).toBe(false);
  });

  it.each([
    [{ OTEL_SDK_DISABLED: "true" }, "sdk_disabled"],
    [{ OTEL_TRACES_EXPORTER: "none" }, "exporter_none"],
    [{ OTEL_TRACES_EXPORTER: "zipkin" }, "unsupported_exporter"],
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, "unsupported_protocol"],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a url" }, "invalid_endpoint"],
  ])("reports %o as %s instead of guessing", (env, reason) => {
    expect(resolveTelemetryExport({ ...ON, ...env }, {})).toMatchObject({
      enabled: false,
      reason,
    });
  });

  it("merges traces headers over generic headers per key", () => {
    expect(
      resolveTelemetryExport(
        {
          ...ON,
          OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=3",
        },
        {},
      ).headers,
    ).toEqual({ a: "1", b: "3" });
  });
});

describe("parseOtlpHeaders", () => {
  it("percent-decodes values and skips malformed entries", () => {
    expect(
      parseOtlpHeaders("Authorization=Bearer%20abc, broken ,=x,api-key=k=v"),
    ).toEqual({ Authorization: "Bearer abc", "api-key": "k=v" });
  });
});
