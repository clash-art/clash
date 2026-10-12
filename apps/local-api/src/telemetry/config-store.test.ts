import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalConfigError } from "../local-config-routes.js";
import { clashHomeForLocalDataDir } from "../local-paths.js";
import { createTelemetryConfigResource } from "./config-store.js";
import type { HostTelemetry } from "./pipeline.js";
import type { TelemetryExportResolution } from "./resolve.js";

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-telemetry-config-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("createTelemetryConfigResource", () => {
  it("keeps header credentials out of config.yaml and out of the view", async () => {
    const resource = createTelemetryConfigResource({
      dataDir,
      env: { OTEL_EXPORTER_OTLP_HEADERS: "authorization=env-token" },
    });
    await resource.update({
      settings: {
        CLASH_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.com:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=settings-token",
      },
    });

    const clashHome = clashHomeForLocalDataDir(dataDir);
    const yaml = await readFile(join(clashHome, "config.yaml"), "utf8");
    expect(yaml).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(yaml).not.toContain("settings-token");
    expect(
      await readFile(join(clashHome, "credentials.json"), "utf8"),
    ).toContain("settings-token");

    const { view } = await resource.read();
    expect(JSON.stringify(view)).not.toContain("token");
    expect(
      view.keys.find((entry) => entry.key === "OTEL_EXPORTER_OTLP_HEADERS"),
    ).toMatchObject({
      secret: true,
      setting: null,
      has_setting: true,
      env: null,
      has_env: true,
      source: "config",
    });
    expect(view.export).toMatchObject({
      enabled: true,
      endpoint: "http://collector.example.com:4318/v1/traces",
    });
    expect((await resource.resolve()).headers).toEqual({
      authorization: "settings-token",
    });
  });

  it("removes a setting with null so the environment applies again", async () => {
    const resource = createTelemetryConfigResource({
      dataDir,
      env: { CLASH_ENABLE_TELEMETRY: "1" },
    });
    await resource.update({ settings: { CLASH_ENABLE_TELEMETRY: "" } });
    expect((await resource.resolve()).enabled).toBe(false);
    await resource.update({ settings: { CLASH_ENABLE_TELEMETRY: null } });
    const resolution = await resource.resolve();
    expect(resolution.enabled).toBe(true);
    expect(resolution.sources.CLASH_ENABLE_TELEMETRY).toBe("env");
  });

  it("advances updatedAt on secret-only updates", async () => {
    const resource = createTelemetryConfigResource({ dataDir, env: {} });
    const before = (await resource.read()).updatedAt;
    await resource.update({
      settings: { OTEL_EXPORTER_OTLP_HEADERS: "authorization=x" },
    });
    expect((await resource.read()).updatedAt).not.toBe(before);
  });

  it.each([
    [{ OTEL_SOMETHING_ELSE: "x" }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector" }],
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }],
    [{ OTEL_TRACES_EXPORTER: "zipkin" }],
    [{ CLASH_ENABLE_TELEMETRY: 1 }],
  ])("rejects %o with a LocalConfigError", async (settings) => {
    const resource = createTelemetryConfigResource({ dataDir, env: {} });
    await expect(resource.update({ settings })).rejects.toBeInstanceOf(
      LocalConfigError,
    );
  });

  it("applies the current resolution to the pipeline after updates", async () => {
    const applied: TelemetryExportResolution[] = [];
    const pipeline: HostTelemetry = {
      exporting: false,
      async applyExport(resolution) {
        applied.push(resolution);
      },
      ingest() {},
      async shutdown() {},
    };
    const resource = createTelemetryConfigResource({ dataDir, env: {}, pipeline });
    await resource.update({ settings: { CLASH_ENABLE_TELEMETRY: "1" } });
    await resource.afterUpdate?.();
    expect(applied.at(-1)?.enabled).toBe(true);
  });
});

describe("telemetry routes in the Host app", () => {
  it("serves Settings and enforces agent read-before-write", async () => {
    const { managedLocalApiApps } = await import("../local-api-app.test-fixtures.js");
    const apps = managedLocalApiApps();
    try {
      const app = apps.createApp({
        dataDir,
        userId: "local-user",
        telemetryConfig: createTelemetryConfigResource({ dataDir, env: {} }),
      });
      const read = await app.request("/api/v1/local/telemetry");
      const view = (await read.json()) as { readToken: string; export: { reason: string } };
      expect(view.export.reason).toBe("telemetry_disabled");

      const blind = await app.request("/api/v1/local/telemetry", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-clash-client-type": "agent" },
        body: JSON.stringify({ settings: { CLASH_ENABLE_TELEMETRY: "1" } }),
      });
      expect(blind.status).toBe(409);

      const informed = await app.request("/api/v1/local/telemetry", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-clash-client-type": "agent",
          "if-match": view.readToken,
        },
        body: JSON.stringify({ settings: { CLASH_ENABLE_TELEMETRY: "1" } }),
      });
      expect(informed.status).toBe(200);
      expect(await informed.json()).toMatchObject({
        export: { enabled: true },
        mutation: { accepted: true, afterReadToken: expect.any(String) },
      });
    } finally {
      await apps.close();
    }
  });
});
