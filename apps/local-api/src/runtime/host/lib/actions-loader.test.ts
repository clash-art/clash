import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginModule } from "@clash/action-sdk";
import { describe, expect, it, vi } from "vitest";
import type {
  LoadedTrustedBundledPluginModule,
  TrustedBundledPluginModuleRegistration,
} from "../../../bundled-plugin-modules.js";
import type { ActionEnv } from "./actions-loader.js";
import * as actionsLoader from "./actions-loader";

const { ActionsHost } = actionsLoader;

async function attestTestPlugin(
  actionsRoot: string,
  pluginDir: string,
): Promise<void> {
  const createReceipt = (actionsLoader as Record<string, unknown>)
    .createExecutablePluginActivationReceipt as (
    dir: string,
  ) => Promise<Record<string, unknown>>;
  const receiptPath = (actionsLoader as Record<string, unknown>)
    .executablePluginActivationReceiptPath as (
    root: string,
    pluginId: string,
  ) => string;
  const manifest = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(pluginDir, "manifest.json"), "utf8"),
    ),
  ) as { id: string };
  const path = receiptPath(actionsRoot, manifest.id);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(await createReceipt(pluginDir)));
}

interface BundledTestPlugin {
  registration: TrustedBundledPluginModuleRegistration;
  loaded: LoadedTrustedBundledPluginModule;
}

type MixedRealmActionEnv = ActionEnv & {
  trustedBundledPluginModules: readonly TrustedBundledPluginModuleRegistration[];
  loadTrustedBundledPluginModule(
    pluginId: string,
  ): Promise<LoadedTrustedBundledPluginModule>;
};

async function bundledTestPlugin(options: {
  id: string;
  resultValue: string;
  invoke?: PluginModule["invoke"];
  actionAssetInputs?: Array<{
    match: { kinds?: string[]; slots?: string[] };
    representations: string[];
    mediaTypes?: string[];
  }>;
}): Promise<BundledTestPlugin> {
  const root = await mkdtemp(join(tmpdir(), "clash-bundled-module-"));
  await mkdir(join(root, "cards"), { recursive: true });
  await mkdir(join(root, "providers"), { recursive: true });
  await mkdir(join(root, "bindings"), { recursive: true });
  await mkdir(join(root, "generators"), { recursive: true });
  await writeFile(
    join(root, "cards", "run-action.json"),
    JSON.stringify({
      apiVersion: "clash.card/v1",
      kind: "action-card",
      spec: {
        id: "run-action",
        name: "Run Action",
        outputType: "image",
        functionExportId: "run-action",
      },
    }),
  );
  await writeFile(
    join(root, "providers", "test-provider.json"),
    JSON.stringify({
      apiVersion: "clash.provider/v1",
      kind: "provider",
      spec: {
        id: "test-provider",
        name: "Test Provider",
        upstreamId: "test-upstream",
        apiShape: "test-api",
        executorExportId: "execute",
        auth: {
          methods: [
            {
              id: "api-key",
              label: "API key",
              form: [
                {
                  kind: "field",
                  key: "apiKey",
                  label: "API key",
                  secret: true,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(root, "bindings", "test-model.json"),
    JSON.stringify({
      apiVersion: "clash.binding/v1",
      kind: "model-provider-binding",
      spec: {
        id: "test-model-binding",
        modelId: "test-model",
        providerId: "test-provider",
        upstreamId: "test-upstream",
        upstreamModel: "test-model-v1",
        apiShape: "test-api",
        executorExportId: "execute",
      },
    }),
  );
  await writeFile(
    join(root, "generators", "test-generator.json"),
    JSON.stringify({
      apiVersion: "clash.generator/v1",
      kind: "generator",
      spec: {
        definitionId: "test-generator",
        stateSchema: { type: "object" },
        editPolicy: "advance-head",
        persistentInputs: [],
        actions: [
          {
            id: "run",
            executorExportId: "run-action",
            parametersSchema: { type: "object" },
            invocationInputs: [],
            outputs: [
              {
                slot: "media",
                assetType: { kind: "media", mediaKind: "image" },
                cardinality: { minItems: 1, maxItems: 1 },
              },
            ],
          },
        ],
      },
    }),
  );
  const functions = [
    {
      id: "run-action",
      kind: "action" as const,
      ...(options.actionAssetInputs
        ? { assetInputs: options.actionAssetInputs }
        : {}),
    },
    { id: "execute", kind: "provider-executor" as const },
  ];
  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: options.id,
      version: "1.0.0",
      name: "Bundled module test",
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/must-not-be-spawned.mjs",
      },
      contributes: {
        cards: [
          {
            id: "run-action",
            kind: "action-card",
            path: "cards/run-action.json",
          },
        ],
        providers: [
          {
            id: "test-provider",
            kind: "provider",
            path: "providers/test-provider.json",
          },
        ],
        modelBindings: [
          {
            id: "test-model-binding",
            kind: "model-provider-binding",
            path: "bindings/test-model.json",
          },
        ],
        generators: [
          {
            id: "test-generator",
            kind: "generator",
            path: "generators/test-generator.json",
          },
        ],
        functions,
      },
    }),
  );
  return {
    registration: { id: options.id },
    loaded: {
      id: options.id,
      manifestPath,
      entrypointPath: join(root, "dist", "must-not-be-spawned.mjs"),
      plugin: {
        contributes: functions,
        invoke:
          options.invoke ??
          (async (invocation) => ({
            protocol: "clash.plugin.result/v1",
            invocationId: invocation.invocationId,
            status: "completed",
            outputs: [
              {
                slot: "realm",
                kind: "value",
                value: options.resultValue,
              },
            ],
          })),
      },
    },
  };
}

function mixedRealmEnv(
  actionsRoot: string,
  ...plugins: BundledTestPlugin[]
): MixedRealmActionEnv {
  const loaded = new Map(
    plugins.map((plugin) => [plugin.loaded.id, plugin.loaded]),
  );
  return {
    actionsRoot,
    trustedBundledPluginModules: plugins.map((plugin) => plugin.registration),
    async loadTrustedBundledPluginModule(pluginId) {
      const plugin = loaded.get(pluginId);
      if (!plugin) throw new Error(`No trusted test module ${pluginId}.`);
      return plugin;
    },
  };
}

async function writeProcessTestPlugin(options: {
  actionsRoot: string;
  id: string;
  resultValue: string;
  generator?: boolean;
  fastExit?: boolean;
}): Promise<void> {
  const root = join(options.actionsRoot, options.id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "stdio.mjs"),
    options.fastExit
      ? "process.exit(0);\n"
      : [
          'import { createInterface } from "node:readline";',
          "const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });",
          "for await (const line of lines) {",
          "  if (!line.trim()) continue;",
          "  const invocation = JSON.parse(line);",
          "  process.stdout.write(JSON.stringify({",
          '    protocol: "clash.plugin.result/v1",',
          "    invocationId: invocation.invocationId,",
          '    status: "completed",',
          `    outputs: [{ slot: "realm", kind: "value", value: ${JSON.stringify(options.resultValue)} }],`,
          '  }) + "\\n");',
          "}",
        ].join("\n"),
  );
  if (options.generator) {
    await mkdir(join(root, "generators"), { recursive: true });
    await writeFile(
      join(root, "generators", "test-generator.json"),
      JSON.stringify({
        apiVersion: "clash.generator/v1",
        kind: "generator",
        spec: {
          definitionId: "test-generator",
          stateSchema: { type: "object" },
          editPolicy: "advance-head",
          persistentInputs: [],
          actions: [
            {
              id: "run",
              executorExportId: "run-action",
              parametersSchema: { type: "object" },
              invocationInputs: [],
              outputs: [
                {
                  slot: "media",
                  assetType: { kind: "media", mediaKind: "image" },
                  cardinality: { minItems: 1, maxItems: 1 },
                },
              ],
            },
          ],
        },
      }),
    );
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: options.id,
      version: "1.0.0",
      name: "Process test plugin",
      runtime: { kind: "local", transport: "stdio", entrypoint: "stdio.mjs" },
      contributes: {
        functions: [
          { id: "execute", kind: "provider-executor" },
          ...(options.generator ? [{ id: "run-action", kind: "action" }] : []),
        ],
        ...(options.generator
          ? {
              generators: [
                {
                  id: "test-generator",
                  kind: "generator",
                  path: "generators/test-generator.json",
                },
              ],
            }
          : {}),
      },
    }),
  );
  await attestTestPlugin(options.actionsRoot, root);
}

function invocationFor(binding: {
  pluginId: string;
  version: string;
  exportId: string;
  schemaHash: string;
}) {
  return {
    protocol: "clash.plugin.invoke/v1",
    invocationId: `invocation-${binding.pluginId}`,
    taskId: `task-${binding.pluginId}`,
    projectId: "project-1",
    target: { ...binding, kind: "provider-executor" as const },
    input: { values: {}, references: [] },
    actor: { kind: "system" as const, id: "test" },
  };
}

function completedValue(result: unknown): unknown {
  return (result as { outputs?: Array<{ value?: unknown }> }).outputs?.[0]
    ?.value;
}

function executionDiagnostics(host: InstanceType<typeof ActionsHost>): Array<{
  pluginId: string;
  version: string;
  realm: "bundled-module" | "process-stdio";
  ready: boolean;
}> {
  return (
    host as InstanceType<typeof ActionsHost> & {
      listExecutionDiagnostics(): Array<{
        pluginId: string;
        version: string;
        realm: "bundled-module" | "process-stdio";
        ready: boolean;
      }>;
    }
  ).listExecutionDiagnostics();
}

describe("ActionsHost mixed execution realms", () => {
  it("replaces caller-supplied action Asset delivery with the schema-pinned function export", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-module-action-asset-inputs-"),
    );
    const bundled = await bundledTestPlugin({
      id: "clash.action-asset-inputs",
      resultValue: "unused",
      actionAssetInputs: [
        {
          match: { kinds: ["image"], slots: ["source"] },
          representations: ["executor-url"],
          mediaTypes: ["image/png"],
        },
      ],
      invoke: async (current) => ({
        protocol: "clash.plugin.result/v1",
        invocationId: current.invocationId,
        status: "completed",
        outputs: [
          {
            slot: "delivery",
            kind: "value",
            value: current.assetInputs,
          },
        ],
      }),
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await host.start();
      const binding = host.resolveBinding(
        "clash.action-asset-inputs",
        "run-action",
        "action",
      );
      const result = await host.invoke("clash.action-asset-inputs", {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-action-delivery",
        taskId: "task-action-delivery",
        projectId: "project-1",
        target: { ...binding, kind: "action" },
        input: { values: {}, references: [] },
        assetInputs: [
          {
            match: { kinds: ["video"], slots: ["forged"] },
            representations: ["bytes"],
          },
        ],
        actor: { kind: "system", id: "test" },
      });

      expect(completedValue(result)).toEqual([
        {
          match: { kinds: ["image"], slots: ["source"] },
          representations: ["executor-url"],
          mediaTypes: ["image/png"],
        },
      ]);
    } finally {
      await host.stopAll();
    }
  });

  it("preserves the caller-frozen delivery contract for provider executors", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-module-provider-asset-inputs-"),
    );
    const bundled = await bundledTestPlugin({
      id: "clash.provider-asset-inputs",
      resultValue: "unused",
      invoke: async (current) => ({
        protocol: "clash.plugin.result/v1",
        invocationId: current.invocationId,
        status: "completed",
        outputs: [
          {
            slot: "delivery",
            kind: "value",
            value: current.assetInputs,
          },
        ],
      }),
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await host.start();
      const binding = host.resolveBinding(
        "clash.provider-asset-inputs",
        "execute",
        "provider-executor",
      );
      const frozen = [
        {
          match: { kinds: ["video"], slots: ["reference"] },
          representations: ["provider-url"],
        },
      ];
      const result = await host.invoke("clash.provider-asset-inputs", {
        ...invocationFor(binding),
        assetInputs: frozen,
      });

      expect(completedValue(result)).toEqual(frozen);
    } finally {
      await host.stopAll();
    }
  });

  it("keeps an installed Generator definition readable while its process executor is unavailable", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-process-generator-unavailable-"),
    );
    await writeProcessTestPlugin({
      actionsRoot,
      id: "test.unavailable-generator",
      resultValue: "unreachable",
      generator: true,
      fastExit: true,
    });
    const host = new ActionsHost({ actionsRoot });

    try {
      await host.start();
      await expect
        .poll(
          () =>
            executionDiagnostics(host).find(
              (entry) => entry.pluginId === "test.unavailable-generator",
            )?.ready,
        )
        .toBe(false);
      expect(host.listGenerators()).toMatchObject([
        {
          pluginId: "test.unavailable-generator",
          document: { spec: { definitionId: "test-generator" } },
        },
      ]);
      expect(
        host.resolveGeneratorDefinition(
          "test.unavailable-generator",
          "test-generator",
        ),
      ).toMatchObject({
        pluginId: "test.unavailable-generator",
        definitionId: "test-generator",
      });
    } finally {
      await host.stopAll();
    }
  });

  it("lists native Generator registrations from a trusted module without a realm fact", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-module-generators-"),
    );
    const bundled = await bundledTestPlugin({
      id: "clash.generator-module",
      resultValue: "bundled-module",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await host.start();
      const generatorHost = host as InstanceType<typeof ActionsHost> & {
        listGenerators?: () => Array<Record<string, unknown>>;
      };
      expect(generatorHost.listGenerators).toBeTypeOf("function");
      const registrations = generatorHost.listGenerators?.() ?? [];
      expect(registrations).toMatchObject([
        {
          pluginId: "clash.generator-module",
          version: "1.0.0",
          document: {
            spec: {
              definitionId: "test-generator",
              actions: [{ id: "run", executorExportId: "run-action" }],
            },
          },
        },
      ]);
      expect(registrations[0]).not.toHaveProperty("runtime");
      expect(registrations[0]).not.toHaveProperty("realm");
    } finally {
      await host.stopAll();
    }
  });

  it("resolves a native Generator definition pinned to its package schema", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-resolve-generator-"),
    );
    const bundled = await bundledTestPlugin({
      id: "clash.resolve-generator",
      resultValue: "bundled-module",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await host.start();
      const generatorHost = host as InstanceType<typeof ActionsHost> & {
        resolveGeneratorDefinition?: (
          pluginId: string,
          definitionId: string,
        ) => Record<string, unknown>;
      };
      expect(generatorHost.resolveGeneratorDefinition).toBeTypeOf("function");
      const definition = generatorHost.resolveGeneratorDefinition?.(
        "clash.resolve-generator",
        "test-generator",
      );
      expect(definition).toMatchObject({
        pluginId: "clash.resolve-generator",
        definitionId: "test-generator",
        version: "1.0.0",
        schemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        editPolicy: "advance-head",
        actions: [{ id: "run", executorExportId: "run-action" }],
      });
      expect(definition).not.toHaveProperty("runtime");
      expect(definition).not.toHaveProperty("realm");
    } finally {
      await host.stopAll();
    }
  });

  it("invokes a trusted module without requiring its process entrypoint", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-module-host-"));
    const bundled = await bundledTestPlugin({
      id: "clash.test-module",
      resultValue: "bundled-module",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await expect(host.start()).resolves.toEqual({ spawned: [], skipped: [] });
      expect(host.listIds()).toEqual(["clash.test-module"]);
      expect(executionDiagnostics(host)).toEqual([
        {
          pluginId: "clash.test-module",
          version: "1.0.0",
          realm: "bundled-module",
          ready: true,
        },
      ]);
      expect(host.listCards()).toMatchObject([
        {
          pluginId: "clash.test-module",
          document: { spec: { id: "run-action" } },
        },
      ]);
      expect(host.listProviders()).toMatchObject([
        {
          pluginId: "clash.test-module",
          document: { spec: { id: "test-provider" } },
        },
      ]);
      expect(host.listModelBindings()).toMatchObject([
        {
          pluginId: "clash.test-module",
          document: { spec: { id: "test-model-binding" } },
        },
      ]);

      const binding = host.resolveBinding(
        "clash.test-module",
        "execute",
        "provider-executor",
      );
      expect(binding).not.toHaveProperty("realm");
      await expect(
        host.invoke("clash.test-module", invocationFor(binding)),
      ).resolves.toSatisfy(
        (result) => completedValue(result) === "bundled-module",
      );
    } finally {
      await host.stopAll();
    }
  });

  it("keeps an installed stdio plugin running when a bundled module is present", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-mixed-host-"));
    const bundled = await bundledTestPlugin({
      id: "clash.test-module",
      resultValue: "bundled-module",
    });
    await writeProcessTestPlugin({
      actionsRoot,
      id: "third.process",
      resultValue: "process-stdio",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await expect(host.start()).resolves.toEqual({
        spawned: ["third.process"],
        skipped: [],
      });
      const binding = host.resolveBinding(
        "third.process",
        "execute",
        "provider-executor",
      );
      await expect(
        host.invoke("third.process", invocationFor(binding)),
      ).resolves.toSatisfy(
        (result) => completedValue(result) === "process-stdio",
      );
      const moduleBinding = host.resolveBinding(
        "clash.test-module",
        "execute",
        "provider-executor",
      );
      await expect(
        host.invoke("clash.test-module", invocationFor(moduleBinding)),
      ).resolves.toSatisfy(
        (result) => completedValue(result) === "bundled-module",
      );
      expect(executionDiagnostics(host)).toEqual([
        {
          pluginId: "clash.test-module",
          version: "1.0.0",
          realm: "bundled-module",
          ready: true,
        },
        {
          pluginId: "third.process",
          version: "1.0.0",
          realm: "process-stdio",
          ready: true,
        },
      ]);
    } finally {
      await host.stopAll();
    }
  });

  it("refuses an installed package that collides with a trusted bundled id", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-collision-host-"));
    const bundled = await bundledTestPlugin({
      id: "clash.collision",
      resultValue: "trusted-bundled",
    });
    await writeProcessTestPlugin({
      actionsRoot,
      id: "clash.collision",
      resultValue: "untrusted-shadow",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await expect(host.start()).resolves.toEqual({
        spawned: [],
        skipped: ["clash.collision"],
      });
      const binding = host.resolveBinding(
        "clash.collision",
        "execute",
        "provider-executor",
      );
      const result = await host.invoke(
        "clash.collision",
        invocationFor(binding),
      );
      expect(completedValue(result)).toBe("trusted-bundled");
    } finally {
      await host.stopAll();
    }
  });

  it("fails closed when a trusted module is unavailable instead of running its same-id package", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-broken-bundle-"));
    const pluginId = "clash.broken-bundle";
    await writeProcessTestPlugin({
      actionsRoot,
      id: pluginId,
      resultValue: "untrusted-fallback",
    });
    const host = new ActionsHost({
      actionsRoot,
      trustedBundledPluginModules: [{ id: pluginId }],
      async loadTrustedBundledPluginModule() {
        throw new Error("bundled payload is corrupt");
      },
    } satisfies MixedRealmActionEnv);

    try {
      await expect(host.start()).resolves.toEqual({
        spawned: [],
        skipped: [pluginId],
      });
      expect(host.listIds()).toEqual([]);
      expect(() =>
        host.resolveBinding(pluginId, "execute", "provider-executor"),
      ).toThrow(/not installed/i);
    } finally {
      await host.stopAll();
    }
  });

  it("loads trusted modules with a small bound, registry order and per-plugin isolation", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-bounded-bundle-"));
    const ids = ["clash.parallel-a", "clash.parallel-b", "clash.parallel-c", "clash.parallel-d", "clash.parallel-e"];
    const brokenId = "clash.parallel-c";
    const plugins = await Promise.all(
      ids.map((id) => bundledTestPlugin({ id, resultValue: id })),
    );
    let active = 0;
    let maxActive = 0;
    const host = new ActionsHost({
      actionsRoot,
      trustedBundledPluginModules: plugins.map((plugin) => plugin.registration),
      async loadTrustedBundledPluginModule(id) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          // Finish in reverse registry order so registration order cannot come from completion.
          await new Promise((resolve) => setTimeout(resolve, (ids.length - ids.indexOf(id)) * 10));
          if (id === brokenId) throw new Error("corrupt bundled payload");
          return plugins.find((plugin) => plugin.loaded.id === id)!.loaded;
        } finally {
          active -= 1;
        }
      },
    } satisfies MixedRealmActionEnv);

    try {
      await host.start();
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(4);
      expect(host.listIds()).toEqual(ids.filter((id) => id !== brokenId));
    } finally {
      await host.stopAll();
    }
  });

  it("keeps bundled modules outside actions-directory reconciliation", async () => {
    const actionsRoot = await mkdtemp(
      join(tmpdir(), "clash-module-reconcile-"),
    );
    const bundled = await bundledTestPlugin({
      id: "clash.stable-module",
      resultValue: "still-running",
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    try {
      await host.start();
      await rm(actionsRoot, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 800));

      const binding = host.resolveBinding(
        "clash.stable-module",
        "execute",
        "provider-executor",
      );
      const result = await host.invoke(
        "clash.stable-module",
        invocationFor(binding),
      );
      expect(completedValue(result)).toBe("still-running");
    } finally {
      await host.stopAll();
    }
  });

  it("closes a bundled endpoint and rejects its active invocation on shutdown", async () => {
    const actionsRoot = await mkdtemp(join(tmpdir(), "clash-module-close-"));
    let entered!: () => void;
    const invoked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundled = await bundledTestPlugin({
      id: "clash.pending-module",
      resultValue: "never",
      invoke: async () => {
        entered();
        return await new Promise(() => undefined);
      },
    });
    const host = new ActionsHost(mixedRealmEnv(actionsRoot, bundled));

    await host.start();
    const binding = host.resolveBinding(
      "clash.pending-module",
      "execute",
      "provider-executor",
    );
    const active = host.invoke("clash.pending-module", invocationFor(binding));
    await invoked;

    await host.stopAll();

    await expect(active).rejects.toThrow(/endpoint closed/i);
  });
});

it("ActionsHost scans actions under CLASH_HOME", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await mkdtemp(join(tmpdir(), "clash-actions-home-"));
  process.env.CLASH_HOME = clashHome;
  const host = new ActionsHost({});

  try {
    const result = await host.start();

    expect(result.spawned).toEqual([]);
    expect((await stat(join(clashHome, "actions"))).isDirectory()).toBe(true);
  } finally {
    await host.stopAll();
    if (originalClashHome === undefined) {
      delete process.env.CLASH_HOME;
    } else {
      process.env.CLASH_HOME = originalClashHome;
    }
  }
});

it("ActionsHost strictly validates executable plugin Cards before spawning", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await mkdtemp(join(tmpdir(), "clash-plugin-home-"));
  process.env.CLASH_HOME = clashHome;

  const writePlugin = async (dirName: string, cardId: string) => {
    const root = join(clashHome, "actions", dirName);
    await mkdir(join(root, "cards"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "dist", "handler.mjs"),
      "setInterval(() => {}, 1000);\n",
    );
    await writeFile(
      join(root, "cards", "action.json"),
      JSON.stringify({
        apiVersion: "clash.card/v1",
        kind: "action-card",
        spec: {
          id: cardId,
          name: "Test Action",
          outputType: "image",
          functionExportId: "test-action",
        },
      }),
    );
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({
        apiVersion: "clash.plugin/v1",
        id: dirName,
        version: "1.0.0",
        name: "Test Plugin",
        runtime: {
          kind: "local",
          transport: "stdio",
          entrypoint: "dist/handler.mjs",
        },
        contributes: {
          cards: [
            {
              id: "test-action",
              kind: "action-card",
              path: "cards/action.json",
            },
          ],
          functions: [{ id: "test-action", kind: "action" }],
        },
      }),
    );
    if (cardId === "test-action")
      await attestTestPlugin(join(clashHome, "actions"), root);
  };

  await writePlugin("test.valid-plugin", "test-action");
  await writePlugin("invalid-plugin", "wrong-id");
  const retired = join(clashHome, "actions", "retired-websocket-action");
  await mkdir(retired, { recursive: true });
  await writeFile(join(retired, "handler.py"), "raise SystemExit(0)\n");
  await writeFile(
    join(retired, "manifest.json"),
    JSON.stringify({
      id: "retired-websocket-action",
      name: "Retired websocket action",
      runtime: "local",
      entrypoint: "handler.py",
    }),
  );
  const host = new ActionsHost({});

  try {
    const result = await host.start();
    expect(new Set(result.spawned)).toEqual(new Set(["test.valid-plugin"]));
    expect(new Set(result.skipped)).toEqual(
      new Set(["invalid-plugin", "retired-websocket-action"]),
    );
    expect(host.listIds()).toEqual(["test.valid-plugin"]);
  } finally {
    await host.stopAll();
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});

it("ActionsHost discovers independently exported Providers and model bindings", async () => {
  const clashHome = await mkdtemp(join(tmpdir(), "clash-provider-artifacts-"));
  const actionsRoot = join(clashHome, "actions");
  const root = join(actionsRoot, "hilo.hub-media");
  await mkdir(join(root, "providers"), { recursive: true });
  await mkdir(join(root, "bindings"), { recursive: true });
  await writeFile(join(root, "stdio.mjs"), "setInterval(() => {}, 1000);\n");
  await writeFile(
    join(root, "providers", "hilo-hub.json"),
    JSON.stringify({
      apiVersion: "clash.provider/v1",
      kind: "provider",
      spec: {
        id: "hilo-hub",
        name: "MiniMax Hilo Hub",
        upstreamId: "hilo-hub",
        apiShape: "hilo-hub",
        executorExportId: "hilo-hub-execute",
        auth: {
          methods: [
            {
              id: "sign-in",
              label: "Sign in",
              flow: {
                open: "https://hub.minimax.io/login",
                callback: { type: "scheme", scheme: "minimax-hub" },
                credential: {
                  from: "query",
                  name: "accessToken",
                  storeAs: "accessToken",
                },
              },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(root, "bindings", "minimax-h3.json"),
    JSON.stringify({
      apiVersion: "clash.binding/v1",
      kind: "model-provider-binding",
      spec: {
        id: "hilo-hub-minimax-h3",
        modelId: "minimax-h3",
        providerId: "hilo-hub",
        upstreamId: "hilo-hub",
        upstreamModel: "MiniMax-H3",
        apiShape: "hilo-hub",
        executorExportId: "hilo-hub-execute",
        requiredOAuth: ["hilo-hub"],
      },
    }),
  );
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "hilo.hub-media",
      version: "1.0.0",
      name: "Hilo Hub Media",
      runtime: { kind: "local", transport: "stdio", entrypoint: "stdio.mjs" },
      contributes: {
        cards: [],
        providers: [
          { id: "hilo-hub", kind: "provider", path: "providers/hilo-hub.json" },
        ],
        modelBindings: [
          {
            id: "hilo-hub-minimax-h3",
            kind: "model-provider-binding",
            path: "bindings/minimax-h3.json",
          },
        ],
        functions: [{ id: "hilo-hub-execute", kind: "provider-executor" }],
      },
    }),
  );
  await attestTestPlugin(actionsRoot, root);
  const host = new ActionsHost({
    actionsRoot,
  }) as InstanceType<typeof ActionsHost> & {
    listProviders(): Array<{
      pluginId: string;
      document: { spec: { id: string } };
    }>;
    listModelBindings(): Array<{
      pluginId: string;
      document: { spec: { modelId: string } };
    }>;
  };

  try {
    await host.start();
    expect(host.listProviders()).toMatchObject([
      {
        pluginId: "hilo.hub-media",
        document: { spec: { id: "hilo-hub" } },
      },
    ]);
    expect(host.listModelBindings()).toMatchObject([
      {
        pluginId: "hilo.hub-media",
        document: { spec: { modelId: "minimax-h3" } },
      },
    ]);
  } finally {
    await host.stopAll();
  }
});

it("v1 plugin processes cannot inherit Clash or provider credentials", () => {
  const buildEnv = (actionsLoader as Record<string, unknown>)
    .credentialFreePluginEnv as
    | ((manifest: unknown, inherited?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv)
    | undefined;
  expect(buildEnv).toBeDefined();
  if (!buildEnv) return;

  const env = buildEnv(
    { id: "test.safe-plugin", version: "1.0.0" },
    {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      CLASH_API_KEY: "clsh_secret",
      FAL_KEY: "fal_secret",
      MINIMAX_API_KEY: "minimax_secret",
    },
  );

  expect(env).toMatchObject({
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    CLASH_PLUGIN_ID: "test.safe-plugin",
    CLASH_PLUGIN_VERSION: "1.0.0",
    CLASH_PLUGIN_TRANSPORT: "stdio",
  });
  expect(env.CLASH_API_KEY).toBeUndefined();
  expect(env.FAL_KEY).toBeUndefined();
  expect(env.MINIMAX_API_KEY).toBeUndefined();
  expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
});

it("v1 plugin processes prefer the explicit Node runtime provided by Electron", () => {
  const resolveNode = (actionsLoader as Record<string, unknown>)
    .resolveExecutablePluginNodePath as
    ((inherited?: NodeJS.ProcessEnv, fallback?: string) => string) | undefined;
  expect(resolveNode).toBeDefined();
  if (!resolveNode) return;

  expect(
    resolveNode(
      { CLASH_NODE_EXEC_PATH: "/opt/clash/node" },
      "/Applications/Clash/Electron",
    ),
  ).toBe("/opt/clash/node");
  expect(resolveNode({}, "/Applications/Clash/Electron")).toBe(
    "/Applications/Clash/Electron",
  );
});

it("ActionsHost invokes a supervised Python v1 plugin over host-owned stdio", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const originalPython = process.env.CLASH_ACTIONS_PYTHON;
  const clashHome = await mkdtemp(join(tmpdir(), "clash-plugin-python-home-"));
  process.env.CLASH_HOME = clashHome;
  process.env.CLASH_ACTIONS_PYTHON = "python3";
  const root = join(clashHome, "actions", "test.python-plugin");
  const trafficPath = join(clashHome, "python-replay.jsonl");
  await writeFile(trafficPath, "", "utf8");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "stdio.py"),
    [
      "import json",
      "import os",
      "import sys",
      "for line in sys.stdin:",
      "    line = line.strip()",
      "    if not line:",
      "        continue",
      "    message = json.loads(line)",
      "    if message.get('protocol') != 'clash.plugin.invoke/v1':",
      "        continue",
      "    print(json.dumps({",
      "        'protocol': 'clash.plugin.result/v1',",
      "        'invocationId': message['invocationId'],",
      "        'status': 'completed',",
      "        'outputs': [{'slot': 'wire', 'kind': 'value', 'value': {",
      "            'pythonRuntime': True,",
      "            'pythonInstrumentation': os.environ.get('CLASH_PROVIDER_TRAFFIC_MODE') == 'replay' and 'sitecustomize' in sys.modules,",
      "        }}],",
      "    }), flush=True)",
    ].join("\n"),
  );
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "test.python-plugin",
      version: "1.0.0",
      name: "Python Plugin",
      runtime: { kind: "local", transport: "stdio", entrypoint: "stdio.py" },
      contributes: {
        cards: [],
        functions: [{ id: "project", kind: "provider-projector" }],
      },
    }),
  );
  await attestTestPlugin(join(clashHome, "actions"), root);
  const host = new ActionsHost({
    providerHttpInstrumentation: {
      mode: "replay",
      trafficPath,
      modulePath: join(clashHome, "node-provider-instrumentation.ts"),
    },
  }) as InstanceType<typeof ActionsHost> & {
    resolveBinding(
      pluginId: string,
      exportId: string,
      kind: "provider-projector",
    ): {
      pluginId: string;
      version: string;
      exportId: string;
      schemaHash: string;
    };
    invoke(
      pluginId: string,
      invocation: unknown,
      options?: { timeoutMs?: number },
    ): Promise<any>;
  };

  try {
    await host.start();
    const binding = host.resolveBinding(
      "test.python-plugin",
      "project",
      "provider-projector",
    );
    const result = await host.invoke(
      "test.python-plugin",
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-python-1",
        taskId: "task-1",
        projectId: "project-1",
        target: {
          ...binding,
          kind: "provider-projector",
        },
        input: { values: {}, references: [] },
        actor: { kind: "agent", id: "agent-1" },
      },
      { timeoutMs: 60_000 },
    );
    expect(result).toMatchObject({
      status: "completed",
      outputs: [
        {
          value: { pythonRuntime: true, pythonInstrumentation: true },
        },
      ],
    });
  } finally {
    await host.stopAll();
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
    if (originalPython === undefined) delete process.env.CLASH_ACTIONS_PYTHON;
    else process.env.CLASH_ACTIONS_PYTHON = originalPython;
  }
}, 90_000);

it("contract tests drive Python entrypoints through scoped-store fixtures", async () => {
  const originalPython = process.env.CLASH_ACTIONS_PYTHON;
  process.env.CLASH_ACTIONS_PYTHON = "python3";
  const pluginDir = await mkdtemp(join(tmpdir(), "clash-python-contract-"));
  await mkdir(join(pluginDir, "contract-tests"), { recursive: true });
  await writeFile(
    join(pluginDir, "stdio.py"),
    [
      "import json",
      "import sys",
      "",
      "request_seq = 0",
      "",
      "",
      "def broker(operation):",
      "    global request_seq",
      "    request_seq += 1",
      "    request_id = f'py-broker-{request_seq}'",
      "    print(json.dumps({",
      "        'protocol': 'clash.plugin.broker-request/v1',",
      "        'requestId': request_id,",
      "        'invocationId': CURRENT_INVOCATION,",
      "        'operation': operation,",
      "    }), flush=True)",
      "    for raw in sys.stdin:",
      "        raw = raw.strip()",
      "        if not raw:",
      "            continue",
      "        response = json.loads(raw)",
      "        if response.get('protocol') != 'clash.plugin.broker-response/v1':",
      "            continue",
      "        if response.get('requestId') != request_id:",
      "            continue",
      "        if response.get('status') != 'ok':",
      "            raise RuntimeError(response.get('error', {}).get('message', 'broker error'))",
      "        return response.get('result')",
      "    raise RuntimeError('broker stream closed')",
      "",
      "",
      "for line in sys.stdin:",
      "    line = line.strip()",
      "    if not line:",
      "        continue",
      "    message = json.loads(line)",
      "    if message.get('protocol') != 'clash.plugin.invoke/v1':",
      "        continue",
      "    CURRENT_INVOCATION = message['invocationId']",
      "    state = broker({'kind': 'store.get', 'key': 'apiKey'})",
      "    print(json.dumps({",
      "        'protocol': 'clash.plugin.result/v1',",
      "        'invocationId': message['invocationId'],",
      "        'status': 'completed',",
      "        'outputs': [{'slot': 'media', 'kind': 'value', 'value': {",
      "            'apiKey': state['value'],",
      "            'prompt': message['input']['values'].get('prompt'),",
      "        }}],",
      "    }), flush=True)",
    ].join("\n"),
  );
  await writeFile(
    join(pluginDir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "test.py-gateway",
      version: "1.0.0",
      name: "Python Gateway",
      runtime: { kind: "local", transport: "stdio", entrypoint: "stdio.py" },
      contributes: {
        cards: [],
        functions: [{ id: "execute", kind: "provider-executor" }],
      },
      contractTests: ["contract-tests/echo.json"],
    }),
  );
  await writeFile(
    join(pluginDir, "contract-tests", "echo.json"),
    JSON.stringify({
      apiVersion: "clash.plugin.contract-test/v1",
      id: "py-echo",
      target: { exportId: "execute", kind: "provider-executor" },
      context: { projectId: "project-contract" },
      timeoutMs: 60_000,
      input: { values: { prompt: "A paper moon" }, references: [] },
      brokerFixtures: [
        {
          operation: { kind: "store.get", key: "apiKey" },
          response: { status: "ok", result: { value: "contract-key" } },
        },
      ],
      expect: {
        status: "completed",
        outputs: [
          {
            slot: "media",
            kind: "value",
            value: {
              apiKey: "contract-key",
              prompt: "A paper moon",
            },
          },
        ],
      },
    }),
  );

  try {
    const run = await actionsLoader.runExecutablePluginContractTests(pluginDir);
    expect(run).toEqual({
      passed: 1,
      tests: [{ id: "py-echo", status: "passed" }],
    });
  } finally {
    if (originalPython === undefined) delete process.env.CLASH_ACTIONS_PYTHON;
    else process.env.CLASH_ACTIONS_PYTHON = originalPython;
  }
}, 90_000);

it("contract tests run serve()-based Python plugins with the SDK on PYTHONPATH", async () => {
  const originalPython = process.env.CLASH_ACTIONS_PYTHON;
  process.env.CLASH_ACTIONS_PYTHON = "python3";
  const pluginDir = await mkdtemp(join(tmpdir(), "clash-python-serve-"));
  await mkdir(join(pluginDir, "contract-tests"), { recursive: true });
  await writeFile(
    join(pluginDir, "stdio.py"),
    [
      "from clash_sdk.executable import serve",
      "",
      "",
      "async def execute(invocation, context):",
      "    api_key = await context.store.get('apiKey')",
      "    return [{'slot': 'media', 'kind': 'value', 'value': {",
      "        'apiKey': api_key,",
      "        'prompt': invocation['input']['values'].get('prompt'),",
      "    }}]",
      "",
      "",
      "serve({'execute': {'submit': execute}})",
    ].join("\n"),
  );
  await writeFile(
    join(pluginDir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "test.py-serve",
      version: "1.0.0",
      name: "Python Serve Plugin",
      runtime: { kind: "local", transport: "stdio", entrypoint: "stdio.py" },
      contributes: {
        cards: [],
        functions: [{ id: "execute", kind: "provider-executor" }],
      },
      contractTests: ["contract-tests/echo.json"],
    }),
  );
  await writeFile(
    join(pluginDir, "contract-tests", "echo.json"),
    JSON.stringify({
      apiVersion: "clash.plugin.contract-test/v1",
      id: "py-serve-echo",
      target: { exportId: "execute", kind: "provider-executor" },
      context: { projectId: "project-contract" },
      timeoutMs: 60_000,
      input: { values: { prompt: "A paper moon" }, references: [] },
      brokerFixtures: [
        {
          operation: { kind: "store.get", key: "apiKey" },
          response: { status: "ok", result: { value: "serve-key" } },
        },
      ],
      expect: {
        status: "completed",
        outputs: [
          {
            slot: "media",
            kind: "value",
            value: {
              apiKey: "serve-key",
              prompt: "A paper moon",
            },
          },
        ],
      },
    }),
  );

  try {
    const run = await actionsLoader.runExecutablePluginContractTests(pluginDir);
    expect(run).toEqual({
      passed: 1,
      tests: [{ id: "py-serve-echo", status: "passed" }],
    });
  } finally {
    if (originalPython === undefined) delete process.env.CLASH_ACTIONS_PYTHON;
    else process.env.CLASH_ACTIONS_PYTHON = originalPython;
  }
}, 90_000);

it("ActionsHost refuses executable code changed outside atomic activation", async () => {
  const createReceipt = (actionsLoader as Record<string, unknown>)
    .createExecutablePluginActivationReceipt as
    ((pluginDir: string) => Promise<Record<string, unknown>>) | undefined;
  const receiptPath = (actionsLoader as Record<string, unknown>)
    .executablePluginActivationReceiptPath as
    ((actionsRoot: string, pluginId: string) => string) | undefined;
  expect(createReceipt).toBeDefined();
  expect(receiptPath).toBeDefined();
  if (!createReceipt || !receiptPath) return;

  const clashHome = await mkdtemp(join(tmpdir(), "clash-plugin-attestation-"));
  const actionsRoot = join(clashHome, "actions");
  const pluginDir = join(actionsRoot, "test.attested-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "handler.mjs"),
    "setInterval(() => {}, 1000);\n",
  );
  await writeFile(
    join(pluginDir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "test.attested-plugin",
      version: "1.0.0",
      name: "Attested Plugin",
      runtime: { kind: "local", transport: "stdio", entrypoint: "handler.mjs" },
      contributes: {
        cards: [],
        functions: [{ id: "run", kind: "provider-executor" as const }],
      },
    }),
  );
  const path = receiptPath(actionsRoot, "test.attested-plugin");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(await createReceipt(pluginDir)));

  const first = new ActionsHost({
    actionsRoot,
  });
  try {
    await expect(first.start()).resolves.toMatchObject({
      spawned: ["test.attested-plugin"],
    });
  } finally {
    await first.stopAll();
  }

  await writeFile(
    join(pluginDir, "handler.mjs"),
    "// changed without version bump\nsetInterval(() => {}, 1000);\n",
  );
  const second = new ActionsHost({
    actionsRoot,
  });
  try {
    await expect(second.start()).resolves.toMatchObject({
      spawned: [],
      skipped: ["test.attested-plugin"],
    });
    expect(second.listIds()).toEqual([]);
  } finally {
    await second.stopAll();
  }
});

describe("plugin stderr forwarding", () => {
  it("batches a bounded ring and counts the lines it dropped", () => {
    vi.useFakeTimers();
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const forwarder = actionsLoader.createPluginStderrForwarder("test.plugin");
      for (let i = 0; i < 10_000; i++) forwarder.push(`line ${i}\n`);
      // Nothing reaches the Host stderr on the per-line hot path.
      expect(write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(write).toHaveBeenCalledTimes(1);
      const chunk = String(write.mock.calls[0]![0]);
      // The newest 200 lines are kept; 9,800 older ones are counted, not logged.
      expect(chunk).toContain("line 9999");
      expect(chunk).not.toContain("line 9799\n");
      expect(chunk).toContain("9800 stderr lines suppressed");
      expect(
        chunk.split("\n").filter((line) => line.length > 0),
      ).toHaveLength(201);
      forwarder.close();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      vi.useRealTimers();
    }
  });
});
