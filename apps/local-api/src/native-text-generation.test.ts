import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it, vi } from "vitest";
import {
  Canvas,
  createModelPromptEdit,
  MODEL_CARDS,
  generatorDefinitionFromExecutablePluginRegistration,
  readOutputCommit,
  readDocumentAssetRevision,
  readProjectActionRun,
  type ModelCard,
} from "@clash/shared-types";
import { readMetadataBody } from "@clash/shared-runtime";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createLocalModelExecutionPlanner } from "./local-model-generation.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import {
  createMockExternalAigcService,
  type ProviderPluginExecutor,
  type ProviderPluginExecutorResponse,
} from "./local-aigc.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { createLocalDocumentProductService } from "./local-document-product.js";

it.each([
  {
    name: "plain text",
    value: "A quiet courtyard.\n\nMorning light falls across the stones.",
    succeeds: true,
  },
  { name: "empty text", value: " \n", succeeds: false },
  {
    name: "an untyped object",
    value: { text: "Do not silently stringify this object." },
    succeeds: false,
  },
])(
  "handles $name through native Model admission without a Canvas target",
  async ({ value, succeeds }) => {
    const directory = await mkdtemp(join(tmpdir(), "clash-native-text-"));
    const doc = new LoroDoc();
    try {
      const definition = generatorDefinitionFromExecutablePluginRegistration({
        pluginId: "clash.model-generation",
        version: "0.1.0",
        schemaHash: `sha256:${"a".repeat(64)}`,
        document: JSON.parse(
          readFileSync(
            new URL(
              "../../../plugins/model-generation/generators/text.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      });
      const binding = {
        pluginId: "test.text-provider",
        version: "1.0.0",
        exportId: "execute",
        schemaHash: `sha256:${"b".repeat(64)}`,
      };
      const card: ModelCard = {
        ...MODEL_CARDS.find((candidate) => candidate.kind === "text")!,
        providerImplementations: [
          {
            providerId: "test-text",
            upstreamId: "test-text",
            upstreamModel: "text-model",
            apiShape: "test-text",
            priority: 1,
            executorPluginId: binding.pluginId,
            executorExportId: binding.exportId,
          },
        ],
      };
      // Includes a malformed provider response to exercise runtime admission.
      const execute = vi.fn<ProviderPluginExecutor>(
        async () =>
          ({
            status: "completed",
            binding,
            output: { slot: "text", kind: "value", value },
          }) as unknown as ProviderPluginExecutorResponse,
      );
      const aigc = createMockExternalAigcService({
        modelCards: async () => [card],
        providerAccounts: async () => [
          {
            id: "private-account",
            providerId: "test-text",
            upstreamId: "test-text",
            enabled: true,
          },
        ],
        resolveProviderPluginBinding: async () => binding,
        providerPluginExecutor: execute,
      });
      const journal = createSqliteDurableRunJournal(directory);
      const product = createLocalGeneratorProductService({
        authority: {
          inspect: async (_id, read) => read(doc),
          mutate: async (_id, mutate) => mutate(doc, async () => undefined),
        },
        resolveDefinition: async () => definition,
        ownerId: "host",
        journal,
        actor: { kind: "system" },
        resolveModelExecution: createLocalModelExecutionPlanner({
          aigc,
          modelCards: async () => [card],
          dataDir: directory,
        }),
      });
      await product.create("project", {
        generatorId: "writer",
        generatorRevisionId: "writer:r1",
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: {
          modelId: card.id,
          prompt: "Describe the courtyard",
          params: card.defaultParams,
        },
        persistentInputRefs: [],
      });
      const invocation = {
        actionRunId: "write",
        generatorRevisionId: "writer:r1",
        parameters: {},
        invocationInputRefs: [],
      };
      await product.submit("project", "writer", "generate", invocation);
      expect(execute).not.toHaveBeenCalled();
      const processor = createLocalWorkflowProcessor({
        dataDir: directory,
        aigc,
        modelCards: async () => [card],
        resolveGeneratorDefinition: async () => definition,
        durableProviderRuns: {
          ownerId: "host",
          providerPluginExecutor: execute,
        },
        providerPollDelayCapMs: 0,
      });
      const process = () =>
        processor.process({
          doc,
          projectId: "project",
          checkpoint: async () => undefined,
        });
      await process();
      if (!succeeds) {
        expect(readProjectActionRun(doc, "write")?.status).toBe("failed");
        expect(
          readOutputCommit(doc, { actionRunId: "write", outputSlot: "text" }),
        ).toBeNull();
        return;
      }
      expect(readProjectActionRun(doc, "write")?.status).toBe("succeeded");
      const commit = readOutputCommit(doc, {
        actionRunId: "write",
        outputSlot: "text",
      });
      expect(commit?.asset.kind).toBe("document");
      if (commit?.asset.kind !== "document")
        throw new Error("Missing text Document");
      const revision = readDocumentAssetRevision(doc, commit.asset)!;
      expect(revision.producer).toEqual({
        kind: "action-run",
        actionRunId: "write",
      });
      expect(
        await readMetadataBody({
          dataDir: directory,
          contentHash: revision.body.digest,
        }),
      ).toEqual(value);
      expect(doc.getMap("nodes").size).toBe(0);
      const before = doc.frontiers();
      await product.submit("project", "writer", "generate", invocation);
      await process();
      expect(doc.frontiers()).toEqual(before);
      expect(execute).toHaveBeenCalledTimes(1);
      const rewriteDraft = createModelPromptEdit("Rewrite @[script](node:script)", () => ({
        type: "text", data: { documentRevision: commit.asset, content: "A stale Canvas text shadow" },
      }))({ id: "rewrite:r1", generatorId: "rewrite",
        definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash },
        state: { modelId: card.id, prompt: "", params: card.defaultParams }, persistentInputRefs: [],
      });
      await product.create("project", {
        generatorId: "rewrite",
        generatorRevisionId: "rewrite:r1",
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: rewriteDraft.state,
        persistentInputRefs: rewriteDraft.persistentInputRefs,
      });
      const documents = createLocalDocumentProductService({
        dataDir: directory,
        producer: { kind: "actor", actor: { kind: "user", id: "editor" } },
        authority: {
          inspect: async (_id, read) => read(doc),
          mutate: async (_id, mutate) => mutate(doc, async () => undefined),
        },
      });
      await documents.advance("project", {
        documentAssetId: commit.asset.documentAssetId,
        expectedHeadRevisionId: commit.asset.revisionId,
        revisionId: "edited-script",
        body: "A later edit must not replace the pinned script.",
        sourceRefs: [],
      });
      await product.submit("project", "rewrite", "generate", {
        ...invocation,
        actionRunId: "rewrite-run",
        generatorRevisionId: "rewrite:r1",
      });
      await process();
      expect(readProjectActionRun(doc, "rewrite-run")?.status).toBe(
        "succeeded",
      );
      expect(execute.mock.lastCall?.[0].input.references).toContainEqual(
        expect.objectContaining({ text: expect.objectContaining({ value }) }),
      );
      const rewriteCommit = readOutputCommit(doc, {
        actionRunId: "rewrite-run",
        outputSlot: "text",
      });
      if (rewriteCommit?.asset.kind !== "document")
        throw new Error("Missing rewritten text Document");
      expect(
        readDocumentAssetRevision(doc, rewriteCommit.asset)?.sourceRefs,
      ).toEqual(rewriteDraft.persistentInputRefs);
      expect(rewriteDraft.persistentInputRefs).toEqual([{ slot: "text", itemKey: expect.any(String), target: commit.asset }]);
      const canvas = new Canvas(doc, () => {});
      await product.create("project", {
        generatorId: "canvas-writer",
        generatorRevisionId: "canvas-writer:r1",
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: {
          modelId: card.id,
          prompt: "A Canvas script",
          params: card.defaultParams,
        },
        persistentInputRefs: [],
        placement: {
          canvasId: "main",
          nodeId: "text-draft",
          label: "Write text",
        },
      });
      for (const mode of ["unchanged", "rewired", "deleted"]) {
        const nodeId = `output-${mode}`;
        expect(
          canvas.executeGeneration("text-draft", () => nodeId).error,
        ).toBeNull();
        const pending = canvas.readNode(nodeId)!;
        const pinned = pending.data.generatorRevision as {
          generatorId: string;
          generatorRevisionId: string;
        };
        const runId = `canvas-output:${nodeId}:${pinned.generatorId}:${pinned.generatorRevisionId}:generate`;
        execute.mockImplementationOnce(async () => {
          if (mode === "rewired")
            canvas.updateNode(nodeId, {
              generatorRevision: {
                generatorId: "rewrite",
                generatorRevisionId: "rewrite:r1",
              },
              status: "completed",
              label: "A different result",
            });
          if (mode === "deleted") canvas.deleteNode(nodeId);
          return {
            status: "completed",
            binding,
            output: { slot: "text", kind: "value", value: String(value) },
          };
        });
        await process();
        expect(readProjectActionRun(doc, runId)?.status).toBe("succeeded");
        const output = readOutputCommit(doc, {
          actionRunId: runId,
          outputSlot: "text",
        });
        expect(output?.asset.kind).toBe("document");
        if (mode === "unchanged") {
          expect(canvas.readNode(nodeId)?.data).toMatchObject({
            status: "completed",
            documentRevision: output?.asset,
          });
          expect(canvas.readNode(nodeId)?.data).not.toHaveProperty("content");
          const callsBeforeReplay = execute.mock.calls.length;
          canvas.updateNode(nodeId, { status: "pending" });
          await process();
          expect(canvas.readNode(nodeId)?.data).toMatchObject({
            status: "completed",
            documentRevision: output?.asset,
          });
          expect(execute.mock.calls.length).toBe(callsBeforeReplay);
        } else if (mode === "rewired") {
          expect(canvas.readNode(nodeId)?.data).toMatchObject({
            label: "A different result",
          });
          expect(canvas.readNode(nodeId)?.data).not.toHaveProperty(
            "documentRevision",
          );
        } else expect(canvas.readNode(nodeId)).toBeNull();
      }
      canvas.createNode("legacy-pending-text", "text", {
        status: "pending",
        model: card.id,
        prompt: "Finish a pre-migration request",
        modelParams: card.defaultParams,
      });
      await process();
      const legacyResult = canvas.readNode("legacy-pending-text")!.data;
      expect(legacyResult.status).toBe("completed");
      expect(legacyResult.documentRevision).toMatchObject({ kind: "document" });
      expect(
        readProjectActionRun(doc, legacyResult.actionRunId as string)?.status,
      ).toBe("succeeded");
      expect(
        readOutputCommit(doc, {
          actionRunId: legacyResult.actionRunId as string,
          outputSlot: "text",
        })?.asset,
      ).toEqual(legacyResult.documentRevision);
      // A recovered pending projection must reuse its committed Document and must
      // not restore the legacy editable text body alongside that immutable result.
      const callsBeforeReplay = execute.mock.calls.length;
      canvas.updateNode("legacy-pending-text", {
        status: "pending",
        content: "A stale result from the old text pipeline.",
        textRevision: "legacy-result-revision",
      });
      await process();
      const replayed = canvas.readNode("legacy-pending-text")!.data;
      expect(replayed).toMatchObject({
        status: "completed",
        documentRevision: legacyResult.documentRevision,
      });
      expect(replayed).not.toHaveProperty("content");
      expect(replayed).not.toHaveProperty("textRevision");
      expect(execute.mock.calls.length).toBe(callsBeforeReplay);
    } finally {
      doc.free();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
