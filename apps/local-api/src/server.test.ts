import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_HOST_PROTOCOL_VERSION,
  createDurableRunRecord,
  storeMetadataBody,
} from "@clash/shared-runtime";
import {
  createProjectDocumentAsset,
  projectAssetAuthorityVersion,
  readProjectDocumentAsset,
} from "@clash/shared-types";
import { readHostDiscovery } from "./host-discovery";
import {
  createConfiguredLocalAcpAdapter,
  bootstrapLocalDurableRunRecovery,
  createLocalAgentToolEnv,
  createLocalPluginBrokerServices,
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
  startLocalApiServer,
} from "./server";
import * as serverModule from "./server";
import { createLocalAudioConfigStore } from "./audio-config";
import { createLocalMetadataStore } from "./local-metadata-store";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging";
import {
  createLocalProjectAssetService,
  type LocalProjectAssetReplica,
} from "./local-project-assets";
import { createLocalAssetInspectionService } from "./local-asset-inspections";
import { createClashUserConfigStore } from "./user-config";
import { createSqliteDurableRunJournal } from "./durable-run-journal";
import { FileReplicaStore } from "./loro/file-replica-store";
import {
  createProviderConformanceStubs,
  providerTestRecordingEventToJsonl,
} from "./provider-test-recorder";

const execFileAsync = promisify(execFile);

async function withLocalDataDir<T>(
  dataDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.CLASH_LOCAL_DATA_DIR;
  process.env.CLASH_LOCAL_DATA_DIR = dataDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLASH_LOCAL_DATA_DIR;
    } else {
      process.env.CLASH_LOCAL_DATA_DIR = previous;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

const availableCodexImagegenPreflight = async () => ({
  available: true as const,
  codexPath: "/test/codex",
  generate: async () => ({
    mediaType: "image/png" as const,
    bytes: new Uint8Array([137, 80, 78, 71]),
  }),
});

async function listenOnLoopback(
  server: ReturnType<typeof createServer>,
  port = 0,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      if (errorCode(error) === "EPERM") {
        resolve(null);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("failed to reserve port"));
        return;
      }
      resolve(address.port);
    });
  });
}

describe("local API server configuration", () => {
  it("omits Codex ImageGen when its startup preflight is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-codex-unavailable-"));
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir: join(root, "local-api"),
        port: 0,
        remotePersistence: null,
        discovery: { enabled: false },
        localAcp: createConfiguredLocalAcpAdapter({
          CLASH_E2E_STUB_ACP: "1",
        }),
        codexImagegenPreflight: async () => ({
          available: false,
          reason: "not-logged-in",
        }),
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("local-api did not bind a TCP port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const registry = (await (
        await fetch(`${origin}/api/marketplace/registry`)
      ).json()) as { plugins: Array<{ id: string }> };
      expect(registry.plugins.map(({ id }) => id)).not.toContain(
        "clash.codex-imagegen",
      );

      const installed = (await (
        await fetch(`${origin}/api/v1/local/plugins`)
      ).json()) as Array<{ id?: string }>;
      expect(installed.map(({ id }) => id)).not.toContain(
        "clash.codex-imagegen",
      );

      const definitions = (await (
        await fetch(`${origin}/api/v1/generator-definitions`)
      ).json()) as {
        definitions: Array<{ pluginId: string }>;
      };
      expect(
        definitions.definitions.map(({ pluginId }) => pluginId),
      ).not.toContain("clash.codex-imagegen");
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes Storyboard as an official marketplace plugin without preinstalling it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-storyboard-catalog-"));
    const dataDir = join(root, "local-api");
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        discovery: { enabled: false },
        localAcp: createConfiguredLocalAcpAdapter({
          CLASH_E2E_STUB_ACP: "1",
        }),
        codexImagegenPreflight: availableCodexImagegenPreflight,
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("local-api did not bind a TCP port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const registry = (await (
        await fetch(`${origin}/api/marketplace/registry`)
      ).json()) as {
        actions: Array<Record<string, unknown> & { id: string; type: string }>;
        plugins: Array<Record<string, unknown> & { id: string; type: string }>;
        skills: Array<Record<string, unknown> & { id: string; type: string }>;
      };
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: "clash.storyboard", type: "plugin" }),
      );
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({
          id: "clash.codex-imagegen",
          type: "plugin",
        }),
      );
      expect(registry.actions).toEqual([]);

      const feed = (await (
        await fetch(`${origin}/api/marketplace/feed`)
      ).json()) as {
        featuredPlugins: Array<Record<string, unknown> & {
          id: string;
          type: string;
        }>;
      };
      expect(feed.featuredPlugins.map((item) => item.id)).toEqual(expect.arrayContaining([
        "clash.storyboard",
        "clash.codex-imagegen",
      ]));
      const catalog = new Map(
        [...registry.actions, ...registry.plugins, ...registry.skills].map(
          (item) => [item.id, item],
        ),
      );
      for (const item of feed.featuredPlugins) {
        expect(
          item.type === "plugin" ||
            item.type === "skill",
        ).toBe(true);
        expect(item).toEqual(catalog.get(item.id));
      }

      const installed = (await (
        await fetch(`${origin}/api/v1/local/plugins`)
      ).json()) as Array<{ id?: string }>;
      expect(installed.some((plugin) => plugin.id === "clash.storyboard")).toBe(
        false,
      );
      const storyboard = registry.plugins.find(item => item.id === "clash.storyboard")!;
      expect(storyboard.installation).toMatchObject({ kind: "executable-plugin", packageId: storyboard.packageId });
      expect(registry.plugins.find(item => item.id === "clash.codex-imagegen")).not.toHaveProperty("installation");
      for (const _attempt of ["initial", "idempotent retry"]) {
        const response = await fetch(`${origin}/api/marketplace/plugins/${storyboard.packageId}/install`, { method: "POST" });
        expect(await response.json()).toMatchObject({ installed: true, id: storyboard.id });
        expect(response.ok).toBe(true);
      }
      const activeResponse = await fetch(`${origin}/api/v1/local/plugins/${storyboard.id}/package`);
      const active = await activeResponse.json() as { id: string; manifest: { id: string }; viewRegistrations: unknown[] };
      expect(activeResponse.ok).toBe(true);
      expect(active.id).toBe(storyboard.id);
      expect(active.manifest.id).toBe(storyboard.id);
      expect(active.viewRegistrations.length).toBeGreaterThan(0);
      const runtimeViews = await (await fetch(`${origin}/api/v1/plugin-views`)).json() as {views: Array<{pluginId: string}>};
      expect(runtimeViews.views.some(view => view.pluginId === storyboard.id)).toBe(true);
      const after = await (await fetch(`${origin}/api/v1/local/plugins`)).json() as Array<{id: string; drifted: boolean}>;
      expect(after.find(item => item.id === storyboard.id)?.drifted).toBe(false);
      expect((await fetch(`${origin}/api/marketplace/plugins/${storyboard.packageId}/install`, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${origin}/api/v1/local/plugins/${storyboard.id}/package`)).ok).toBe(false);

    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves workflow bindings only after the verified plugin runtime is ready and forces the action export kind", async () => {
    const createResolver = (serverModule as Record<string, unknown>)
      .createWorkflowPluginBindingResolver as
      | ((options: {
          ensurePluginRuntime(): Promise<void>;
          resolveBinding(
            pluginId: string,
            exportId: string,
            kind: "action",
          ): Promise<{
            pluginId: string;
            version: string;
            exportId: string;
            schemaHash: string;
          }>;
        }) => (pluginId: string, exportId: string) => Promise<unknown>)
      | undefined;
    expect(createResolver).toBeDefined();
    if (!createResolver) return;
    const events: string[] = [];
    let runtimeReady = false;
    const resolver = createResolver({
      async ensurePluginRuntime() {
        events.push("runtime-ready");
        runtimeReady = true;
      },
      async resolveBinding(pluginId, exportId, kind) {
        if (!runtimeReady) throw new Error("plugin runtime was not ready");
        events.push(`resolve:${pluginId}:${exportId}:${kind}`);
        return {
          pluginId,
          version: "1.0.0",
          exportId,
          schemaHash: `sha256:${"a".repeat(64)}`,
        };
      },
    });

    await expect(
      resolver("clash.remotion", "render-timeline"),
    ).resolves.toEqual({
      pluginId: "clash.remotion",
      version: "1.0.0",
      exportId: "render-timeline",
      schemaHash: `sha256:${"a".repeat(64)}`,
    });
    expect(events).toEqual([
      "runtime-ready",
      "resolve:clash.remotion:render-timeline:action",
    ]);
  });

  it("installs replay instrumentation in the Host process only for the test option and disposes it on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-host-module-replay-"));
    const trafficPath = join(root, "traffic.jsonl");
    const requestId = "host-module-replay";
    const providerUrl = "https://module-provider.invalid/generate";
    const stub = createProviderConformanceStubs({ includeMock: true }).find(
      (candidate) =>
        candidate.providerId === "mock" && candidate.shape === "text",
    );
    if (!stub) throw new Error("Mock text Provider stub is missing.");
    await writeFile(
      trafficPath,
      [
        providerTestRecordingEventToJsonl({
          schemaVersion: 1,
          type: "request",
          timestamp: "2026-08-14T00:00:00.000Z",
          requestId,
          stub,
          request: {
            url: providerUrl,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: { prompt: "module replay" },
          },
        }),
        providerTestRecordingEventToJsonl({
          schemaVersion: 1,
          type: "response",
          timestamp: "2026-08-14T00:00:01.000Z",
          requestId,
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: { answer: "same cassette" },
          },
        }),
      ].join(""),
    );
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir: join(root, "local-api"),
        port: 0,
        remotePersistence: null,
        providerHttpInstrumentation: {
          mode: "replay",
          trafficPath,
          modulePath: "child-preload-not-used-by-module-realm.mjs",
        },
        discovery: { enabled: false },
        localAcp: createConfiguredLocalAcpAdapter({
          CLASH_E2E_STUB_ACP: "1",
        }),
      });
      const hostAddress = server.address();
      if (!hostAddress || typeof hostAddress === "string") {
        throw new Error("Local Host fixture did not bind a TCP port.");
      }
      const providers = await fetch(
        `http://127.0.0.1:${hostAddress.port}/api/v1/plugin-providers`,
      );
      expect(providers.status).toBe(200);

      const replayed = await fetch(providerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "module replay" }),
      });
      await expect(replayed.json()).resolves.toEqual({
        answer: "same cassette",
      });
      await new Promise<void>((resolveClose) =>
        server!.close(() => resolveClose()),
      );
      server = undefined;

      await expect(
        fetch(providerUrl, { signal: AbortSignal.timeout(3_000) }),
      ).rejects.toThrow();
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not install a process-wide HTTP hook in a normal production startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-host-no-replay-hook-"));
    const originalFetch = globalThis.fetch;
    const transport = vi.fn(async () =>
      Response.json({ direct: true }),
    ) as unknown as typeof fetch;
    globalThis.fetch = transport;
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir: join(root, "local-api"),
        port: 0,
        remotePersistence: null,
        discovery: { enabled: false },
        localAcp: createConfiguredLocalAcpAdapter({
          CLASH_E2E_STUB_ACP: "1",
        }),
      });
      const response = await fetch("https://ordinary-production.invalid/");
      await expect(response.json()).resolves.toEqual({ direct: true });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads trusted first-party modules without seeding or trusting an actions-directory shadow", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-bundled-module-startup-"),
    );
    const dataDir = join(clashRoot, "local-api");
    const actionsRoot = join(clashRoot, "actions");
    const shadowRoot = join(actionsRoot, "clash.google");
    await mkdir(shadowRoot, { recursive: true });
    await writeFile(
      join(shadowRoot, "manifest.json"),
      JSON.stringify({ id: "clash.google", marker: "untrusted-shadow" }),
    );
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        discovery: { enabled: false },
        localAcp: createConfiguredLocalAcpAdapter({
          CLASH_E2E_STUB_ACP: "1",
        }),
        codexImagegenPreflight: availableCodexImagegenPreflight,
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("local-api did not bind a TCP port");
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/plugin-providers`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        providers: Array<{ pluginId: string }>;
      };
      const providerIds = new Set(
        body.providers.map(({ pluginId }) => pluginId),
      );
      expect(providerIds.has("clash.google")).toBe(true);
      expect(providerIds.has("clash.meshy")).toBe(true);
      expect(providerIds.has("clash.tripo")).toBe(true);

      // The bundled clash.meshy/clash.tripo modules just proved trusted above.
      // Confirm the model catalog actually synthesizes their manifest-declared
      // provider + binding + executor data into executable routes for every
      // built-in card they bind, rather than merely registering the plugin.
      const modelsCatalog = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/models/catalog`,
      );
      expect(modelsCatalog.status, await modelsCatalog.clone().text()).toBe(
        200,
      );
      const catalogBody = (await modelsCatalog.json()) as {
        models: Array<{
          model: {
            id: string;
            kind: string;
            providerImplementations?: Array<{
              providerId?: string;
              executorPluginId?: string;
              executorExportId?: string;
            }>;
          };
          routes: Array<{
            providerId?: string;
            executorPluginId?: string;
            executorExportId?: string;
          }>;
        }>;
      };
      const expectedBundledModelExecutors = [
        {
          modelId: "meshy-6",
          providerId: "meshy",
          pluginId: "clash.meshy",
          exportId: "meshy-execute",
        },
        {
          modelId: "meshy-7",
          providerId: "meshy",
          pluginId: "clash.meshy",
          exportId: "meshy-execute",
        },
        {
          modelId: "meshy-auto-rig",
          providerId: "meshy",
          pluginId: "clash.meshy",
          exportId: "meshy-execute",
        },
        {
          modelId: "tripo-h3.1",
          providerId: "tripo",
          pluginId: "clash.tripo",
          exportId: "tripo-execute",
        },
        {
          modelId: "tripo-auto-rig",
          providerId: "tripo",
          pluginId: "clash.tripo",
          exportId: "tripo-execute",
        },
      ] as const;
      for (const expected of expectedBundledModelExecutors) {
        const entry = catalogBody.models.find(
          (candidate) => candidate.model.id === expected.modelId,
        );
        expect(
          entry,
          `models/catalog is missing an entry for ${expected.modelId}`,
        ).toBeDefined();
        expect(entry!.model.kind).toBe("model");
        // No provider account is configured in this test (no credentials), so
        // `routes` (account-gated) stays empty and `selectedRoute` stays null;
        // the manifest-declared implementation still surfaces on the card.
        const implementations = [
          ...(entry!.model.providerImplementations ?? []),
          ...entry!.routes,
        ];
        const binding = implementations.find(
          (candidate) => candidate.providerId === expected.providerId,
        );
        expect(
          binding,
          `${expected.modelId} has no "${expected.providerId}" provider implementation ` +
            `synthesized from the bundled ${expected.pluginId} plugin`,
        ).toBeDefined();
        expect(binding!.executorPluginId).toBe(expected.pluginId);
        expect(binding!.executorExportId).toBe(expected.exportId);
      }

      const generatorDefinitions = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/generator-definitions`,
      );
      expect(
        generatorDefinitions.status,
        await generatorDefinitions.clone().text(),
      ).toBe(200);
      const generatorBody = (await generatorDefinitions.json()) as {
        definitions: Array<Record<string, unknown>>;
      };
      expect(generatorBody.definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "clash.asr",
            definitionId: "speech-analysis",
            actions: expect.arrayContaining([
              expect.objectContaining({
                id: "transcribe",
                executorExportId: "transcribe",
              }),
            ]),
          }),
          expect.objectContaining({
            pluginId: "clash.codex-imagegen",
            definitionId: "codex-imagegen",
            actions: expect.arrayContaining([
              expect.objectContaining({
                id: "generate",
                executorExportId: "generate-image",
              }),
            ]),
          }),
        ]),
      );

      const createdGenerator = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/projects/server-generator-project/generators`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            generatorId: "codex-imagegen-1",
            generatorRevisionId: "codex-imagegen-1:r1",
            pluginId: "clash.codex-imagegen",
            definitionId: "codex-imagegen",
            state: { prompt: "a lighthouse built from folded paper" },
            persistentInputRefs: [],
          }),
        },
      );
      expect(
        createdGenerator.status,
        await createdGenerator.clone().text(),
      ).toBe(201);
      const readGenerator = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/projects/server-generator-project/generators/codex-imagegen-1`,
      );
      expect(readGenerator.status, await readGenerator.clone().text()).toBe(
        200,
      );
      await expect(readGenerator.json()).resolves.toMatchObject({
        generator: {
          id: "codex-imagegen-1",
          headRevisionId: "codex-imagegen-1:r1",
          definitionRef: {
            pluginId: "clash.codex-imagegen",
            definitionId: "codex-imagegen",
          },
        },
      });

      const documentsUrl =
        `http://127.0.0.1:${address.port}` +
        "/api/v1/projects/server-generator-project/documents";
      const createdDocument = await fetch(documentsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentAssetId: "server-description-1",
          revisionId: "server-description-1:r1",
          documentKind: "media.description",
          schemaVersion: 1,
          body: {
            schemaVersion: 1,
            kind: "media.description",
            text: "A folded-paper lighthouse at dusk.",
            sourceHash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          sourceRefs: [],
        }),
      });
      expect(createdDocument.status, await createdDocument.clone().text()).toBe(
        201,
      );
      await expect(createdDocument.json()).resolves.toMatchObject({
        asset: {
          id: "server-description-1",
          headRevisionId: "server-description-1:r1",
        },
        revision: {
          id: "server-description-1:r1",
          producer: {
            kind: "actor",
            actor: { kind: "user", id: "local-user" },
          },
        },
        body: { text: "A folded-paper lighthouse at dusk." },
      });
      const checkpointedProject = await new FileReplicaStore(
        join(dataDir, "projects"),
      ).recover("server-generator-project");
      expect(
        readProjectDocumentAsset(checkpointedProject, "server-description-1"),
      ).toMatchObject({ headRevisionId: "server-description-1:r1" });

      const listedDocuments = await fetch(documentsUrl);
      expect(listedDocuments.status, await listedDocuments.clone().text()).toBe(
        200,
      );
      await expect(listedDocuments.json()).resolves.toMatchObject({
        documents: [
          {
            id: "server-description-1",
            headRevisionId: "server-description-1:r1",
          },
        ],
      });
      const documentHistory = await fetch(
        `${documentsUrl}/server-description-1/revisions`,
      );
      expect(documentHistory.status, await documentHistory.clone().text()).toBe(
        200,
      );
      const documentHistoryBody = (await documentHistory.json()) as {
        revisions: Array<Record<string, unknown>>;
      };
      expect(documentHistoryBody.revisions).toEqual([
        expect.objectContaining({ id: "server-description-1:r1" }),
      ]);
      expect(JSON.stringify(documentHistoryBody)).not.toContain(
        "A folded-paper lighthouse at dusk.",
      );

      expect((await readdir(actionsRoot)).sort()).toEqual(["clash.google"]);
      await expect(
        readFile(join(shadowRoot, "manifest.json"), "utf8"),
      ).resolves.toContain("untrusted-shadow");
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      await rm(clashRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("reopens journal-owned Projects for recovery without waiting for a client visit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-startup-recovery-"));
    try {
      const journal = createSqliteDurableRunJournal(dataDir);
      for (const [actionRunId, projectId] of [
        ["run-project-b", "project-b"],
        ["run-project-a", "project-a"],
        ["run-project-a-second", "project-a"],
      ] as const) {
        await journal.create(
          createDurableRunRecord({
            actionRunId,
            outputSlot: "media",
            owner: { realm: "local", id: "local-api" },
            executorInput: { projectId },
            createdAt: 1,
            deadlineAt: 10_000,
          }),
        );
      }
      const opened: string[] = [];

      await expect(
        bootstrapLocalDurableRunRecovery({
          dataDir,
          ownerId: "local-api",
          roomHub: {
            async room(projectId) {
              opened.push(projectId);
              return {} as never;
            },
          },
        }),
      ).resolves.toEqual(["project-a", "project-b"]);
      expect(opened).toEqual(["project-a", "project-b"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("advances a journaled run after daemon start without a Project request", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "clash-startup-recovery-boundary-"),
    );
    const journal = createSqliteDurableRunJournal(dataDir);
    const identity = {
      actionRunId: "restart-without-client",
      outputSlot: "media",
    };
    await journal.create(
      createDurableRunRecord({
        ...identity,
        owner: { realm: "local", id: "local-api" },
        executorInput: {
          schemaVersion: 1,
          binding: {
            pluginId: "missing.restart-provider",
            version: "1.0.0",
            exportId: "generate",
            schemaHash: `sha256:${"0".repeat(64)}`,
          },
          accountId: "account-restart",
          kind: "image",
          projectId: "project-restart",
          input: { values: {}, references: [] },
        },
        createdAt: Date.now(),
        deadlineAt: Date.now() + 30 * 60_000,
      }),
    );
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await withLocalDataDir(dataDir, () =>
        startLocalApiServer({
          dataDir,
          port: 0,
          remotePersistence: null,
          discovery: { enabled: false },
          localAcp: createConfiguredLocalAcpAdapter({
            CLASH_E2E_STUB_ACP: "1",
          }),
        }),
      );

      const deadline = Date.now() + 15_000;
      let recovered = await journal.load(identity);
      while ((recovered?.revision ?? 0) === 0 && Date.now() < deadline) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
        recovered = await journal.load(identity);
      }
      expect(recovered).toMatchObject({
        actionRunId: identity.actionRunId,
        outputSlot: identity.outputSlot,
        owner: { realm: "local", id: "local-api" },
      });
      expect(recovered!.revision).toBeGreaterThan(0);
      expect(recovered!.phase).not.toBe("queued");
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("materializes plugin Asset reads through the supplied Project replica", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-plugin-live-replica-"));
    try {
      const projectId = "project-live-replica";
      const assetId = "legacy-live-asset";
      const bytes = new TextEncoder().encode("legacy plugin input");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const storageKey = "generated/live-input.png";
      await mkdir(join(dataDir, "assets", "generated"), { recursive: true });
      await writeFile(join(dataDir, "assets", storageKey), bytes);
      const metadata = createLocalMetadataStore(dataDir);
      const legacy = await metadata.load();
      legacy.assets.push({
        id: assetId,
        userId: "local-user",
        projectId,
        kind: "image",
        srcR2Key: storageKey,
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: digest,
          contentType: "image/png",
          originalName: "live-input.png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      });
      legacy.assetRefs.push({
        assetId,
        projectId,
        importedAt: 1,
      });
      await metadata.save(legacy, {
        replaceLegacyAssetMigrationInput: true,
      });

      const liveDoc = new LoroDoc();
      const projectAssetReplica: LocalProjectAssetReplica = {
        inspect: async (_id, read) => read(liveDoc),
        mutate: async (_id, mutation) => (await mutation(liveDoc)).value,
      };
      const brokerOptions = {
        dataDir,
        uploadOrigin: "http://127.0.0.1:8787",
        projectAssetReplica,
      } as Parameters<typeof createLocalPluginBrokerServices>[0] & {
        projectAssetReplica: LocalProjectAssetReplica;
      };
      const broker = createLocalPluginBrokerServices(brokerOptions);

      await expect(
        broker(
          {
            protocol: "clash.plugin.broker-request/v1",
            requestId: "read-live-asset",
            invocationId: "invocation-live-asset",
            operation: {
              kind: "asset.resolve",
              reference: {
                slot: "image",
                index: 0,
                asset: {
                  assetId,
                  uri: `clash-asset://${assetId}`,
                  kind: "image",
                },
              },
            },
          },
          {
            manifest: {
              apiVersion: "clash.plugin/v1",
              id: "test.live-reader",
              version: "1.0.0",
              name: "Live reader",
              runtime: {
                kind: "local",
                transport: "stdio",
                entrypoint: "handler.mjs",
                args: [],
              },
              contractTests: [],
              contributes: {
                cards: [],
                providers: [],
                modelBindings: [],
                generators: [],
                views: [],
                functions: [
                  {
                    id: "run",
                    kind: "action",
                    operations: ["submit"],
                  },
                ],
                hostTools: [],
              },
            },
            invocation: {
              protocol: "clash.plugin.invoke/v1",
              invocationId: "invocation-live-asset",
              taskId: "task-live-asset",
              projectId,
              target: {
                pluginId: "test.live-reader",
                version: "1.0.0",
                exportId: "run",
                schemaHash: `sha256:${"e".repeat(64)}`,
                kind: "action",
              },
              input: {
                values: {},
                references: [
                  {
                    slot: "image",
                    index: 0,
                    asset: {
                      assetId,
                      uri: `clash-asset://${assetId}`,
                      kind: "image",
                    },
                  },
                ],
              },
              assetInputs: [
                {
                  match: { kinds: ["image"], slots: ["image"] },
                  representations: ["bytes"],
                },
              ],
              actor: { kind: "agent", id: "agent-live" },
              operation: "submit",
            },
          },
        ),
      ).resolves.toMatchObject({
        form: "bytes",
        kind: "image",
        bytesBase64: Buffer.from(bytes).toString("base64"),
      });
      expect(projectAssetAuthorityVersion(liveDoc)).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("serves an invocation-scoped executor URL directly from an immutable Project Resource", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-plugin-executor-url-"),
    );
    const dataDir = join(clashRoot, "local-api");
    const projectId = "project-executor-url";
    const assetId = "asset-executor-url";
    const bytes = Uint8Array.from([10, 20, 30, 40, 50, 60]);
    const projectAssets = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: async ({ resource }) => ({
          width: 1,
          height: 1,
          rotationDegrees: 0,
          ...(resource.contentType
            ? { contentType: resource.contentType }
            : {}),
        }),
      }),
    });
    await projectAssets.installOwned({
      projectId,
      projectAssetId: assetId,
      kind: "image",
      bytes,
      contentType: "image/png",
      name: "source.png",
      metadata: { width: 1, height: 1 },
      provenance: { kind: "import" },
    });
    const broker = createLocalPluginBrokerServices({ dataDir });
    const reference = {
      slot: "source",
      index: 0,
      asset: {
        assetId,
        uri: `clash-asset://${assetId}`,
        kind: "image" as const,
        mediaType: "image/png",
      },
    };

    try {
      const resolved = await broker(
        {
          protocol: "clash.plugin.broker-request/v1",
          requestId: "read-executor-url",
          invocationId: "invocation-executor-url",
          operation: { kind: "asset.resolve", reference },
        },
        {
          manifest: {
            apiVersion: "clash.plugin/v1",
            id: "test.executor-reader",
            version: "1.0.0",
            name: "Executor reader",
            runtime: {
              kind: "local",
              transport: "stdio",
              entrypoint: "handler.mjs",
              args: [],
            },
            contractTests: [],
            contributes: {
              cards: [],
              providers: [],
              modelBindings: [],
              generators: [],
              views: [],
              functions: [
                {
                  id: "run",
                  kind: "action",
                  operations: ["submit"],
                  assetInputs: [
                    {
                      match: { kinds: ["image"], slots: ["source"] },
                      representations: ["executor-url"],
                    },
                  ],
                },
              ],
              hostTools: [],
            },
          },
          invocation: {
            protocol: "clash.plugin.invoke/v1",
            invocationId: "invocation-executor-url",
            taskId: "task-executor-url",
            projectId,
            target: {
              pluginId: "test.executor-reader",
              version: "1.0.0",
              exportId: "run",
              schemaHash: `sha256:${"e".repeat(64)}`,
              kind: "action",
            },
            input: { values: {}, references: [reference] },
            assetInputs: [
              {
                match: { kinds: ["image"], slots: ["source"] },
                representations: ["executor-url"],
              },
            ],
            actor: { kind: "agent", id: "agent-executor" },
            operation: "submit",
          },
        },
      );
      expect(resolved).toMatchObject({
        form: "executor-url",
        kind: "image",
        mediaType: "image/png",
      });
      const executorUrl = (resolved as { executorUrl: string }).executorUrl;
      const range = await fetch(executorUrl, {
        headers: { Range: "bytes=1-3" },
      });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(
        Uint8Array.from([20, 30, 40]),
      );

      await broker.releaseInvocation?.("invocation-executor-url");
      expect((await fetch(executorUrl)).status).toBe(404);
    } finally {
      await broker.close?.();
      await rm(clashRoot, { recursive: true, force: true });
    }
  });

  it("delivers reference bytes when public Asset storage is explicitly unavailable", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "clash-plugin-private-reference-"),
    );
    try {
      const projectId = "project-private-reference";
      const staging = createLocalPluginAssetStagingStore({
        dataDir,
        clashRoot: clashHomeForLocalDataDir(dataDir),
      });
      const staged = await staging.stage({
        projectId,
        taskId: "reference-import",
        slot: "image",
        pluginId: "test.reference-import",
        pluginVersion: "1.0.0",
        invocationId: "reference-import-1",
        kind: "image",
        mediaType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      });
      const publish = vi.fn(async () => {
        throw new Error("disabled public storage must not be called");
      });
      const publicAssetStorage = {
        getPublicConfig: async () => ({
          capability: "public-asset-storage" as const,
          mode: "disabled" as const,
          available: false,
          provider: null,
          account_id: null,
          endpoint: null,
          bucket: null,
          region: null,
          key_prefix: "clash-temporary",
          force_path_style: false,
          has_access_key_id: false,
          has_secret_access_key: false,
          has_session_token: false,
          managed: { available: false, authenticated: false },
        }),
        publish,
        updateFromRequest: async () => {
          throw new Error("not used");
        },
        testConnection: async () => {
          throw new Error("not used");
        },
        delete: async () => {
          throw new Error("not used");
        },
      } satisfies NonNullable<
        Parameters<
          typeof createLocalPluginBrokerServices
        >[0]["publicAssetStorage"]
      >;
      const broker = createLocalPluginBrokerServices({
        dataDir,
        assetStaging: staging,
        publicAssetStorage,
      });

      await expect(
        broker(
          {
            protocol: "clash.plugin.broker-request/v1",
            requestId: "private-reference-1",
            invocationId: "private-reference-invocation",
            operation: {
              kind: "asset.resolve",
              reference: {
                slot: "image",
                index: 0,
                asset: {
                  assetId: staged.projectAssetId,
                  uri: `clash-asset://${staged.projectAssetId}`,
                  kind: "image",
                  mediaType: "image/png",
                },
              },
            },
          },
          {
            manifest: {
              apiVersion: "clash.plugin/v1",
              id: "test.reference-reader",
              version: "1.0.0",
              name: "Reference reader",
              runtime: {
                kind: "local",
                transport: "stdio",
                entrypoint: "handler.mjs",
                args: [],
              },
              contractTests: [],
              contributes: {
                cards: [],
                providers: [],
                modelBindings: [],
                generators: [],
                views: [],
                functions: [
                  {
                    id: "run",
                    kind: "provider-executor",
                    operations: ["submit"],
                  },
                ],
                hostTools: [],
              },
            },
            invocation: {
              protocol: "clash.plugin.invoke/v1",
              invocationId: "private-reference-invocation",
              taskId: "private-reference-task",
              projectId,
              target: {
                pluginId: "test.reference-reader",
                version: "1.0.0",
                exportId: "run",
                schemaHash: `sha256:${"f".repeat(64)}`,
                kind: "provider-executor",
              },
              input: {
                values: {},
                references: [
                  {
                    slot: "image",
                    index: 0,
                    asset: {
                      assetId: staged.projectAssetId,
                      uri: `clash-asset://${staged.projectAssetId}`,
                      kind: "image",
                      mediaType: "image/png",
                    },
                  },
                ],
              },
              assetInputs: [
                {
                  match: { kinds: ["image"] },
                  representations: ["provider-url", "bytes"],
                },
              ],
              actor: { kind: "system" },
              operation: "submit",
            },
          },
        ),
      ).resolves.toMatchObject({
        form: "bytes",
        bytesBase64: "AQID",
        kind: "image",
        mediaType: "image/png",
      });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves a frozen Project Document revision through the production broker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-plugin-document-"));
    try {
      const projectId = "project-document-input";
      const body = {
        schemaVersion: 1,
        kind: "clash.asr.timed-transcript",
        timebase: "milliseconds",
        alignment: "word",
        text: "frozen words",
        backendId: "test-asr",
        modelId: "test-model",
        durationMs: 500,
        words: [{ id: "word-1", text: "frozen", startMs: 0, endMs: 500 }],
        segments: [
          {
            id: "segment-1",
            text: "frozen",
            startMs: 0,
            endMs: 500,
            wordIds: ["word-1"],
          },
        ],
      };
      const stored = await storeMetadataBody({ dataDir, body });
      const liveDoc = new LoroDoc();
      const created = createProjectDocumentAsset(liveDoc, {
        id: "revision-2",
        documentAssetId: "document-1",
        documentKind: "media.transcript",
        schemaVersion: 1,
        mutability: "versioned",
        body: {
          digest: stored.contentHash,
          byteLength: stored.bytes,
          contentType: "application/json",
        },
        producer: { kind: "actor", actor: { kind: "user", id: "user-1" } },
        sourceRefs: [],
      });
      if (!created.ok) throw new Error(created.error.message);
      const projectAssetReplica: LocalProjectAssetReplica = {
        inspect: async (_id, read) => read(liveDoc),
        mutate: async (_id, mutation) => (await mutation(liveDoc)).value,
      };
      const broker = createLocalPluginBrokerServices({
        dataDir,
        projectAssetReplica,
      });
      const reference = {
        slot: "transcript",
        index: 0,
        document: {
          documentAssetId: "document-1",
          revisionId: "revision-2",
          documentKind: "media.transcript",
          schemaVersion: 1,
        },
      } as const;

      await expect(
        broker(
          {
            protocol: "clash.plugin.broker-request/v1",
            requestId: "read-document",
            invocationId: "invocation-document",
            operation: { kind: "asset.resolve", reference },
          },
          {
            manifest: {
              apiVersion: "clash.plugin/v1",
              id: "test.document-reader",
              version: "1.0.0",
              name: "Document reader",
              runtime: {
                kind: "local",
                transport: "stdio",
                entrypoint: "handler.mjs",
                args: [],
              },
              contractTests: [],
              contributes: {
                cards: [],
                providers: [],
                modelBindings: [],
                generators: [],
                views: [],
                functions: [
                  { id: "run", kind: "action", operations: ["submit"] },
                ],
                hostTools: [],
              },
            },
            invocation: {
              protocol: "clash.plugin.invoke/v1",
              invocationId: "invocation-document",
              taskId: "task-document",
              projectId,
              target: {
                pluginId: "test.document-reader",
                version: "1.0.0",
                exportId: "run",
                schemaHash: `sha256:${"f".repeat(64)}`,
                kind: "action",
              },
              input: { values: {}, references: [reference] },
              assetInputs: [],
              actor: { kind: "system" },
              operation: "submit",
            },
          },
        ),
      ).resolves.toEqual({
        form: "document",
        documentKind: "media.transcript",
        schemaVersion: 1,
        body,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("persists plugin asset writes as immutable project-scoped Clash assets", async () => {
    const createBroker = (serverModule as Record<string, unknown>)
      .createLocalPluginBrokerServices as
      | ((options: { dataDir: string; uploadOrigin?: string }) => any)
      | undefined;
    expect(createBroker).toBeDefined();
    if (!createBroker) return;
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-plugin-output-"));
    const broker = createBroker({
      dataDir,
      uploadOrigin: "http://127.0.0.1:8787",
    });
    const context = {
      manifest: {
        apiVersion: "clash.plugin/v1",
        id: "test.asset-writer-plugin",
        version: "1.0.0",
        name: "Asset Writer Plugin",
        runtime: {
          kind: "local",
          transport: "stdio",
          entrypoint: "handler.mjs",
        },
        contributes: {
          cards: [],
          providers: [],
          modelBindings: [],
          functions: [{ id: "run", kind: "provider-executor" as const }],
        },
      },
      invocation: {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-output-1",
        taskId: "task-output-1",
        projectId: "project-output-1",
        target: {
          pluginId: "test.asset-writer-plugin",
          version: "1.0.0",
          exportId: "write",
          schemaHash: `sha256:${"c".repeat(64)}`,
          kind: "action",
        },
        input: { values: {}, references: [] },
        actor: { kind: "agent", id: "agent-1" },
      },
    };
    const output = (await broker(
      {
        protocol: "clash.plugin.broker-request/v1",
        requestId: "asset-output-1",
        invocationId: "invocation-output-1",
        operation: {
          kind: "asset.write",
          slot: "image",
          assetKind: "image",
          mediaType: "image/png",
          dataBase64: "AQID",
        },
      },
      context,
    )) as {
      assetId: string;
      uri: string;
      url?: string;
      reach?: string;
    };

    expect(output.uri).toBe(`clash-asset://${output.assetId}`);
    expect(output.assetId).toMatch(/^plugin-output:[a-f0-9]{64}$/);
    expect(output).not.toHaveProperty("url");
    expect(output).not.toHaveProperty("reach");
    const staged = await createLocalPluginAssetStagingStore({
      dataDir,
      clashRoot: clashHomeForLocalDataDir(dataDir),
    }).resolve({
      projectId: "project-output-1",
      projectAssetId: output.assetId,
    });
    expect(staged).toMatchObject({
      projectAssetId: output.assetId,
      projectId: "project-output-1",
      pluginId: "test.asset-writer-plugin",
      pluginVersion: "1.0.0",
      taskId: "task-output-1",
      kind: "image",
      mediaType: "image/png",
      projection: {
        byteLength: 3,
        receipt: { byteLength: 3 },
      },
    });
    expect(staged?.projection.resourceId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(staged?.projection.receipt.resourceId).toBe(
      staged?.projection.resourceId,
    );
    expect(staged?.projection).not.toHaveProperty("resource");
    expect(staged?.projection).not.toHaveProperty("kind");
    expect(staged?.projection).not.toHaveProperty("contentType");
    await expect(readFile(staged!.projection.path)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    const metadata = await createLocalMetadataStore(dataDir).load();
    expect(metadata.assets).toEqual([]);
    expect(metadata.assetRefs).toEqual([]);
  });

  it("stores a provider URL before returning its asset handle to a third-party plugin", async () => {
    const createBroker = (serverModule as Record<string, unknown>)
      .createLocalPluginBrokerServices as
      | ((options: {
          dataDir: string;
          assetFetch: typeof fetch;
          uploadOrigin?: string;
        }) => any)
      | undefined;
    expect(createBroker).toBeDefined();
    if (!createBroker) return;

    const dataDir = await mkdtemp(
      join(tmpdir(), "clash-local-plugin-url-output-"),
    );
    try {
      const assetFetch = vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "video/mp4" },
          }),
      );
      const broker = createBroker({
        dataDir,
        assetFetch,
        uploadOrigin: "http://127.0.0.1:8787",
      });
      const output = (await broker(
        {
          protocol: "clash.plugin.broker-request/v1",
          requestId: "asset-url-1",
          invocationId: "invocation-url-1",
          operation: {
            kind: "asset.upload-slot",
            slot: "media",
            assetKind: "video",
            mediaType: "video/mp4",
            url: "https://cdn.example.test/output.mp4",
          },
        },
        {
          manifest: {
            apiVersion: "clash.plugin/v1",
            id: "third-party.video-plugin",
            version: "2.1.0",
            name: "Third-party Video Plugin",
            runtime: {
              kind: "local",
              transport: "stdio",
              entrypoint: "handler.mjs",
            },
            contributes: {
              cards: [],
              providers: [],
              modelBindings: [],
              functions: [{ id: "run", kind: "provider-executor" }],
            },
          },
          invocation: {
            protocol: "clash.plugin.invoke/v1",
            invocationId: "invocation-url-1",
            taskId: "task-url-1",
            projectId: "project-url-1",
            target: {
              pluginId: "third-party.video-plugin",
              version: "2.1.0",
              exportId: "run",
              schemaHash: `sha256:${"d".repeat(64)}`,
              kind: "provider-executor",
            },
            input: { values: {}, references: [] },
            actor: { kind: "system", id: "test" },
          },
        },
      )) as {
        assetId: string;
        uri: string;
        kind: string;
        mediaType?: string;
        url?: string;
        reach?: string;
      };

      expect(output).toMatchObject({
        assetId: expect.not.stringMatching(/^upload-/),
        uri: `clash-asset://${output.assetId}`,
        kind: "video",
        mediaType: "video/mp4",
      });
      expect(output.assetId).toMatch(/^plugin-output:[a-f0-9]{64}$/);
      expect(output).not.toHaveProperty("url");
      expect(output).not.toHaveProperty("reach");
      expect(assetFetch).toHaveBeenCalledWith(
        "https://cdn.example.test/output.mp4",
      );
      const staged = await createLocalPluginAssetStagingStore({
        dataDir,
        clashRoot: clashHomeForLocalDataDir(dataDir),
      }).resolve({
        projectId: "project-url-1",
        projectAssetId: output.assetId,
      });
      expect(staged).toMatchObject({
        projectAssetId: output.assetId,
        projectId: "project-url-1",
        pluginId: "third-party.video-plugin",
        pluginVersion: "2.1.0",
        taskId: "task-url-1",
        kind: "video",
        mediaType: "video/mp4",
        projection: {
          byteLength: 3,
          receipt: { byteLength: 3 },
        },
      });
      expect(staged?.projection.resourceId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(staged?.projection.receipt.resourceId).toBe(
        staged?.projection.resourceId,
      );
      expect(staged?.projection).not.toHaveProperty("resource");
      expect(staged?.projection).not.toHaveProperty("kind");
      expect(staged?.projection).not.toHaveProperty("contentType");
      const metadata = await createLocalMetadataStore(dataDir).load();
      expect(metadata.assets).toEqual([]);
      expect(metadata.assetRefs).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps package scripts local and leaves dependency orchestration to the root", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};

    expect(scripts["build:deps"]).toBeUndefined();
    expect(scripts["build:with-deps"]).toBeUndefined();
    expect(scripts.build).toBe("tsc");
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts.test).toBe("vitest run src");
    expect(scripts["test:e2e"]).toBe(
      "tsx --tsconfig tsconfig.dev.json e2e/daemon-smoke.ts",
    );
  });

  it("uses CLASH_HOME for the default local data dir when CLASH_LOCAL_DATA_DIR is absent", () => {
    expect(
      defaultLocalApiDataDir({
        CLASH_HOME: "/tmp/clash-home",
      }),
    ).toBe(join("/tmp/clash-home", "local-api"));
    expect(
      defaultLocalApiDataDir({
        CLASH_HOME: "/tmp/clash-home",
        CLASH_LOCAL_DATA_DIR: "/tmp/explicit-local-api",
      }),
    ).toBe("/tmp/explicit-local-api");
    expect(
      defaultLocalApiDataDir({
        CLASH_LOCAL_DATA_DIR: "./relative-local-api",
      }),
    ).toBe(resolve("./relative-local-api"));
  });

  it("uses the server data directory as the ACP lifecycle directory", async () => {
    const clashRoot = await mkdtemp(join(tmpdir(), "clash-local-api-root-"));
    const dataDir = join(clashRoot, "local-api");
    const acpBinDir = join(dataDir, "acp-bin");
    await mkdir(acpBinDir, { recursive: true });
    const codexShim = join(acpBinDir, "codex-acp");
    await writeFile(codexShim, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(codexShim, 0o755);

    const adapter = createConfiguredLocalAcpAdapter({ PATH: "" }, { dataDir });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: expect.arrayContaining([
            expect.objectContaining({
              id: "codex-acp",
              binary: codexShim,
            }),
          ]),
        },
      ],
    });
  });

  it("rejects when the requested listen port is occupied", async () => {
    const blocker = createServer();
    const occupiedPort = await listenOnLoopback(blocker);
    if (occupiedPort === null) return;

    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-port-"));

    try {
      await withLocalDataDir(dataDir, async () => {
        await expect(
          startLocalApiServer({
            dataDir,
            port: occupiedPort,
            remotePersistence: null,
          }),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
      });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("writes a discovery record after listen and removes it on close", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-data-"));
    const runDir = await mkdtemp(join(tmpdir(), "clash-local-api-run-"));
    let server: Awaited<ReturnType<typeof startLocalApiServer>>;
    try {
      server = await withLocalDataDir(dataDir, () =>
        startLocalApiServer({
          dataDir,
          port: 0,
          remotePersistence: null,
          discovery: {
            enabled: true,
            runDir,
            launchMode: "desktop",
            ownerClientId: "desktop-1",
            startedBy: "desktop",
          },
        }),
      );
    } catch (error) {
      if (errorCode(error) === "EPERM") return;
      throw error;
    }

    const discovery = await readHostDiscovery({ runDir });
    expect(discovery.status).toBe("active");
    if (discovery.status !== "active")
      throw new Error("expected active discovery record");
    expect(discovery.record).toMatchObject({
      endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      agentCliPath: join(dataDir, "agent-bin", "clash"),
      launchMode: "desktop",
      ownerClientId: "desktop-1",
      pid: process.pid,
      protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
    });
    const health = await fetch(new URL("/health", discovery.record.endpoint));
    expect(await health.json()).toMatchObject({
      ok: true,
      mode: "local",
      host: {
        hostId: discovery.record.hostId,
        pid: discovery.record.pid,
        profile: discovery.record.profile,
        protocolVersion: discovery.record.protocolVersion,
      },
    });
    const shimText = await readFile(
      join(dataDir, "agent-bin", "clash"),
      "utf8",
    );
    expect(shimText).toContain(`CLASH_API_URL='${discovery.record.endpoint}'`);
    expect(shimText).not.toContain("CLASH_API_URL='http://127.0.0.1:0'");

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });

    await expect(readHostDiscovery({ runDir })).resolves.toEqual({
      status: "inactive",
    });
  });

  it("keeps a supervised source-watch lease discoverable across child restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-data-"));
    const runDir = await mkdtemp(join(tmpdir(), "clash-local-api-run-"));
    const previousSourceWatch = process.env.CLASH_DAEMON_SOURCE_WATCH;
    process.env.CLASH_DAEMON_SOURCE_WATCH = "1";
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await withLocalDataDir(dataDir, () =>
        startLocalApiServer({
          dataDir,
          port: 0,
          remotePersistence: null,
          discovery: {
            enabled: true,
            runDir,
            launchMode: "user-service",
            startedBy: "desktop",
          },
        }),
      );
      const first = await readHostDiscovery({ runDir });
      expect(first.status).toBe("active");
      if (first.status !== "active")
        throw new Error("expected active supervised discovery record");
      expect(first.record.pid).toBe(process.ppid);

      await new Promise<void>((resolve, reject) => {
        server!.close((error?: Error) => (error ? reject(error) : resolve()));
      });
      server = undefined;

      await expect(readHostDiscovery({ runDir })).resolves.toEqual(first);

      server = await withLocalDataDir(dataDir, () =>
        startLocalApiServer({
          dataDir,
          port: 0,
          remotePersistence: null,
          discovery: {
            enabled: true,
            runDir,
            launchMode: "user-service",
            startedBy: "desktop",
          },
        }),
      );
      const restarted = await readHostDiscovery({ runDir });
      expect(restarted.status).toBe("active");
      if (restarted.status !== "active")
        throw new Error("expected restarted supervised discovery record");
      expect(restarted.record.pid).toBe(process.ppid);
      expect(restarted.record.hostId).not.toBe(first.record.hostId);
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (previousSourceWatch === undefined) {
        delete process.env.CLASH_DAEMON_SOURCE_WATCH;
      } else {
        process.env.CLASH_DAEMON_SOURCE_WATCH = previousSourceWatch;
      }
      await rm(runDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("starts the configured voice readiness probe without blocking server listen", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "clash-local-api-voice-warmup-"),
    );
    await createClashUserConfigStore(dataDir).setSection("audio", {
      asr: {
        enabled: true,
        provider: "builtin-funasr",
        model: "iic/SenseVoiceSmall",
      },
      tts: {
        enabled: false,
        provider: "builtin-piper",
        model: "zh_CN-huayan-medium",
      },
    });

    let resolveStatus!: (status: { available: boolean }) => void;
    const builtinStatus = vi.fn(
      () =>
        new Promise<{ available: boolean }>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const audioConfig = createLocalAudioConfigStore({ dataDir, builtinStatus });
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        audioConfig,
        localAcp: createConfiguredLocalAcpAdapter({ CLASH_E2E_STUB_ACP: "1" }),
      });
      await vi.waitFor(() => expect(builtinStatus).toHaveBeenCalledTimes(1));
    } finally {
      resolveStatus?.({ available: true });
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
    }
  });

  it("keeps default host discovery beside the configured local-api data directory", async () => {
    const clashRoot = await mkdtemp(join(tmpdir(), "clash-local-api-root-"));
    const unrelatedClashHome = await mkdtemp(
      join(tmpdir(), "clash-unrelated-home-"),
    );
    const dataDir = join(clashRoot, "local-api");
    const runDir = join(clashRoot, "run");
    const previousClashHome = process.env.CLASH_HOME;
    process.env.CLASH_HOME = unrelatedClashHome;
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;

    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        localAcp: createConfiguredLocalAcpAdapter({ CLASH_E2E_STUB_ACP: "1" }),
        discovery: {
          enabled: true,
          launchMode: "desktop",
          ownerClientId: "desktop-canonical-root",
          startedBy: "desktop",
        },
      });

      await expect(readHostDiscovery({ runDir })).resolves.toMatchObject({
        status: "active",
        record: {
          ownerClientId: "desktop-canonical-root",
          agentCliPath: join(dataDir, "agent-bin", "clash"),
        },
      });
    } finally {
      if (server) {
        await new Promise<void>((resolveClose) =>
          server!.close(() => resolveClose()),
        );
      }
      if (previousClashHome === undefined) {
        delete process.env.CLASH_HOME;
      } else {
        process.env.CLASH_HOME = previousClashHome;
      }
    }

    await expect(readHostDiscovery({ runDir })).resolves.toEqual({
      status: "inactive",
    });
  });

  it("waits for local ACP disposal before completing server close", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-shutdown-"));
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const disposeAll = vi.fn(async () => disposeGate);
    const localAcp = {
      updateSpawnEnv() {},
      async listRuntimes() {
        return { runtimes: [] };
      },
      async createSession() {
        return { session_id: "unused" };
      },
      async listResumeSessions() {
        return { sessions: [] };
      },
      disposeAll,
    };
    let server: Awaited<ReturnType<typeof startLocalApiServer>>;
    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        localAcp: localAcp as never,
      });
    } catch (error) {
      if (errorCode(error) === "EPERM") return;
      throw error;
    }

    let closeSettled = false;
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        closeSettled = true;
        if (error) reject(error);
        else resolve();
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settledBeforeDispose = closeSettled;
    releaseDispose();
    await closing;

    expect(disposeAll).toHaveBeenCalledOnce();
    expect(settledBeforeDispose).toBe(false);
  });

  it("observes config.yaml edits made while ACP warmup is still running", async () => {
    const clashHome = await mkdtemp(
      join(tmpdir(), "clash-local-api-startup-config-"),
    );
    const dataDir = join(clashHome, "local-api");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(clashHome, "config.yaml"),
      "version: 1\nharnesses:\n  enabled:\n    - codex-acp\n",
    );
    let releaseWarmup!: () => void;
    const warmupGate = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const reconcileConfiguration = vi.fn(async () => undefined);
    const localAcp = {
      updateSpawnEnv() {},
      warmup: vi.fn(async () => warmupGate),
      reconcileConfiguration,
      async listRuntimes() {
        return { runtimes: [] };
      },
      async createSession() {
        return { session_id: "unused" };
      },
      async listResumeSessions() {
        return { sessions: [] };
      },
      async disposeAll() {},
    };
    let server: Awaited<ReturnType<typeof startLocalApiServer>> | null = null;
    try {
      server = await startLocalApiServer({
        dataDir,
        port: 0,
        remotePersistence: null,
        discovery: { enabled: false },
        localAcp: localAcp as never,
      });
      await writeFile(
        join(clashHome, "config.yaml"),
        "version: 1\nharnesses:\n  enabled:\n    - codex-acp\n    - claude-acp\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 180));
      releaseWarmup();

      await vi.waitFor(
        () => expect(reconcileConfiguration).toHaveBeenCalledOnce(),
        { timeout: 1_000 },
      );
    } catch (error) {
      if (errorCode(error) === "EPERM") return;
      throw error;
    } finally {
      releaseWarmup();
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("creates a local Clash CLI shim and injects it into agent spawn env", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const env = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        CLASH_PROFILE: "dev",
        PATH: "/usr/bin:/bin",
      },
    });

    expect(env.CLASH_API_URL).toBe("http://127.0.0.1:49397");
    expect(env.CLASH_PROFILE).toBe("dev");
    expect(env).not.toHaveProperty("CLASH_API_KEY");
    expect(env.PATH?.split(":")[0]).toBe(join(dataDir, "agent-bin"));

    const shim = join(dataDir, "agent-bin", "clash");
    await expect(stat(shim)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    const shimText = await readFile(shim, "utf8");
    expect(shimText).toContain("CLASH_API_URL");
    expect(shimText).toContain("CLASH_PROFILE='dev'");
    expect(shimText).not.toContain("CLASH_API_KEY");
    expect(shimText).toContain("command -v node");
    expect(shimText).toContain("ELECTRON_RUN_AS_NODE=1");
  });

  it("pins the published Clash CLI to the authoritative Clash home", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "canonical-clash-home-"));
    const dataDir = join(clashHome, "local-api");
    const env = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: "/usr/bin:/bin",
        CLASH_HOME: "/tmp/stale-clash-home",
        CLASH_LOCAL_DATA_DIR: "/tmp/stale-clash-home/local-api",
      },
    });

    expect(env.CLASH_HOME).toBe(clashHome);
    expect(env.CLASH_LOCAL_DATA_DIR).toBe(dataDir);

    const shimText = await readFile(
      join(dataDir, "agent-bin", "clash"),
      "utf8",
    );
    expect(shimText).toContain(`export CLASH_HOME='${clashHome}'`);
    expect(shimText).toContain(`export CLASH_LOCAL_DATA_DIR='${dataDir}'`);
    expect(shimText).not.toContain("/tmp/stale-clash-home");
  });

  it("passes an explicit Node runtime through to the local Clash CLI shim", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const env = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: "/usr/bin:/bin",
        CLASH_NODE_EXEC_PATH: "/custom/node",
      },
    });

    expect(env.CLASH_NODE_EXEC_PATH).toBe("/custom/node");

    const shim = join(dataDir, "agent-bin", "clash");
    const shimText = await readFile(shim, "utf8");
    expect(shimText).toContain('exec "$CLASH_NODE_EXEC_PATH"');
  });

  it("preserves the host-owned Clash runtime roots for ACP session setup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const childEnv = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: "/usr/bin:/bin",
        CLASH_AGENT_BUNDLE_ROOT: "/opt/clash/runtime/agents",
        CLASH_BUILTIN_PLUGIN_ROOT: "/opt/clash",
      },
    });

    expect(childEnv).toMatchObject({
      CLASH_AGENT_BUNDLE_ROOT: "/opt/clash/runtime/agents",
      CLASH_BUILTIN_PLUGIN_ROOT: "/opt/clash",
    });
  });

  it("uses an explicit Clash CLI entry path for child-process-safe packaged apps", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const childEnv = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: "/usr/bin:/bin",
        CLASH_NODE_EXEC_PATH: "/custom/node",
        CLASH_CLI_ENTRY_PATH:
          "/Applications/Clash.app/Contents/Resources/clash-cli/dist/index.js",
        CLASH_CLI_NODE_PATH:
          "/Applications/Clash.app/Contents/Resources/clash-cli/vendor",
      },
    });

    const shim = join(dataDir, "agent-bin", "clash");
    const shimText = await readFile(shim, "utf8");
    expect(shimText).toContain(
      "/Applications/Clash.app/Contents/Resources/clash-cli/dist/index.js",
    );
    expect(shimText).toContain(
      "export CLASH_CLI_NODE_PATH='/Applications/Clash.app/Contents/Resources/clash-cli/vendor'",
    );
    expect(childEnv.CLASH_CLI_NODE_PATH).toBe(
      "/Applications/Clash.app/Contents/Resources/clash-cli/vendor",
    );
    expect(shimText).not.toContain("app.asar/node_modules/@clash/cli");
  });

  it("preserves the CLI source tsconfig when the development shim runs from a clean shell", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const tsconfigPath = "/workspace/packages/cli/tsconfig.dev.json";
    const childEnv = createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: "/usr/bin:/bin",
        CLASH_CLI_ENTRY_PATH: "/workspace/packages/cli/src/index.ts",
        TSX_TSCONFIG_PATH: tsconfigPath,
      },
    });

    const shimText = await readFile(
      join(dataDir, "agent-bin", "clash"),
      "utf8",
    );
    expect(shimText).toContain(`export TSX_TSCONFIG_PATH='${tsconfigPath}'`);
    expect(childEnv.TSX_TSCONFIG_PATH).toBe(tsconfigPath);
  });

  it("keeps the packaged CLI vendor path when the shim runs from a clean shell", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-agent-tools-"));
    const cliEntry = join(dataDir, "print-node-path.cjs");
    const vendorPath = join(dataDir, "packaged-vendor");
    await writeFile(
      cliEntry,
      'process.stdout.write(process.env.NODE_PATH ?? "");\n',
      "utf8",
    );

    createLocalAgentToolEnv({
      dataDir,
      apiBaseUrl: "http://127.0.0.1:49397",
      env: {
        PATH: process.env.PATH,
        CLASH_CLI_ENTRY_PATH: cliEntry,
        CLASH_CLI_NODE_PATH: vendorPath,
      },
    });

    const shim = join(dataDir, "agent-bin", "clash");
    const { stdout } = await execFileAsync(shim, [], {
      env: { PATH: process.env.PATH },
    });
    expect(stdout).toBe(vendorPath);
  });

  it("can expose a deterministic mock ACP agent for desktop smoke tests", async () => {
    const adapter = createConfiguredLocalAcpAdapter({
      CLASH_E2E_STUB_ACP: "1",
    });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          id: "desktop-local",
          agents: [{ id: "mock-acp", binary: "mock-acp" }],
          status: "online",
        },
      ],
    });

    const created = await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "mock-agent",
      projectId: "mock-project",
    });
    const handlers = new Map<string, (raw?: unknown) => void>();
    const sent: unknown[] = [];
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((raw: string) => sent.push(JSON.parse(raw) as unknown)),
      on: vi.fn((event: string, handler: (raw?: unknown) => void) => {
        handlers.set(event, handler);
      }),
      close: vi.fn(),
    };

    adapter.bindSessionSocket(created.session_id, ws as never);
    handlers.get("message")?.(
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-smoke",
        text: "hello local agent",
      }),
    );

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: "session.complete",
        session_id: created.session_id,
        turn_id: "turn-smoke",
      });
    });
    const patchEvent = sent.find((message) => {
      const record = message as {
        type?: string;
        session_id?: string;
        turn_id?: string;
        event?: { sessionUpdate?: string; operations?: unknown[] };
      };
      return (
        record.type === "session.event" &&
        record.session_id === created.session_id &&
        record.turn_id === "turn-smoke" &&
        record.event?.sessionUpdate === "clash.canvas.patch" &&
        Array.isArray(record.event.operations)
      );
    }) as
      | {
          event: { operations: unknown[] };
        }
      | undefined;
    expect(patchEvent).toBeTruthy();
    expect(patchEvent?.event.operations).toEqual(
      expect.arrayContaining([
        {
          op: "add_node",
          node: {
            id: "mock-agent-stage-turn-smoke",
            type: "group",
            data: { label: "Agent Stage" },
            position: { x: 480, y: 140 },
            width: 620,
            height: 360,
            style: { width: 620, height: 360 },
          },
        },
        {
          op: "add_node",
          node: {
            id: "mock-agent-brief-turn-smoke",
            type: "action-badge",
            data: {
              label: "Agent Brief",
              actionType: "text-gen",
              content: "# Agent Brief\nhello local agent",
            },
            position: { x: 530, y: 210 },
            width: 260,
            height: 48,
          },
        },
        {
          op: "add_node",
          node: {
            id: "mock-agent-action-turn-smoke",
            type: "action-badge",
            data: {
              label: "Agent Image Pass",
              actionType: "image-gen",
              content: "# Prompt\nhello local agent",
            },
            position: { x: 530, y: 320 },
            width: 260,
            height: 48,
          },
        },
        {
          op: "timeline_apply",
          timeline: expect.objectContaining({
            nodeId: "mock-agent-timeline-turn-smoke",
          }),
        },
      ]),
    );
  });

  it("can stage a managed harness update and session restart for GUI E2E", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-harness-update-e2e-"));
    const adapter = createConfiguredLocalAcpAdapter({
      CLASH_E2E_STUB_ACP: "1",
      CLASH_E2E_STUB_HARNESS_UPDATE: "1",
      CLASH_LOCAL_DATA_DIR: dataDir,
    });

    await expect(adapter.listHarnesses()).resolves.not.toMatchObject({
      harnesses: [expect.objectContaining({ updateAvailable: true })],
    });
    await writeFile(join(dataDir, ".e2e-harness-update-ready"), "ready\n");
    const staged = await adapter.listHarnesses();
    expect(
      staged.harnesses.find((harness) => harness.id === "mock-acp"),
    ).toMatchObject({
      installedVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateAvailable: true,
    });

    const created = await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "mock-project",
    });
    await adapter.upgradeHarness("mock-acp");
    await expect(
      adapter.getSessionRuntimeStatus(created.session_id),
    ).resolves.toMatchObject({
      running_version: "1.0.0",
      installed_version: "2.0.0",
      restart_required: true,
    });
    await adapter.restartSession(created.session_id, { mode: "now" });
    await expect(
      adapter.getSessionRuntimeStatus(created.session_id),
    ).resolves.toMatchObject({
      running_version: "2.0.0",
      installed_version: "2.0.0",
      restart_required: false,
    });
  });

  it("can run a one-shot local ACP text task", async () => {
    const adapter = createConfiguredLocalAcpAdapter({
      CLASH_E2E_STUB_ACP: "1",
    });

    await expect(
      adapter.runTextTask?.({
        projectId: "mock-project",
        prompt: "write a short caption",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Mock ACP reply:"),
      sessionId: expect.any(String),
    });
  });

  it("does not expose the mock ACP agent from the legacy flag alone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-real-path-"));
    const adapter = createConfiguredLocalAcpAdapter({
      CLASH_LOCAL_ACP_MOCK: "1",
      CLASH_LOCAL_DATA_DIR: dataDir,
      CLASH_ACP_BIN_DIR: dataDir,
      PATH: "",
    });

    const runtimes = await adapter.listRuntimes();

    expect(
      runtimes.runtimes[0]?.agents.some((agent) => agent.id === "mock-acp"),
    ).toBe(false);
  });

  it("uses only the self-hosted ACP directory when a packaged runtime directory is also present", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-api-data-"));
    const packagedBinDir = await mkdtemp(
      join(tmpdir(), "clash-local-api-packaged-acp-bin-"),
    );
    const managedBinDir = join(dataDir, "acp-bin");
    await mkdir(managedBinDir, { recursive: true });
    const packagedCodexShim = join(packagedBinDir, "codex-acp");
    const codexShim = join(managedBinDir, "codex-acp");
    await writeFile(packagedCodexShim, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(packagedCodexShim, 0o755);
    await writeFile(codexShim, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(codexShim, 0o755);

    const adapter = createConfiguredLocalAcpAdapter({
      CLASH_LOCAL_DATA_DIR: dataDir,
      CLASH_ACP_BIN_DIR: packagedBinDir,
      PATH: "",
    });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: expect.arrayContaining([
            expect.objectContaining({
              id: "codex-acp",
              binary: codexShim,
            }),
          ]),
        },
      ],
    });
  });
});
