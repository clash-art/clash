import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import {
  GeneratorDefinitionSchema,
  readGeneratorRevision,
  type ProjectDirectorStage,
} from "@clash/shared-types";
import { createLocalDocumentProductService } from "./local-document-product";
import {
  createLocalDirectorStageGenerator,
  advanceLocalDirectorStageGenerator,
} from "./local-director-stage-generator-product";

it("persists component refs across Stage states and replica reload while the Document head advances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "director-code-doc-"));
  let doc = new LoroDoc();
  const documents = createLocalDocumentProductService({
    dataDir,
    authority: {
      inspect: async (_id, read) => read(doc),
      mutate: async (_id, mutation) => mutation(doc, async () => undefined),
    },
    producer: { kind: "actor", actor: { kind: "agent", id: "test" } },
  });
  try {
    const { spec } = JSON.parse(
      await readFile(
        new URL(
          "../../../plugins/director/generators/director-stage.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const definition = GeneratorDefinitionSchema.parse({
      ...spec,
      pluginId: "clash.director",
      version: "1.0.0",
      schemaHash: `sha256:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`,
    });
    const oldBody =
      "export default ({parameters}) => <group name={parameters.name} />";
    const created = await documents.create("project", {
      documentAssetId: "component",
      revisionId: "source-before",
      documentKind: "text.plain",
      schemaVersion: 1,
      body: oldBody,
      sourceRefs: [],
    });
    const source = {
      kind: "document" as const,
      documentAssetId: created.asset.id,
      revisionId: created.revision.id,
    };
    const stage: ProjectDirectorStage = {
      id: "studio",
      name: "Studio",
      owner: { kind: "project" },
      revisionId: "unused",
      state: {
        schemaVersion: 1,
        scene: {
          backgroundColor: "#000",
          grid: { visible: false, snap: false, size: 1 },
        },
        cameras: [],
        shots: [],
        codeComponents: [{ id: "prop", name: "Prop", source }],
        objects: [
          {
            id: "one",
            name: "One",
            kind: "code",
            visible: true,
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
            code: { componentId: "prop", parameters: { name: "warm" } },
          },
        ],
      },
    };
    const first = createLocalDirectorStageGenerator(doc, definition, stage);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    const next = structuredClone(first.stage);
    if (next.state.objects[0].kind === "code")
      next.state.objects[0].code.parameters.name = "cool";
    const second = advanceLocalDirectorStageGenerator(doc, definition, next);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    await documents.advance("project", {
      documentAssetId: source.documentAssetId,
      expectedHeadRevisionId: source.revisionId,
      revisionId: "source-after",
      body: "export default () => <mesh />",
      sourceRefs: [],
    });
    const snapshot = doc.export({ mode: "snapshot" });
    doc = new LoroDoc();
    doc.import(snapshot);
    for (const saved of [first.stage, second.stage]) {
      const revision = readGeneratorRevision(doc, {
        generatorId: saved.id,
        generatorRevisionId: saved.revisionId,
      });
      expect(revision?.persistentInputRefs).toContainEqual({
        slot: "stage:code",
        itemKey: "prop",
        target: source,
      });
      expect(revision?.state).toMatchObject({ stage: { state: saved.state } });
    }
    expect((await documents.readRevision("project", source))?.body).toBe(
      oldBody,
    );
    const invalid = structuredClone(second.stage);
    invalid.state.codeComponents![0].source.revisionId = "missing";
    expect(
      advanceLocalDirectorStageGenerator(doc, definition, invalid).ok,
    ).toBe(false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
