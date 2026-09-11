import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  activateOrUpdateHostExecutablePluginPackage,
  listHostExecutablePluginPackages,
  readHostExecutablePluginPackage,
  removeHostExecutablePluginPackage,
  rollbackHostExecutablePluginPackage,
  validateHostExecutablePluginPackageContracts,
  type HostExecutablePluginPackage,
} from "./plugin-package.js";
import { createExecutablePluginActivationReceipt, executablePluginActivationReceiptPath } from "./host/lib/actions-loader.js";
import { Canvas, MODEL_CARDS, ExecutablePluginCardRegistrationSchema, readGeneratorRevision, readProjectGenerator } from "@clash/shared-types";
import { LocalLoroRoomHub } from "../sync.js";
import { createLocalProjectUpgrade } from "../local-project-upgrade.js";
import { createLocalApiApp } from "../app.js";
import { createSqliteDurableRunJournal } from "../durable-run-journal.js";

it("recovers a legacy bound Card through the existing rollback API without rewriting its original contract", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-card-rollback-"));
  const actionsRoot = join(dataDir, "actions");
  const mappedPackage = (version: string) => {
    const pkg = generatorPackage(version);
    const cardPath = `cards/${pkg.id}.json`;
    const card = JSON.parse(Buffer.from(pkg.files[cardPath]!, "base64").toString("utf8"));
    card.spec.generator = { definitionId: "test-generator", actionId: "render", inputSlots: {} };
    pkg.files[cardPath] = encoded(card);
    const generatorPath = "generators/test-generator.json";
    const generator = JSON.parse(Buffer.from(pkg.files[generatorPath]!, "base64").toString("utf8"));
    generator.spec.actions[0].outputs = [{ slot: "result", assetType: { kind: "document", documentKind: "text.plain", schemaVersion: 1 }, cardinality: { minItems: 1, maxItems: 1 } }];
    pkg.files[generatorPath] = encoded(generator);
    return pkg;
  };
  const originalPackage = mappedPackage("1.0.0");
  const active = () => readHostExecutablePluginPackage(actionsRoot, originalPackage.id);
  const journal = createSqliteDurableRunJournal(dataDir);
  const upgrade = createLocalProjectUpgrade({
    materializeDoc: async () => false,
    listDefinitions: async () => (await active()).generatorRegistrations ?? [],
    modelCards: async () => MODEL_CARDS,
    listActionCards: async () => {
      const pkg = await active();
      const ref = pkg.generatorDefinitions![0]!;
      return [ExecutablePluginCardRegistrationSchema.parse({ pluginId: ref.pluginId, version: ref.version, schemaHash: ref.schemaHash,
        runtime: (pkg.manifest as { runtime: unknown }).runtime,
        document: JSON.parse(Buffer.from(pkg.files[`cards/${pkg.id}.json`]!, "base64").toString("utf8")),
      })];
    },
    rememberDefinition: journal.rememberGeneratorDefinition,
  });
  const seed = new LocalLoroRoomHub(dataDir, undefined, null);
  const hub = new LocalLoroRoomHub(dataDir, undefined, null, upgrade);
  try {
    await activateOrUpdateHostExecutablePluginPackage(originalPackage, actionsRoot);
    const originalDefinition = (await active()).generatorDefinitions![0]!;
    const binding = { pluginId: originalDefinition.pluginId, version: originalDefinition.version, schemaHash: originalDefinition.schemaHash, exportId: originalPackage.id };
    await seed.mutateProject("project", doc => {
      const canvas = new Canvas(doc, () => {});
      canvas.createNode("draft", "action-badge", { actionType: `custom:${originalPackage.id}`, content: "Keep the authored prompt", pluginBinding: binding });
      canvas.createNode("old-result", "text", { content: "Keep the historical result", status: "completed" });
      canvas.insertEdge("historical", "draft", "old-result");
      return { value: undefined, save: true };
    });
    const before = await seed.inspectProject("project", doc => ({ output: new Canvas(doc, () => {}).readNode("old-result"), edges: new Canvas(doc, () => {}).listEdges() }));
    await seed.close();
    await activateOrUpdateHostExecutablePluginPackage(mappedPackage("2.0.0"), actionsRoot);
    await expect(hub.room("project")).rejects.toThrow(/Restore.*1\.0\.0/);
    const app = createLocalApiApp({ dataDir, pluginPackages: {
      list: () => listHostExecutablePluginPackages(actionsRoot),
      validate: input => validateHostExecutablePluginPackageContracts(input as HostExecutablePluginPackage, actionsRoot),
      activate: input => activateOrUpdateHostExecutablePluginPackage(input as HostExecutablePluginPackage, actionsRoot),
      read: id => readHostExecutablePluginPackage(actionsRoot, id),
      rollback: id => rollbackHostExecutablePluginPackage(actionsRoot, id),
      remove: id => removeHostExecutablePluginPackage(actionsRoot, id),
    } });
    const response = await app.request(`/api/v1/local/plugins/${originalPackage.id}/rollback`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: originalDefinition.version });
    const revision = await hub.inspectProject("project", doc => {
      const canvas = new Canvas(doc, () => {});
      const node = canvas.readNode("draft")!;
      const head = readProjectGenerator(doc, node.data.generatorId as string)!;
      const revision = readGeneratorRevision(doc, { generatorId: head.id, generatorRevisionId: head.headRevisionId })!;
      expect(canvas.readNode("old-result")).toEqual(before.output);
      expect(canvas.listEdges()).toEqual(before.edges);
      expect(revision.state.prompt).toBe("Keep the authored prompt");
      expect(revision.definitionRef).toEqual({ pluginId: originalDefinition.pluginId, definitionId: originalDefinition.definitionId, version: originalDefinition.version, schemaHash: originalDefinition.schemaHash });
      return revision;
    });
    expect(await journal.readGeneratorDefinition!(revision.definitionRef)).toEqual(originalDefinition);
    await hub.close();
    const reopened = new LocalLoroRoomHub(dataDir, undefined, null, upgrade);
    try {
      expect(await reopened.inspectProject("project", doc => readGeneratorRevision(doc, { generatorId: revision.generatorId, generatorRevisionId: revision.id }))).toEqual(revision);
    } finally { await reopened.close(); }
  } finally { await seed.close(); await hub.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("revalidates unchanged bytes after a Host schema-hash change without allowing same-version code replacement", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-reattest-"));
  const actionsRoot = join(workspace, "actions");
  const pkg = actionPackage("1.0.0");
  await activateOrUpdateHostExecutablePluginPackage(pkg, actionsRoot);
  const receiptPath = executablePluginActivationReceiptPath(actionsRoot, pkg.id);
  const manifestPath = join(actionsRoot, pkg.id, "manifest.json");
  const oldManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete oldManifest.contributes.views;
  await writeFile(manifestPath, JSON.stringify(oldManifest));
  const before = await createExecutablePluginActivationReceipt(join(actionsRoot, pkg.id));
  await writeFile(receiptPath, JSON.stringify({ ...before, schemaHash: `sha256:${"0".repeat(64)}` }));
  await expect(readHostExecutablePluginPackage(actionsRoot, pkg.id)).rejects.toThrow(/activation receipt/);
  await activateOrUpdateHostExecutablePluginPackage(pkg, actionsRoot);
  expect((await readHostExecutablePluginPackage(actionsRoot, pkg.id)).version).toBe("1.0.0");
  const after = JSON.parse(await readFile(receiptPath, "utf8"));
  expect(after.contentHash).toBe(before.contentHash);
  expect(after.schemaHash).toBe(before.schemaHash);
  await expect(activateOrUpdateHostExecutablePluginPackage(actionPackage("1.0.0", "changed:"), actionsRoot))
    .rejects.toThrow(/version/);
});

function encoded(value: unknown): string {
  return Buffer.from(`${JSON.stringify(value)}\n`).toString("base64");
}

function actionPackage(
  version: string,
  prefix = "",
): HostExecutablePluginPackage {
  const id = "test.package-manager";
  const cardPath = `cards/${id}.json`;
  const contractPath = `contract-tests/${id}.json`;
  const entrypoint = "handler.mjs";
  return {
    id,
    manifest: {
      apiVersion: "clash.plugin/v1",
      id,
      version,
      name: "Package Manager Fixture",
      runtime: {
        kind: "local",
        transport: "stdio",
        language: "node",
        entrypoint,
      },
      contributes: {
        cards: [{ id, kind: "action-card", path: cardPath }],
        functions: [{ id, kind: "action" }],
      },
      contractTests: [contractPath],
    },
    files: {
      [entrypoint]: Buffer.from(
        [
          'import { createInterface } from "node:readline";',
          'createInterface({ input: process.stdin }).on("line", (line) => {',
          "  const frame = JSON.parse(line);",
          "  process.stdout.write(JSON.stringify({",
          '    protocol: "clash.plugin.result/v1",',
          "    invocationId: frame.invocationId,",
          '    status: "completed",',
          `    outputs: [{ slot: "result", kind: "value", value: { text: ${JSON.stringify(prefix)} + frame.input.values.prompt } }],`,
          '  }) + "\\n");',
          "});",
        ].join("\n"),
      ).toString("base64"),
      [cardPath]: encoded({
        apiVersion: "clash.card/v1",
        kind: "action-card",
        spec: {
          id,
          name: "Package Manager Fixture",
          parameters: [],
          outputType: "text",
          input: {
            requiresPrompt: true,
            inputMode: {},
            promptModalities: ["text"],
          },
          functionExportId: id,
        },
      }),
      [contractPath]: encoded({
        apiVersion: "clash.plugin.contract-test/v1",
        id: `${id}-basic`,
        target: { exportId: id, kind: "action" },
        input: { values: { prompt: "hello" }, references: [] },
        expect: {
          status: "completed",
          outputs: [
            {
              slot: "result",
              kind: "value",
              value: { text: `${prefix}hello` },
            },
          ],
        },
      }),
    },
  };
}

function generatorPackage(version = "1.0.0"): HostExecutablePluginPackage {
  const pkg = actionPackage(version);
  const manifest = pkg.manifest as {
    contributes: {
      cards: unknown[];
      functions: unknown[];
      generators?: unknown[];
    };
  };
  manifest.contributes.generators = [
    {
      id: "test-generator",
      kind: "generator",
      path: "generators/test-generator.json",
    },
  ];
  pkg.files["generators/test-generator.json"] = encoded({
    apiVersion: "clash.generator/v1",
    kind: "generator",
    spec: {
      definitionId: "test-generator",
      stateSchema: { type: "object" },
      editPolicy: "advance-head",
      persistentInputs: [],
      actions: [
        {
          id: "render",
          executorExportId: "test.package-manager",
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
  });
  return pkg;
}

it("validates a declared Generator artifact before activation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-generator-package-"));
  const validation = await validateHostExecutablePluginPackageContracts(
    generatorPackage(),
    join(workspace, "actions"),
  );

  expect(validation).toMatchObject({
    id: "test.package-manager",
    version: "1.0.0",
    generatorDefinitions: [
      {
        pluginId: "test.package-manager",
        definitionId: "test-generator",
        version: "1.0.0",
        actions: [
          {
            id: "render",
            executorExportId: "test.package-manager",
          },
        ],
      },
    ],
  });
  expect(validation.generatorDefinitions?.[0]).not.toHaveProperty("runtime");
  expect(validation.generatorDefinitions?.[0]).not.toHaveProperty("realm");
});

it("reads an activated package with its pinned Generator definitions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-generator-read-"));
  const actionsRoot = join(workspace, "actions");
  const pkg = generatorPackage();
  await activateOrUpdateHostExecutablePluginPackage(pkg, actionsRoot);

  const checkedOut = (await readHostExecutablePluginPackage(
    actionsRoot,
    pkg.id,
  )) as Awaited<ReturnType<typeof readHostExecutablePluginPackage>> & {
    generatorDefinitions?: Array<Record<string, unknown>>;
  };
  expect(checkedOut.generatorDefinitions).toMatchObject([
    {
      pluginId: "test.package-manager",
      definitionId: "test-generator",
      version: "1.0.0",
    },
  ]);
  expect(checkedOut.generatorDefinitions?.[0]).not.toHaveProperty("runtime");
  expect(checkedOut.generatorDefinitions?.[0]).not.toHaveProperty("realm");
});

it("owns plugin validation, activation, checkout, rollback, listing, and removal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-manager-"));
  const actionsRoot = join(workspace, "actions");
  const v1 = actionPackage("1.0.0");
  const validation = await validateHostExecutablePluginPackageContracts(
    v1,
    actionsRoot,
  );
  expect(validation.contractTests?.passed).toBe(1);

  const first = await activateOrUpdateHostExecutablePluginPackage(
    v1,
    actionsRoot,
  );
  expect(first.version).toBe("1.0.0");
  expect(
    (await readHostExecutablePluginPackage(actionsRoot, v1.id)).version,
  ).toBe("1.0.0");
  expect(await listHostExecutablePluginPackages(actionsRoot)).toMatchObject([
    { id: v1.id, version: "1.0.0", drifted: false },
  ]);

  const second = await activateOrUpdateHostExecutablePluginPackage(
    actionPackage("2.0.0", "v2:"),
    actionsRoot,
  );
  expect(second.rollbackDir).toBeTruthy();
  expect(
    (await rollbackHostExecutablePluginPackage(actionsRoot, v1.id)).version,
  ).toBe("1.0.0");

  const removed = await removeHostExecutablePluginPackage(actionsRoot, v1.id);
  expect(removed).toMatchObject({ id: v1.id, removed: true });
  expect(await listHostExecutablePluginPackages(actionsRoot)).toEqual([]);
});
