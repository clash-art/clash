import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, expect, it } from "vitest";
import {
  Canvas,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GeneratorDefinitionSchema,
  readOutputCommit,
  readProjectActionRun,
} from "@clash/shared-types";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.each([
  "text.plain",
  "media.description",
  "image",
  "video",
  "audio",
  "model",
])(
  "keeps a placed %s output on its admitted Run while pending, failed and replayed",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "clash-output-guard-"));
    directories.push(directory);
    const doc = new LoroDoc();
    const definition = GeneratorDefinitionSchema.parse({
      pluginId: "test.output-guard",
      definitionId: "native-output",
      version: "1.0.0",
      schemaHash: `sha256:${"a".repeat(64)}`,
      stateSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      editPolicy: "advance-head",
      persistentInputs: [],
      actions: [
        {
          id: "produce",
          executorExportId: "produce",
          parametersSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          invocationInputs: [],
          outputs: [
            {
              slot: "output",
              assetType: kind.includes(".")
                ? { kind: "document", documentKind: kind, schemaVersion: 1 }
                : { kind: "media", mediaKind: kind },
              cardinality: { minItems: 1, maxItems: 1 },
            },
          ],
        },
      ],
    });
    const journal = createSqliteDurableRunJournal(directory);
    let now = 100;
    const service = createLocalGeneratorProductService({
      authority: {
        inspect: async (_id, read) => read(doc),
        mutate: async (_id, write) => write(doc, async () => undefined),
      },
      resolveDefinition: async () => definition,
      ownerId: "host",
      journal,
      actor: { kind: "agent" },
      now: () => now,
    });
    await service.create("project", {
      generatorId: "generator",
      generatorRevisionId: "generator:r1",
      pluginId: definition.pluginId,
      definitionId: definition.definitionId,
      state: {},
      persistentInputRefs: [],
    });
    await service.submit("project", "generator", "produce", {
      actionRunId: "admitted",
      generatorRevisionId: "generator:r1",
      parameters: {},
      invocationInputRefs: [],
      canvasPlacement: { canvasId: "main", nodeId: "operation" },
    });
    const canvas = new Canvas(doc, () => {});
    const outputId = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === "output")!.id;
    const processor = createLocalWorkflowProcessor({
      dataDir: directory,
      resolveGeneratorDefinition: async () => definition,
      executablePluginAction: async (request) =>
        request.operation === "submit"
          ? {
              protocol: "clash.plugin.result/v1",
              invocationId: request.taskId,
              status: "accepted",
              pollState: { job: "pending" },
              retryAfterMs: 5000,
            }
          : {
              protocol: "clash.plugin.result/v1",
              invocationId: request.taskId,
              status: "failed",
              error: {
                code: "invalid_request",
                message: "Controlled executor failure.",
                retryable: false,
                requestState: "accepted",
              },
            },
      durableProviderRuns: {
        ownerId: "host",
        now: () => now,
        providerPluginExecutor: async () => {
          throw new Error("Native Action must use its installed executor.");
        },
      },
    });
    const process = () =>
      processor.process({
        doc,
        projectId: "project",
        checkpoint: async () => undefined,
      });

    await process();
    expect([...doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).keys()]).toEqual([
      "admitted",
    ]);
    expect(canvas.readNode(outputId)?.data).toMatchObject({
      actionRunId: "admitted",
      generatorOutputSlot: "output",
      status: "generating",
    });
    expect(
      (await journal.load({ actionRunId: "admitted", outputSlot: "output" }))
        ?.phase,
    ).toBe("polling");

    now += 6000;
    await process();
    await process();
    expect(readProjectActionRun(doc, "admitted")?.status).toBe("failed");
    expect([...doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).keys()]).toEqual([
      "admitted",
    ]);
    const output = canvas.readNode(outputId)!;
    expect(output.data).toMatchObject({
      actionRunId: "admitted",
      generatorOutputSlot: "output",
      status: "failed",
    });
    expect(output.data.assetId).toBeUndefined();
    expect(output.data.documentRevision).toBeUndefined();
    expect(
      readOutputCommit(doc, { actionRunId: "admitted", outputSlot: "output" }),
    ).toBeNull();
  },
);
