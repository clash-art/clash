import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelInputRefsInPromptOrder, reorderModelMediaInputs, Canvas, createProjectAsset, createProjectDocumentAsset, generatorDefinitionFromExecutablePluginRegistration, readProjectGenerator, readGeneratorRevision } from "@clash/shared-types";
import { createLocalApiApp } from "./app.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-generator-placement-"));
  directories.push(dataDir);
  const doc = new LoroDoc();
  const definition = generatorDefinitionFromExecutablePluginRegistration({
    pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"e".repeat(64)}`,
    document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
  });
  let installed = definition;
  const checkpoints: unknown[] = [];
  const checkpoint = vi.fn(async () => { checkpoints.push(doc.toJSON()); });
  const app = createLocalApiApp({ dataDir, resolveGeneratorDefinition: async () => installed,
    generatorProjectAuthority: {
      inspect: async (_projectId, read) => read(doc),
      mutate: async (_projectId, mutate) => mutate(doc, checkpoint),
    },
  });
  const body = { generatorId: "native-draft", generatorRevisionId: "native-revision", pluginId: definition.pluginId,
    definitionId: definition.definitionId, state: { modelId: "minimax-h3", prompt: "A paper city", params: { resolution: "768P" } },
    persistentInputRefs: [], placement: { canvasId: "main", nodeId: "placement", label: "Scene" } };
  const create = (input: unknown = body) => app.request("/api/v1/projects/project/generators", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return { app, doc, body, create, checkpoint, checkpoints, definition, install: (next: typeof definition) => { installed = next; } };
}

it.each([false, true])("commits native input and Canvas connection together, then removes it (explicit disconnect: %s)", async (explicit) => {
  const { app, doc, body, create, checkpoints } = await fixture();
  expect((await create()).status).toBe(201);
  expect(createProjectAsset(doc, { id: "image", kind: "image", source: { kind: "owned", resourceId: "image-resource" }, lifecycle: { state: "active" }, metadata: {} })).toMatchObject({ ok: true });
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("source", "image", { assetId: "image" });
  checkpoints.length = 0;
  const added = { expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "connected", state: body.state,
    persistentInputRefs: [{ slot: "image", itemKey: "ref", target: { kind: "media", projectAssetId: "image" } }],
    canvasInputConnections: [{ canvasId: "main", sourceNodeId: "source", targetNodeId: body.placement.nodeId, asset: { kind: "media" as const, projectAssetId: "image" } }] };
  const advance = (input: unknown) => app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const response = await advance(added);
  expect(response.ok, await response.clone().text()).toBe(true);
  expect(canvas.listEdges()).toContainEqual(expect.objectContaining({ source: "source", target: body.placement.nodeId }));
  expect(checkpoints).toEqual([doc.toJSON()]);
  const removed = await advance({ expectedHeadRevisionId: "connected", generatorRevisionId: "removed", state: body.state, persistentInputRefs: [],
    ...(explicit ? { canvasInputConnections: added.canvasInputConnections.map((connection) => ({ ...connection, disconnect: true })) } : {}),
  });
  expect(removed.ok, await removed.clone().text()).toBe(true);
  expect(canvas.listEdges()).toEqual([]);
});

it("rolls back the revision when a Canvas connection's source no longer matches the observed Asset", async () => {
  const { app, doc, body, create, checkpoint } = await fixture();
  expect((await create()).status).toBe(201);
  createProjectAsset(doc, { id: "image", kind: "image", source: { kind: "owned", resourceId: "image-resource" }, lifecycle: { state: "active" }, metadata: {} });
  new Canvas(doc, () => {}).createNode("source", "image", { assetId: "another-image" });
  const before = doc.toJSON();
  checkpoint.mockClear();
  const response = await app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "rejected", state: body.state,
    persistentInputRefs: [{ slot: "image", itemKey: "ref", target: { kind: "media", projectAssetId: "image" } }],
    canvasInputConnections: [{ canvasId: "main", sourceNodeId: "source", targetNodeId: body.placement.nodeId, asset: { kind: "media" as const, projectAssetId: "image" } }],
  }) });
  expect(response.status, await response.clone().text()).toBe(409);
  expect(doc.toJSON()).toEqual(before);
  expect(checkpoint).not.toHaveBeenCalled();
});

it.each([false, true])("pins a Document connection through copy/removal and rejects a changed source (stale=%s)", async stale => {
  const { app, doc, body, create } = await fixture();
  expect((await create()).status).toBe(201);
  for (const id of ["script", "replacement"]) expect(createProjectDocumentAsset(doc, {
    id: `${id}:saved`, documentAssetId: id, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
    body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" },
    producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [],
  }).ok).toBe(true);
  const asset = { kind: "document", documentAssetId: "script", revisionId: "script:saved" };
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("script", "text", { documentRevision: stale ? { ...asset, documentAssetId: "replacement", revisionId: "replacement:saved" } : asset });
  const before = doc.toJSON();
  const refs = [{ slot: "text", itemKey: "script", target: asset }];
  const response = await app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "connected", state: body.state, persistentInputRefs: refs,
      canvasInputConnections: [{ canvasId: "main", sourceNodeId: "script", targetNodeId: body.placement.nodeId, asset }],
    }),
  });
  if (stale) {
    expect(response.status, await response.clone().text()).toBe(409);
    expect(doc.toJSON()).toEqual(before);
    return;
  }
  expect(response.ok, await response.clone().text()).toBe(true);
  expect((await response.json()).revision.persistentInputRefs).toEqual(refs);
  expect(canvas.listEdges()).toContainEqual(expect.objectContaining({ source: "script", target: body.placement.nodeId }));
  const copy = await create({ ...body, generatorId: "copy", generatorRevisionId: "copy:saved", persistentInputRefs: refs,
    forkedFrom: { generatorId: body.generatorId, generatorRevisionId: "connected" },
    placement: { ...body.placement, nodeId: "copy", sourceNodeId: body.placement.nodeId },
  });
  expect(copy.status, await copy.clone().text()).toBe(201);
  expect(canvas.listEdges()).toContainEqual(expect.objectContaining({ source: "script", target: "copy" }));
  const removed = await app.request("/api/v1/projects/project/generators/copy/revisions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      expectedHeadRevisionId: "copy:saved", generatorRevisionId: "copy:removed", state: body.state, persistentInputRefs: [],
      canvasInputConnections: [{ canvasId: "main", sourceNodeId: "script", targetNodeId: "copy", asset, disconnect: true }],
    }),
  });
  expect(removed.ok, await removed.clone().text()).toBe(true);
  expect(canvas.listEdges().some(edge => edge.source === "script" && edge.target === "copy")).toBe(false);
  expect(canvas.listEdges()).toContainEqual(expect.objectContaining({ source: "script", target: body.placement.nodeId }));
});

it("copies only retained media connections and rejects a mismatched fork source atomically", async () => {
  const { doc, body, create } = await fixture();
  createProjectAsset(doc, { id: "reference", kind: "image", source: { kind: "owned", resourceId: "reference-resource" }, lifecycle: { state: "active" }, metadata: {} });
  const refs = [{ slot: "image", itemKey: "reference", target: { kind: "media", projectAssetId: "reference" } }];
  expect((await create({ ...body, persistentInputRefs: refs })).status).toBe(201);
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("media", "image", { assetId: "reference" });
  canvas.insertEdge("input", "media", body.placement.nodeId);
  const fork = { ...body, generatorId: "copy", generatorRevisionId: "copy-r1", persistentInputRefs: refs,
    forkedFrom: { generatorId: body.generatorId, generatorRevisionId: body.generatorRevisionId },
    placement: { ...body.placement, nodeId: "copy", sourceNodeId: body.placement.nodeId } };
  const response = await create(fork);
  expect(response.status, await response.clone().text()).toBe(201);
  expect(canvas.listEdges()).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "media", target: "copy" }),
    expect.objectContaining({ source: body.placement.nodeId, target: "copy", type: "copy-on-write" }),
  ]));
  const saved = doc.toJSON();
  expect((await create(fork)).status).toBe(200);
  expect(doc.toJSON()).toEqual(saved);
  const removed = { ...fork, generatorId: "without-input", generatorRevisionId: "without-input-r1", persistentInputRefs: [], placement: { ...fork.placement, nodeId: "without-input" } };
  expect((await create(removed)).status).toBe(201);
  expect(canvas.listEdges().some(edge => edge.source === "media" && edge.target === "without-input")).toBe(false);
  const beforeRejected = doc.toJSON();
  const rejected = await create({ ...fork, generatorId: "rejected", generatorRevisionId: "rejected-r1", placement: { ...fork.placement, nodeId: "rejected", sourceNodeId: "media" } });
  expect(rejected.status).toBe(409);
  expect(doc.toJSON()).toEqual(beforeRejected);
});

it("retains authored reference order through Host normalization and readback", async () => {
  const { app, doc, body, create } = await fixture();
  for (const id of ["first", "second"]) createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id }, lifecycle: { state: "active" }, metadata: {} });
  const refs = [
    { slot: "image", itemKey: "a", target: { kind: "media" as const, projectAssetId: "first" } },
    { slot: "image", itemKey: "b", target: { kind: "media" as const, projectAssetId: "second" } },
  ];
  expect((await create({ ...body, persistentInputRefs: refs })).status).toBe(201);
  const state = reorderModelMediaInputs(body.state, refs, ["second", "first"]);
  const response = await app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "ordered", state, persistentInputRefs: refs,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const read = await app.request(`/api/v1/projects/project/generators/${body.generatorId}`);
  const { revision } = await read.json() as any;
  expect(revision.persistentInputRefs).toEqual(refs);
  expect(modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs)).toEqual([refs[1], refs[0]]);
  expect(revision.state.prompt).toBe(body.state.prompt);
});

describe("native Generator creation with Canvas placement", () => {
  it("places a native draft inside the requested group", async () => {
    const { doc, body, create } = await fixture();
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("group", "group", { label: "Scenes" });
    const response = await create({ ...body, placement: { ...body.placement, parentId: "group" } });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(canvas.readNode(body.placement.nodeId)?.parent_id).toBe("group");
  });

  it("rolls back both facts when the placement parent is missing", async () => {
    const { doc, body, create, checkpoint } = await fixture();
    const before = doc.toJSON();
    const response = await create({ ...body, placement: { ...body.placement, parentId: "missing" } });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(doc.toJSON()).toEqual(before);
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it("forks a placement while keeping the original Generator and downstream references intact", async () => {
    const { doc, body, create } = await fixture();
    expect((await create()).status).toBe(201);
    const canvas = new Canvas(doc, () => {});
    canvas.createLinkedNode({ sourceNodeId: body.placement.nodeId, nodeId: "downstream", nodeType: "text", parentId: null, data: { content: "Keep source reference" } });
    const original = readProjectGenerator(doc, body.generatorId);
    const downstream = canvas.readNode("downstream");
    const input = { ...body, generatorId: "copied-generator", generatorRevisionId: "copied-revision",
      forkedFrom: { generatorId: body.generatorId, generatorRevisionId: body.generatorRevisionId },
      state: { ...body.state, prompt: "A different scene" }, placement: { ...body.placement, nodeId: "copied-placement" } };
    const response = await create(input);
    expect(response.status, await response.clone().text()).toBe(201);
    const accepted = await response.json() as any;
    expect(accepted.revision.forkedFrom).toEqual(input.forkedFrom);
    expect(canvas.readNode(input.placement.nodeId)?.data).toMatchObject({ generatorId: input.generatorId, content: input.state.prompt });
    expect(readProjectGenerator(doc, body.generatorId)).toEqual(original);
    expect(canvas.readNode("downstream")).toEqual(downstream);
  });
  it("creates both facts in one acknowledged mutation and replays without resetting placement metadata", async () => {
    const { doc, body, create, checkpoints } = await fixture();
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(checkpoints).toEqual([doc.toJSON()]);
    const canvas = new Canvas(doc, () => {});
    expect(canvas.readNode(body.placement.nodeId)?.data).toMatchObject({ generatorId: body.generatorId, content: body.state.prompt });
    expect((doc.getMap("nodes").get(body.placement.nodeId) as any).data).toEqual({ generatorId: body.generatorId, label: body.placement.label });
    canvas.updateNode(body.placement.nodeId, { label: "Renamed locally" });
    const savedCheckpoints = structuredClone(checkpoints);
    const replay = await create();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(canvas.readNode(body.placement.nodeId)?.data.label).toBe("Renamed locally");
    expect(checkpoints).toEqual(savedCheckpoints);
  });

  it("rolls back draft creation when the requested placement collides with an unrelated node", async () => {
    const { doc, body, create, checkpoint } = await fixture();
    const canvas = new Canvas(doc, () => {});
    canvas.createNode(body.placement.nodeId, "text", { content: "Keep this node" });
    const before = doc.toJSON();
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(doc.toJSON()).toEqual(before);
    expect(readProjectGenerator(doc, body.generatorId)).toBeNull();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("does not acknowledge a placement rejected by Canvas", async () => {
    const { doc, body, create, checkpoint } = await fixture();
    const before = doc.toJSON();
    const response = await create({ ...body, placement: { ...body.placement, canvasId: "missing-canvas" } });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(doc.toJSON()).toEqual(before);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("rejects invalid draft state without creating a placement", async () => {
    const { doc, body, create, checkpoint } = await fixture();
    const response = await create({ ...body, state: { ...body.state, modelId: "" } });
    expect(response.status, await response.clone().text()).toBe(422);
    expect(readProjectGenerator(doc, body.generatorId)).toBeNull();
    expect(doc.getMap("nodes").get(body.placement.nodeId)).toBeUndefined();
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

it("preserves a Model placement with downstream references when its Generator is edited directly", async () => {
  const { app, create, doc, body, checkpoints } = await fixture();
  expect((await create()).ok).toBe(true);
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("historical", "video", { status: "completed" });
  canvas.insertEdge("historical-lineage", "placement", "historical");
  const before = doc.toJSON();
  const saved = checkpoints.length;
  const response = await app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "overwrite", state: { ...body.state, prompt: "Changed" }, persistentInputRefs: [],
  }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "IMMUTABLE_NODE" });
  expect(doc.toJSON()).toEqual(before);
  expect(checkpoints.length).toBe(saved);
});

it("adopts the installed Model contract on a new edit while retaining old revisions and replay acknowledgements", async () => {
  const { app, create, doc, body, definition, install } = await fixture();
  expect((await create()).ok).toBe(true);
  const updated = { ...definition, schemaHash: `sha256:${"f".repeat(64)}` };
  install(updated);
  const request = { expectedHeadRevisionId: body.generatorRevisionId, generatorRevisionId: "updated-contract", state: { ...body.state, prompt: "New edit" }, persistentInputRefs: [] };
  const advance = () => app.request(`/api/v1/projects/project/generators/${body.generatorId}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const response = await advance();
  expect(response.status, await response.clone().text()).toBe(201);
  const accepted = await response.json();
  expect(accepted).toMatchObject({ revision: { definitionRef: { schemaHash: updated.schemaHash }, parentRevisionId: body.generatorRevisionId } });
  expect(readGeneratorRevision(doc, { generatorId: body.generatorId, generatorRevisionId: body.generatorRevisionId })?.definitionRef.schemaHash).toBe(definition.schemaHash);
  install({ ...definition, schemaHash: `sha256:${"d".repeat(64)}` });
  const replay = await advance();
  expect(replay.ok, await replay.clone().text()).toBe(true);
  expect(await replay.json()).toEqual(accepted);
});
