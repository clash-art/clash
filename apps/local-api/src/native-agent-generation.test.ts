import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it, vi } from "vitest";
import { createExecutorContext } from "@clash/action-sdk";
import {
  Canvas,
  createActionCardPromptEdit,
  ExecutableActionCardSchema,
  generatorDefinitionFromExecutablePluginRegistration,
  ExecutablePluginInvocationSchema,
  ExecutablePluginJsonValueSchema,
  readDocumentAssetRevision,
  readOutputCommit,
  readProjectActionRun,
  listActionAssetBindings,
  readGeneratorRevision,
} from "@clash/shared-types";
import { readMetadataBody } from "@clash/shared-runtime";
import { plugin } from "../../../plugins/agent-text/src/stdio.js";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalDocumentProductService } from "./local-document-product.js";
import { createLocalExecutablePluginBroker } from "./local-plugin-broker.js";

it("runs a local agent as a native Generator Action and publishes a replayable Document without a Provider or Canvas node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-native-agent-"));
  const doc = new LoroDoc();
  try {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../plugins/agent-text/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const document = JSON.parse(
      readFileSync(
        new URL(
          "../../../plugins/agent-text/generators/text.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const definition = generatorDefinitionFromExecutablePluginRegistration({
      pluginId: manifest.id,
      version: manifest.version,
      schemaHash: `sha256:${"a".repeat(64)}`,
      document,
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
      actor: { kind: "user", id: "author" },
    });
    await product.create("project", {
      generatorId: "agent-writer",
      generatorRevisionId: "agent-writer:r1",
      pluginId: definition.pluginId,
      definitionId: definition.definitionId,
      state: {
        prompt: "Describe the courtyard",
        agentId: "test-harness",
        modelId: "selected-model",
        systemPrompt: "Be concise.",
      },
      persistentInputRefs: [],
    });
    const invocation = {
      actionRunId: "agent-write",
      generatorRevisionId: "agent-writer:r1",
      parameters: {},
      invocationInputRefs: [],
    };
    await product.submit("project", "agent-writer", "generate", invocation);
    const documents = createLocalDocumentProductService({
      dataDir: directory, producer: { kind: "actor", actor: { kind: "user" } },
      authority: { inspect: async (_id, read) => read(doc), mutate: async (_id, mutate) => mutate(doc, async () => undefined) },
    });
    const agentCalls: unknown[] = [];
    const text = "A quiet courtyard.\n\nMorning light falls across the stones.";
    const broker = createLocalExecutablePluginBroker({
      loadProviderAccounts: async () => [],
      readDocument: async ({ projectId, documentAssetId, revisionId }) => {
        const saved = await documents.readRevision(projectId, { documentAssetId, revisionId });
        if (!saved) throw new Error("Document revision missing");
        return { documentKind: saved.revision.documentKind, schemaVersion: saved.revision.schemaVersion, body: ExecutablePluginJsonValueSchema.parse(saved.body) };
      },
      generateAgentText: async (input) => {
        agentCalls.push(input);
        return { text };
      },
    });
    const processor = createLocalWorkflowProcessor({
      dataDir: directory,
      resolveGeneratorDefinition: async () => definition,
      textAgent: {
        generate: async () => {
          throw new Error(
            "New agent text requests must use Generator admission.",
          );
        },
      },
      durableProviderRuns: {
        ownerId: "host",
        providerPluginExecutor: async () => {
          throw new Error("An agent Action must not call a Model Provider.");
        },
      },
      executablePluginAction: async (request) => {
        const call = ExecutablePluginInvocationSchema.parse({
          protocol: "clash.plugin.invoke/v1",
          invocationId: request.taskId,
          taskId: request.taskId,
          projectId: request.projectId,
          actor: request.actor,
          target: { ...request.binding, kind: "action" },
          input: request.input,
        });
        const sdk = createExecutorContext({}, (operation) =>
          broker(
            {
              protocol: "clash.plugin.broker-request/v1",
              requestId: "agent-call",
              invocationId: call.invocationId,
              operation,
            },
            { manifest, invocation: call },
          ),
        );
        return plugin.invoke(call, sdk);
      },
    });
    await processor.process({
      projectId: "project",
      doc,
      checkpoint: async () => undefined,
    });
    expect(agentCalls).toEqual([
      {
        projectId: "project",
        prompt: "Describe the courtyard",
        agentId: "test-harness",
        modelId: "selected-model",
        systemPrompt: "Be concise.",
      },
    ]);
    expect(readProjectActionRun(doc, invocation.actionRunId)?.status).toBe(
      "succeeded",
    );
    const commit = readOutputCommit(doc, {
      actionRunId: invocation.actionRunId,
      outputSlot: "text",
    });
    if (commit?.asset.kind !== "document")
      throw new Error("Missing agent Document result");
    const revision = readDocumentAssetRevision(doc, commit.asset)!;
    expect(revision.producer).toEqual({
      kind: "action-run",
      actionRunId: invocation.actionRunId,
    });
    expect(
      await readMetadataBody({
        dataDir: directory,
        contentHash: revision.body.digest,
      }),
    ).toBe(text);
    expect(doc.getMap("nodes").size).toBe(0);
    expect(listActionAssetBindings(doc)).toEqual([]);
    const before = doc.frontiers();
    await product.submit("project", "agent-writer", "generate", invocation);
    await processor.process({
      projectId: "project",
      doc,
      checkpoint: async () => undefined,
    });
    expect(doc.frontiers()).toEqual(before);
    expect(agentCalls).toHaveLength(1);
    await product.create("project", {
      generatorId: "default-agent", generatorRevisionId: "default-agent:r1", pluginId: definition.pluginId, definitionId: definition.definitionId,
      state: { prompt: "Use the configured defaults", agentId: "", modelId: " " }, persistentInputRefs: [],
    });
    await product.submit("project", "default-agent", "generate", { actionRunId: "default-agent-run", generatorRevisionId: "default-agent:r1", parameters: {}, invocationInputRefs: [] });
    await processor.process({ projectId: "project", doc, checkpoint: async () => undefined });
    expect(readProjectActionRun(doc, "default-agent-run")?.status).toBe("succeeded");
    expect(agentCalls.at(-1)).toEqual({ projectId: "project", prompt: "Use the configured defaults" });
    const card = ExecutableActionCardSchema.parse(JSON.parse(readFileSync(new URL("../../../plugins/agent-text/cards/agent-text.json", import.meta.url), "utf8")).spec);
    const authored = createActionCardPromptEdit("Rewrite @[saved scene](node:source)", card.generator!, () => ({ type: "text", data: { documentRevision: commit.asset, content: "A stale Canvas shadow" } }))({
      state: { prompt: "", systemPrompt: "Be concise." }, persistentInputRefs: [],
    }, definition);
    expect(authored.persistentInputRefs.map(ref => ref.target)).toEqual([commit.asset]);
    await documents.advance("project", { documentAssetId: commit.asset.documentAssetId, expectedHeadRevisionId: commit.asset.revisionId, revisionId: "later-source", body: "Later text must not replace the saved scene.", sourceRefs: [] });
    await product.create("project", { generatorId: "rewrite", generatorRevisionId: "rewrite:r1", pluginId: definition.pluginId, definitionId: definition.definitionId, ...authored });
    await product.submit("project", "rewrite", "generate", { actionRunId: "rewrite-run", generatorRevisionId: "rewrite:r1", parameters: {}, invocationInputRefs: [] });
    await processor.process({ projectId: "project", doc, checkpoint: async () => undefined });
    expect(readProjectActionRun(doc, "rewrite-run")?.status, JSON.stringify(await journal.load({ actionRunId: "rewrite-run", outputSlot: "text" }))).toBe("succeeded");
    const sent = agentCalls.at(-1) as { prompt: string; systemPrompt?: string };
    expect(sent.prompt).toContain("Rewrite saved scene");
    expect(sent.prompt).toContain(JSON.stringify(text).slice(1, -1));
    expect(sent.prompt).not.toContain("Later text must not replace");
    expect(sent.prompt).not.toContain("A stale Canvas shadow");
    expect(sent.systemPrompt).toBe("Be concise.");
    const rewritten = readOutputCommit(doc, { actionRunId: "rewrite-run", outputSlot: "text" });
    if (rewritten?.asset.kind !== "document") throw new Error("Missing rewritten Document");
    expect(readDocumentAssetRevision(doc, rewritten.asset)?.sourceRefs).toEqual(authored.persistentInputRefs);
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("legacy-agent-output", "text", {
      status: "pending",
      model: "local-acp",
      prompt: "A legacy agent request",
      modelParams: {
        acp_model: "selected-model",
        system_prompt: "Be concise.",
      },
      actorType: "agent",
      actorAgentId: "test-harness",
    });
    await processor.process({
      projectId: "project",
      doc,
      checkpoint: async () => undefined,
    });
    const result = canvas.readNode("legacy-agent-output")!.data;
    expect(result).toMatchObject({
      status: "completed",
      documentRevision: { kind: "document" },
    });
    expect(result).not.toHaveProperty("content");
    const run = readProjectActionRun(doc, result.actionRunId as string)!;
    expect(run.status).toBe("succeeded");
    expect(
      readGeneratorRevision(doc, run.generatorRevision)?.definitionRef.pluginId,
    ).toBe(definition.pluginId);
    expect(
      readOutputCommit(doc, {
        actionRunId: run.actionRunId,
        outputSlot: "text",
      })?.asset,
    ).toEqual(result.documentRevision);
    expect(agentCalls.at(-1)).toEqual({
      projectId: "project",
      prompt: "A legacy agent request",
      agentId: "test-harness",
      modelId: "selected-model",
      systemPrompt: "Be concise.",
    });
  } finally {
    doc.free();
    await rm(directory, { recursive: true, force: true });
  }
});


it.each([null, { text: "Do not stringify an untyped value." }])("rejects a non-text resolved Document before calling the agent (%j)", async (body) => {
  const call = ExecutablePluginInvocationSchema.parse({ protocol: "clash.plugin.invoke/v1", invocationId: "invalid-document", taskId: "invalid-document", projectId: "project",
    target: { pluginId: "clash.agent-text", version: "0.1.0", exportId: "generate-text", kind: "action", schemaHash: `sha256:${"a".repeat(64)}` }, actor: { kind: "user" },
    input: { values: { prompt: "Rewrite the source" }, references: [{ slot: "text:source", index: 0, document: { documentAssetId: "source", revisionId: "saved", documentKind: "text.plain", schemaVersion: 1 } }] } });
  const hostCall = vi.fn(async () => ({ text: "must not run" }));
  const sdk = createExecutorContext({ reference: async () => ({ form: "document", documentKind: "text.plain", schemaVersion: 1, body }) }, hostCall);
  await expect(plugin.invoke(call, sdk)).rejects.toThrow(/plain-text body/);
  expect(hostCall).not.toHaveBeenCalled();
});
