import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActionAssetBinding,
  createProjectAsset,
  createProjectGenerator,
  Canvas,
  listActionAssetBindings,
  listActionAssetReferences,
  listProjectAssets,
  MODEL_CARDS,
  readProjectAsset,
  readProjectActionRun,
  readGeneratorRevision,
  readOutputCommit,
  generatorDefinitionFromExecutablePluginRegistration,
} from "@clash/shared-types";

import { createLocalApiApp } from "./app.js";
import { createLocalDurableRun, parseFrozenExecutorInput } from "./durable-run-coordinator.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createProviderExecutionHandoffStore } from "./provider-execution-handoff.js";
import type {
  ExternalAigcService,
  ProviderPluginExecutionPlan,
  ProviderPluginExecutor,
} from "./local-aigc.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalAssetInspectionService } from "./local-asset-inspections.js";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "clash-durable-provider-workflow-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function completeByteDerivedInspection(dataDir: string) {
  return createLocalAssetInspectionService({
    dataDir,
    inspectResource: async ({ sourcePath, resource }) => {
      const byteLength = (await readFile(sourcePath)).byteLength;
      if (byteLength !== resource.byteLength || byteLength < 1) {
        throw new Error("Test media bytes do not match the Resource receipt.");
      }
      if (!resource.contentType) {
        throw new Error("Test media requires a frozen content type.");
      }
      const contentType = resource.contentType;
      if (resource.kind === "image") {
        return {
          width: byteLength,
          height: 1,
          rotationDegrees: 0,
          contentType,
        };
      }
      if (resource.kind === "video") {
        return {
          width: byteLength,
          height: 1,
          rotationDegrees: 0,
          durationMs: byteLength * 1_000,
          frameRate: byteLength,
          videoCodec: "test-video",
          hasAudio: false,
          contentType,
        };
      }
      if (resource.kind === "audio") {
        return {
          durationMs: byteLength * 1_000,
          hasAudio: true,
          audioCodec: "test-audio",
          sampleRate: byteLength,
          channelCount: 1,
          channelLayout: "mono",
          contentType,
        };
      }
      return { contentType };
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const binding = {
  pluginId: "test.provider",
  version: "1.0.0",
  exportId: "execute",
  schemaHash: `sha256:${"d".repeat(64)}`,
} as const;

const plan: ProviderPluginExecutionPlan = {
  binding,
  accountId: "private-account",
  assetInputs: [],
  kind: "video",
  projectId: "project-1",
  nodeId: "node-1",
  provider: "test-provider",
  modelEndpoint: "video-v1",
  input: {
    values: {
      modelId: "test-video",
      upstreamModel: "video-v1",
      prompt: "A paper city",
      modelParams: {},
    },
    references: [],
  },
};

it("executes an existing native revision from a Canvas placement without recreating its draft", async () => {
  const dataDir = await temporaryDataDir();
  const doc = new LoroDoc();
  const definition = generatorDefinitionFromExecutablePluginRegistration({
    pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"e".repeat(64)}`,
    document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
  });
  const revision = { id: "authored-revision", generatorId: "authored-draft",
    definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash },
    state: { modelId: "test-video", prompt: "Native paper city", params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: [] };
  const created = createProjectGenerator(doc, { head: { id: revision.generatorId, headRevisionId: revision.id }, revision });
  if (!created.ok) throw new Error(created.error.message);
  doc.getMap("nodes").set("native-output", { type: "video", data: {
    status: "pending", generatorRevision: { generatorId: revision.generatorId, generatorRevisionId: revision.id },
    prompt: "stale Canvas prompt", modelId: "stale-model", modelParams: { resolution: "invented" },
  } });
  doc.getMap("nodes").set("invalid-native-output", { type: "video", data: {
    status: "pending", generatorRevision: { generatorId: "missing-revision-id" },
  } });
  const planned = vi.fn(async () => ({ ...plan, route: { modelCode: "test-video", kind: "video" as const, priority: 1,
    providerId: plan.provider, upstreamId: plan.provider, upstreamModel: plan.modelEndpoint, apiShape: plan.provider, executorBinding: binding } }));
  const submitted: string[] = [];
  const processor = createLocalWorkflowProcessor({ dataDir,
    modelCards: async () => [{ ...MODEL_CARDS.find((c) => c.id === "minimax-h3")!, id: "test-video" }],
    resolveGeneratorDefinition: async () => definition, aigc: aigc(planned),
    durableProviderRuns: { ownerId: "local-api", now: () => 100, providerPluginExecutor: async (request) => {
      submitted.push(request.taskId);
      return { status: "accepted", binding, pollState: { taskId: request.taskId }, retryAfterMs: 5000 };
    } },
  });
  await processor.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  expect((doc.getMap("nodes").get("invalid-native-output") as any).data.status).toBe("failed");
  expect(planned).toHaveBeenCalledWith(expect.objectContaining({ model: revision.state.modelId, prompt: revision.state.prompt, modelParams: revision.state.params }), "video");
  expect(submitted).not.toEqual([]);
  const run = readProjectActionRun(doc, identityFromProviderTaskId(submitted[0]!, "media").actionRunId)!;
  expect(run.generatorRevision).toEqual({ generatorId: revision.generatorId, generatorRevisionId: revision.id });
  expect(readGeneratorRevision(doc, run.generatorRevision)).toEqual(revision);
  const before = [...submitted];
  await processor.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  expect(submitted).toEqual(before);
  const next = { ...revision, id: "another-revision", generatorId: "another-draft" };
  const nextCreated = createProjectGenerator(doc, { head: { id: next.generatorId, headRevisionId: next.id }, revision: next });
  if (!nextCreated.ok) throw new Error(nextCreated.error.message);
  const pending = doc.getMap("nodes").get("native-output") as any;
  doc.getMap("nodes").set("native-output", { ...pending, data: { ...pending.data,
    generatorRevision: { generatorId: next.generatorId, generatorRevisionId: next.id },
  } });
  await processor.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  const journal = createSqliteDurableRunJournal(dataDir);
  const originalTask = await journal.load(identityFromProviderTaskId(submitted[0]!, "media"));
  const nextTask = await journal.load(identityFromProviderTaskId(submitted.at(-1)!, "media"));
  if (!nextTask || !originalTask) throw new Error("Both native requests must be durable before execution.");
  expect(parseFrozenExecutorInput(nextTask.executorInput).nodeProjectionRevisionId)
    .not.toEqual(parseFrozenExecutorInput(originalTask.executorInput).nodeProjectionRevisionId);
});

it("shares a Generator Revision across a Canvas batch while giving each output its own Run", async () => {
  const dataDir = await temporaryDataDir();
  const doc = pendingDoc();
  const nodes = doc.getMap("nodes");
  const first = nodes.get("node-1") as any;
  const data = { ...first.data, duration: 5, aspectRatio: "16:9", modelParams: { duration: 5, aspect_ratio: "16:9", resolution: "768P" } };
  nodes.set("node-1", { ...first, data });
  nodes.set("node-2", { ...first, data: { ...data, label: "Second result" } });
  nodes.set("node-3", { ...first, data: { ...data, label: "Independent source result" } });
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("source", "action-badge", { actionType: "video-gen", modelId: "test-video", content: "A paper city" });
  canvas.insertEdge("first-output", "source", "node-1", "default");
  canvas.insertEdge("second-output", "source", "node-2", "default");
  canvas.createNode("other-source", "action-badge", { actionType: "video-gen", modelId: "test-video", content: "A paper city" });
  canvas.insertEdge("other-output", "other-source", "node-3", "default");
  const definition = generatorDefinitionFromExecutablePluginRegistration({
    pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"e".repeat(64)}`,
    document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
  });
  const taskIds: string[] = [];
  const taskTargets: string[] = [];
  const processor = createLocalWorkflowProcessor({ dataDir,
    modelCards: async () => [{ ...MODEL_CARDS.find((c) => c.id === "minimax-h3")!, id: "test-video" }],
    resolveGeneratorDefinition: async () => definition,
    aigc: aigc(async () => ({ ...plan, route: { modelCode: "test-video", kind: "video", priority: 1,
      providerId: plan.provider, upstreamId: plan.provider, upstreamModel: plan.modelEndpoint, apiShape: plan.provider, executorBinding: binding } })),
    durableProviderRuns: { ownerId: "local-api", now: () => 100, providerPluginExecutor: async (request) => {
      taskIds.push(request.taskId);
      taskTargets.push(request.nodeId!);
      return { status: "accepted", binding, pollState: { taskId: request.taskId }, retryAfterMs: 5000 };
    } },
  });
  await processor.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  const runs = taskIds.map((taskId) => readProjectActionRun(doc, identityFromProviderTaskId(taskId, "media").actionRunId)!);
  expect([...taskTargets].sort()).toEqual(["node-1", "node-2", "node-3"]);
  const byTarget = new Map(taskTargets.map((target, index) => [target, runs[index]]));
  expect(byTarget.get("node-1")!.actionRunId).not.toBe(byTarget.get("node-2")!.actionRunId);
  expect(byTarget.get("node-1")!.generatorRevision).toEqual(byTarget.get("node-2")!.generatorRevision);
  expect(byTarget.get("node-1")!.generatorRevision).not.toEqual(byTarget.get("node-3")!.generatorRevision);
  expect((nodes.get("node-1") as any).data.generatorId).toBe((nodes.get("node-2") as any).data.generatorId);
  const before = [...taskIds];
  const second = nodes.get("node-2") as any;
  nodes.set("node-2", { ...second, data: { ...second.data, actionRunId: byTarget.get("node-1")!.actionRunId } });
  await processor.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  expect((nodes.get("node-2") as any).data.actionRunId).toBe(byTarget.get("node-2")!.actionRunId);
  expect(taskIds).toEqual(before);
});

it.each(["unchanged", "edited", "deleted"] as const)("admits Canvas media through a native Generator Run and preserves the %s projection after restart", async (projection) => {
  const dataDir = await temporaryDataDir();
  const doc = pendingDoc();
  const node = doc.getMap("nodes").get("node-1") as any;
  doc.getMap("nodes").set("node-1", { ...node, data: { ...node.data,
    duration: 5, aspectRatio: "16:9", modelParams: { duration: 4, resolution: "768P", aspect_ratio: "1:1" },
  } });
  const definition = generatorDefinitionFromExecutablePluginRegistration({
    pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"e".repeat(64)}`,
    document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
  });
  const routedPlan: ProviderPluginExecutionPlan = { ...plan, route: { modelCode: "test-video", kind: "video", priority: 1, providerId: plan.provider, upstreamId: plan.provider,
    upstreamModel: plan.modelEndpoint, apiShape: plan.provider, executorBinding: binding } };
  const now = { value: 100 };
  let providerTaskId = "";
  const options = { dataDir, modelCards: async () => [{ ...MODEL_CARDS.find((c) => c.id === "minimax-h3")!, id: "test-video" }],
    resolveGeneratorDefinition: async () => definition, aigc: aigc(vi.fn(async () => routedPlan)),
    assetInspection: completeByteDerivedInspection(dataDir),
  };
  const submit = vi.fn(async (request: any) => {
    providerTaskId = request.taskId;
    const identity = identityFromProviderTaskId(providerTaskId, "media");
    expect(readProjectActionRun(doc, identity.actionRunId)?.status).toBe("running");
    return { status: "accepted" as const, binding, pollState: { task: "provider-task" }, retryAfterMs: 5 };
  });
  const first = createLocalWorkflowProcessor({ ...options, durableProviderRuns: { ownerId: "local-api", providerPluginExecutor: submit, now: () => now.value } });
  await first.process({ doc, projectId: "project-1", checkpoint: async () => {} });
  expect(submit, JSON.stringify(doc.getMap("nodes").get("node-1"))).toHaveBeenCalledOnce();
  const identity = identityFromProviderTaskId(providerTaskId, "media");
  const task = await createSqliteDurableRunJournal(dataDir).load(identity);
  expect(task?.executorInput).toMatchObject({ targetKind: "generator-action", nodeId: "node-1" });
  const publicRun = readProjectActionRun(doc, identity.actionRunId)!;
  expect(readGeneratorRevision(doc, publicRun.generatorRevision)?.state.params)
    .toMatchObject({ duration: 5, resolution: "768P", aspect_ratio: "16:9" });
  const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
    projectId: "project-1", taskId: providerTaskId, slot: "media", pluginId: binding.pluginId,
    pluginVersion: binding.version, accountId: "private-account", invocationId: "poll-result", kind: "video",
    mediaType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24]),
  });
  if (projection === "deleted") doc.getMap("nodes").delete("node-1");
  if (projection === "edited") {
    const current = doc.getMap("nodes").get("node-1") as any;
    doc.getMap("nodes").set("node-1", { ...current, data: { ...current.data, prompt: "A different draft", status: "draft" } });
  }
  now.value = 106;
  const poll = vi.fn(async () => ({ status: "completed" as const, binding,
    media: { assetId: staged.projectAssetId, uri: `clash-asset://${staged.projectAssetId}`, kind: "video" as const, mediaType: "video/mp4" },
  }));
  await createLocalWorkflowProcessor({ ...options, durableProviderRuns: { ownerId: "local-api", providerPluginExecutor: poll, now: () => now.value } })
    .process({ doc, projectId: "project-1", checkpoint: async () => {} });
  expect(readProjectActionRun(doc, identity.actionRunId)?.status).toBe("succeeded");
  expect(readOutputCommit(doc, identity)?.asset).toEqual({ kind: "media", projectAssetId: staged.projectAssetId });
  if (projection === "unchanged") expect((doc.getMap("nodes").get("node-1") as any).data).toMatchObject({ status: "completed", assetId: staged.projectAssetId });
  if (projection === "deleted") expect(doc.getMap("nodes").get("node-1")).toBeUndefined();
  if (projection === "edited") expect((doc.getMap("nodes").get("node-1") as any).data).toMatchObject({ status: "draft", prompt: "A different draft" });
  if (projection === "unchanged") {
    const completed = doc.getMap("nodes").get("node-1") as any;
    const pendingData = { ...completed.data, status: "pending" };
    delete pendingData.assetId;
    doc.getMap("nodes").set("node-1", { ...completed, data: pendingData });
    await createLocalWorkflowProcessor({ ...options, resolveGeneratorDefinition: async () => { throw new Error("A completed Run must not resolve a newer definition."); },
      durableProviderRuns: { ownerId: "local-api", providerPluginExecutor: poll, now: () => now.value },
    }).process({ doc, projectId: "project-1", checkpoint: async () => {} });
    expect((doc.getMap("nodes").get("node-1") as any).data).toMatchObject({ status: "completed", assetId: staged.projectAssetId });
    expect(poll).toHaveBeenCalledOnce();
  }
  expect(submit).toHaveBeenCalledOnce();
});

function aigc(
  planProviderPlugin: ExternalAigcService["planProviderPlugin"],
): ExternalAigcService {
  return {
    planProviderPlugin,
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
    generateAudio: vi.fn(),
    generateText: vi.fn(),
  };
}

function identityFromProviderTaskId(
  taskId: string,
  outputSlot: string,
): { actionRunId: string; outputSlot: string } {
  const suffix = `:${encodeURIComponent(outputSlot)}`;
  expect(taskId.endsWith(suffix)).toBe(true);
  return {
    actionRunId: taskId.slice(0, -suffix.length),
    outputSlot,
  };
}

function pendingDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.getMap("nodes").set("node-1", {
    id: "node-1",
    type: "video",
    position: { x: 0, y: 0 },
    data: {
      status: "pending",
      actionType: "video-gen",
      modelId: "test-video",
      prompt: "A paper city",
    },
  });
  return doc;
}

function pendingDocWithLoroReorderedModelParams(): LoroDoc {
  const doc = new LoroDoc();
  doc.getMap("nodes").set("node-1", {
    canvasId: "main",
    type: "video",
    data: {
      status: "pending",
      modelId: "test-video",
      referenceMode: "image-and-prompt",
      aspectRatio: "auto",
      actorType: "user",
      actorUserId: "local-user",
      model: "test-video",
      actionType: "video-gen",
      referenceVideoAssetIds: [],
      label: "Test video",
      prompt: "A paper city",
      modelParams: {
        duration: "auto",
        aspect_ratio: "auto",
        resolution: "480p",
        generate_audio: false,
        edit_mode: true,
      },
      duration: "auto",
    },
    parentId: null,
    position: { x: 840, y: 30 },
  });
  return doc;
}

async function recoverCompletedDurableVideoAfterTargetMutation(
  mutateTarget: (data: Record<string, unknown>) => Record<string, unknown>,
  doc = pendingDoc(),
): Promise<{
  doc: LoroDoc;
  actionRunId: string;
  staged: Awaited<
    ReturnType<ReturnType<typeof createLocalPluginAssetStagingStore>["stage"]>
  >;
}> {
  const dataDir = await temporaryDataDir();
  const now = { value: 100 };
  let providerTaskId = "";
  const first = createLocalWorkflowProcessor({
    dataDir,
    aigc: aigc(vi.fn(async () => plan)),
    durableProviderRuns: {
      ownerId: "local-api",
      providerPluginExecutor: async (request) => {
        providerTaskId = request.taskId;
        return {
          status: "accepted",
          binding,
          pollState: { providerTask: "task-1" },
          retryAfterMs: 5,
        };
      },
      now: () => now.value,
    },
  });

  await first.process({ doc, projectId: "project-1" });

  const nodes = doc.getMap("nodes");
  const target = nodes.get("node-1") as Record<string, any>;
  nodes.set("node-1", {
    ...target,
    data: mutateTarget(target.data as Record<string, unknown>),
  });
  const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
    projectId: "project-1",
    taskId: providerTaskId,
    slot: "media",
    pluginId: binding.pluginId,
    pluginVersion: binding.version,
    invocationId: "provider-poll-result",
    kind: "video",
    mediaType: "video/mp4",
    bytes: new Uint8Array([0, 0, 0, 24]),
  });
  now.value = 106;
  const reopened = createLocalWorkflowProcessor({
    dataDir,
    assetInspection: completeByteDerivedInspection(dataDir),
    aigc: aigc(vi.fn(async () => plan)),
    durableProviderRuns: {
      ownerId: "local-api",
      providerPluginExecutor: async () => ({
        status: "completed",
        binding,
        media: {
          assetId: staged.projectAssetId,
          uri: `clash-asset://${staged.projectAssetId}`,
          kind: "video",
          mediaType: "video/mp4",
        },
      }),
      now: () => now.value,
    },
  });

  await reopened.process({ doc, projectId: "project-1" });
  return {
    doc,
    staged,
    actionRunId: identityFromProviderTaskId(providerTaskId, "media")
      .actionRunId,
  };
}

async function seedLegacyCanvasVideoRun(input: {
  dataDir: string;
  doc: LoroDoc;
  now: number;
}): Promise<void> {
  await createLocalDurableRun({
    ownerId: "local-api",
    journal: createSqliteDurableRunJournal(input.dataDir),
    clock: { now: () => input.now },
    command: {
      type: "create",
      actionRunId: "project:project-1:node:node-1",
      outputSlot: "media",
      deadlineAt: input.now + 30 * 60_000,
      executor: {
        binding,
        accountId: "private-account",
        kind: "video",
        projectId: "project-1",
        nodeId: "node-1",
        provider: "test-provider",
        modelEndpoint: "video-v1",
        assetInputs: [],
        input: {
          values: {
            modelId: "test-video",
            upstreamModel: "video-v1",
            prompt: "A paper city",
            modelParams: {},
          },
          references: [],
        },
      },
    },
  });
}

describe("durable executable Provider generation", () => {
  it("recovers a legacy run without projecting it onto or starving a newer node revision", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const now = { value: 100 };
    await seedLegacyCanvasVideoRun({ dataDir, doc, now: now.value });
    const seededNodes = doc.getMap("nodes");
    const seededNode = seededNodes.get("node-1") as Record<string, any>;
    seededNodes.set("node-1", {
      ...seededNode,
      data: { ...seededNode.data, status: "completed" },
    });
    const submittedTaskIds: string[] = [];
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async (input) => ({
        ...plan,
        modelEndpoint: input.model === "test-video-b" ? "video-v2" : "video-v1",
        input: {
          values: {
            ...plan.input.values,
            modelId: input.model,
            upstreamModel:
              input.model === "test-video-b" ? "video-v2" : "video-v1",
            prompt: input.prompt,
          },
          references: [],
        },
      })),
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now.value,
        providerPluginExecutor: async (request) => {
          submittedTaskIds.push(request.taskId);
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: request.taskId },
            retryAfterMs: 5_000,
          };
        },
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    const nodes = doc.getMap("nodes");
    const revisionA = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...revisionA,
      data: {
        ...revisionA.data,
        status: "pending",
        prompt: "Revision B",
        modelId: "test-video-b",
      },
    });

    now.value = 101;
    await processor.process({ doc, projectId: "project-1" });

    expect((nodes.get("node-1") as Record<string, any>).data).toMatchObject({
      status: "generating",
      prompt: "Revision B",
      modelId: "test-video-b",
    });
    expect(submittedTaskIds).toHaveLength(2);
    expect(submittedTaskIds[0]).toBe("project:project-1:node:node-1:media");
    expect(submittedTaskIds[1]).toMatch(
      /^project:project-1:node:node-1:revision:[a-f0-9]{64}:media$/,
    );

    now.value = 5_101;
    const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
      projectId: "project-1",
      taskId: "project:project-1:node:node-1:media",
      slot: "media",
      pluginId: binding.pluginId,
      pluginVersion: binding.version,
      invocationId: "legacy-revision-a-result",
      kind: "video",
      mediaType: "video/mp4",
      bytes: new Uint8Array([0, 0, 0, 24]),
    });
    const reopened = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(async () => ({
        ...plan,
        modelEndpoint: "video-v2",
        input: {
          values: {
            ...plan.input.values,
            modelId: "test-video-b",
            upstreamModel: "video-v2",
            prompt: "Revision B",
          },
          references: [],
        },
      })),
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now.value,
        providerPluginExecutor: async (request) => {
          submittedTaskIds.push(request.taskId);
          if (
            request.taskId === "project:project-1:node:node-1:media" &&
            request.pollState
          ) {
            return {
              status: "completed",
              binding,
              media: {
                assetId: staged.projectAssetId,
                uri: `clash-asset://${staged.projectAssetId}`,
                kind: "video",
                mediaType: "video/mp4",
              },
            };
          }
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: request.taskId },
            retryAfterMs: 5_000,
          };
        },
      },
    });

    await reopened.process({ doc, projectId: "project-1" });

    const revisionB = nodes.get("node-1") as Record<string, any>;
    expect(revisionB.data).toMatchObject({
      status: "generating",
      prompt: "Revision B",
      modelId: "test-video-b",
    });
    expect(revisionB.data.assetId).toBeUndefined();
    expect(readProjectAsset(doc, staged.projectAssetId)).not.toBeNull();
    expect(listActionAssetReferences(doc, staged.projectAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        owner: expect.objectContaining({
          actionRunId: "project:project-1:node:node-1",
        }),
      }),
    ]);
    expect(
      submittedTaskIds.filter(
        (taskId) => taskId === "project:project-1:node:node-1:media",
      ),
    ).toHaveLength(2);
    expect(
      new Set(
        submittedTaskIds.filter(
          (taskId) => taskId !== "project:project-1:node:node-1:media",
        ),
      ),
    ).toEqual(new Set([submittedTaskIds[1]]));
  });

  it("starts a distinct run when an authored mention resolves to another Asset", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    for (const assetId of ["reference-a", "reference-b"] as const) {
      expect(
        createProjectAsset(doc, {
          id: assetId,
          kind: "image",
          source: {
            kind: "owned",
            resourceId: `sha256:${assetId === "reference-a" ? "a".repeat(64) : "b".repeat(64)}`,
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png" },
        }),
      ).toMatchObject({ ok: true });
    }
    const nodes = doc.getMap("nodes");
    const pending = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...pending,
      data: {
        ...pending.data,
        prompt: "Animate @[Source](node:reference-node)",
        referenceImageAssetIds: ["reference-a"],
      },
    });
    nodes.set("reference-node", {
      id: "reference-node",
      type: "image",
      position: { x: -100, y: 0 },
      data: { status: "completed", assetId: "reference-a" },
    });
    const taskIds: string[] = [];
    const now = { value: 100 };
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async (input) => ({
        ...plan,
        input: {
          ...plan.input,
          references: input.references ?? [],
        },
      })),
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now.value,
        providerPluginExecutor: async (request) => {
          taskIds.push(request.taskId);
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: request.taskId },
            retryAfterMs: 5_000,
          };
        },
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    const source = nodes.get("reference-node") as Record<string, any>;
    nodes.set("reference-node", {
      ...source,
      data: { ...source.data, assetId: "reference-b" },
    });
    const target = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...target,
      data: { ...target.data, status: "pending" },
    });
    now.value = 101;

    await processor.process({ doc, projectId: "project-1" });

    expect(taskIds).toHaveLength(2);
    expect(taskIds[0]).toMatch(
      /^project:project-1:node:node-1:revision:[a-f0-9]{64}:media$/,
    );
    expect(taskIds[1]).toMatch(
      /^project:project-1:node:node-1:revision:[a-f0-9]{64}:media$/,
    );
    expect(taskIds[1]).not.toBe(taskIds[0]);
  });

  it("starts a distinct run when a label-backed execution prompt changes", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const nodes = doc.getMap("nodes");
    const pending = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...pending,
      data: { ...pending.data, prompt: "", label: "Revision A label" },
    });
    const taskIds: string[] = [];
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async (input) => ({
        ...plan,
        input: {
          ...plan.input,
          values: { ...plan.input.values, prompt: input.prompt },
        },
      })),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          taskIds.push(request.taskId);
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: request.taskId },
            retryAfterMs: 5_000,
          };
        },
        now: () => 100,
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    const generating = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...generating,
      data: {
        ...generating.data,
        status: "pending",
        label: "Revision B label",
      },
    });
    await processor.process({ doc, projectId: "project-1" });

    expect(taskIds).toHaveLength(2);
    expect(taskIds[1]).not.toBe(taskIds[0]);
  });

  it("reuses the frozen run when only presentation and derived node fields change", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const taskIds: string[] = [];
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async () => plan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          taskIds.push(request.taskId);
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: request.taskId },
            retryAfterMs: 5_000,
          };
        },
        now: () => 100,
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    const nodes = doc.getMap("nodes");
    const generating = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...generating,
      data: {
        ...generating.data,
        status: "pending",
        label: "Renamed presentation",
        name: "renamed.mp4",
        posterUrl: "blob:presentation-only",
        waveform: [0.1, 0.2],
      },
    });

    await processor.process({ doc, projectId: "project-1" });

    expect(taskIds).toHaveLength(1);
    expect((nodes.get("node-1") as Record<string, any>).data).toMatchObject({
      status: "generating",
      label: "Renamed presentation",
      name: "renamed.mp4",
    });
  });

  it("applies parameter-conditioned Model Card validation before planning", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const nodes = doc.getMap("nodes");
    const node = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...node,
      data: {
        ...node.data,
        modelId: "seedance-2.5-ref",
        modelParams: { edit_mode: true },
      },
    });
    const planner = vi.fn(async () => plan);
    const processor = createLocalWorkflowProcessor({
      dataDir,
      modelCards: async () => MODEL_CARDS,
      aigc: aigc(planner),
    });

    await processor.process({ doc, projectId: "project-1" });

    expect((nodes.get("node-1") as Record<string, any>).data).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/at least 1 reference video/i),
    });
    expect(planner).not.toHaveBeenCalled();
  });

  it("fails closed before submit when a Provider plan has no durable coordinator", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const service = aigc(vi.fn(async () => plan));
    const processor = createLocalWorkflowProcessor({ dataDir, aigc: service });

    await processor.process({ doc, projectId: "project-1" });

    expect((doc.getMap("nodes").get("node-1") as any).data).toMatchObject({
      status: "failed",
      error:
        "Provider-backed generation requires the Host durable run coordinator before submit.",
    });
    expect(service.generateVideo).not.toHaveBeenCalled();
  });

  it("freezes media sizing into the same input used by durable and direct execution", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const nodes = doc.getMap("nodes");
    const node = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...node,
      data: {
        ...node.data,
        aspectRatio: "9:16",
        modelParams: { aspect_ratio: "9:16", duration: 8 },
      },
    });
    const planner = vi.fn(async () => plan);
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(planner),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "accepted",
          binding,
          pollState: { taskId: "provider-task" },
        }),
      },
    });

    await processor.process({ doc, projectId: "project-1" });

    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "9:16",
        duration: 8,
        modelParams: { aspect_ratio: "9:16", duration: 8 },
      }),
      "video",
    );
  });

  it("publishes input bindings even when Project Asset authority materialization already changed the replica", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    expect(
      createProjectAsset(doc, {
        id: "reference-asset",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"a".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    ).toMatchObject({ ok: true });

    const referencePlan: ProviderPluginExecutionPlan = {
      ...plan,
      input: {
        ...plan.input,
        references: [
          {
            slot: "image",
            index: 0,
            asset: {
              assetId: "reference-asset",
              uri: "clash-asset://reference-asset",
              kind: "image",
            },
          },
        ],
      },
    };
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async () => referencePlan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "accepted",
          binding,
          pollState: { providerTask: "task-with-reference" },
        }),
        now: () => 100,
      },
    });

    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);
    expect(listActionAssetReferences(doc, "reference-asset")).toEqual([
      expect.objectContaining({
        direction: "input",
        slot: "image:0",
        projectAssetId: "reference-asset",
        role: "reference",
      }),
    ]);
  });

  it("repairs and checkpoints frozen input bindings after a crash before Provider submit", async () => {
    const dataDir = await temporaryDataDir();
    const referencePlan: ProviderPluginExecutionPlan = {
      ...plan,
      input: {
        ...plan.input,
        references: [
          {
            slot: "image",
            index: 0,
            asset: {
              assetId: "reference-asset",
              uri: "clash-asset://reference-asset",
              kind: "image",
            },
          },
        ],
      },
    };
    const firstDoc = pendingDoc();
    expect(
      createProjectAsset(firstDoc, {
        id: "reference-asset",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"b".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    ).toMatchObject({ ok: true });
    const submit = vi.fn<ProviderPluginExecutor>(async () => ({
      status: "accepted",
      binding,
      pollState: { providerTask: "recovered-task" },
      retryAfterMs: 5_000,
    }));
    const first = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async () => referencePlan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: submit,
        now: () => 100,
      },
    });

    await first.process({
      doc: firstDoc,
      projectId: "project-1",
      checkpoint: async () => {
        throw new Error("process crashed before binding snapshot commit");
      },
    });
    expect(submit).not.toHaveBeenCalled();
    const frozenInputBinding = listActionAssetReferences(
      firstDoc,
      "reference-asset",
    )[0];
    expect(frozenInputBinding?.owner.kind).toBe("run");
    const frozenActionRunId =
      frozenInputBinding?.owner.kind === "run"
        ? frozenInputBinding.owner.actionRunId
        : "missing-run";
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: frozenActionRunId,
        outputSlot: "media",
      }),
    ).resolves.toMatchObject({ phase: "queued" });

    // Reopen the last durable Project snapshot: it predates the in-memory binding mutation above.
    const recoveredDoc = pendingDoc();
    expect(
      createProjectAsset(recoveredDoc, {
        id: "reference-asset",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"b".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    ).toMatchObject({ ok: true });
    const events: string[] = [];
    const recoveredSubmit = vi.fn<ProviderPluginExecutor>(async () => {
      events.push("submit");
      expect(
        listActionAssetReferences(recoveredDoc, "reference-asset"),
      ).toEqual([
        expect.objectContaining({ direction: "input", slot: "image:0" }),
      ]);
      return {
        status: "accepted",
        binding,
        pollState: { providerTask: "recovered-task" },
        retryAfterMs: 5_000,
      };
    });
    const recovered = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async () => referencePlan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: recoveredSubmit,
        now: () => 100,
      },
    });

    await recovered.process({
      doc: recoveredDoc,
      projectId: "project-1",
      checkpoint: async () => {
        events.push("checkpoint");
      },
    });

    expect(recoveredSubmit).toHaveBeenCalledTimes(1);
    expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("submit"));
  });

  it("freezes ordered content with global indexes and multiset Asset occurrences", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const nodes = doc.getMap("nodes");
    const pending = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...pending,
      data: {
        ...pending.data,
        modelId: "minimax-h3",
        prompt: "Before @[same](node:reference-node) after",
        referenceImageAssetIds: ["same-asset", "same-asset"],
      },
    });
    nodes.set("reference-node", {
      id: "reference-node",
      type: "image",
      position: { x: -100, y: 0 },
      data: { status: "completed", assetId: "same-asset" },
    });
    expect(
      createProjectAsset(doc, {
        id: "same-asset",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"c".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: { contentType: "image/png" },
      }),
    ).toMatchObject({ ok: true });
    const plannedInputs: ProviderPluginExecutionPlan["input"][] = [];
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(async (input) => {
        const plannedInput = {
          values: plan.input.values,
          references: input.references ?? [],
        };
        plannedInputs.push(plannedInput);
        return { ...plan, input: plannedInput };
      }),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "accepted",
          binding,
          pollState: { providerTask: "ordered-task" },
          retryAfterMs: 5_000,
        }),
        now: () => 100,
      },
    });

    await processor.process({ doc, projectId: "project-1" });

    expect(plannedInputs).toHaveLength(1);
    expect(plannedInputs[0]?.references).toEqual([
      {
        slot: "content",
        index: 0,
        text: { nodeId: "node-1:prompt:0", value: "Before " },
      },
      expect.objectContaining({
        slot: "content",
        index: 1,
        asset: expect.objectContaining({ assetId: "same-asset" }),
      }),
      {
        slot: "content",
        index: 2,
        text: { nodeId: "node-1:prompt:2", value: " after" },
      },
      expect.objectContaining({
        slot: "content",
        index: 3,
        asset: expect.objectContaining({ assetId: "same-asset" }),
      }),
    ]);
  });

  it("keeps a CLI-selected account out of Loro while freezing it into the durable run", async () => {
    const dataDir = await temporaryDataDir();
    const app = createLocalApiApp({ dataDir });
    const command = (body: Record<string, unknown>) =>
      app.request("/api/v1/projects/project-private-account/host-command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const added = await command({
      action: "add",
      canvasId: "main",
      type: "image_gen",
      label: "Private account routing",
      prompt: "Private account routing",
    });
    const action = (await added.json()) as { node_id: string };
    expect(action).toEqual(
      expect.objectContaining({ node_id: expect.any(String) }),
    );
    const executed = await command({
      action: "execute",
      canvasId: "main",
      nodeId: action.node_id,
      providerAccountId: "private-account",
    });
    const execution = (await executed.json()) as { childNodeId: string };
    expect(execution).toEqual(
      expect.objectContaining({
        childNodeId: expect.any(String),
      }),
    );

    const replica = await new FileReplicaStore(
      join(dataDir, "projects"),
    ).recover("project-private-account");
    const beforeProcessing = JSON.stringify(replica.getMap("nodes").toJSON());
    expect(beforeProcessing).not.toContain("private-account");
    expect(beforeProcessing).not.toContain("providerAccountId");
    expect(beforeProcessing).not.toContain("provider_id");
    await expect(
      createProviderExecutionHandoffStore(dataDir).load(
        "project-private-account",
        execution.childNodeId,
      ),
    ).resolves.toMatchObject({ accountId: "private-account" });

    const planner = vi.fn(
      async (
        input: Parameters<
          NonNullable<ExternalAigcService["planProviderPlugin"]>
        >[0],
      ) => ({
        ...plan,
        accountId: input.providerAccountId,
        kind: "image" as const,
        projectId: "project-private-account",
        nodeId: execution.childNodeId,
        input: {
          values: {
            modelId: input.model,
            upstreamModel: "image-v1",
            prompt: input.prompt,
            modelParams: input.modelParams ?? {},
          },
          references: [],
        },
      }),
    );
    let submittedTaskId = "";
    const processor = createLocalWorkflowProcessor({
      dataDir,
      modelCards: async () => [],
      aigc: aigc(planner),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          submittedTaskId = request.taskId;
          return {
            status: "accepted",
            binding,
            pollState: { taskId: "provider-task" },
            retryAfterMs: 5_000,
          };
        },
        now: () => 100,
      },
    });

    await processor.process({
      doc: replica,
      projectId: "project-private-account",
    });

    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: "private-account",
        modelParams: expect.not.objectContaining({
          provider_id: expect.anything(),
        }),
      }),
      "image",
    );
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: identityFromProviderTaskId(submittedTaskId, "media")
          .actionRunId,
        outputSlot: "media",
      }),
    ).resolves.toMatchObject({
      executorInput: { accountId: "private-account" },
    });
    const afterProcessing = JSON.stringify(replica.getMap("nodes").toJSON());
    expect(afterProcessing).not.toContain("private-account");
    expect(afterProcessing).not.toContain("providerAccountId");
    expect(afterProcessing).not.toContain("provider_id");
  });

  it("does not route from a legacy provider_id stored in Project Loro", async () => {
    const dataDir = await temporaryDataDir();
    const doc = pendingDoc();
    const nodes = doc.getMap("nodes");
    const node = nodes.get("node-1") as Record<string, any>;
    nodes.set("node-1", {
      ...node,
      data: {
        ...node.data,
        modelParams: {
          provider_id: "legacy-private-account",
          require_real_provider: true,
        },
      },
    });
    const planner = vi.fn(async () => plan);
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(planner),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "accepted",
          binding,
          pollState: { taskId: "provider-task" },
          retryAfterMs: 5_000,
        }),
      },
    });

    await processor.process({ doc, projectId: "project-1" });

    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        modelParams: { require_real_provider: true },
      }),
      "video",
    );
    expect(JSON.stringify(nodes.toJSON())).not.toContain(
      "legacy-private-account",
    );
  });

  it("persists private execution state before submit and resumes from SQLite without resubmitting", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const requests: Parameters<ProviderPluginExecutor>[0][] = [];
    const firstExecutor: ProviderPluginExecutor = async (request) => {
      requests.push(structuredClone(request));
      return {
        status: "accepted",
        binding,
        pollState: { providerTask: "task-1" },
        retryAfterMs: 5,
      };
    };
    const firstPlanner = vi.fn(async () => plan);
    const doc = pendingDoc();
    const first = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(firstPlanner),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: firstExecutor,
        now: () => now.value,
      },
    });

    await expect(first.process({ doc, projectId: "project-1" })).resolves.toBe(
      true,
    );

    expect(requests).toHaveLength(1);
    const firstTaskId = requests[0]!.taskId;
    expect(firstTaskId).toMatch(
      /^project:project-1:node:node-1:revision:[a-f0-9]{64}:media$/,
    );
    expect(requests[0]).toMatchObject({
      taskId: firstTaskId,
      binding,
      accountId: "private-account",
      input: plan.input,
    });
    expect(requests[0]).not.toHaveProperty("pollState");
    const generating = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(generating.data).toMatchObject({ status: "generating" });
    for (const field of [
      "providerPollState",
      "providerPollAt",
      "providerAcceptedAt",
      "providerDeadlineAt",
      "providerFinalPolledAt",
      "providerAccountId",
    ]) {
      expect(generating.data).not.toHaveProperty(field);
    }
    const identity = identityFromProviderTaskId(firstTaskId, "media");
    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "polling",
      pollState: { providerTask: "task-1" },
      executorInput: {
        binding,
        accountId: "private-account",
        projectId: "project-1",
        nodeId: "node-1",
        input: plan.input,
      },
    });
    await expect(first.nextWakeAt!("project-1")).resolves.toBe(105);

    now.value = 106;
    const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
      projectId: "project-1",
      taskId: firstTaskId,
      slot: "media",
      pluginId: binding.pluginId,
      pluginVersion: binding.version,
      invocationId: "provider-poll-result",
      kind: "video",
      mediaType: "video/mp4",
      bytes: new Uint8Array([0, 0, 0, 24]),
    });
    const reopenedPlanner = vi.fn(async () => plan);
    const reopenedExecutor: ProviderPluginExecutor = async (request) => {
      requests.push(structuredClone(request));
      return {
        status: "completed",
        binding,
        media: {
          assetId: staged.projectAssetId,
          uri: `clash-asset://${staged.projectAssetId}`,
          kind: "video",
          mediaType: "video/mp4",
        },
      };
    };
    const reopened = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(reopenedPlanner),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: reopenedExecutor,
        now: () => now.value,
      },
    });

    await expect(
      reopened.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);

    expect(reopenedPlanner).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      taskId: firstTaskId,
      pollState: { providerTask: "task-1" },
      binding,
      accountId: "private-account",
    });
    const completed = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(completed.data).toMatchObject({
      status: "completed",
      assetId: staged.projectAssetId,
    });
    expect(readProjectAsset(doc, completed.data.assetId)).toMatchObject({
      id: completed.data.assetId,
      source: { kind: "owned", resourceId: expect.stringMatching(/^sha256:/) },
      lifecycle: { state: "active" },
    });
    expect(listActionAssetReferences(doc, completed.data.assetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        slot: "media",
        projectAssetId: completed.data.assetId,
        owner: expect.objectContaining({
          kind: "run",
          actionRunId: identity.actionRunId,
        }),
      }),
    ]);

    await expect(
      reopened.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(false);
    expect(requests).toHaveLength(2);
    expect(
      listProjectAssets(doc).filter(
        (asset) => asset.id === completed.data.assetId,
      ),
    ).toHaveLength(1);
  });

  it("derives recovered Asset provenance from the frozen executor input", async () => {
    const { doc, staged, actionRunId } =
      await recoverCompletedDurableVideoAfterTargetMutation((data) => ({
        ...data,
        prompt: "A glass city",
        modelId: "mutated-video-model",
        label: "Revision B output",
        name: "revision-b.mp4",
      }));

    const published = readProjectAsset(doc, staged.projectAssetId);
    expect(published).toMatchObject({
      provenance: {
        kind: "generation",
        actionRunId,
        model: "video-v1",
        prompt: "A paper city",
      },
    });
  });

  it("projects a recovered result when Loro reorders semantically identical model params", async () => {
    const { doc, staged } =
      await recoverCompletedDurableVideoAfterTargetMutation(
        (data) => ({ ...data }),
        pendingDocWithLoroReorderedModelParams(),
      );

    const target = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(target.data).toMatchObject({
      status: "completed",
      assetId: staged.projectAssetId,
    });
  });

  it("does not project a recovered result after a model param value changes", async () => {
    const { doc, staged } =
      await recoverCompletedDurableVideoAfterTargetMutation(
        (data) => ({
          ...data,
          modelParams: {
            ...(data.modelParams as Record<string, unknown>),
            edit_mode: false,
          },
        }),
        pendingDocWithLoroReorderedModelParams(),
      );

    const target = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(target.data).toMatchObject({
      status: "generating",
      modelParams: { edit_mode: false },
    });
    expect(target.data.assetId).toBeUndefined();
    expect(readProjectAsset(doc, staged.projectAssetId)).not.toBeNull();
  });

  it("does not project an old recovered run onto a target carrying another semantic revision", async () => {
    const { doc, staged, actionRunId } =
      await recoverCompletedDurableVideoAfterTargetMutation((data) => ({
        ...data,
        status: "failed",
        prompt: "A glass city",
        modelId: "mutated-video-model",
        error: "The replacement revision failed",
        failureCode: "invalid_request",
      }));

    const target = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(target.data).toMatchObject({
      status: "failed",
      prompt: "A glass city",
      modelId: "mutated-video-model",
      error: "The replacement revision failed",
      failureCode: "invalid_request",
    });
    expect(target.data.assetId).toBeUndefined();
    expect(readProjectAsset(doc, staged.projectAssetId)).not.toBeNull();
    expect(listActionAssetReferences(doc, staged.projectAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        slot: "media",
        projectAssetId: staged.projectAssetId,
        owner: expect.objectContaining({
          kind: "run",
          actionRunId,
        }),
      }),
    ]);
  });

  it("retries Host inspection from staged CAS before publishing a generated Asset", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new Error("decoder temporarily unavailable"))
      .mockResolvedValue({
        width: 1_920,
        height: 1_080,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        rotationDegrees: 0,
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
      });
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: inspect,
    });
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    let providerTaskId = "";
    let stagedAssetId = "";
    const execute = vi.fn<ProviderPluginExecutor>(async (request) => {
      providerTaskId = request.taskId;
      const staged = await staging.stage({
        projectId: request.projectId,
        taskId: request.taskId,
        slot: "media",
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
        invocationId: "provider-result-needing-inspection",
        kind: "video",
        mediaType: "video/mp4",
        bytes: new Uint8Array([0, 0, 0, 24]),
      });
      stagedAssetId = staged.projectAssetId;
      return {
        status: "completed",
        binding,
        media: {
          assetId: staged.projectAssetId,
          uri: `clash-asset://${staged.projectAssetId}`,
          kind: "video",
          mediaType: "video/mp4",
        },
      };
    });
    const doc = pendingDoc();
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection,
      aigc: aigc(async () => plan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: execute,
        now: () => now.value,
      },
    });
    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);
    const identity = identityFromProviderTaskId(providerTaskId, "media");

    expect(stagedAssetId).not.toBe("");
    expect(readProjectAsset(doc, stagedAssetId)).toBeNull();
    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "finalizing",
      nextAttemptAt: 1_100,
      providerOutputs: expect.any(Array),
    });

    now.value = 1_101;
    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(readProjectAsset(doc, stagedAssetId)).toMatchObject({
      metadata: {
        width: 1_920,
        height: 1_080,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        hasAudio: true,
        audioCodec: "aac",
      },
    });
    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({ phase: "succeeded" });
  });

  it("consumes a project-scoped plugin staging receipt without downloading local bytes over HTTP", async () => {
    const dataDir = await temporaryDataDir();
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    let providerTaskId = "";
    let stagedAssetId = "";
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(async () => plan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          providerTaskId = request.taskId;
          const staged = await staging.stage({
            projectId: request.projectId,
            taskId: request.taskId,
            slot: "media",
            pluginId: binding.pluginId,
            pluginVersion: binding.version,
            invocationId: "invoke-staged-provider-output",
            kind: "video",
            mediaType: "video/mp4",
            bytes: new Uint8Array([0, 0, 0, 24]),
          });
          stagedAssetId = staged.projectAssetId;
          return {
            status: "completed",
            binding,
            media: {
              assetId: staged.projectAssetId,
              uri: `clash-asset://${staged.projectAssetId}`,
              kind: "video",
              mediaType: "video/mp4",
            },
          };
        },
        now: () => 100,
      },
    });
    const doc = pendingDoc();

    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);
    const staged = await staging.resolve({
      projectId: "project-1",
      projectAssetId: stagedAssetId,
    });
    expect(staged).toBeDefined();
    if (!staged) throw new Error("Expected the Provider output to be staged.");

    expect(doc.getMap("nodes").get("node-1")).toMatchObject({
      data: { status: "completed", assetId: staged.projectAssetId },
    });
    expect(readProjectAsset(doc, staged.projectAssetId)).toMatchObject({
      id: staged.projectAssetId,
      source: { kind: "owned", resourceId: staged.resourceId },
    });
    expect(listActionAssetReferences(doc, staged.projectAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        projectAssetId: staged.projectAssetId,
        owner: expect.objectContaining({
          actionRunId: identityFromProviderTaskId(providerTaskId, "media")
            .actionRunId,
        }),
      }),
    ]);
  });

  it("accepts a staged media receipt owned by the current custom Action task", async () => {
    const dataDir = await temporaryDataDir();
    const actionRunId = "custom-action-run-1";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("custom-action-node", {
      id: "custom-action-node",
      type: "image",
      position: { x: 0, y: 0 },
      data: { status: "generating" },
    });
    await createLocalDurableRun({
      ownerId: "local-api",
      journal: createSqliteDurableRunJournal(dataDir),
      clock: { now: () => 100 },
      command: {
        type: "create",
        actionRunId,
        outputSlot: "media",
        deadlineAt: 10_000,
        executor: {
          targetKind: "action",
          binding,
          actionId: "image-helper",
          actor: { kind: "user", id: "local-user" },
          publicOwner: {
            actionId: "image-helper",
            actionRevisionId: `sha256:${"4".repeat(64)}`,
          },
          kind: "image",
          projectId: "project-1",
          nodeId: "custom-action-node",
          provider: "plugin:test.provider",
          modelEndpoint: "image-helper",
          assetInputs: [],
          input: { values: { prompt: "A paper icon" }, references: [] },
        },
      },
    });
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    let stagedAssetId = "";
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      executablePluginAction: async (request) => {
        const staged = await staging.stage({
          projectId: request.projectId,
          taskId: request.taskId,
          slot: "media",
          pluginId: binding.pluginId,
          pluginVersion: binding.version,
          invocationId: "custom-action-result",
          kind: "image",
          mediaType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        });
        stagedAssetId = staged.projectAssetId;
        return {
          protocol: "clash.plugin.result/v1",
          invocationId: "custom-action-result",
          status: "completed",
          outputs: [
            {
              slot: "media",
              kind: "asset",
              asset: {
                assetId: staged.projectAssetId,
                uri: `clash-asset://${staged.projectAssetId}`,
                kind: "image",
                mediaType: "image/png",
              },
            },
          ],
        };
      },
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => {
          throw new Error("Provider path must not run for a custom Action.");
        },
        now: () => 100,
      },
    });

    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);

    expect(stagedAssetId).not.toBe("");
    expect(readProjectAsset(doc, stagedAssetId)).toMatchObject({
      id: stagedAssetId,
      kind: "image",
    });
    expect(listActionAssetReferences(doc, stagedAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        slot: "media",
        owner: expect.objectContaining({ actionRunId }),
      }),
    ]);
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId,
        outputSlot: "media",
      }),
    ).resolves.toMatchObject({ phase: "succeeded" });
  });

  it.each([
    {
      boundary: "task id",
      receipt: (taskId: string) => ({
        taskId: `${taskId}:other-task`,
        slot: "media",
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
      }),
    },
    {
      boundary: "output slot",
      receipt: (taskId: string) => ({
        taskId,
        slot: "preview",
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
      }),
    },
    {
      boundary: "plugin id",
      receipt: (taskId: string) => ({
        taskId,
        slot: "media",
        pluginId: "other.provider",
        pluginVersion: binding.version,
      }),
    },
    {
      boundary: "plugin version",
      receipt: (taskId: string) => ({
        taskId,
        slot: "media",
        pluginId: binding.pluginId,
        pluginVersion: "2.0.0",
      }),
    },
  ])(
    "refuses a staged media handle owned by another $boundary without publishing it",
    async ({ boundary, receipt }) => {
      const dataDir = await temporaryDataDir();
      const staging = createLocalPluginAssetStagingStore({ dataDir });
      let providerTaskId = "";
      let stagedAssetId = "";
      let stagedPath = "";
      const processor = createLocalWorkflowProcessor({
        dataDir,
        assetInspection: completeByteDerivedInspection(dataDir),
        aigc: aigc(async () => plan),
        durableProviderRuns: {
          ownerId: "local-api",
          providerPluginExecutor: async (request) => {
            providerTaskId = request.taskId;
            const owner = receipt(request.taskId);
            const staged = await staging.stage({
              projectId: request.projectId,
              ...owner,
              invocationId: `foreign-${boundary}`,
              kind: "video",
              mediaType: "video/mp4",
              bytes: new Uint8Array([0, 0, 0, 24]),
            });
            stagedAssetId = staged.projectAssetId;
            stagedPath = staged.projection.path;
            return {
              status: "completed",
              binding,
              media: {
                assetId: staged.projectAssetId,
                uri: `clash-asset://${staged.projectAssetId}`,
                kind: "video",
                mediaType: "video/mp4",
              },
            };
          },
          now: () => 100,
        },
      });
      const doc = pendingDoc();

      await expect(
        processor.process({ doc, projectId: "project-1" }),
      ).resolves.toBe(true);

      expect(stagedAssetId).not.toBe("");
      expect(readProjectAsset(doc, stagedAssetId)).toBeNull();
      expect(listActionAssetReferences(doc, stagedAssetId)).toEqual([]);
      const identity = identityFromProviderTaskId(providerTaskId, "media");
      const run = await createSqliteDurableRunJournal(dataDir).load(identity);
      expect(run).toMatchObject({
        phase: "finalizing",
        failure: {
          code: "output_persistence_failed",
          retryable: true,
          requestState: "accepted",
        },
      });
      expect(run?.failure?.message).not.toContain(dataDir);
      expect(run?.failure?.message).not.toContain(stagedPath);
      expect(doc.getMap("nodes").get("node-1")).toMatchObject({
        data: { status: "generating" },
      });
      expect(
        (doc.getMap("nodes").get("node-1") as Record<string, any>).data.assetId,
      ).toBeUndefined();
    },
  );

  it("does not publish a partial Project Asset when its output binding identity conflicts", async () => {
    const dataDir = await temporaryDataDir();
    const taskId = "project:project-1:node:node-1:media";
    const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
      projectId: "project-1",
      taskId,
      slot: "media",
      pluginId: binding.pluginId,
      pluginVersion: binding.version,
      invocationId: "invoke-conflicting-output",
      kind: "video",
      mediaType: "video/mp4",
      bytes: new Uint8Array([0, 0, 0, 24]),
    });
    const doc = pendingDoc();
    expect(
      createProjectAsset(doc, {
        id: "existing-output",
        kind: "video",
        source: { kind: "owned", resourceId: `sha256:${"e".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    ).toMatchObject({ ok: true });
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(async () => plan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          const conflict = createActionAssetBinding(doc, {
            id: `action-asset:${request.taskId}:output`,
            owner: { kind: "draft", actionId: "different-action" },
            direction: "output",
            slot: "different-slot",
            projectAssetId: "existing-output",
          });
          if (!conflict.ok) throw new Error(conflict.error.message);
          return {
            status: "completed",
            binding,
            media: {
              assetId: staged.projectAssetId,
              uri: `clash-asset://${staged.projectAssetId}`,
              kind: "video",
              mediaType: "video/mp4",
            },
          };
        },
        now: () => 100,
      },
    });

    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);

    expect(readProjectAsset(doc, staged.projectAssetId)).toBeNull();
  });

  it("publishes distinct bindings for delimiter-bearing durable run identities", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const doc = new LoroDoc();
    const identities = [
      { actionRunId: "a:b", outputSlot: "c", nodeId: "node-left" },
      { actionRunId: "a", outputSlot: "b:c", nodeId: "node-right" },
    ] as const;
    for (const identity of identities) {
      doc.getMap("nodes").set(identity.nodeId, {
        id: identity.nodeId,
        type: "video",
        position: { x: 0, y: 0 },
        data: { status: "generating" },
      });
      await createLocalDurableRun({
        ownerId: "local-api",
        journal,
        clock: { now: () => 100 },
        command: {
          type: "create",
          actionRunId: identity.actionRunId,
          outputSlot: identity.outputSlot,
          deadlineAt: 10_000,
          executor: {
            binding,
            kind: "video",
            projectId: "project-1",
            nodeId: identity.nodeId,
            provider: "test-provider",
            modelEndpoint: "video-v1",
            assetInputs: [],
            input: {
              values: {
                modelId: "test-video",
                upstreamModel: "video-v1",
                prompt: "A paper city",
                modelParams: {},
              },
              references: [],
            },
          },
        },
      });
    }
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(async () => plan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          const staged = await staging.stage({
            projectId: request.projectId,
            taskId: request.taskId,
            slot:
              identities.find((identity) => identity.nodeId === request.nodeId)
                ?.outputSlot ?? "",
            pluginId: binding.pluginId,
            pluginVersion: binding.version,
            invocationId: `invocation-${request.nodeId}`,
            kind: "video",
            mediaType: "video/mp4",
            bytes: new Uint8Array([0, 0, 0, 24]),
          });
          return {
            status: "completed",
            binding,
            media: {
              assetId: staged.projectAssetId,
              uri: `clash-asset://${staged.projectAssetId}`,
              kind: "video",
              mediaType: "video/mp4",
            },
          };
        },
        now: () => 100,
      },
    });

    await expect(
      processor.process({ doc, projectId: "project-1" }),
    ).resolves.toBe(true);

    const outputBindings = listActionAssetBindings(doc).filter((candidate) => {
      if (candidate.direction !== "output" || candidate.owner.kind !== "run") {
        return false;
      }
      const actionRunId = candidate.owner.actionRunId;
      return identities.some(
        (identity) => identity.actionRunId === actionRunId,
      );
    });
    expect(outputBindings).toHaveLength(2);
    expect(new Set(outputBindings.map((candidate) => candidate.id)).size).toBe(
      2,
    );
    for (const identity of identities) {
      await expect(journal.load(identity)).resolves.toMatchObject({
        phase: "succeeded",
      });
    }
  });

  it("re-checkpoints an already projected node before marking the journal succeeded", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const imagePlan: ProviderPluginExecutionPlan = {
      ...plan,
      kind: "image",
      input: {
        values: {
          modelId: "test-image",
          upstreamModel: "image-v1",
          prompt: "A paper city",
          modelParams: {},
        },
        references: [],
      },
    };
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    let providerTaskId = "";
    let stagedAssetId = "";
    const execute = vi.fn<ProviderPluginExecutor>(async (request) => {
      providerTaskId = request.taskId;
      const staged = await staging.stage({
        projectId: request.projectId,
        taskId: request.taskId,
        slot: "media",
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
        invocationId: "image-provider-result",
        kind: "image",
        mediaType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      });
      stagedAssetId = staged.projectAssetId;
      return {
        status: "completed",
        binding,
        media: {
          assetId: staged.projectAssetId,
          uri: `clash-asset://${staged.projectAssetId}`,
          kind: "image",
          mediaType: "image/png",
        },
      };
    });
    const doc = new LoroDoc();
    doc.getMap("nodes").set("node-1", {
      id: "node-1",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "image-gen",
        modelId: "test-image",
        prompt: "A paper city",
      },
    });
    let completedCheckpoints = 0;
    const checkpoint = vi.fn(async () => {
      const node = doc.getMap("nodes").get("node-1") as Record<string, any>;
      if (node.data.status !== "completed") return;
      completedCheckpoints += 1;
      if (completedCheckpoints === 1)
        throw new Error("snapshot write interrupted");
    });
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(async () => imagePlan),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: execute,
        now: () => now.value,
      },
    });
    await processor.process({ doc, projectId: "project-1", checkpoint });
    expect(completedCheckpoints).toBe(1);
    const identity = identityFromProviderTaskId(providerTaskId, "media");
    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "finalizing",
    });

    now.value = 1_101;
    await processor.process({ doc, projectId: "project-1", checkpoint });

    expect(completedCheckpoints).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "succeeded",
      projectedAt: 1_101,
    });
    expect(listProjectAssets(doc)).toEqual([
      expect.objectContaining({
        id: stagedAssetId,
        source: {
          kind: "owned",
          resourceId: expect.stringMatching(/^sha256:/),
        },
      }),
    ]);
  });
});

const modelPlan: ProviderPluginExecutionPlan = {
  binding,
  accountId: "private-account",
  assetInputs: [],
  kind: "model",
  projectId: "project-1",
  nodeId: "node-1",
  provider: "test-provider",
  modelEndpoint: "tripo-h3.1",
  input: {
    values: {
      modelId: "tripo-h3.1",
      upstreamModel: "tripo-h3.1",
      prompt: "A ceramic mug",
      modelParams: {},
    },
    references: [],
  },
};

function pendingModelDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.getMap("nodes").set("node-1", {
    id: "node-1",
    type: "model",
    position: { x: 0, y: 0 },
    data: {
      status: "pending",
      actionType: "model-gen",
      modelId: "tripo-h3.1",
      prompt: "A ceramic mug",
    },
  });
  return doc;
}

describe("durable model-gen node projection (Tripo H3.1 GLB completion)", () => {
  it("projects a completed model provider run onto the Canvas model node and publishes the output binding", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const doc = pendingModelDoc();
    let providerTaskId = "";
    const first = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(vi.fn(async () => modelPlan)),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async (request) => {
          providerTaskId = request.taskId;
          return {
            status: "accepted",
            binding,
            pollState: { providerTask: "task-1" },
            retryAfterMs: 5,
          };
        },
        now: () => now.value,
      },
    });

    await first.process({ doc, projectId: "project-1" });

    const staged = await createLocalPluginAssetStagingStore({ dataDir }).stage({
      projectId: "project-1",
      taskId: providerTaskId,
      slot: "media",
      pluginId: binding.pluginId,
      pluginVersion: binding.version,
      invocationId: "provider-poll-result",
      kind: "model",
      mediaType: "model/gltf-binary",
      bytes: new Uint8Array([0, 0, 0, 24]),
    });
    now.value = 106;
    const reopened = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: completeByteDerivedInspection(dataDir),
      aigc: aigc(vi.fn(async () => modelPlan)),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "completed",
          binding,
          media: {
            assetId: staged.projectAssetId,
            uri: `clash-asset://${staged.projectAssetId}`,
            kind: "model",
            mediaType: "model/gltf-binary",
          },
        }),
        now: () => now.value,
      },
    });

    await reopened.process({ doc, projectId: "project-1" });

    const target = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(target.data).toMatchObject({
      status: "completed",
      assetId: staged.projectAssetId,
    });
    expect(readProjectAsset(doc, staged.projectAssetId)).not.toBeNull();
    const actionRunId = identityFromProviderTaskId(
      providerTaskId,
      "media",
    ).actionRunId;
    expect(listActionAssetReferences(doc, staged.projectAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        slot: "media",
        projectAssetId: staged.projectAssetId,
        owner: expect.objectContaining({
          kind: "run",
          actionRunId,
        }),
      }),
    ]);
  });

  it("projects a failed model provider run onto the Canvas model node", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const doc = pendingModelDoc();
    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc: aigc(vi.fn(async () => modelPlan)),
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor: async () => ({
          status: "failed",
          binding,
          error: {
            code: "invalid_request",
            message: "The reference model could not be processed",
            retryable: false,
            requestState: "rejected",
          },
        }),
        now: () => now.value,
      },
    });

    await processor.process({ doc, projectId: "project-1" });

    const target = doc.getMap("nodes").get("node-1") as Record<string, any>;
    expect(target.data).toMatchObject({
      status: "failed",
      failureCode: "invalid_request",
    });
    expect(typeof target.data.error).toBe("string");
  });
});
