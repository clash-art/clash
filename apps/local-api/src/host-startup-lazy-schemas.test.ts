import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentAnnotationTargetSchema,
  GeneratorDefinitionSchema,
  MODEL_CARDS,
  ModelCardSchema,
  NodeDataSchema,
  PluginAuthFlowSchema,
  ProjectHostCommandSchema,
  ResourceSchema,
  TimelineDslSchema,
  WorkspaceBundleManifestSchema,
  isLazyValueInitialized,
  lazyValueConstructionCount,
} from "@clash/shared-types";
import { expect, it } from "vitest";

import { createConfiguredLocalAcpAdapter, startLocalApiServer } from "./server.js";

// The schemas the packaged Host used to build before it answered /health (see
// `.lapfix/REPORT.md` for the per-declaration ranking). None of them belongs to the startup path.
const deferredSchemas = {
  AgentAnnotationTargetSchema,
  GeneratorDefinitionSchema,
  ModelCardSchema,
  NodeDataSchema,
  PluginAuthFlowSchema,
  ProjectHostCommandSchema,
  ResourceSchema,
  TimelineDslSchema,
  WorkspaceBundleManifestSchema,
} as const;

it("answers /health without constructing deferred shared-types schemas, then constructs them once on first use", async () => {
  // Constructing them lazily is only useful if the eager import graph does not touch them; measure
  // from after this test's own imports so the assertions are about the Host startup path.
  const constructionsBeforeStart = lazyValueConstructionCount();
  // Capture the proxy identities: once first use swaps the module's live binding, the exported
  // name yields the real schema and is intentionally no longer "initialized" as a lazy value.
  const deferredProxies = { ...deferredSchemas };
  const modelCardsProxy = MODEL_CARDS;
  const modelCardSchemaProxy = ModelCardSchema;
  for (const schema of Object.values(deferredProxies)) {
    expect(isLazyValueInitialized(schema)).toBe(false);
  }
  expect(isLazyValueInitialized(modelCardsProxy)).toBe(false);

  const root = await mkdtemp(join(tmpdir(), "clash-lazy-schemas-"));
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

    expect(lazyValueConstructionCount()).toBe(constructionsBeforeStart);
    for (const [name, schema] of Object.entries(deferredProxies)) {
      expect(isLazyValueInitialized(schema), name).toBe(false);
    }
    expect(isLazyValueInitialized(modelCardsProxy)).toBe(false);

    // First use constructs the requested graph exactly once; unrelated schemas stay deferred.
    expect(MODEL_CARDS.length).toBeGreaterThan(0);
    expect(isLazyValueInitialized(modelCardsProxy)).toBe(true);
    expect(isLazyValueInitialized(modelCardSchemaProxy)).toBe(true);
    expect(isLazyValueInitialized(deferredProxies.NodeDataSchema)).toBe(false);
    // The live bindings now yield the real values, not the proxies.
    expect(MODEL_CARDS).not.toBe(modelCardsProxy);
    expect(ModelCardSchema).not.toBe(modelCardSchemaProxy);
    expect(lazyValueConstructionCount()).toBeGreaterThan(constructionsBeforeStart);

    const constructionsAfterCatalog = lazyValueConstructionCount();
    expect(MODEL_CARDS[0]?.id).toBeTruthy();
    expect(lazyValueConstructionCount()).toBe(constructionsAfterCatalog);
  } finally {
    if (server) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
