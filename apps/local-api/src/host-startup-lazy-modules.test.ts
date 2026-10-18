import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

// Each factory runs only when some module first imports the dependency, so the set records exactly
// which lazily imported Host dependencies have been evaluated so far.
const evaluated = vi.hoisted(() => new Set<string>());
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  evaluated.add("@aws-sdk/client-s3");
  return await importOriginal();
});
vi.mock("@aws-sdk/s3-request-presigner", async (importOriginal) => {
  evaluated.add("@aws-sdk/s3-request-presigner");
  return await importOriginal();
});
vi.mock("sharp", async (importOriginal) => {
  evaluated.add("sharp");
  return await importOriginal();
});
vi.mock("@opentelemetry/exporter-trace-otlp-http", async (importOriginal) => {
  evaluated.add("@opentelemetry/exporter-trace-otlp-http");
  return await importOriginal();
});
vi.mock("@opentelemetry/exporter-trace-otlp-proto", async (importOriginal) => {
  evaluated.add("@opentelemetry/exporter-trace-otlp-proto");
  return await importOriginal();
});

import { loadSharp } from "./local-image-codec.js";
import { createConfiguredLocalAcpAdapter, startLocalApiServer } from "./server.js";
import { loadOtlpTraceExporters } from "./telemetry/index.js";

it("serves /health without evaluating the lazily imported Host dependencies, and loads them on first use", async () => {
  // Regression guard for Host startup: a static import of any of these from the eager module graph
  // puts its evaluation back on the single startup event-loop block before the Host listens.
  const root = await mkdtemp(join(tmpdir(), "clash-lazy-startup-"));
  let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;
  try {
    server = await startLocalApiServer({
      dataDir: join(root, "local-api"),
      port: 0,
      remotePersistence: null,
      discovery: { enabled: false },
      localAcp: createConfiguredLocalAcpAdapter({ CLASH_E2E_STUB_ACP: "1" }),
      codexImagegenPreflight: async () => ({
        available: false as const,
        reason: "cli-not-found" as const,
      }),
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("local-api did not bind a TCP port");
    }
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(health.ok).toBe(true);
    expect([...evaluated]).toEqual([]);

    // First use imports exactly the dependency that path needs.
    await loadSharp();
    expect([...evaluated]).toEqual(["sharp"]);
    await loadOtlpTraceExporters();
    expect([...evaluated].sort()).toEqual([
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/exporter-trace-otlp-proto",
      "sharp",
    ]);
  } finally {
    if (server) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
