import { readFile } from "node:fs/promises";
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  canvasBatchDeleteReadToken,
  commitActionRunOutcome,
  createProjectAsset,
  createProjectGenerator,
  advanceProjectGeneratorHead,
  ensureActionRunRequest,
  ensureOutputCommit,
  GeneratorDefinitionSchema,
  generatorDefinitionFromExecutablePluginRegistration,
  readProjectGenerator,
  readGeneratorRevision,
  type GeneratorDefinition,
  canvasNodeReadToken,
  LoroSyncClient,
  MODEL_CARDS,
  PROJECT_ASSET_RENDER_CANVAS_ID,
  resolveOutputCommitAssetType,
  projectDirectorStageReadToken,
  projectDirectorStageRevisionId,
  projectCanvasReadToken,
  projectTimelineReadToken,
} from "@clash/shared-types";
import { handleCommandForTest } from "./project-command-host.js";
import { textHash, textReadToken } from "./project-text-projection.js";

test("canvas copy forks native Model state and rolls back a colliding placement", () => {
  const client = new LoroSyncClient({ serverUrl: "http://localhost:0", projectId: "project-1", token: "test" });
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const sourceRevision = { id: "source-revision", generatorId: "source-generator", definitionRef,
    state: { modelId: "minimax-h3", prompt: "Keep authored text", params: { resolution: "768P" } },
    persistentInputRefs: [{ slot: "image", itemKey: "subject", target: { kind: "media" as const, projectAssetId: "source-asset" } }] };
  assert.equal(createProjectGenerator(client.doc, { head: { id: "source-generator", headRevisionId: sourceRevision.id }, revision: sourceRevision }).ok, true);
  client.canvas.createNode("source-node", "action-badge", { generatorId: "source-generator", label: "Source" });
  createProjectAsset(client.doc, { id: "source-asset", kind: "image", source: { kind: "owned", resourceId: "source-resource" }, lifecycle: { state: "active" }, metadata: {} });
  client.canvas.createNode("reference-node", "image", { assetId: "source-asset" });
  client.canvas.insertEdge("reference-source", "reference-node", "source-node");
  client.createNode("output", "video", { assetId: "output-asset" });
  client.canvas.insertEdge("source-output", "source-node", "output");
  const copyCommand = () => handleCommandForTest(client, { action: "copy_node", nodeId: "source-node", newNodeId: "copy-node", actorClientType: "agent", observedVersion: canvasNodeReadToken(client.readNode("source-node")!) }) as { error?: string; node?: { data: Record<string, unknown> } };
  const copy = copyCommand();
  assert.equal(copy.error, undefined);
  const generatorId = copy.node?.data.generatorId as string;
  assert.notEqual(generatorId, sourceRevision.generatorId);
  const head = readProjectGenerator(client.doc, generatorId)!;
  const revision = readGeneratorRevision(client.doc, { generatorId, generatorRevisionId: head.headRevisionId })!;
  assert.deepEqual(revision.forkedFrom, { generatorId: sourceRevision.generatorId, generatorRevisionId: sourceRevision.id });
  assert.deepEqual(revision.state, sourceRevision.state);
  assert.deepEqual(revision.persistentInputRefs, sourceRevision.persistentInputRefs);
  assert.ok(client.canvas.listEdges().some(edge => edge.source === "reference-node" && edge.target === "copy-node"));
  const raw = client.doc.getMap("nodes").get("copy-node") as { data: Record<string, unknown> };
  assert.equal(raw.data.content, undefined);
  assert.equal(raw.data.modelParams, undefined);
  assert.equal(advanceProjectGeneratorHead(client.doc, { generatorId, expectedHeadRevisionId: revision.id, editPolicy: "advance-head",
    revision: { ...revision, id: "copy-edit", parentRevisionId: revision.id, state: { ...revision.state, prompt: "Edited copy" } } }).ok, true);
  assert.equal(client.readNode("source-node")?.data.content, sourceRevision.state.prompt);
  assert.equal(client.readNode("copy-node")?.data.content, "Edited copy");
  assert.ok(client.canvas.listEdges().some((edge) => edge.source === "source-node" && edge.target === "output"));
  const beforeCollision = client.doc.toJSON();
  assert.ok(copyCommand().error);
  assert.deepEqual(client.doc.toJSON(), beforeCollision);
});

function timelineGeneratorDefinition(): GeneratorDefinition {
  return GeneratorDefinitionSchema.parse({
    pluginId: "clash.remotion",
    definitionId: "timeline",
    version: "0.1.0",
    schemaHash: `sha256:${"3".repeat(64)}`,
    stateSchema: { type: "object" },
    editPolicy: "advance-head",
    persistentInputs: [{
      slot: "timeline:item",
      accepts: [{ kind: "media", mediaKind: "video" }],
      cardinality: { minItems: 0, maxItems: null },
    }],
    actions: [{
      id: "render",
      executorExportId: "render-timeline",
      parametersSchema: { type: "object" },
      invocationInputs: [],
      outputs: [{
        slot: "render:output",
        assetType: { kind: "media", mediaKind: "video" },
        cardinality: { minItems: 1, maxItems: 1 },
      }],
    }],
    projectionSurface: {
      id: "clash.timeline",
      stateKey: "timeline",
      mediaInputSlot: "timeline:item",
      primaryActionId: "render",
    },
  });
}

function directorStageGeneratorDefinition(): GeneratorDefinition {
  return GeneratorDefinitionSchema.parse({
    pluginId: "clash.director", definitionId: "director-stage", version: "1.0.0",
    schemaHash: `sha256:${"4".repeat(64)}`, stateSchema: { type: "object" }, editPolicy: "advance-head",
    persistentInputs: [{ slot: "stage:media", accepts: [{ kind: "media", mediaKind: "image" }], cardinality: { minItems: 0, maxItems: null } }],
    actions: [{ id: "capture-frame", executorExportId: "capture-frame", parametersSchema: { type: "object" }, invocationInputs: [], outputs: [{ slot: "capture:output", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } }] }],
    projectionSurface: { id: "clash.director-stage", stateKey: "stage", mediaInputSlot: "stage:media", primaryActionId: "capture-frame" },
  });
}

test("Host creates a native Timeline and its Canvas placement atomically", () => {
  const client = new LoroSyncClient({ serverUrl: "http://localhost:0", projectId: "atomic-timeline", token: "test" });
  const context = { timelineGeneratorDefinition: timelineGeneratorDefinition() };
  client.createCanvas({ id: "shots", name: "Shots" });
  const input = { action: "create_timeline", timelineId: "cut", name: "Cut", state: { tracks: [] },
    placement: { canvasId: "missing", actionNodeId: "cut-node" } };
  const rejected = handleCommandForTest(client, input, context) as { error?: string };
  assert.ok(rejected.error);
  assert.equal(readProjectGenerator(client.doc, "cut"), null);
  const created = handleCommandForTest(client, { ...input, placement: { canvasId: "shots", actionNodeId: "cut-node" } }, context) as {
    timeline: { id: string; owner: unknown }; readToken: string;
  };
  assert.deepEqual(created.timeline.owner, { kind: "canvas-action", canvasId: "shots", actionNodeId: "cut-node" });
  assert.ok(client.doc.getMap("nodes").get("cut-node"));
  assert.equal(client.doc.getMap("timelines").size, 0);
  const advanced = handleCommandForTest(client, { action: "update_timeline_state", timelineId: "cut",
    state: { tracks: [], durationInFrames: 72 }, actorClientType: "browser", ifMatch: created.readToken }, context) as { readToken: string };
  const staleDelete = handleCommandForTest(client, { action: "delete_timeline", timelineId: "cut",
    actorClientType: "browser", ifMatch: created.readToken }, context) as { error?: string };
  assert.ok(staleDelete.error);
  assert.ok(readProjectGenerator(client.doc, "cut"));
  assert.ok(client.doc.getMap("nodes").get("cut-node"));
  const deleted = handleCommandForTest(client, { action: "delete_timeline", timelineId: "cut",
    actorClientType: "browser", ifMatch: advanced.readToken }, context) as { deleted?: boolean };
  assert.equal(deleted.deleted, true);
  assert.equal(readProjectGenerator(client.doc, "cut"), null);
  assert.equal(client.doc.getMap("nodes").get("cut-node"), undefined);
});

test("Timeline commands project native Generator facts and fail closed without the Definition", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-native-timeline-host",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();

  for (const action of ["list_timelines", "create_timeline", "update_timeline_state"]) {
    const missing = handleCommandForTest(client, {
      action,
      timelineId: "native-cut",
      name: "Native cut",
      state: { tracks: [] },
    }) as { code?: string };
    assert.equal(missing.code, "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED");
  }

  const created = handleCommandForTest(client, {
    action: "create_timeline",
    timelineId: "native-cut",
    name: "Native cut",
    state: { tracks: [] },
  }, { timelineGeneratorDefinition: definition }) as {
    timeline: Parameters<typeof projectTimelineReadToken>[0];
    readToken: string;
  };
  assert.equal(client.doc.getMap("timelines").get("native-cut"), undefined);
  const head = readProjectGenerator(client.doc, "native-cut");
  assert.ok(head);
  assert.ok(readGeneratorRevision(client.doc, {
    generatorId: "native-cut",
    generatorRevisionId: head.headRevisionId,
  }));

  const listed = handleCommandForTest(client, { action: "list_timelines" }, {
    timelineGeneratorDefinition: definition,
  }) as { timelines: Array<{ id: string }>; versions: Record<string, string> };
  assert.deepEqual(listed.timelines.map((timeline) => timeline.id), ["native-cut"]);

  const updated = handleCommandForTest(client, {
    action: "update_timeline_state",
    timelineId: "native-cut",
    state: { tracks: [{ id: "dialogue", items: [] }] },
    actorClientType: "agent",
    ifMatch: created.readToken,
  }, { timelineGeneratorDefinition: definition }) as {
    timeline: Parameters<typeof projectTimelineReadToken>[0];
  };
  assert.deepEqual(updated.timeline.state, { tracks: [{ id: "dialogue", items: [] }] });
  assert.equal(client.doc.getMap("timelines").get("native-cut"), undefined);

  const stale = handleCommandForTest(client, {
    action: "update_timeline_state",
    timelineId: "native-cut",
    state: { tracks: [] },
    actorClientType: "agent",
    ifMatch: created.readToken,
  }, { timelineGeneratorDefinition: definition }) as { code?: string; error?: string };
  assert.match(`${stale.code} ${stale.error}`, /STALE/);
});

test("Canvas list exposes host-issued MCP receipts for every returned node", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-list-receipts",
    token: "test",
  });
  client.createNode("note-1", "text", { content: "Opening" });

  const result = handleCommandForTest(client, {
    action: "list",
    canvasId: "main",
  }) as { nodes: Array<{ id: string }>; versions: Record<string, string> };

  assert.deepEqual(result.nodes.map((node) => node.id), ["note-1"]);
  assert.match(
    result.versions["note-1"] ?? "",
    /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/,
  );
});

test("Timeline validation is a typed read-only host command", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-timeline-validation",
    token: "test",
  });
  const valid = handleCommandForTest(client, {
    action: "validate_timeline",
    document: { tracks: [] },
  }) as { ok?: boolean; contractFingerprint?: string };
  assert.equal(valid.ok, true);
  assert.match(valid.contractFingerprint ?? "", /^fnv1a32:/);

  const invalid = handleCommandForTest(client, {
    action: "validate_timeline",
    document: { tracks: [{ id: "visual", items: [{ id: "bad", type: "video", from: 0, durationInFrames: 10 }] }] },
  }) as { ok?: boolean; issues?: Array<{ ruleId?: string }> };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues?.some((issue) => issue.ruleId === "timeline.item.source-required"), true);
});

test("local-api allocates composition owner ids and the default Director Stage state", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-host-identities",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, {
      timelineGeneratorDefinition: definition,
      directorStageGeneratorDefinition: directorStageGeneratorDefinition(),
    });
  client.createCanvas({ id: "main", name: "Main" });
  const createdTimeline = nativeHandle({
    action: "create_timeline",
    timelineId: "cut-1",
    name: "Cut",
  }) as { timeline?: { id: string }; readToken?: string };
  const attachedTimeline = nativeHandle({
    action: "attach_timeline",
    timelineId: "cut-1",
    canvasId: "main",
    actorClientType: "mcp",
    ifMatch: createdTimeline.readToken,
  }) as { timeline?: { owner?: { actionNodeId?: string } } };
  assert.match(attachedTimeline.timeline?.owner?.actionNodeId ?? "", /^[a-f0-9-]{8,}$/);

  const createdStage = nativeHandle({
    action: "create_director_stage",
    stageId: "stage-1",
    name: "Blocking",
  }) as { stage?: { state?: { schemaVersion?: number } } };
  assert.equal(createdStage.stage?.state?.schemaVersion, 1);
});

test("local-api host scopes commands to the requested Canvas in one Project replica", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-multi-canvas",
    token: "test",
  });
  client.createNode("main-node", "text", { content: "Main" });
  assert.equal(client.createCanvas({ id: "shots", name: "Shots" }).ok, true);
  client.selectCanvas("shots");
  client.createNode("shots-node", "image", { assetId: "asset-1" });
  client.selectCanvas("main");

  const shots = handleCommandForTest(client, {
    action: "list",
    canvasId: "shots",
  }) as { nodes: Array<{ id: string }> };
  assert.deepEqual(shots.nodes.map((node) => node.id), ["shots-node"]);

  const main = handleCommandForTest(client, {
    action: "list",
    canvasId: "main",
  }) as { nodes: Array<{ id: string }> };
  assert.deepEqual(main.nodes.map((node) => node.id), ["main-node"]);
});

test("local-api host owns generation node defaults, parameter coercion, prompt refs, and edge wiring", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-add-generation",
    token: "test",
  });
  client.createNode("source-image", "image", { label: "Source", assetId: "asset-source" });

  const result = handleCommandForTest(client, {
    action: "add",
    type: "video_gen",
    label: "Animate source",
    prompt: "Animate @[Source](node:source-image)",
    modelId: "veo-3.1-fast",
    params: { duration: "6", generate_audio: "false" },
    refs: ["asset-source"],
    actorClientType: "agent",
    actorAgentId: "agent-1",
  }, {
    actorUserId: "user-1",
  }) as {
    node_id?: string;
    asset_id?: string | null;
    node?: { type?: string; data?: Record<string, unknown> };
    refNodeIds?: string[];
    readToken?: string;
  };

  assert.ok(result.node_id);
  assert.equal(result.asset_id, null);
  assert.equal(result.node?.type, "action-badge");
  const data = result.node?.data ?? {};
  assert.equal(Object.hasOwn(data, "assetId"), false);
  assert.equal(
    Object.hasOwn(client.readNode(result.node_id)?.data ?? {}, "assetId"),
    false,
  );
  assert.deepEqual({
    label: data.label,
    actionType: data.actionType,
    modelId: data.modelId,
    modelParams: data.modelParams,
    prompt: data.prompt,
    content: data.content,
    referenceImageOrder: data.referenceImageOrder,
    actorType: data.actorType,
    actorUserId: data.actorUserId,
    actorAgentId: data.actorAgentId,
  }, {
    label: "Animate source",
    actionType: "video-gen",
    modelId: "veo-3.1-fast",
    modelParams: { duration: 6, generate_audio: false },
    prompt: "Animate @[Source](node:source-image)",
    content: "Animate @[Source](node:source-image)",
    referenceImageOrder: ["source-image"],
    actorType: "agent",
    actorUserId: "user-1",
    actorAgentId: "agent-1",
  });
  assert.deepEqual(result.refNodeIds, ["source-image"]);
  assert.match(result.readToken ?? "", /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.equal(
    client.canvas.listEdges().some((edge) =>
      edge.source === "source-image" && edge.target === result.node_id && edge.type === "reference"),
    true,
  );
});

test("local-api host picks generation defaults from the injected effective catalogue", () => {
  const pluginCard = {
    ...MODEL_CARDS.find((card) => card.kind === "image")!,
    id: "plugin-default-image",
    aliases: [],
    name: "Plugin Default Image",
  };
  const clientOptions = {
    serverUrl: "http://localhost:0",
    projectId: "project-add-default-model",
    token: "test",
    modelCards: [pluginCard],
  };
  const client = new LoroSyncClient(
    clientOptions as ConstructorParameters<typeof LoroSyncClient>[0],
  );

  const result = handleCommandForTest(client, {
    action: "add",
    type: "image_gen",
    label: "Default model",
    prompt: "A portrait",
  }, {
    effectiveModelCards: [pluginCard],
  }) as { node?: { data?: Record<string, unknown> } };

  assert.equal(result.node?.data?.modelId, pluginCard.id);
});

test("local-api host resolves and registers trusted custom action metadata", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-add-custom-action",
    token: "test",
  });
  const pluginBinding = {
    pluginId: "test.caption-actions",
    version: "1.2.0",
    exportId: "run-caption-helper",
    schemaHash: `sha256:${"c".repeat(64)}`,
  };
  const trustedAction = {
      id: "caption-helper",
      outputType: "text",
      pluginBinding,
  };

  const result = handleCommandForTest(client, {
    action: "add",
    type: "text_gen",
    label: "Caption",
    prompt: "Write a caption",
    actionId: "caption-helper",
    params: { alternatives: "3", concise: "true" },
  }, {
    trustedCustomActions: [trustedAction],
  }) as { node?: { data?: Record<string, unknown> } };

  const data = result.node?.data ?? {};
  assert.deepEqual({
    actionType: data.actionType,
    customActionId: data.customActionId,
    customActionParams: data.customActionParams,
    outputType: data.outputType,
    pluginBinding: data.pluginBinding,
  }, {
    actionType: "custom:caption-helper",
    customActionId: "caption-helper",
    customActionParams: { alternatives: 3, concise: true },
    outputType: "text",
    pluginBinding,
  });
  assert.deepEqual(client.doc.getMap("customActions").get("caption-helper"), trustedAction);
});

test("local-api host rejects unresolved refs and unknown actions without leaving a node", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-add-preflight",
    token: "test",
  });

  const missingRef = handleCommandForTest(client, {
    action: "add",
    type: "image_gen",
    label: "Broken ref",
    prompt: "Use missing",
    modelId: "nano-banana-2",
    refs: ["missing-node"],
  }) as { code?: string; error?: string };
  assert.equal(missingRef.code, "UNRESOLVED_REFERENCE");
  assert.match(missingRef.error ?? "", /missing-node/);
  assert.deepEqual(client.listNodes(), []);

  const missingAction = handleCommandForTest(client, {
    action: "add",
    type: "image_gen",
    label: "Missing action",
    actionId: "not-installed",
  }) as { code?: string; error?: string };
  assert.equal(missingAction.code, "UNKNOWN_CUSTOM_ACTION");
  assert.match(missingAction.error ?? "", /not-installed/);
  assert.deepEqual(client.listNodes(), []);
});

test("local-api host moves a node in the requested Canvas without patching node data", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-move-node",
    token: "test",
  });
  client.createNode("note-1", "text", { label: "Opening beat", content: "Rain" });

  const result = handleCommandForTest(client, {
    action: "move",
    canvasId: "main",
    nodeId: "note-1",
    position: { x: 420, y: 180 },
  }) as { moved?: boolean; nodeId?: string; position?: { x: number; y: number } };
  assert.equal(result.moved, true);
  assert.equal(result.nodeId, "note-1");
  assert.deepEqual(result.position, { x: 420, y: 180 });
  assert.deepEqual(client.readNode("note-1")?.position, { x: 420, y: 180 });
  assert.deepEqual(client.readNode("note-1")?.data, {
    label: "Opening beat",
    content: "Rain",
  });
});

test("local-api host rejects moving a downstream-referenced node without changing the replica", () => {
  const client = new LoroSyncClient({ serverUrl: "http://localhost:0", projectId: "immutable-move" });
  try {
    client.createNode("source", "text", { content: "Source" });
    client.createNode("target", "text", { content: "Dependent" });
    client.canvas.insertEdge("reference", "source", "target");
    const before = client.doc.toJSON();
    const result = handleCommandForTest(client, { action: "move", canvasId: "main", nodeId: "source", position: { x: 420, y: 180 } }) as { code?: string; mutation?: { accepted: boolean } };
    assert.equal(result.code, "IMMUTABLE_NODE");
    assert.equal(result.mutation?.accepted, false);
    assert.deepEqual(client.doc.toJSON(), before);
  } finally { client.doc.free(); }
});

test("local-api host protects agent moves with host-issued read receipts and returns a fresh receipt", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-move-cas",
    token: "test",
  });
  client.createNode("note-1", "text", { label: "Opening beat", content: "Rain" });

  const unread = handleCommandForTest(client, {
    action: "move",
    nodeId: "note-1",
    position: { x: 100, y: 50 },
    actorClientType: "agent",
  }) as { error?: string };
  assert.match(unread.error ?? "", /READ_REQUIRED|read proof/i);
  assert.notDeepEqual(client.readNode("note-1")?.position, { x: 100, y: 50 });

  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "note-1",
    actorClientType: "agent",
  }) as { version: string; readToken: string };
  assert.match(read.readToken, /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);

  const forged = handleCommandForTest(client, {
    action: "move",
    nodeId: "note-1",
    position: { x: 100, y: 50 },
    actorClientType: "agent",
    observedVersion: read.readToken,
    ifMatch: `${read.version}:receipt:forged`,
  }) as { error?: string };
  assert.match(forged.error ?? "", /invalid.*read receipt/i);
  assert.notDeepEqual(client.readNode("note-1")?.position, { x: 100, y: 50 });

  client.canvas.moveNode("note-1", { x: 25, y: 30 });
  const stale = handleCommandForTest(client, {
    action: "move",
    nodeId: "note-1",
    position: { x: 100, y: 50 },
    actorClientType: "agent",
    observedVersion: read.readToken,
    ifMatch: read.readToken,
  }) as { error?: string };
  assert.match(stale.error ?? "", /stale.*read/i);
  assert.deepEqual(client.readNode("note-1")?.position, { x: 25, y: 30 });

  const freshRead = handleCommandForTest(client, {
    action: "get",
    nodeId: "note-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const accepted = handleCommandForTest(client, {
    action: "move",
    nodeId: "note-1",
    position: { x: 100, y: 50 },
    actorClientType: "agent",
    observedVersion: freshRead.readToken,
    ifMatch: freshRead.readToken,
  }) as {
    moved?: boolean;
    version?: string;
    readToken?: string;
    mutation?: { accepted?: boolean; expectedReadToken?: string; afterReadToken?: string };
  };
  assert.equal(accepted.moved, true);
  assert.equal(accepted.version, canvasNodeReadToken(client.readNode("note-1")!));
  assert.match(accepted.readToken ?? "", /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.equal(accepted.mutation?.accepted, true);
  assert.equal(accepted.mutation?.expectedReadToken, freshRead.readToken);
  assert.equal(accepted.mutation?.afterReadToken, accepted.readToken);
  assert.deepEqual(client.readNode("note-1")?.position, { x: 100, y: 50 });
});

test("local-api host reads derived upstream edges for graph CAS and batch-delete guardrails", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-derived-edges",
    token: "test",
  });
  client.createNode("source", "text", { content: "Source" });
  client.createNode("target", "image_gen", { prompt: "Use source" });
  client.canvas.insertEdge("source-target", "source", "target", "reference");

  const listed = handleCommandForTest(client, {
    action: "edges",
    canvasId: "main",
  }) as { edges?: Array<{ id: string; source: string; target: string; type: string }> };
  assert.deepEqual(listed.edges, [
    { id: "source-target", source: "source", target: "target", type: "reference" },
  ]);

  const plan = handleCommandForTest(client, {
    action: "batch_delete_plan",
    canvasId: "main",
    nodeIds: ["source"],
  }) as { edges?: Array<{ id: string; source: string; target: string }> };
  assert.deepEqual(plan.edges, [
    { id: "source-target", source: "source", target: "target", type: "reference" },
  ]);

  assert.match(JSON.stringify(handleCommandForTest(client, {
    action: "delete_batch",
    canvasId: "main",
    nodeIds: ["source"],
  })), /downstream/i);
  assert.ok(client.readNode("source"));
});

test("local-api host executes against the selected Canvas instead of falling back to main", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-execute-scope",
    token: "test",
  });
  assert.equal(client.createCanvas({ id: "shots", name: "Shots" }).ok, true);
  client.selectCanvas("shots");
  client.createNode("shot-action", "image_gen", {
    prompt: "A product shot",
    content: "A product shot",
    modelId: "nano-banana-pro",
  });

  const result = handleCommandForTest(client, {
    action: "execute",
    canvasId: "shots",
    nodeId: "shot-action",
  }) as { error?: string; childNodeId?: string };
  assert.equal(result.error, undefined);
  assert.ok(result.childNodeId);
  assert.ok(client.canvasFor("shots").readNode(result.childNodeId!));
  assert.equal(client.canvasFor("main").readNode(result.childNodeId!), null);
});

test("local-api host resolves a globally active image plugin when an older project has no local action copy", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-execute-global-plugin",
    token: "test",
  });
  const pluginBinding = {
    pluginId: "clash.codex-imagegen",
    version: "0.1.1",
    exportId: "generate-image",
    schemaHash: `sha256:${"c".repeat(64)}`,
  };
  const trustedAction = {
    id: "codex-imagegen",
    name: "Codex ImageGen",
    outputType: "image",
    pluginBinding,
  };
  client.createNode("codex-action", "image_gen", {
    prompt: "A cat",
    content: "A cat",
    actionType: "custom:codex-imagegen",
    customActionId: "codex-imagegen",
    customActionParams: { aspect_ratio: "1:1" },
    outputType: "image",
    pluginBinding,
  });

  const result = handleCommandForTest(
    client,
    {
      action: "execute",
      canvasId: "main",
      nodeId: "codex-action",
    },
    { trustedCustomActions: [trustedAction] },
  ) as { error?: string; childNodeId?: string };

  assert.equal(result.error, undefined);
  assert.ok(result.childNodeId);
  assert.equal(
    client.doc.getMap("customActions").get("codex-imagegen"),
    undefined,
  );
});

test("local-api host rejects an unknown Canvas scope without creating it", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-unknown-canvas",
    token: "test",
  });
  client.createNode("main-node", "text", { content: "Main" });

  assert.deepEqual(handleCommandForTest(client, {
    action: "list",
    canvasId: "typo",
  }), { error: "Canvas typo not found" });
  assert.deepEqual(client.listCanvases().map((canvas) => canvas.id), ["main"]);
});

test("local-api host manages the Project Canvas registry", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-canvas-registry",
    token: "test",
  });
  client.createNode("bootstrap", "text", { content: "Bootstrap" });

  const listed = handleCommandForTest(client, { action: "list_canvases" }) as {
    canvases: Array<{ id: string; name: string; position: number }>;
    versions: Record<string, string>;
  };
  assert.deepEqual(listed.canvases, [{ id: "main", name: "Main", position: 0 }]);
  assert.match(listed.versions.main, /^canvas-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  const created = handleCommandForTest(client, {
    action: "create_canvas",
    canvasId: "shots",
    name: "Shots",
  }) as {
    canvas: { id: string; name: string; position: number };
    version: string;
    readToken: string;
  };
  assert.deepEqual(created.canvas, {
    canvas: { id: "shots", name: "Shots", position: 1 },
  }.canvas);
  assert.match(created.version, /^canvas-v1:[a-f0-9]{16}$/);
  assert.match(created.readToken, /^canvas-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  const renamed = handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
  }) as { canvas: unknown; version: string; readToken: string };
  assert.deepEqual(renamed.canvas, { id: "shots", name: "Selects", position: 1 });
  assert.equal(renamed.version, projectCanvasReadToken({ id: "shots", name: "Selects", position: 1 }));
  assert.match(renamed.readToken, /^canvas-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.deepEqual(handleCommandForTest(client, {
    action: "delete_canvas",
    canvasId: "shots",
  }), {
    deleted: true,
    canvasId: "shots",
  });
});

test("local-api host Canvas rename verifies the implicit host receipt", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-canvas-cas",
    token: "test",
  });
  client.createCanvas({ id: "shots", name: "Shots" });
  const observedVersion = projectCanvasReadToken({ id: "shots", name: "Shots", position: 1 });
  const listed = handleCommandForTest(client, { action: "list_canvases" }) as {
    versions: Record<string, string>;
  };
  const readReceipt = listed.versions.shots;
  assert.match(readReceipt, /^canvas-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);

  assert.match(JSON.stringify(handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
    actorClientType: "agent",
  })), /READ_REQUIRED/);
  assert.match(JSON.stringify(handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
    actorClientType: "agent",
    observedVersion: "canvas-v1:stale",
  })), /STALE_READ/);
  assert.match(JSON.stringify(handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
    actorClientType: "agent",
    ifMatch: observedVersion,
  })), /read receipt/);
  assert.match(JSON.stringify(handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
    actorClientType: "agent",
    ifMatch: `${observedVersion}:receipt:forged`,
  })), /Invalid Canvas rename read receipt/);

  const renamed = handleCommandForTest(client, {
    action: "rename_canvas",
    canvasId: "shots",
    name: "Selects",
    actorClientType: "agent",
    ifMatch: readReceipt,
  }) as { canvas: unknown; version: string; readToken: string };
  assert.deepEqual(renamed.canvas, { id: "shots", name: "Selects", position: 1 });
  assert.equal(renamed.version, projectCanvasReadToken({ id: "shots", name: "Selects", position: 1 }));
  assert.match(renamed.readToken, /^canvas-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
});

test("local-api host manages standalone and Canvas-owned Timelines", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-timeline-registry",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, { timelineGeneratorDefinition: definition });
  client.createCanvas({ id: "shots", name: "Shots" });

  const created = nativeHandle({
    action: "create_timeline",
    timelineId: "timeline-1",
    name: "Episode 1",
    state: { tracks: [] },
  }) as { timeline: Parameters<typeof projectTimelineReadToken>[0]; version: string; readToken: string };
  assert.equal(created.timeline.id, "timeline-1");
  assert.equal(created.timeline.name, "Episode 1");
  assert.deepEqual(created.timeline.owner, { kind: "project" });
  assert.deepEqual(created.timeline.state, { tracks: [] });
  assert.equal(created.version, projectTimelineReadToken(created.timeline));
  assert.match(created.readToken, /^timeline-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.equal((nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "main",
    actionNodeId: "timeline-action-1",
    position: { x: 0, y: 0 },
  }) as { timeline?: { owner?: { canvasId?: string } } }).timeline?.owner?.canvasId, "main");
  assert.equal((nativeHandle({
    action: "copy_timeline_action",
    sourceTimelineId: "timeline-1",
    targetCanvasId: "shots",
    newTimelineId: "timeline-2",
    newActionNodeId: "timeline-action-2",
    position: { x: 0, y: 0 },
  }) as { timeline?: { id?: string; owner?: { canvasId?: string } } }).timeline?.id, "timeline-2");
  const listed = nativeHandle({ action: "list_timelines" }) as {
    timelines: Array<{ id: string; owner: { kind: string } }>;
  };
  assert.equal(listed.timelines.find((timeline) => timeline.id === "timeline-2")?.owner.kind, "canvas-action");

  assert.equal((nativeHandle({
    action: "detach_timeline",
    timelineId: "timeline-1",
  }) as { timeline?: { owner?: { kind?: string } } }).timeline?.owner?.kind, "project");
});

test("local-api host plans native Timeline Actions and projects native Runs as legacy render reads", () => {
  const client = new LoroSyncClient({ serverUrl: "http://localhost:0", projectId: "project-timeline-render-readback", token: "test" });
  const definition = timelineGeneratorDefinition();
  const created = handleCommandForTest(client, {
    action: "create_timeline", timelineId: "timeline-1", name: "Episode 1", state: { tracks: [] },
  }, { timelineGeneratorDefinition: definition }) as { timeline: Parameters<typeof projectTimelineReadToken>[0]; readToken: string };

  const plan = handleCommandForTest(client, {
    action: "request_timeline_render", timelineId: "timeline-1", actorClientType: "agent", ifMatch: created.readToken,
  }, { timelineGeneratorDefinition: definition, generationId: () => "run-planned" }) as Record<string, unknown>;
  assert.deepEqual(plan, {
    kind: "timeline-generator-action-plan", actionRunId: "run-planned", generatorId: "timeline-1",
    generatorRevisionId: created.timeline.revisionId, actionId: "render", timelineId: "timeline-1",
    sourceTimelineRevisionId: created.timeline.revisionId, renderNodeId: "run-planned", target: { kind: "project-assets" },
  });
  assert.equal(client.doc.getMap("nodes").get("run-planned"), undefined);
  assert.equal(client.doc.getMap("timelines").size, 0);
  assert.equal(Object.hasOwn(plan, "submitted"), false);

  const request = (actionRunId: string) => ({
    actionRunId,
    generatorRevision: { generatorId: "timeline-1", generatorRevisionId: created.timeline.revisionId },
    actionId: "render",
    executor: { pluginId: definition.pluginId, version: definition.version, exportId: "render-timeline", schemaHash: definition.schemaHash },
    invocationFingerprint: `sha256:${(actionRunId === "run-completed" ? "a" : "b").repeat(64)}`,
    parameters: {}, invocationInputRefs: [], outputContract: definition.actions[0]!.outputs,
  });
  assert.equal(ensureActionRunRequest(client.doc, request("run-pending")).ok, true);
  assert.equal(ensureActionRunRequest(client.doc, request("run-completed")).ok, true);
  assert.equal(createProjectAsset(client.doc, {
    id: "asset-render-completed", kind: "video",
    source: { kind: "owned", resourceId: "resource:asset-render-completed" },
    lifecycle: { state: "active" }, metadata: { contentType: "video/mp4" },
  }).ok, true);
  assert.equal(ensureOutputCommit(client.doc, {
    actionRunId: "run-completed", outputSlot: "render:output", asset: { kind: "media", projectAssetId: "asset-render-completed" },
  }, resolveOutputCommitAssetType).ok, true);
  assert.equal(commitActionRunOutcome(client.doc, { actionRunId: "run-completed", status: "succeeded" }).ok, true);

  const completed = handleCommandForTest(client, { action: "list_timeline_renders" }, { timelineGeneratorDefinition: definition }) as any;
  assert.deepEqual(completed.renders.map((render: any) => render.node.id), ["run-completed"]);
  assert.deepEqual(completed.renders[0].node.data, {
    status: "completed", sourceTimelineId: "timeline-1", sourceTimelineRevisionId: created.timeline.revisionId,
    assetId: "asset-render-completed",
  });
  assert.equal(completed.renders[0].version, canvasNodeReadToken(completed.renders[0].node));
  assert.match(completed.renders[0].readToken, /:receipt:/);

  const all = handleCommandForTest(client, { action: "list_timeline_renders", status: "all" }, { timelineGeneratorDefinition: definition }) as any;
  assert.deepEqual(all.renders.map((render: any) => [render.node.id, render.node.data.status]), [
    ["run-completed", "completed"], ["run-pending", "generating"],
  ]);
  assert.equal(client.listCanvases().some((canvas) => canvas.id === PROJECT_ASSET_RENDER_CANVAS_ID), false);
});

test("local-api host manages independently revisioned Director Stages", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-director-stage-registry",
    token: "test",
  });
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, {
      directorStageGeneratorDefinition: directorStageGeneratorDefinition(),
    });
  const state = {
    schemaVersion: 1 as const,
    scene: {
      backgroundColor: "#171816",
      grid: { visible: true, snap: false, size: 1 },
    },
    objects: [],
    cameras: [],
    shots: [],
  };

  const created = nativeHandle({
    action: "create_director_stage",
    stageId: "stage-1",
    name: "Courtyard blocking",
    state,
  }) as { stage?: any; version?: string; readToken?: string; error?: string };
  assert.equal(created.error, undefined);
  assert.notEqual(created.stage?.revisionId, "");
  assert.equal(created.version, created.stage && projectDirectorStageReadToken(created.stage));
  assert.match(created.readToken ?? "", /:receipt:/);

  const attached = nativeHandle({
    action: "attach_director_stage",
    stageId: "stage-1",
    canvasId: "main",
    actionNodeId: "director-stage-action-1",
    position: { x: 0, y: 0 },
  }) as { stage?: { owner?: { kind?: string } }; error?: string };
  assert.equal(attached.error, undefined);
  assert.equal(attached.stage?.owner?.kind, "canvas-action");

  const nextState = {
    ...state,
    scene: {
      ...state.scene,
      grid: { ...state.scene.grid, snap: true },
    },
  };
  const updated = nativeHandle({
    action: "update_director_stage_state",
    stageId: "stage-1",
    state: nextState,
  }) as { stage?: any; error?: string };
  assert.equal(updated.error, undefined);
  assert.notEqual(updated.stage?.revisionId, created.stage?.revisionId);

  const listed = nativeHandle({
    action: "list_director_stages",
  }) as { stages?: Array<{ id: string }>; versions?: Record<string, string> };
  assert.deepEqual(listed.stages?.map((stage) => stage.id), ["stage-1"]);
  assert.match(listed.versions?.["stage-1"] ?? "", /:receipt:/);

  const detached = nativeHandle({
    action: "detach_director_stage",
    stageId: "stage-1",
  }) as { stage?: { owner?: { kind?: string } }; error?: string };
  assert.equal(detached.error, undefined);
  assert.equal(detached.stage?.owner?.kind, "project");
});

test("local-api host Timeline ownership changes verify the implicit host receipt", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-timeline-cas",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, { timelineGeneratorDefinition: definition });
  client.createNode("bootstrap", "text", { content: "Bootstrap" });
  const created = nativeHandle({
    action: "create_timeline",
    timelineId: "timeline-1",
    name: "Episode 1",
    state: { tracks: [] },
  }) as { timeline: Parameters<typeof projectTimelineReadToken>[0]; readToken: string };
  const observedVersion = projectTimelineReadToken(created.timeline);

  const listed = nativeHandle({ action: "list_timelines" }) as {
    versions?: Record<string, string>;
  };
  const readReceipt = listed.versions?.["timeline-1"] ?? "";
  assert.match(readReceipt, /^timeline-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.match(JSON.stringify(nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "main",
    actionNodeId: "timeline-action-1",
    actorClientType: "agent",
  })), /READ_REQUIRED/);
  assert.match(JSON.stringify(nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "main",
    actionNodeId: "timeline-action-1",
    actorClientType: "agent",
    observedVersion: "timeline-v1:stale",
  })), /STALE_READ/);
  assert.match(JSON.stringify(nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "main",
    actionNodeId: "timeline-action-1",
    actorClientType: "agent",
    ifMatch: `${observedVersion}:receipt:forged`,
  })), /Invalid Timeline attach read receipt/);

  const attached = nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "main",
    actionNodeId: "timeline-action-1",
    actorClientType: "agent",
    ifMatch: readReceipt,
  }) as { timeline?: { owner?: { kind?: string } }; version?: string };
  assert.equal(attached.timeline?.owner?.kind, "canvas-action");
  assert.equal(
    attached.version,
    projectTimelineReadToken(attached.timeline as Parameters<typeof projectTimelineReadToken>[0]),
  );
});

test("local-api host Timeline state apply advances its revision under implicit CAS", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-timeline-state-cas",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, { timelineGeneratorDefinition: definition });
  const created = nativeHandle({
    action: "create_timeline",
    timelineId: "timeline-1",
    name: "Episode 1",
    state: { tracks: [] },
  }) as { timeline: Parameters<typeof projectTimelineReadToken>[0]; readToken: string };
  const observedVersion = projectTimelineReadToken(created.timeline);

  assert.match(JSON.stringify(nativeHandle({
    action: "update_timeline_state",
    timelineId: "timeline-1",
    state: { tracks: [{ id: "dialogue", items: [] }] },
    actorClientType: "agent",
  })), /READ_REQUIRED/);
  assert.match(JSON.stringify(nativeHandle({
    action: "update_timeline_state",
    timelineId: "timeline-1",
    state: { tracks: [{ id: "dialogue", items: [] }] },
    actorClientType: "agent",
    observedVersion: "timeline-v1:stale",
  })), /STALE_READ/);

  const result = nativeHandle({
    action: "update_timeline_state",
    timelineId: "timeline-1",
    state: { tracks: [{ id: "dialogue", items: [] }] },
    actorClientType: "agent",
    observedVersion,
  }) as { timeline?: Parameters<typeof projectTimelineReadToken>[0]; version?: string };
  assert.notEqual(result.timeline?.revisionId, created.timeline.revisionId);
  const advancedRevision = result.timeline && readGeneratorRevision(client.doc, {
    generatorId: "timeline-1",
    generatorRevisionId: result.timeline.revisionId,
  });
  assert.equal(advancedRevision?.parentRevisionId, created.timeline.revisionId);
  assert.equal(result.version, result.timeline && projectTimelineReadToken(result.timeline));
});

test("local-api host Timeline attach does not create an unknown Canvas", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-timeline-invalid-canvas",
    token: "test",
  });
  const definition = timelineGeneratorDefinition();
  const nativeHandle = (command: Record<string, unknown>) =>
    handleCommandForTest(client, command, { timelineGeneratorDefinition: definition });
  client.createNode("bootstrap", "text", { content: "Bootstrap" });
  nativeHandle({
    action: "create_timeline",
    timelineId: "timeline-1",
    name: "Episode 1",
    state: { tracks: [] },
  });

  const result = nativeHandle({
    action: "attach_timeline",
    timelineId: "timeline-1",
    canvasId: "missing",
    actionNodeId: "timeline-action-1",
  });

  assert.match(JSON.stringify(result), /Canvas missing not found/);
  assert.deepEqual(client.listCanvases().map((canvas) => canvas.id), ["main"]);
});

test("local-api host ensure_edge rejects new inputs to materialized action checkpoints", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("image-1", "image", { assetId: "asset-1" });
  client.createNode("image-2", "image", { assetId: "asset-2" });
  client.createNode("action-1", "action-badge", { actionType: "image-gen" });
  client.createNode("output-1", "image", { assetId: "asset-output", status: "completed" });
  client.canvas.insertEdge("image-1-action-1", "image-1", "action-1");
  client.canvas.insertEdge("action-1-output-1", "action-1", "output-1");

  const result = handleCommandForTest(client, {
    action: "ensure_edge",
    source: "image-2",
    target: "action-1",
  });

  assert.deepEqual(client.canvas.listEdges().some((edge) => edge.source === "image-2" && edge.target === "action-1"), false);
  assert.match(JSON.stringify(result), /checkpoint input edge/);
});

test("local-api host ensure_edge allows inputs while downstream output is only a draft placeholder", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("image-1", "image", { assetId: "asset-1" });
  client.createNode("image-2", "image", { assetId: "asset-2" });
  client.createNode("action-1", "action-badge", { actionType: "image-gen" });
  client.createNode("draft-1", "image", { status: "draft" });
  client.canvas.insertEdge("image-1-action-1", "image-1", "action-1");
  client.canvas.insertEdge("action-1-draft-1", "action-1", "draft-1");

  const result = handleCommandForTest(client, {
    action: "ensure_edge",
    source: "image-2",
    target: "action-1",
  });

  assert.equal((result as { existed?: boolean }).existed, false);
  assert.equal(typeof (result as { edgeId?: unknown }).edgeId, "string");
  assert.equal(client.canvas.listEdges().some((edge) => edge.source === "image-2" && edge.target === "action-1"), true);
});

test("local-api host direct update requires an observation or legacy read receipt", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("text-1", "text", { label: "Script", content: "before" });
  const nodeBefore = client.readNode("text-1");
  assert.ok(nodeBefore);
  const readToken = (handleCommandForTest(client, {
    action: "get",
    nodeId: "text-1",
    actorClientType: "agent",
  }) as { readToken: string }).readToken;

  const missing = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-1",
    label: "Changed without read proof",
    actorClientType: "agent",
  });
  assert.match(JSON.stringify(missing), /READ_REQUIRED/);
  assert.deepEqual(
    (missing as { mutation?: unknown }).mutation,
    {
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: "text-1" },
      accepted: false,
      error: "READ_REQUIRED: Read the target before canvas update.",
    },
  );
  assert.equal(client.readNode("text-1")?.data.label, "Script");

  client.updateNode("text-1", { label: "Concurrent change" });
  const concurrentToken = canvasNodeReadToken(client.readNode("text-1")!);
  const stale = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-1",
    label: "Changed from stale read",
    actorClientType: "agent",
    ifMatch: readToken,
  });
  assert.match(JSON.stringify(stale), /Stale canvas update rejected/);
  assert.deepEqual(
    (stale as { mutation?: unknown }).mutation,
    {
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: "text-1" },
      expectedReadToken: readToken,
      beforeReadToken: concurrentToken,
      accepted: false,
      error: "Stale canvas update rejected (STALE_READ). The target changed after it was read. " +
        "Run `clash canvas get --json` first, then retry the mutation.",
    },
  );
  assert.equal(client.readNode("text-1")?.data.label, "Concurrent change");

  const freshRead = handleCommandForTest(client, {
    action: "get",
    nodeId: "text-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const freshReadToken = freshRead.readToken;
  const freshBaseReadToken = canvasNodeReadToken(client.readNode("text-1")!);
  const fresh = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-1",
    label: "Changed from fresh read",
    actorClientType: "agent",
    ifMatch: freshReadToken,
  });
  const updatedReadToken = (fresh as { readToken?: string }).readToken;
  assert.match(updatedReadToken ?? "", /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.deepEqual(fresh, {
    updated: true,
    nodeId: "text-1",
    version: (fresh as { version?: string }).version,
    readToken: updatedReadToken,
    mutation: {
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: "text-1" },
      expectedReadToken: freshReadToken,
      beforeReadToken: freshBaseReadToken,
      afterReadToken: updatedReadToken,
      resultEntityId: "text-1",
      accepted: true,
    },
  });
  assert.equal(client.readNode("text-1")?.data.label, "Changed from fresh read");
});

test("local-api host validates plugin View state as one structured update", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("storyboard-1", "plugin-view", {
    label: "Storyboard",
    view: {
      pluginId: "community.storyboard",
      definitionId: "storyboard",
      version: "1.0.0",
      schemaHash: `sha256:${"a".repeat(64)}`,
    },
    state: { keyElements: [], shots: [], audioLayers: [], uncategorized: [] },
  });
  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "storyboard-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const invalid = handleCommandForTest(client, {
    action: "update",
    nodeId: "storyboard-1",
    data: { state: { keyElements: [] } },
    actorClientType: "agent",
    ifMatch: read.readToken,
  });
  assert.equal((invalid as { code?: string }).code, "INVALID_VIEW_STATE");

  const reread = handleCommandForTest(client, {
    action: "get",
    nodeId: "storyboard-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const valid = handleCommandForTest(client, {
    action: "update",
    nodeId: "storyboard-1",
    data: {
      state: { keyElements: [], shots: [], audioLayers: [], uncategorized: [] },
    },
    actorClientType: "agent",
    ifMatch: reread.readToken,
  });
  assert.equal((valid as { updated?: boolean }).updated, true);
});

test("local-api host direct update requires a host-issued read receipt for agent writes", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("text-1", "text", { label: "Script", content: "before" });

  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "text-1",
    actorClientType: "agent",
  }) as { readToken?: string };
  assert.match(read.readToken ?? "", /^node-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  const baseReadToken = canvasNodeReadToken(client.readNode("text-1")!);

  const syntheticCasOnly = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-1",
    label: "Changed from synthetic hash",
    actorClientType: "agent",
    ifMatch: baseReadToken,
  });
  assert.match(JSON.stringify(syntheticCasOnly), /read receipt/);
  assert.equal(client.readNode("text-1")?.data.label, "Script");

  const accepted = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-1",
    label: "Changed from host read",
    actorClientType: "agent",
    ifMatch: read.readToken,
  }) as { updated?: boolean; mutation?: { expectedReadToken?: string; beforeReadToken?: string } };

  assert.equal(accepted.updated, true);
  assert.equal(accepted.mutation?.expectedReadToken, read.readToken);
  assert.equal(accepted.mutation?.beforeReadToken, baseReadToken);
  assert.equal(client.readNode("text-1")?.data.label, "Changed from host read");
});

test("local-api host direct update uses the cwd observation version without a client token", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("text-observed", "text", { label: "Script", content: "before" });

  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "text-observed",
    actorClientType: "agent",
  }) as { version?: string };
  assert.equal(read.version, canvasNodeReadToken(client.readNode("text-observed")!));

  const accepted = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-observed",
    label: "after read",
    actorClientType: "agent",
    observedVersion: read.version,
  }) as { updated?: boolean; mutation?: { accepted?: boolean } };
  assert.equal(accepted.updated, true);
  assert.equal(accepted.mutation?.accepted, true);

  client.updateNode("text-observed", { label: "concurrent" });
  const stale = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-observed",
    label: "stale write",
    actorClientType: "agent",
    observedVersion: read.version,
  }) as { error?: string; mutation?: { accepted?: boolean } };
  assert.match(stale.error ?? "", /^STALE_READ:/);
  assert.equal(stale.mutation?.accepted, false);
  assert.equal(client.readNode("text-observed")?.data.label, "concurrent");

  const unread = handleCommandForTest(client, {
    action: "update",
    nodeId: "text-observed",
    label: "unread write",
    actorClientType: "agent",
  }) as { error?: string };
  assert.match(unread.error ?? "", /^READ_REQUIRED:/);
});

test("local-api host exposes immutable nodes and provides an explicit copy-on-write operation", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("gen-immutable", "image_gen", { label: "Hero", prompt: "original" });
  client.createNode("image-output", "image", { label: "Output", assetId: "asset-1", status: "completed" });
  client.canvas.insertEdge("gen-output", "gen-immutable", "image-output");

  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "gen-immutable",
    actorClientType: "agent",
  }) as { immutable?: boolean; version?: string };
  assert.equal(read.immutable, true);
  assert.ok(read.version);

  const blocked = handleCommandForTest(client, {
    action: "update",
    nodeId: "gen-immutable",
    data: { prompt: "changed in place" },
    actorClientType: "agent",
    observedVersion: read.version,
  }) as { code?: string; error?: string };
  assert.equal(blocked.code, "IMMUTABLE_NODE");
  assert.equal(blocked.error, "IMMUTABLE_NODE");
  assert.equal(client.readNode("gen-immutable")?.data.prompt, "original");

  const copied = handleCommandForTest(client, {
    action: "copy_node",
    nodeId: "gen-immutable",
    newNodeId: "gen-copy",
    actorClientType: "agent",
    observedVersion: read.version,
  }) as {
    copied?: boolean;
    copyOnWrite?: boolean;
    node?: { id?: string; data?: Record<string, unknown> };
    immutable?: boolean;
    version?: string;
  };
  assert.equal(copied.copied, true);
  assert.equal(copied.copyOnWrite, true);
  assert.equal(copied.node?.id, "gen-copy");
  assert.equal(copied.node?.data?.prompt, "original");
  assert.equal(copied.node?.data?.copyOnWrite, true);
  assert.equal(copied.node?.data?.sourceNodeId, "gen-immutable");
  assert.equal(copied.immutable, false);
  assert.ok(copied.version);
  assert.equal(
    client.canvas.listEdges().some((edge) => edge.source === "gen-immutable" && edge.target === "image-output"),
    true,
  );
  assert.equal(
    client.canvas.listEdges().some((edge) => edge.source === "gen-immutable" && edge.target === "gen-copy"),
    true,
  );
});

test("local-api host text projections use implicit observed versions", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { content: "before" });

  const unreadText = handleCommandForTest(client, {
    action: "text_cas_update",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    actorClientType: "agent",
  }) as { error?: string };
  assert.match(unreadText.error ?? "", /read proof/i);

  const read = handleCommandForTest(client, {
    action: "get",
    projectId: "project-1",
    nodeId: "script",
    actorClientType: "agent",
  }) as { textReadToken?: string };

  const textResult = handleCommandForTest(client, {
    action: "text_cas_update",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    actorClientType: "agent",
    observedVersion: read.textReadToken,
    ifMatch: read.textReadToken,
  }) as { updated?: boolean; version?: string };
  assert.equal(textResult.updated, true);
  assert.equal(
    textResult.version,
    textReadToken({ projectId: "project-1", nodeId: "script", content: "after" }),
  );
});

test("local-api host text apply accepts the opaque receipt returned by text pull", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { content: "before" });

  const read = handleCommandForTest(client, {
    action: "get",
    projectId: "project-1",
    nodeId: "script",
    actorClientType: "agent",
  }) as { textReadToken?: string };
  assert.match(read.textReadToken ?? "", /^text-v1:[a-f0-9]+:receipt:/);

  const result = handleCommandForTest(client, {
    action: "text_cas_update",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    actorClientType: "agent",
    observedVersion: read.textReadToken,
    ifMatch: read.textReadToken,
  }) as { updated?: boolean; error?: string };

  assert.equal(result.error, undefined);
  assert.equal(result.updated, true);
  assert.equal(client.readNode("script")?.data.content, "after");
});

test("local-api host projection apply reports immutable nodes after observation CAS", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { content: "before" });
  client.createNode("consumer", "image_gen", { prompt: "use script" });
  client.canvas.insertEdge("script-consumer", "script", "consumer");
  const read = handleCommandForTest(client, {
    action: "get",
    projectId: "project-1",
    nodeId: "script",
    actorClientType: "agent",
  }) as { textReadToken?: string };

  const result = handleCommandForTest(client, {
    action: "text_cas_update",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    actorClientType: "agent",
    observedVersion: read.textReadToken,
    ifMatch: read.textReadToken,
  }) as { code?: string; error?: string };
  assert.equal(result.code, "IMMUTABLE_NODE");
  assert.equal(result.error, "IMMUTABLE_NODE");
  assert.equal(client.readNode("script")?.data.content, "before");
});

test("local-api host direct delete requires fresh agent read proof", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("text-1", "text", { label: "Script", content: "before" });
  const read = handleCommandForTest(client, {
    action: "get",
    nodeId: "text-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const readToken = read.readToken;
  client.updateNode("text-1", { label: "Concurrent change" });

  const stale = handleCommandForTest(client, {
    action: "delete",
    nodeId: "text-1",
    actorClientType: "agent",
    ifMatch: readToken,
  });
  assert.match(JSON.stringify(stale), /Stale canvas delete rejected/);
  assert.deepEqual(
    (stale as { mutation?: unknown }).mutation,
    {
      operation: "canvas_delete",
      entity: { kind: "canvas-node", id: "text-1" },
      expectedReadToken: readToken,
      beforeReadToken: canvasNodeReadToken(client.readNode("text-1")!),
      accepted: false,
      error: "Stale canvas delete rejected (STALE_READ). The target changed after it was read. " +
        "Run `clash canvas get --json` first, then retry the mutation.",
    },
  );
  assert.ok(client.readNode("text-1"));

  const fresh = handleCommandForTest(client, {
    action: "get",
    nodeId: "text-1",
    actorClientType: "agent",
  }) as { readToken: string };
  const deleted = handleCommandForTest(client, {
    action: "delete",
    nodeId: "text-1",
    actorClientType: "agent",
    ifMatch: fresh.readToken,
  });
  assert.equal((deleted as { deleted?: boolean }).deleted, true);
  assert.equal(client.readNode("text-1"), null);
});

test("local-api host batch delete requires a host-issued graph-aware read proof", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("source-1", "text", { label: "Source", content: "source" });
  client.createNode("child-1", "image", { label: "Child", status: "completed" });
  client.canvas.insertEdge("edge-internal", "source-1", "child-1");

  const plan = handleCommandForTest(client, {
    action: "batch_delete_plan",
    nodeIds: ["source-1", "child-1"],
    actorClientType: "agent",
  }) as { nodes: any[]; edges: any[]; readToken: string };
  const baseReadToken = canvasBatchDeleteReadToken({ nodes: plan.nodes, edges: plan.edges });
  assert.match(plan.readToken, /^canvas-batch-delete-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);

  const missing = handleCommandForTest(client, {
    action: "delete_batch",
    nodeIds: ["source-1", "child-1"],
    actorClientType: "agent",
  });
  assert.match(JSON.stringify(missing), /READ_REQUIRED/);
  assert.ok(client.readNode("source-1"));

  const syntheticCasOnly = handleCommandForTest(client, {
    action: "delete_batch",
    nodeIds: ["source-1", "child-1"],
    actorClientType: "agent",
    ifMatch: baseReadToken,
  });
  assert.match(JSON.stringify(syntheticCasOnly), /read receipt/);
  assert.ok(client.readNode("source-1"));

  const accepted = handleCommandForTest(client, {
    action: "delete_batch",
    nodeIds: ["source-1", "child-1"],
    actorClientType: "agent",
    ifMatch: plan.readToken,
  }) as { deleted?: boolean; mutation?: { expectedReadToken?: string; beforeReadToken?: string; resultEntityId?: string } };

  assert.equal(accepted.deleted, true);
  assert.equal(accepted.mutation?.expectedReadToken, plan.readToken);
  assert.equal(accepted.mutation?.beforeReadToken, baseReadToken);
  assert.equal(accepted.mutation?.resultEntityId, "source-1,child-1");
  assert.equal(client.readNode("source-1"), null);
  assert.equal(client.readNode("child-1"), null);
  assert.deepEqual(client.canvas.listEdges(), []);
});

test("local-api host asset copy-on-write replace preserves old media references", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("image-1", "image", { label: "Hero", status: "completed", assetId: "asset-old" });
  client.createNode("consumer-1", "image_gen", { prompt: "use hero" });
  client.canvas.insertEdge("image-1-consumer-1", "image-1", "consumer-1");
  const readToken = (handleCommandForTest(client, {
    action: "get",
    nodeId: "image-1",
    actorClientType: "agent",
  }) as { readToken: string }).readToken;
  const baseReadToken = canvasNodeReadToken(client.readNode("image-1")!);

  const result = handleCommandForTest(client, {
    action: "asset_cow_replace",
    nodeId: "image-1",
    assetId: "asset-new",
    newNodeId: "image-2",
    actorClientType: "agent",
    ifMatch: readToken,
  });

  assert.deepEqual(result, {
    replaced: true,
    copyOnWrite: true,
    sourceNodeId: "image-1",
    newNodeId: "image-2",
    nodeId: "image-2",
    sourceAssetId: "asset-old",
    assetId: "asset-new",
    lineageEdge: { source: "image-1", target: "image-2", type: "copy-on-write" },
    version: (result as { version?: string }).version,
    readToken: (result as { readToken?: string }).readToken,
    mutation: {
      operation: "asset_cow_replace",
      entity: { kind: "media-node", id: "image-1" },
      expectedReadToken: readToken,
      beforeReadToken: baseReadToken,
      afterReadToken: (result as { readToken?: string }).readToken,
      resultEntityId: "image-2",
      accepted: true,
    },
  });
  assert.equal(client.readNode("image-1")?.data.assetId, "asset-old");
  assert.equal(client.readNode("image-2")?.type, "image");
  assert.deepEqual(client.readNode("image-2")?.data, {
    label: "Hero (copy)",
    status: "completed",
    assetId: "asset-new",
    copyOnWrite: true,
    copyOnWriteKind: "media-asset-replacement",
    sourceMediaNodeId: "image-1",
    sourceAssetId: "asset-old",
  });
  assert.equal(client.canvas.listEdges().some((edge) => edge.source === "image-1" && edge.target === "consumer-1"), true);
  assert.equal(client.canvas.listEdges().some((edge) => edge.source === "image-2" && edge.target === "consumer-1"), false);
  assert.equal(client.canvas.listEdges().some((edge) => edge.source === "image-1" && edge.target === "image-2"), true);
});

test("local-api host projects an active Project Asset as an independent Canvas media node", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-asset-projection",
    token: "test",
  });
  assert.equal(createProjectAsset(client.doc, {
    id: "asset-otter",
    kind: "image",
    source: { kind: "owned", resourceId: "resource:asset-otter" },
    lifecycle: { state: "active" },
    metadata: { contentType: "image/png" },
  }).ok, true);

  const result = handleCommandForTest(client, {
    action: "add",
    type: "image",
    label: "Deep-space otter",
    assetId: "asset-otter",
    actorClientType: "agent",
  }) as { node_id?: string; error?: string | null };

  assert.equal(result.error, null);
  assert.ok(result.node_id);
  const node = client.readNode(result.node_id);
  assert.equal(node?.id, result.node_id);
  assert.equal(node?.type, "image");
  assert.deepEqual(node?.data, {
    label: "Deep-space otter",
    assetId: "asset-otter",
    status: "completed",
  });
  assert.equal(node?.parent_id, null);
  assert.deepEqual(client.canvas.listEdges(), []);
});

test("local-api host rejects a Canvas media projection without an active matching Project Asset", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-invalid-asset-projection",
    token: "test",
  });

  const result = handleCommandForTest(client, {
    action: "add",
    type: "image",
    label: "Fabricated asset",
    assetId: "asset-missing",
    actorClientType: "agent",
  }) as { code?: string; error?: string };

  assert.equal(result.code, "PROJECT_ASSET_NOT_FOUND");
  assert.match(result.error ?? "", /asset-missing/);
  assert.deepEqual(client.canvas.listNodes(), []);
});

test("local-api host refuses copy-on-write replacement for a mutable media node", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-mutable-media",
    token: "test",
  });
  client.createNode("image-1", "image", {
    label: "Hero",
    status: "completed",
    assetId: "asset-old",
  });
  const readToken = (handleCommandForTest(client, {
    action: "get",
    nodeId: "image-1",
    actorClientType: "agent",
  }) as { readToken: string }).readToken;

  const result = handleCommandForTest(client, {
    action: "asset_cow_replace",
    nodeId: "image-1",
    assetId: "asset-new",
    newNodeId: "image-2",
    actorClientType: "agent",
    ifMatch: readToken,
  }) as { code?: string; mutation?: { accepted?: boolean } };

  assert.equal(result.code, "NODE_NOT_IMMUTABLE");
  assert.equal(result.mutation?.accepted, false);
  assert.equal(client.readNode("image-2"), null);
  assert.deepEqual(client.canvas.listEdges(), []);
});

test("local-api host asset copy-on-write replace enforces stale agent read proof", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("image-1", "image", { label: "Hero", status: "completed", assetId: "asset-old" });
  const readToken = (handleCommandForTest(client, {
    action: "get",
    nodeId: "image-1",
    actorClientType: "agent",
  }) as { readToken: string }).readToken;
  client.updateNode("image-1", { label: "Concurrent rename" });

  const result = handleCommandForTest(client, {
    action: "asset_cow_replace",
    nodeId: "image-1",
    assetId: "asset-new",
    newNodeId: "image-2",
    actorClientType: "agent",
    ifMatch: readToken,
  });

  assert.match(JSON.stringify(result), /Stale canvas update rejected/);
  assert.equal((result as { mutation?: { accepted?: boolean } }).mutation?.accepted, false);
  assert.equal(client.readNode("image-2"), null);
});

test("local-api host text projection writes require a host-issued read receipt for agent writes", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { label: "Script", content: "before" });
  const expectedContentHash = textHash("before");
  const syntheticReadToken = textReadToken({
    projectId: "project-1",
    nodeId: "script",
    contentHash: expectedContentHash,
  });

  const rejected = handleCommandForTest(client, {
    action: "text_cow_replace",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    observedVersion: syntheticReadToken,
    ifMatch: syntheticReadToken,
    filePath: "/tmp/project/projections/text/script.md",
    actorClientType: "agent",
    newNodeId: "script-v2",
  }) as { error?: string; mutation?: { accepted?: boolean; expectedReadToken?: string } };

  assert.match(rejected.error ?? "", /read receipt/);
  assert.equal(rejected.mutation?.accepted, false);
  assert.equal(rejected.mutation?.expectedReadToken, syntheticReadToken);
  assert.equal(client.readNode("script-v2"), null);

  const read = handleCommandForTest(client, {
    action: "get",
    projectId: "project-1",
    nodeId: "script",
    actorClientType: "agent",
  }) as { textReadToken?: string };
  assert.match(read.textReadToken ?? "", /^text-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);

  const accepted = handleCommandForTest(client, {
    action: "text_cow_replace",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    observedVersion: read.textReadToken,
    ifMatch: read.textReadToken,
    filePath: "/tmp/project/projections/text/script.md",
    actorClientType: "agent",
    newNodeId: "script-v2",
  }) as { copyOnWrite?: boolean; readToken?: string; mutation?: { expectedReadToken?: string; beforeReadToken?: string; afterReadToken?: string } };

  assert.equal(accepted.copyOnWrite, true);
  assert.match(accepted.readToken ?? "", /^text-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/);
  assert.equal(accepted.mutation?.expectedReadToken, read.textReadToken);
  assert.equal(accepted.mutation?.beforeReadToken, syntheticReadToken);
  assert.equal(accepted.mutation?.afterReadToken, accepted.readToken);
  assert.equal(client.readNode("script-v2")?.data.content, "after");
});

test("local-api host text copy-on-write replace preserves materialized references", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { label: "Script", content: "before" });
  client.createNode("action-1", "action-badge", { actionType: "image-gen" });
  client.createNode("output-1", "image", { assetId: "asset-output", status: "completed" });
  client.canvas.insertEdge("script-action-1", "script", "action-1");
  client.canvas.insertEdge("action-1-output-1", "action-1", "output-1");
  const expectedContentHash = textHash("before");
  const baseReadToken = textReadToken({
    projectId: "project-1",
    nodeId: "script",
    contentHash: expectedContentHash,
  });
  const read = handleCommandForTest(client, {
    action: "get",
    projectId: "project-1",
    nodeId: "script",
    actorClientType: "agent",
  }) as { textReadToken?: string };

  const result = handleCommandForTest(client, {
    action: "text_cow_replace",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    label: "Script v2",
    observedVersion: read.textReadToken,
    ifMatch: read.textReadToken,
    cwd: "/tmp/project",
    filePath: "/tmp/project/projections/text/script.md",
    parentRevisionId: "txrev-parent",
    actor: { actorType: "agent", actorUserId: "user-1", actorAgentId: "agent-1" },
    newNodeId: "script-v2",
  }) as {
    copyOnWrite?: boolean;
    sourceNodeId?: string;
    newNodeId?: string;
    sourceContentHash?: string;
    contentHash?: string;
    textRevision?: {
      kind?: string;
      nodeId?: string;
      parentRevisionId?: string;
      contentHash?: string;
      sourceFilePath?: string;
      actor?: unknown;
    };
  };

  assert.equal(result.copyOnWrite, true);
  assert.equal(result.sourceNodeId, "script");
  assert.equal(result.newNodeId, "script-v2");
  assert.equal(result.sourceContentHash, expectedContentHash);
  assert.equal(result.contentHash, textHash("after"));
  assert.equal(result.textRevision?.kind, "clash.text.revision");
  assert.equal(result.textRevision?.nodeId, "script-v2");
  assert.equal(result.textRevision?.parentRevisionId, "txrev-parent");
  assert.equal(result.textRevision?.contentHash, textHash("after"));
  assert.equal(result.textRevision?.sourceFilePath, "projections/text/script.md");
  assert.deepEqual(result.textRevision?.actor, { actorType: "agent", actorUserId: "user-1", actorAgentId: "agent-1" });
  assert.deepEqual((result as { mutation?: unknown }).mutation, {
    operation: "text_cow_replace",
    entity: { kind: "text", id: "script" },
    beforeHash: expectedContentHash,
    expectedReadToken: read.textReadToken,
    beforeReadToken: baseReadToken,
    afterHash: textHash("after"),
    afterReadToken: (result as { mutation?: { afterReadToken?: string } }).mutation?.afterReadToken,
    resultEntityId: "script-v2",
    accepted: true,
  });
  assert.equal(client.readNode("script")?.data.content, "before");
  const replacement = client.readNode("script-v2");
  assert.equal(replacement?.type, "text");
  assert.equal(replacement?.data.label, "Script v2");
  assert.equal(replacement?.data.content, "after");
  assert.equal(replacement?.data.copyOnWrite, true);
  assert.equal(replacement?.data.sourceTextNodeId, "script");
  assert.equal(replacement?.data.sourceContentHash, textHash("before"));
  assert.equal(replacement?.data.contentHash, textHash("after"));
  assert.deepEqual(replacement?.data.textRevision, result.textRevision);
  assert.equal(
    client.canvas.listEdges().some((edge) => edge.source === "script" && edge.target === "action-1"),
    true,
  );
  assert.equal(
    client.canvas.listEdges().some((edge) => edge.source === "script-v2" && edge.target === "action-1"),
    false,
  );
  assert.equal(
    client.canvas.listEdges().some((edge) => edge.source === "script" && edge.target === "script-v2"),
    true,
  );
});

test("local-api host text copy-on-write replace still enforces stale CAS", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-1",
    token: "test",
  });
  client.createNode("script", "text", { label: "Script", content: "changed" });
  const staleReadToken = textReadToken({
    projectId: "project-1",
    nodeId: "script",
    content: "before",
  });

  const result = handleCommandForTest(client, {
    action: "text_cow_replace",
    projectId: "project-1",
    nodeId: "script",
    content: "after",
    observedVersion: staleReadToken,
    ifMatch: staleReadToken,
    actorClientType: "agent",
    newNodeId: "script-v2",
  }) as { error?: string };

  assert.match(result.error ?? "", /Stale text replace rejected/);
  assert.equal((result as { mutation?: { accepted?: boolean } }).mutation?.accepted, false);
  assert.equal(client.readNode("script-v2"), null);
});

test("local-api host add selects a model Card for model_gen", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-model-gen",
    token: "test",
  });

  const added = handleCommandForTest(client, {
    action: "add",
    type: "model_gen",
    label: "Statue",
    prompt: "A marble statue",
    modelId: "tripo-h3.1",
  }) as { node_id?: string; error?: string; node?: { data?: Record<string, unknown> } };

  assert.equal(added.error ?? undefined, undefined);
  assert.equal(added.node?.data?.modelId, "tripo-h3.1");
  assert.equal(added.node?.data?.actionType, "model-gen");
});

test("local-api host add picks the default model Card (not an image Card) for model_gen without a modelId", () => {
  const modelCard = MODEL_CARDS.find((card) => card.id === "tripo-h3.1")!;
  const imageCard = MODEL_CARDS.find((card) => card.kind === "image")!;
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-model-gen-default",
    token: "test",
    modelCards: [imageCard, modelCard],
  } as ConstructorParameters<typeof LoroSyncClient>[0]);

  const added = handleCommandForTest(client, {
    action: "add",
    type: "model_gen",
    label: "Statue",
    prompt: "A marble statue",
  }, {
    effectiveModelCards: [imageCard, modelCard],
  }) as { node?: { data?: Record<string, unknown> } };

  assert.equal(added.node?.data?.modelId, modelCard.id);
});

test("local-api host add rejects model_gen for an unknown modelId", () => {
  const client = new LoroSyncClient({
    serverUrl: "http://localhost:0",
    projectId: "project-model-gen-unknown",
    token: "test",
  });

  const result = handleCommandForTest(client, {
    action: "add",
    type: "model_gen",
    label: "Statue",
    prompt: "A marble statue",
    modelId: "not-a-real-model",
  }) as { code?: string; error?: string };

  assert.equal(result.code, "MODEL_NOT_AVAILABLE");
  assert.match(result.error ?? "", /not-a-real-model/);
});


test("native Canvas updates advance the Generator and atomically retain placement metadata", async () => {
  const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
    document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")) });
  const { pluginId, definitionId, version, schemaHash } = definition;
  const client = new LoroSyncClient({ serverUrl: "http://localhost:0", projectId: "project-1", token: "test" });
  const revision = { id: "initial", generatorId: "draft", definitionRef: { pluginId, definitionId, version, schemaHash }, state: { modelId: "minimax-h3", prompt: "Before", params: {} }, persistentInputRefs: [] };
  assert.equal(createProjectGenerator(client.doc, { head: { id: "draft", headRevisionId: revision.id }, revision }).ok, true);
  client.canvas.createNode("placement", "action-badge", { generatorId: "draft", label: "Before" });
  assert.equal(createProjectGenerator(client.doc, { head: { id: "origin", headRevisionId: "origin-revision" }, revision: { ...revision, id: "origin-revision", generatorId: "origin" } }).ok, true);
  client.canvas.createNode("origin-node", "action-badge", { generatorId: "origin" });
  client.canvas.insertEdge("copy-lineage", "origin-node", "placement", "copy-on-write");
  const observedVersion = canvasNodeReadToken(client.readNode("placement")!);
  const command = { action: "update", nodeId: "placement", content: "After", label: "Edited label", actorClientType: "agent", observedVersion };
  const result = handleCommandForTest(client, command, { canvasGeneratorDefinitions: [definition] }) as { error?: string; updated?: boolean };
  assert.equal(result.error, undefined);
  assert.equal(result.updated, true);
  assert.ok(client.canvas.listEdges().some((edge) => edge.id === "copy-lineage"));
  const head = readProjectGenerator(client.doc, "draft")!;
  assert.notEqual(head.headRevisionId, revision.id);
  assert.equal(readGeneratorRevision(client.doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })?.state.prompt, "After");
  const raw = client.doc.getMap("nodes").get("placement") as { data: Record<string, unknown> };
  assert.equal(raw.data.label, "Edited label");
  assert.equal(raw.data.content, undefined);
  assert.equal(readGeneratorRevision(client.doc, { generatorId: "draft", generatorRevisionId: revision.id })?.state.prompt, "Before");
  const before = client.doc.toJSON();
  assert.ok((handleCommandForTest(client, command, { canvasGeneratorDefinitions: [definition] }) as { error?: string }).error);
  assert.deepEqual(client.doc.toJSON(), before);
  const invalid = handleCommandForTest(client, { ...command, observedVersion: canvasNodeReadToken(client.readNode("placement")!), label: "Must roll back", data: { modelParams: [] } }, { canvasGeneratorDefinitions: [definition] }) as { error?: string };
  assert.ok(invalid.error);
  assert.deepEqual(client.doc.toJSON(), before);
});
