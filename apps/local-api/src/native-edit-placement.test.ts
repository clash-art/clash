import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import {
  Canvas,
  GeneratorDefinitionSchema,
  createProjectAsset,
  readProjectActionRun,
} from "@clash/shared-types";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalGeneratorProductService } from "./local-generator-product.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(definitionId: string, mediaKind: "image" | "video") {
  const artifact = JSON.parse(
    await readFile(
      new URL(
        `../../../plugins/asset-edit/generators/${definitionId}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const definition = GeneratorDefinitionSchema.parse({
    ...artifact.spec,
    pluginId: "clash.asset-edit",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
  });
  const directory = await mkdtemp(
    join(tmpdir(), "clash-native-edit-placement-"),
  );
  directories.push(directory);
  const journal = createSqliteDurableRunJournal(directory);
  const doc = new LoroDoc();
  expect(
    createProjectAsset(doc, {
      id: "source",
      kind: mediaKind,
      source: { kind: "owned", resourceId: "source-resource" },
      lifecycle: { state: "active" },
      metadata: {},
    }),
  ).toMatchObject({ ok: true });
  const canvas = new Canvas(doc, () => {});
  const snapshots: unknown[] = [];
  const service = createLocalGeneratorProductService({
    authority: {
      inspect: async (_id, read) => read(doc),
      mutate: async (_id, write) =>
        write(doc, async () => {
          snapshots.push(canvas.listNodes());
        }),
    },
    resolveDefinition: async () => definition,
    ownerId: "local-api",
    journal,
    actor: { kind: "agent" },
  });
  await service.create("project", {
    generatorId: "edit",
    generatorRevisionId: "edit:r1",
    pluginId: definition.pluginId,
    definitionId,
    state: {},
    persistentInputRefs: [],
  });
  const input = (parameters: Record<string, number>) => ({
    actionRunId: "edit:run",
    generatorRevisionId: "edit:r1",
    parameters,
    invocationInputRefs: [
      {
        slot: "source",
        target: { kind: "media" as const, projectAssetId: "source" },
      },
    ],
    canvasPlacement: {
      canvasId: "main",
      nodeId: "edit-operation",
      label: "Edit source",
    },
  });
  return { service, doc, canvas, journal, snapshots, input };
}

const edits: Array<{
  definitionId: string;
  kind: "image" | "video";
  action: string;
  parameters: Record<string, number>;
}> = [
  {
    definitionId: "image-editor",
    kind: "image" as const,
    action: "transform",
    parameters: { rotation: 90 },
  },
  {
    definitionId: "video-clipper",
    kind: "video" as const,
    action: "screenshot",
    parameters: { frameTimeSec: 1.2 },
  },
  {
    definitionId: "video-clipper",
    kind: "video" as const,
    action: "crop",
    parameters: { startSec: 1.2, endSec: 2.6 },
  },
];

describe("native edit Run Canvas placement", () => {
  it.each(edits)(
    "shows $action with frozen inputs and parameters before execution, without a legacy Card",
    async ({ definitionId, kind, action, parameters }) => {
      const { service, doc, canvas, snapshots, input } = await fixture(
        definitionId,
        kind,
      );
      const request = input(parameters);
      await service.submit("project", "edit", action, request);
      expect(canvas.readNode("edit-operation")).toMatchObject({
        type: "action-badge",
        data: {
          actionRunId: request.actionRunId,
          generatorActionId: action,
          generatorRevision: {
            generatorId: "edit",
            generatorRevisionId: request.generatorRevisionId,
          },
        },
      });
      expect(readProjectActionRun(doc, request.actionRunId)).toMatchObject({
        parameters,
        invocationInputRefs: request.invocationInputRefs,
      });
      expect(snapshots).toContainEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "edit-operation",
            data: expect.objectContaining({ actionRunId: request.actionRunId }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              actionRunId: request.actionRunId,
              status: "generating",
              generatorOutputSlot: "output",
            }),
          }),
        ]),
      );
      const operation = canvas.readNode("edit-operation")!;
      expect(canvas.listEdges()).toContainEqual(
        expect.objectContaining({ target: operation.id }),
      );
      const beforeReplay = doc.toJSON();
      await service.submit("project", "edit", action, request);
      expect(doc.toJSON()).toEqual(beforeReplay);
      await service.advance("project", "edit", {
        expectedHeadRevisionId: request.generatorRevisionId,
        generatorRevisionId: "edit:r2",
        state: {},
        persistentInputRefs: [],
      });
      expect(canvas.readNode("edit-operation")?.data.generatorRevisionId).toBe(
        request.generatorRevisionId,
      );
      const afterAdvance = doc.toJSON();
      await service.submit("project", "edit", action, request);
      expect(doc.toJSON()).toEqual(afterAdvance);
    },
  );

  it("rejects assigning a second Run to an existing operation without admitting partial work", async () => {
    const { service, doc, journal, input } = await fixture(
      "image-editor",
      "image",
    );
    const request = input({ rotation: 90 });
    await service.submit("project", "edit", "transform", request);
    const before = doc.toJSON();
    const second = {
      ...request,
      actionRunId: "another-run",
      parameters: { rotation: 180 },
    };
    await expect(
      service.submit("project", "edit", "transform", second),
    ).rejects.toThrow(/another Run/);
    expect(doc.toJSON()).toEqual(before);
    expect(
      await journal.load({
        actionRunId: second.actionRunId,
        outputSlot: "output",
      }),
    ).toBeUndefined();
  });
});
