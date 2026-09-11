import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it, vi } from "vitest";
import {
  Canvas,
  CustomActionDefinitionSchema,
  ExecutablePluginCardRegistrationSchema,
  GeneratorDefinitionSchema,
  readGeneratorRevision,
  readProjectActionRun,
  readOutputCommit,
  listActionAssetBindings,
  readDocumentAssetRevision,
  generatorDefinitionFromExecutablePluginRegistration,
  createProjectAsset,
  readProjectAsset,
} from "@clash/shared-types";
import { readMetadataBody } from "@clash/shared-runtime";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalAssetInspectionService } from "./local-asset-inspections.js";
import { createLocalProjectAssetService } from "./local-project-assets.js";
import { runCodexImageGeneration } from "../../../plugins/codex-imagegen/src/stdio.js";

it("admits an explicitly mapped Action through its native revision and restores the same output after replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-native-custom-"));
  const doc = new LoroDoc();
  try {
    const definition = GeneratorDefinitionSchema.parse({
      pluginId: "test.writer",
      definitionId: "writer",
      version: "1.0.0",
      schemaHash: `sha256:${"c".repeat(64)}`,
      stateSchema: {
        type: "object",
        properties: { prompt: { type: "string" }, tone: { type: "string" } },
        required: ["prompt"],
        additionalProperties: false,
      },
      editPolicy: "fork-when-materialized",
      persistentInputs: [],
      actions: ["draft", "revise"].map((id) => ({
        id,
        executorExportId: "write",
        parametersSchema: { type: "object", additionalProperties: false },
        invocationInputs: [],
        outputs: [
          {
            slot: "prose",
            assetType: {
              kind: "document",
              documentKind: "text.plain",
              schemaVersion: 1,
            },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      })),
    });
    const registration = ExecutablePluginCardRegistrationSchema.parse({
      pluginId: definition.pluginId,
      version: definition.version,
      schemaHash: definition.schemaHash,
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
      },
      document: {
        apiVersion: "clash.card/v1",
        kind: "action-card",
        spec: {
          id: "revise-card",
          name: "Revise",
          functionExportId: "write",
          outputType: "text",
          parameters: [{ id: "tone", label: "Tone", type: "text" }],
          generator: {
            definitionId: definition.definitionId,
            actionId: "revise",
          },
        },
      },
    });
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("output", "text", {
      status: "pending",
      actionType: "custom:revise-card",
      customActionId: "revise-card",
      outputType: "text",
      prompt: "Describe a courtyard",
      customActionParams: { tone: "quiet" },
      pluginBinding: {
        pluginId: definition.pluginId,
        version: definition.version,
        schemaHash: definition.schemaHash,
        exportId: "write",
      },
    });
    const text = "A quiet courtyard.\nMorning light falls across the stones.";
    const execute = vi.fn(async (request: { taskId: string }) => ({
      protocol: "clash.plugin.result/v1" as const,
      invocationId: request.taskId,
      status: "completed" as const,
      outputs: [
        {
          slot: "prose",
          kind: "document" as const,
          document: {
            documentKind: "text.plain",
            schemaVersion: 1,
            body: text,
          },
        },
      ],
    }));
    const listPluginCards = vi.fn(async () => [registration]);
    const processor = createLocalWorkflowProcessor({
      dataDir: directory,
      listPluginCards,
      resolveGeneratorDefinition: async () => definition,
      durableProviderRuns: {
        ownerId: "host",
        providerPluginExecutor: async () => {
          throw new Error("Custom Actions cannot invoke a Model Provider.");
        },
      },
      executablePluginAction: execute,
    });
    const process = () =>
      processor.process({
        projectId: "project",
        doc,
        checkpoint: async () => undefined,
      });
    await process();
    const result = canvas.readNode("output")!;
    expect(result.data.status).toBe("completed");
    const run = readProjectActionRun(doc, result.data.actionRunId as string)!;
    expect(run).toMatchObject({ actionId: "revise", status: "succeeded" });
    expect(run.executor.exportId).toBe("write");
    expect(readGeneratorRevision(doc, run.generatorRevision)).toMatchObject({
      definitionRef: {
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        schemaHash: definition.schemaHash,
      },
      state: { prompt: "Describe a courtyard", tone: "quiet" },
    });
    const commit = readOutputCommit(doc, {
      actionRunId: run.actionRunId,
      outputSlot: "prose",
    })!;
    expect(result.data.documentRevision).toEqual(commit.asset);
    if (commit.asset.kind !== "document") throw new Error("Missing Document");
    const revision = readDocumentAssetRevision(doc, commit.asset)!;
    expect(
      await readMetadataBody({
        dataDir: directory,
        contentHash: revision.body.digest,
      }),
    ).toBe(text);
    expect(listActionAssetBindings(doc)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    listPluginCards.mockRejectedValue(new Error("Package no longer installed"));
    // A copied public pointer does not transfer the private Canvas ownership guard.
    canvas.createNode("other-output", "text", {
      ...result.data,
      status: "pending",
      prompt: "A different request",
    });
    await process();
    expect(canvas.readNode("other-output")!.data.status).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1);
    // A stale visible pending state after restart must restore the frozen Run;
    // the active package may no longer be installed.
    doc
      .getMap("nodes")
      .set("output", {
        ...result,
        data: { ...result.data, status: "pending" },
      });
    await process();
    expect(canvas.readNode("output")!.data).toMatchObject({
      status: "completed",
      actionRunId: run.actionRunId,
      documentRevision: commit.asset,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    doc.free();
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs the shipped Codex ImageGen Card through its declared native image slot and retains exact input assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-native-image-card-"));
  const doc = new LoroDoc();
  try {
    const readJson = async (path: string) =>
      JSON.parse(
        await readFile(
          new URL(`../../../plugins/codex-imagegen/${path}`, import.meta.url),
          "utf8",
        ),
      );
    const [manifest, card, document] = await Promise.all([
      readJson("manifest.json"),
      readJson("cards/codex-imagegen.json"),
      readJson("generators/codex-imagegen.json"),
    ]);
    const provenance = {
      pluginId: manifest.id,
      version: manifest.version,
      schemaHash: `sha256:${"d".repeat(64)}`,
    };
    const definition = generatorDefinitionFromExecutablePluginRegistration({
      ...provenance,
      document,
    });
    const registration = ExecutablePluginCardRegistrationSchema.parse({
      ...provenance,
      runtime: manifest.runtime,
      document: card,
    });
    await createLocalProjectAssetService({
      dataDir: directory,
      projectionOrigin: "http://localhost",
    }).materializeDoc("project", doc);
    const referenceIds = ["reference-b", "reference-a"];
    for (const id of referenceIds) {
      expect(
        createProjectAsset(doc, {
          id,
          kind: "image",
          source: { kind: "owned", resourceId: `sha256:${"e".repeat(64)}` },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png" },
        }),
      ).toMatchObject({ ok: true });
    }
    const canvas = new Canvas(doc, () => {});
    const requestData = {
      status: "pending",
      actionType: `custom:${card.spec.id}`,
      customActionId: card.spec.id,
      outputType: card.spec.outputType,
      prompt: "An orange cat",
      customActionParams: { aspect_ratio: "16:9" },
      referenceImageAssetIds: referenceIds,
      pluginBinding: { ...provenance, exportId: card.spec.functionExportId },
    };
    canvas.createNode("output", "image", requestData);
    const staging = createLocalPluginAssetStagingStore({ dataDir: directory });
    const hostCalls: unknown[] = [];
    const processor = createLocalWorkflowProcessor({
      dataDir: directory,
      listPluginCards: async () => [registration],
      resolveGeneratorDefinition: async () => definition,
      assetInspection: createLocalAssetInspectionService({
        dataDir: directory,
        inspectResource: async () => ({
          contentType: "image/png",
          width: 1,
          height: 1,
          rotationDegrees: 0,
        }),
      }),
      executablePluginAction: async (request) =>
        runCodexImageGeneration(
          {
            protocol: "clash.plugin.invoke/v1",
            invocationId: request.taskId,
            taskId: request.taskId,
            projectId: request.projectId,
            actor: request.actor,
            target: { ...request.binding, kind: "action" },
            input: request.input,
          },
          {
            hostTools: {
              codexImagegen: {
                generate: async (input) => {
                  hostCalls.push(input);
                  const staged = await staging.stage({
                    projectId: request.projectId,
                    taskId: request.taskId,
                    slot: input.slot,
                    pluginId: request.binding.pluginId,
                    pluginVersion: request.binding.version,
                    invocationId: request.taskId,
                    kind: "image",
                    mediaType: "image/png",
                    bytes: Buffer.from(
                      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                      "base64",
                    ),
                  });
                  return {
                    assetId: staged.projectAssetId,
                    uri: `clash-asset://${staged.projectAssetId}`,
                    kind: "image",
                    mediaType: "image/png",
                  };
                },
              },
            },
          },
        ),
    });
    const process = () =>
      processor.process({
        projectId: "project",
        doc,
        checkpoint: async () => undefined,
      });
    await process();
    const result = canvas.readNode("output")!;
    expect(result.data.status, String(result.data.error)).toBe("completed");
    const run = readProjectActionRun(doc, result.data.actionRunId as string)!;
    expect(run.actionId).toBe(card.spec.generator.actionId);
    expect(
      readGeneratorRevision(doc, run.generatorRevision)?.persistentInputRefs,
    ).toEqual(
      referenceIds.map((projectAssetId) => ({
        slot: card.spec.generator.inputSlots.image,
        itemKey: expect.any(String),
        target: { kind: "media", projectAssetId },
      })),
    );
    const commit = readOutputCommit(doc, {
      actionRunId: run.actionRunId,
      outputSlot: definition.actions[0].outputs[0].slot,
    })!;
    expect(commit.asset).toEqual({
      kind: "media",
      projectAssetId: result.data.assetId,
    });
    expect(
      readProjectAsset(doc, result.data.assetId as string)?.provenance,
    ).toMatchObject({ actionRunId: run.actionRunId });
    expect(hostCalls).toEqual([
      expect.objectContaining({
        prompt: requestData.prompt,
        aspectRatio: requestData.customActionParams.aspect_ratio,
        references: referenceIds.map((assetId) =>
          expect.objectContaining({ assetId }),
        ),
      }),
    ]);
    expect(listActionAssetBindings(doc)).toEqual([]);
    const service = createLocalGeneratorProductService({
      authority: { inspect: async (_id, read) => read(doc), mutate: async (_id, mutate) => mutate(doc, async () => {}) },
      resolveDefinition: async () => definition, listPluginCards: async () => [registration],
      ownerId: "local-api", journal: createSqliteDurableRunJournal(directory), actor: { kind: "user" },
    });
    const nativeDraft = await service.create("project", {
      pluginId: definition.pluginId, definitionId: definition.definitionId,
      generatorId: "native-draft", generatorRevisionId: "native-draft:r1",
      state: { prompt: "A native courtyard", aspect_ratio: "16:9" }, persistentInputRefs: [],
      placement: { canvasId: "main", nodeId: "native-card", actionCardId: card.spec.id },
    });
    const nativeOutput = canvas.executeGeneration("native-card", () => "native-output", undefined,
      CustomActionDefinitionSchema.parse({ ...card.spec, pluginBinding: requestData.pluginBinding }));
    expect(nativeOutput.error).toBeNull();
    await process();
    const nativeResult = canvas.readNode(nativeOutput.assetNodeId)!;
    expect(nativeResult.data.status, String(nativeResult.data.error)).toBe("completed");
    expect(readProjectActionRun(doc, nativeResult.data.actionRunId as string)?.generatorRevision).toEqual({ generatorId: nativeDraft.generator.id, generatorRevisionId: nativeDraft.revision.id });
    expect(hostCalls).toHaveLength(2);
    await process();
    expect(hostCalls).toHaveLength(2);
    // Reject changed package identity and unavailable input before the host tool.
    canvas.createNode("stale", "image", {
      ...requestData,
      pluginBinding: {
        ...requestData.pluginBinding,
        schemaHash: `sha256:${"f".repeat(64)}`,
      },
    });
    // Simulate a historical pending node whose referenced asset is unavailable.
    doc
      .getMap("nodes")
      .set("missing-input", {
        ...result,
        id: "missing-input",
        data: { ...requestData, referenceImageAssetIds: ["missing"] },
      });
    await process();
    expect(canvas.readNode("stale")!.data.status).toBe("failed");
    expect(canvas.readNode("missing-input")!.data.status).toBe("failed");
    expect(hostCalls).toHaveLength(2);
  } finally {
    doc.free();
    await rm(directory, { recursive: true, force: true });
  }
});
