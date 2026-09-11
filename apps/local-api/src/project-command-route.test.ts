import { FileReplicaStore } from "./loro/file-replica-store.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Canvas,
  createProjectTimeline,
  createProjectGenerator,
  createProjectAsset,
  createProjectDocumentAsset,
  advanceProjectDocumentAssetHead,
  readGeneratorRevision,
  modelInputRefsInPromptOrder,
  generatorDefinitionFromExecutablePluginRegistration,
  readProjectActionRun,
  readProjectGenerator,
  readProjectTimeline,
  ExecutablePluginCardRegistrationSchema,
  type GeneratorInputRef,
  type GeneratorRevision,
  type ExecutablePluginGeneratorRegistration,
} from "@clash/shared-types";
import { createLocalApiApp } from "./app.js";
import type { LocalProjectAssetReplica } from "./local-project-assets.js";
import { LocalLoroRoomHub } from "./sync.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";

async function timelineGeneratorRegistrations(): Promise<
  ExecutablePluginGeneratorRegistration[]
> {
  const document = JSON.parse(
    await readFile(
      join(process.cwd(), "../../plugins/remotion/generators/timeline.json"),
      "utf8",
    ),
  ) as ExecutablePluginGeneratorRegistration["document"];
  return [{
    pluginId: "clash.remotion",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
    document,
  }];
}

async function timelineGeneratorDefinition() {
  return generatorDefinitionFromExecutablePluginRegistration(
    (await timelineGeneratorRegistrations())[0]!,
  );
}

async function directorStageGeneratorRegistrations(): Promise<ExecutablePluginGeneratorRegistration[]> {
  const timeline = (await timelineGeneratorRegistrations())[0]!;
  return [{
    pluginId: "clash.director", version: "1.0.0", schemaHash: `sha256:${"d".repeat(64)}`,
    document: {
      apiVersion: "clash.generator/v1", kind: "generator",
      spec: {
        definitionId: "director-stage", stateSchema: { type: "object" }, editPolicy: "advance-head",
        persistentInputs: [{ slot: "stage:media", accepts: [{ kind: "media", mediaKind: "image" }], cardinality: { minItems: 0, maxItems: null } }],
        actions: [{ id: "capture-frame", executorExportId: "capture-frame", parametersSchema: { type: "object" }, invocationInputs: [], outputs: [{ slot: "capture:output", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } }] }],
        projectionSurface: { id: "clash.director-stage", stateKey: "stage", mediaInputSlot: "stage:media", primaryActionId: "capture-frame" },
      },
    } as typeof timeline.document,
  }];
}

function hubAuthorities(hub: LocalLoroRoomHub) {
  return {
    projectAssetReplica: {
      inspect: <T>(id: string, read: Parameters<LocalProjectAssetReplica["inspect"]>[1]) =>
        hub.inspectProject(id, read) as Promise<T>,
      mutate: (id: string, mutation: Parameters<LocalProjectAssetReplica["mutate"]>[1]) =>
        hub.mutateProject(id, mutation),
    } as LocalProjectAssetReplica,
    generatorProjectAuthority: {
      inspect: <T>(id: string, read: (doc: LoroDoc) => T | Promise<T>) =>
        hub.inspectProject(id, read),
      mutate: <T>(id: string, mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>) =>
        hub.mutateProjectWithCheckpoint(id, mutation),
    },
  };
}

describe("project host command route", () => {
  let dataDir = "";

  it("routes mapped Action Canvas add, edit, references, copy and execute through native revisions", async () => {
    const read = async (file: string) => JSON.parse(await readFile(new URL(`../../../plugins/codex-imagegen/${file}`, import.meta.url), "utf8"));
    const manifest = await read("manifest.json");
    const provenance = { pluginId: manifest.id, version: manifest.version, schemaHash: `sha256:${"a".repeat(64)}` };
    const registration = ExecutablePluginCardRegistrationSchema.parse({ ...provenance, runtime: manifest.runtime, document: await read("cards/codex-imagegen.json") });
    if (registration.document.kind !== "action-card") throw new Error("Expected shipped Card");
    const card = registration.document.spec;
    const generatorRegistration = { ...provenance, document: await read("generators/codex-imagegen.json") };
    const definition = generatorDefinitionFromExecutablePluginRegistration(generatorRegistration);
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    try {
      await hub.mutateProject("action-canvas", (doc) => {
        const canvas = new Canvas(doc, () => {});
        createProjectAsset(doc, { id: "reference", kind: "image", source: { kind: "owned", resourceId: "reference" }, lifecycle: { state: "active" }, metadata: {} });
        canvas.createNode("reference", "image", { assetId: "reference" });
        return { value: undefined, save: true };
      });
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub), listPluginCards: async () => [registration], listPluginGenerators: async () => [generatorRegistration], resolveGeneratorDefinition: async () => definition });
      const command = async (body: object) => {
        const response = await app.request("/api/v1/projects/action-canvas/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json();
        expect(response.status, JSON.stringify(result)).toBe(200);
        expect(result.error, JSON.stringify(result)).toBeFalsy();
        return result;
      };
      const created = await command({ action: "add", type: "image_gen", actionId: card.id, label: "Courtyard", prompt: "A courtyard", params: { aspect_ratio: "16:9" } });
      const nodeId = created.node_id;
      let observed = await command({ action: "get", nodeId });
      expect(observed.node.data.generatorId).toEqual(expect.any(String));
      const generatorId = observed.node.data.generatorId;
      const getRevision = () => hub.inspectProject("action-canvas", (doc) => {
        const head = readProjectGenerator(doc, generatorId)!;
        return readGeneratorRevision(doc, { generatorId, generatorRevisionId: head.headRevisionId })!;
      });
      expect(await createSqliteDurableRunJournal(dataDir).readGeneratorDefinition!((await getRevision()).definitionRef)).toEqual(definition);
      await command({ action: "update", nodeId, data: { content: "An edited courtyard", customActionParams: { aspect_ratio: "1:1" } }, actorClientType: "agent", ifMatch: observed.readToken });
      expect((await getRevision()).state).toEqual({ prompt: "An edited courtyard", aspect_ratio: "1:1" });
      const graph = await command({ action: "edges" });
      await command({ action: "ensure_edge", source: "reference", target: nodeId, actorClientType: "agent", ifMatch: graph.readToken });
      expect((await getRevision()).persistentInputRefs).toEqual([expect.objectContaining({ slot: card.generator!.inputSlots.image, target: { kind: "media", projectAssetId: "reference" } })]);
      const rest = async (path: string, method = "GET", body?: object) => app.request(`/api/v1/projects/action-canvas/canvas${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const beforeDisconnect = await getRevision();
      const edges = await (await rest("/edges")).json();
      const connection = edges.edges.find((edge: any) => edge.source === "reference" && edge.target === nodeId);
      const removed = await rest(`/edges/${connection.id}`, "DELETE", { actorClientType: "agent", ifMatch: connection.readToken });
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect((await getRevision()).state).toEqual(beforeDisconnect.state);
      expect((await getRevision()).persistentInputRefs).toEqual([]);
      const emptyGraph = await (await rest("/edges")).json();
      const reconnected = await rest("/edges/reconnected", "POST", { source: "reference", target: nodeId, actorClientType: "agent", ifMatch: emptyGraph.readToken });
      expect(reconnected.status, await reconnected.clone().text()).toBe(200);
      const editable = await (await rest(`/nodes/${nodeId}`)).json();
      const edited = await rest(`/nodes/${nodeId}`, "PATCH", { data: { content: "REST-edited courtyard" }, actorClientType: "agent", ifMatch: editable.readToken });
      expect(edited.status, await edited.clone().text()).toBe(200);
      expect((await getRevision()).state).toEqual({ prompt: "REST-edited courtyard", aspect_ratio: "1:1" });
      const beforeInvalid = await hub.inspectProject("action-canvas", doc => doc.toJSON());
      const invalid = await rest(`/nodes/${nodeId}`, "PATCH", { data: { customActionParams: [], label: "Must roll back" }, actorClientType: "agent", ifMatch: (await edited.json()).readToken });
      expect(invalid.status).toBe(409);
      expect(await hub.inspectProject("action-canvas", doc => doc.toJSON())).toEqual(beforeInvalid);
      observed = await command({ action: "get", nodeId });
      const before = await getRevision();
      const copied = await command({ action: "copy_node", nodeId, actorClientType: "agent", ifMatch: observed.readToken });
      expect(await getRevision()).toEqual(before);
      const copyId = copied.nodeId;
      const copy = await command({ action: "get", nodeId: copyId });
      expect(copy.node.data.actionCardId).toBe(card.id);
      expect(copy.node.data.generatorId).not.toBe(generatorId);
      expect(copy.node.data.customActionParams).toEqual({ aspect_ratio: "1:1" });
      const executed = await command({ action: "execute", nodeId: copyId, actorClientType: "agent", ifMatch: copy.readToken });
      expect(await hub.inspectProject("action-canvas", (doc) => new Canvas(doc, () => {}).readNode(executed.childNodeId)?.data)).toMatchObject({ generatorRevision: { generatorId: copy.node.data.generatorId, generatorRevisionId: copy.node.data.generatorRevisionId }, generatorActionId: card.generator!.actionId });
    } finally { await hub.close(); }
  });

  it("routes Canvas REST reads and mutations through the live Host even when its checkpoint lags", async () => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    try {
      await hub.mutateProject("live-canvas", (doc) => {
        const canvas = new Canvas(doc, () => {});
        for (const id of ["a", "b", "c"]) canvas.createNode(id, "text", { label: id, content: id });
        return { value: undefined, save: true };
      });
      // An older checkpoint is not a second authority for a connected room.
      const old = new LoroDoc();
      await new FileReplicaStore(join(dataDir, "projects")).saveSnapshotAtomic("live-canvas", old.export({ mode: "snapshot" }));
      old.free();
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub) });
      const base = "/api/v1/projects/live-canvas/canvas";
      const request = (path: string, method = "GET", body?: object) => app.request(base + path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const read = await request("/nodes/c");
      expect(read.status).toBe(200);
      const node = await read.json();
      const patched = await request("/nodes/c", "PATCH", { data: { label: "Live edit" }, actorClientType: "agent", ifMatch: node.readToken });
      expect(patched.status, await patched.clone().text()).toBe(200);
      expect(await hub.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).readNode("c")?.data.label)).toBe("Live edit");
      const edges = await (await request("/edges")).json();
      const added = await request("/edges/ab", "POST", { source: "a", target: "b", actorClientType: "agent", ifMatch: edges.readToken });
      expect(added.status, await added.clone().text()).toBe(200);
      expect(await hub.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).listEdges().some((edge) => edge.id === "ab"))).toBe(true);
      const edgeList = await (await request("/edges")).json();
      const edgeToken = edgeList.edges.find((edge: { id: string }) => edge.id === "ab")?.readToken;
      const rewired = await request("/edges/ab", "PATCH", { target: "c", actorClientType: "agent", ifMatch: edgeToken });
      expect(rewired.status, await rewired.clone().text()).toBe(200);
      const edge = await rewired.json();
      expect(await hub.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).listEdges().find((edge) => edge.id === "ab")?.target)).toBe("c");
      const removed = await request("/edges/ab", "DELETE", { actorClientType: "agent", ifMatch: edge.readToken });
      expect(removed.status, await removed.clone().text()).toBe(200);
      const b = await (await request("/nodes/b")).json();
      expect((await request("/nodes/b", "DELETE", { actorClientType: "agent", ifMatch: b.readToken })).status).toBe(200);
      expect(await hub.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).readNode("b"))).toBeNull();
      const plan = await (await request("/delete-plan", "POST", { nodeIds: ["a", "c"] })).json();
      const deleted = await request("/delete-batch", "POST", { nodeIds: ["a", "c"], actorClientType: "agent", ifMatch: plan.readToken });
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await hub.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).listNodes())).toEqual([]);
    } finally { await hub.close(); }
    const reopened = new LocalLoroRoomHub(dataDir, undefined, null);
    try {
      expect(await reopened.inspectProject("live-canvas", (doc) => new Canvas(doc, () => {}).listNodes())).toEqual([]);
    } finally { await reopened.close(); }
  });

  it("keeps exact Document revisions synchronized across REST edge add, rewire and last-connection removal", async () => {
    const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
      document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")) });
    const { pluginId, definitionId, version, schemaHash } = definition;
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const target = (revisionId: string) => ({ kind: "document" as const, documentAssetId: "script", revisionId });
    try {
      await hub.mutateProject("document-edges", doc => {
        const initial = { id: "old", documentAssetId: "script", documentKind: "text.plain", schemaVersion: 1, mutability: "versioned" as const,
          body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" },
          producer: { kind: "actor" as const, actor: { kind: "user" as const } }, sourceRefs: [] };
        expect(createProjectDocumentAsset(doc, initial).ok).toBe(true);
        expect(advanceProjectDocumentAssetHead(doc, { documentAssetId: "script", expectedHeadRevisionId: "old", revision: { ...initial, id: "new", parentRevisionId: "old" } }).ok).toBe(true);
        expect(createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "draft", definitionRef: { pluginId, definitionId, version, schemaHash },
          state: { modelId: "minimax-h3", prompt: "Rewrite", params: {} }, persistentInputRefs: [],
        } }).ok).toBe(true);
        const canvas = new Canvas(doc, () => {});
        for (const id of ["old", "new", "old-again", "missing"]) canvas.createNode(id, "text", { documentRevision: target(id === "old-again" ? "old" : id) });
        canvas.createNode("target", "action-badge", { generatorId: "draft" });
        return { value: undefined, save: true };
      });
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub), resolveGeneratorDefinition: async () => definition });
      const request = (path: string, method = "GET", body?: object) => app.request(`/api/v1/projects/document-edges/canvas${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const refs = () => hub.inspectProject("document-edges", doc => {
        const head = readProjectGenerator(doc, "draft")!;
        return readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!.persistentInputRefs.map(ref => ref.target);
      });
      for (const [id, source] of [["first", "old"], ["duplicate", "old-again"]]) {
        const added = await request(`/edges/${id}`, "POST", { source, target: "target" });
        expect(added.status, await added.clone().text()).toBe(200);
      }
      expect(await refs()).toEqual([target("old")]);
      const rewired = await request("/edges/first", "PATCH", { source: "new" });
      expect(rewired.ok, await rewired.clone().text()).toBe(true);
      expect(await refs()).toEqual(expect.arrayContaining([target("old"), target("new")]));
      expect((await request("/edges/duplicate", "DELETE")).ok).toBe(true);
      expect(await refs()).toEqual([target("new")]);
      const before = await hub.inspectProject("document-edges", doc => doc.toJSON());
      expect((await request("/edges/first", "PATCH", { source: "missing" })).ok).toBe(false);
      expect(await hub.inspectProject("document-edges", doc => doc.toJSON())).toEqual(before);
      expect((await request("/edges/first", "DELETE")).ok).toBe(true);
      expect(await refs()).toEqual([]);
    } finally { await hub.close(); }
  });

  it.each(["frame-role", "document", "mapped-action"] as const)("retains the authored slot and order when rewiring a same-kind reference (%s)", async kind => {
    const mapped = kind === "mapped-action";
    const directory = mapped ? "codex-imagegen" : "model-generation";
    const read = async (file: string) => JSON.parse(await readFile(new URL(`../../../plugins/${directory}/${file}`, import.meta.url), "utf8"));
    const manifest = await read("manifest.json");
    const provenance = { pluginId: manifest.id, version: manifest.version, schemaHash: `sha256:${"a".repeat(64)}` };
    const definition = generatorDefinitionFromExecutablePluginRegistration({ ...provenance, document: await read(`generators/${mapped ? "codex-imagegen" : "video"}.json`) });
    const registration = mapped ? ExecutablePluginCardRegistrationSchema.parse({ ...provenance, runtime: manifest.runtime, document: await read("cards/codex-imagegen.json") }) : undefined;
    const target = (id: string) => kind === "document" ? { kind: "document" as const, documentAssetId: id, revisionId: "saved" } : { kind: "media" as const, projectAssetId: id };
    const inputRefs: GeneratorInputRef[] = ["opening", "closing"].map((id, index) => ({
      ...(kind === "frame-role" ? { slot: index === 0 ? "startFrame" : "endFrame" } : { slot: kind === "document" ? "text" : "image", itemKey: String(index).padStart(10, "0") }), target: target(id),
    }));
    const state: GeneratorRevision["state"] = mapped ? { prompt: "Paint", aspect_ratio: "1:1" } : { modelId: kind === "frame-role" ? "minimax-h3-startend" : "minimax-h3", prompt: "Animate", params: {},
      contentParts: [{ type: "text", text: "Animate" }, ...inputRefs.map(ref => ({ type: "input", slot: ref.slot, ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }), label: "" }))] };
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    try {
      await hub.mutateProject("reference-rewire", doc => {
        const canvas = new Canvas(doc, () => {});
        for (const id of ["opening", "closing"]) {
          if (kind === "document") {
            expect(createProjectDocumentAsset(doc, { id: "saved", documentAssetId: id, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
              body: { digest: `sha256:${"b".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] }).ok).toBe(true);
            canvas.createNode(id, "text", { documentRevision: target(id) });
          } else {
            expect(createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id }, lifecycle: { state: "active" }, metadata: {} }).ok).toBe(true);
            canvas.createNode(id, "image", { assetId: id });
          }
        }
        expect(createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "draft", definitionRef: { ...provenance, definitionId: definition.definitionId }, state, persistentInputRefs: inputRefs,
        } }).ok).toBe(true);
        canvas.createNode("target", "action-badge", { generatorId: "draft", ...(registration?.document.kind === "action-card" ? { actionCardId: registration.document.spec.id } : {}) });
        for (const id of ["opening", "closing"]) canvas.insertEdge(id, id, "target");
        return { value: undefined, save: true };
      });
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub), resolveGeneratorDefinition: async () => definition, listPluginCards: async () => registration ? [registration] : [] });
      const route = "/api/v1/projects/reference-rewire/canvas/edges";
      const graph = await (await app.request(route)).json();
      const response = await app.request(`${route}/opening`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "closing", actorClientType: "agent", ifMatch: graph.edges.find((edge: { id: string }) => edge.id === "opening").readToken }) });
      expect(response.status, await response.clone().text()).toBe(200);
      await hub.inspectProject("reference-rewire", doc => {
        const head = readProjectGenerator(doc, "draft")!;
        const revision = readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!;
        expect(revision.state).toEqual(state);
        expect(revision.persistentInputRefs).toEqual(expect.arrayContaining(inputRefs.map(ref => ({ ...ref, target: target("closing") }))));
        expect(readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: "initial" })?.persistentInputRefs).toEqual(expect.arrayContaining(inputRefs));
      });
    } finally { await hub.close(); }
  });

  it.each([
    { source: "start", replacement: "replacement" },
    { source: "middle", replacement: "replacement" },
    { source: "end", replacement: "replacement" },
    { source: "middle", replacement: "start" },
  ])("rewires a keyframe in place without changing its timing or input identity ($source → $replacement)", async ({ source, replacement }) => {
    const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
      document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")) });
    const { pluginId, definitionId, version, schemaHash } = definition;
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const inputRefs = ["start", "middle", "end"].map(itemKey => ({ slot: "image", itemKey, target: { kind: "media" as const, projectAssetId: itemKey } }));
    const state = { modelId: "flux-3-video-keyframes", prompt: "Animate", params: { duration: 5, keyframe_frame_indices: "[0,24,120]", keyframe_timing_customized: true },
      contentParts: [{ type: "text", text: "Animate" }, ...inputRefs.map(ref => ({ type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "" }))] };
    try {
      await hub.mutateProject("keyframe-rewire", doc => {
        const canvas = new Canvas(doc, () => {});
        for (const id of [...inputRefs.map(ref => ref.itemKey), "replacement"]) {
          expect(createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id }, lifecycle: { state: "active" }, metadata: {} }).ok).toBe(true);
          canvas.createNode(id, "image", { assetId: id });
        }
        expect(createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "draft", definitionRef: { pluginId, definitionId, version, schemaHash }, state, persistentInputRefs: inputRefs,
        } }).ok).toBe(true);
        canvas.createNode("target", "action-badge", { generatorId: "draft" });
        for (const ref of inputRefs) canvas.insertEdge(ref.itemKey, ref.itemKey, "target");
        return { value: undefined, save: true };
      });
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub), resolveGeneratorDefinition: async () => definition });
      const route = `/api/v1/projects/keyframe-rewire/canvas/edges/${source}`;
      const graph = await (await app.request("/api/v1/projects/keyframe-rewire/canvas/edges")).json();
      const observed = graph.edges.find((edge: { id: string }) => edge.id === source);
      const response = await app.request(route, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: replacement, actorClientType: "agent", ifMatch: observed.readToken }) });
      expect(response.status, await response.clone().text()).toBe(200);
      const expectedRefs = inputRefs.map(ref => ref.itemKey === source ? { ...ref, target: { kind: "media", projectAssetId: replacement } } : ref);
      const revision = await hub.inspectProject("keyframe-rewire", doc => {
        const head = readProjectGenerator(doc, "draft")!;
        const revised = readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!;
        expect(revised.state).toEqual(state);
        expect(modelInputRefsInPromptOrder(revised.state, revised.persistentInputRefs)).toEqual(expectedRefs);
        expect(readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: "initial" })?.state).toEqual(state);
        expect(new Canvas(doc, () => {}).listEdges().find(edge => edge.id === source)).toMatchObject({ source: replacement, target: "target" });
        return revised;
      });
      await hub.close();
      const reopened = new LocalLoroRoomHub(dataDir, undefined, null);
      try {
        expect(await reopened.inspectProject("keyframe-rewire", doc => readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: revision.id }))).toEqual(revision);
      } finally { await reopened.close(); }
    } finally { await hub.close(); }
  });

  it.each([
    { orderedPrompt: false, modelId: "minimax-h3" },
    { orderedPrompt: true, modelId: "minimax-h3" },
    { orderedPrompt: true, modelId: "flux-3-video-keyframes" },
  ])("commits REST media edges and native inputs together across add, rewire, delete and rejection ($modelId, ordered: $orderedPrompt)", async ({ orderedPrompt, modelId }) => {
    const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
      document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")) });
    const { pluginId, definitionId, version, schemaHash } = definition;
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    try {
      await hub.mutateProject("native-edges", (doc) => {
        for (const id of ["a", "b", "unplaced"]) createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id + "-resource" }, lifecycle: { state: "active" }, metadata: {} });
        const created = createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "draft", definitionRef: { pluginId, definitionId, version, schemaHash },
          state: { modelId, prompt: "Original", params: {}, ...(orderedPrompt ? { contentParts: [{ type: "text", text: "Original" }, { type: "input", slot: "image", itemKey: "hidden", label: "" }] } : {}) },
          persistentInputRefs: [{ slot: "image", itemKey: "hidden", target: { kind: "media", projectAssetId: "unplaced" } }],
        } });
        if (!created.ok) throw new Error(created.error.message);
        const canvas = new Canvas(doc, () => {});
        for (const id of ["a", "b", "missing"]) canvas.createNode(id, "image", { assetId: id });
        canvas.createNode("target", "action-badge", { generatorId: "draft" });
        canvas.createNode("b-again", "image", { assetId: "b" });
        return { value: undefined, save: true };
      });
      const app = createLocalApiApp({ dataDir, ...hubAuthorities(hub), resolveGeneratorDefinition: async () => definition });
      const base = "/api/v1/projects/native-edges/canvas";
      const request = (path: string, method = "GET", body?: object) => app.request(base + path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const refs = () => hub.inspectProject("native-edges", (doc) => {
        const head = readProjectGenerator(doc, "draft")!;
        return readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!.persistentInputRefs.map((ref) => "kind" in ref.target && ref.target.kind === "media" ? ref.target.projectAssetId : "other").sort();
      });
      const observed = await (await request("/nodes/target")).json();
      const edited = await request("/nodes/target", "PATCH", { data: { content: "Original", modelParams: { duration: 5 }, label: "REST draft edit" }, actorClientType: "agent", ifMatch: observed.readToken });
      expect(edited.status, await edited.clone().text()).toBe(200);
      expect(await hub.inspectProject("native-edges", (doc) => new Canvas(doc, () => {}).readNode("target")?.data)).toMatchObject({ modelParams: { duration: 5 }, label: "REST draft edit" });
      const editBefore = await hub.inspectProject("native-edges", (doc) => doc.toJSON());
      const invalidEdit = await request("/nodes/target", "PATCH", { data: { modelParams: [], label: "Must roll back" }, actorClientType: "agent", ifMatch: (await edited.json()).readToken });
      expect(invalidEdit.status).toBe(409);
      expect(await hub.inspectProject("native-edges", (doc) => doc.toJSON())).toEqual(editBefore);
      let graph = await (await request("/edges")).json();
      const added = await request("/edges/reference", "POST", { source: "a", target: "target", actorClientType: "agent", ifMatch: graph.readToken });
      expect(added.status, await added.clone().text()).toBe(200);
      expect(await refs()).toEqual(["a", "unplaced"]);
      expect(await hub.inspectProject("native-edges", (doc) => {
        const head = readProjectGenerator(doc, "draft")!;
        const revision = readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!;
        if (modelId === "flux-3-video-keyframes") expect(revision.state.params).toMatchObject({ keyframe_frame_indices: "[0,120]" });
        return modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs).map(ref => ref.target);
      })).toEqual(["unplaced", "a"].map(projectAssetId => ({ kind: "media", projectAssetId })));
      graph = await (await request("/edges")).json();
      const rewired = await request("/edges/reference", "PATCH", { source: "b", actorClientType: "agent", ifMatch: graph.edges[0].readToken });
      expect(rewired.status, await rewired.clone().text()).toBe(200);
      expect(await refs()).toEqual(["b", "unplaced"]);
      const acceptedEdge = await rewired.json();
      const beforeBadRewire = await hub.inspectProject("native-edges", (doc) => doc.toJSON());
      const badRewire = await request("/edges/reference", "PATCH", { source: "missing", actorClientType: "agent", ifMatch: acceptedEdge.readToken });
      expect(badRewire.status).toBe(409);
      expect(await hub.inspectProject("native-edges", (doc) => doc.toJSON())).toEqual(beforeBadRewire);
      graph = await (await request("/edges")).json();
      expect((await request("/edges/another", "POST", { source: "b-again", target: "target", actorClientType: "agent", ifMatch: graph.readToken })).status).toBe(200);
      const removed = await request("/edges/reference", "DELETE", { actorClientType: "agent", ifMatch: acceptedEdge.readToken });
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect(await refs()).toEqual(["b", "unplaced"]);
      graph = await (await request("/edges")).json();
      expect((await request("/edges/another", "DELETE", { actorClientType: "agent", ifMatch: graph.edges.find((edge: { id: string }) => edge.id === "another").readToken })).status).toBe(200);
      expect(await refs()).toEqual(["unplaced"]);
      await hub.inspectProject("native-edges", (doc) => {
        const head = readProjectGenerator(doc, "draft")!;
        const revision = readGeneratorRevision(doc, { generatorId: "draft", generatorRevisionId: head.headRevisionId })!;
        expect(revision.state.prompt).toBe("Original");
        if (modelId === "flux-3-video-keyframes") expect(revision.state.params).toMatchObject({ keyframe_frame_indices: "[0]" });
        expect(revision.state.contentParts).toEqual([{ type: "text", text: "Original" }, { type: "input", slot: "image", itemKey: "hidden", label: "" }]);
      });
      const before = await hub.inspectProject("native-edges", (doc) => doc.toJSON());
      graph = await (await request("/edges")).json();
      const rejected = await request("/edges/rejected", "POST", { source: "missing", target: "target", actorClientType: "agent", ifMatch: graph.readToken });
      expect(rejected.status).toBe(409);
      expect(await hub.inspectProject("native-edges", (doc) => doc.toJSON())).toEqual(before);
      const ensure = () => app.request("/api/v1/projects/native-edges/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ensure_edge", source: "a", target: "target" }) });
      expect((await ensure()).ok).toBe(true);
      expect(await refs()).toEqual(["a", "unplaced"]);
      const afterEnsure = await hub.inspectProject("native-edges", (doc) => readProjectGenerator(doc, "draft")!.headRevisionId);
      expect(await (await ensure()).json()).toMatchObject({ existed: true });
      expect(await hub.inspectProject("native-edges", (doc) => readProjectGenerator(doc, "draft")!.headRevisionId)).toBe(afterEnsure);
      const beforeBadEnsure = await hub.inspectProject("native-edges", (doc) => doc.toJSON());
      const badEnsure = await app.request("/api/v1/projects/native-edges/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ensure_edge", source: "missing", target: "target" }) });
      expect(await badEnsure.json()).toHaveProperty("error");
      expect(await hub.inspectProject("native-edges", (doc) => doc.toJSON())).toEqual(beforeBadEnsure);
    } finally { await hub.close(); }
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-project-host-route-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([{ kind: "video", modelId: "minimax-h3" }, { kind: "text", modelId: "minimax-m3" }])("returns a native $kind Model draft directly from Canvas add, without a follow-up migration read", async ({ kind, modelId }) => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const registrations = async () => [{ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`,
      document: JSON.parse(await readFile(new URL(`../../../plugins/model-generation/generators/${kind}.json`, import.meta.url), "utf8")),
    }];
    const app = createLocalApiApp({ dataDir, listPluginGenerators: registrations, ...hubAuthorities(hub) });
    const response = await app.request("/api/v1/projects/new-model/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", type: `${kind}_gen`, label: "New scene", prompt: "A quiet courtyard", modelId }) });
    expect(response.ok, await response.clone().text()).toBe(true);
    const result = await response.json() as { node_id: string; node: { data: Record<string, unknown> }; proposal: unknown };
    expect(result.node.data).toMatchObject({ generatorId: expect.any(String), generatorRevisionId: expect.any(String), content: "A quiet courtyard" });
    expect(result.proposal).toBeNull();
    await hub.inspectProject("new-model", (doc) => {
      const raw = doc.getMap("nodes").get(result.node_id) as { data: Record<string, unknown> };
      expect(raw.data.generatorId).toBe(result.node.data.generatorId);
      expect(raw.data).not.toHaveProperty("content");
      expect(readProjectGenerator(doc, raw.data.generatorId as string)?.headRevisionId).toBe(result.node.data.generatorRevisionId);
    });
    const before = await hub.inspectProject("new-model", (doc) => doc.toJSON());
    const failed = await app.request("/api/v1/projects/new-model/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", type: "image_gen", label: "Missing Definition", prompt: "A scene", modelId: "seedream-5-pro" }) });
    expect(failed.status).toBe(409);
    expect(await hub.inspectProject("new-model", (doc) => doc.toJSON())).toEqual(before);
    await hub.close();
  });

  it("migrates legacy Model placements on a normal Canvas read and persists the native identity", async () => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    await hub.mutateProject("legacy-model", (doc) => {
      new Canvas(doc, () => {}).createNode("draft", "action-badge", { actionType: "video-gen", modelId: "minimax-h3", content: "Draft scene", modelParams: { resolution: "768P" } });
      return { value: undefined, save: true };
    });
    const registrations = async () => [{ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`,
      document: JSON.parse(await readFile(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
    }];
    const app = createLocalApiApp({ dataDir, listPluginGenerators: registrations, ...hubAuthorities(hub) });
    const response = await app.request("/api/v1/projects/legacy-model/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "get", nodeId: "draft" }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const identity = await hub.inspectProject("legacy-model", (doc) => {
      const data = new Canvas(doc, () => {}).readNode("draft")!.data;
      expect(data).toMatchObject({ content: "Draft scene", generatorId: expect.any(String), generatorRevisionId: expect.any(String) });
      expect(readProjectGenerator(doc, data.generatorId as string)?.headRevisionId).toBe(data.generatorRevisionId);
      return data.generatorId;
    });
    await hub.close();
    const reopened = new LocalLoroRoomHub(dataDir, undefined, null);
    expect(await reopened.inspectProject("legacy-model", (doc) => new Canvas(doc, () => {}).readNode("draft")!.data.generatorId)).toBe(identity);
    await reopened.close();
  });

  it("imports a legacy Timeline through the real Host route and deletes the native result", async () => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    let legacyRevision = "";
    await hub.mutateProject("legacy-project", (doc) => {
      const created = createProjectTimeline(doc, { id: "legacy-cut", name: "Legacy cut", state: { tracks: [] } });
      if (!created.ok) throw new Error(created.error);
      legacyRevision = created.timeline.revisionId;
      return { value: undefined, save: true };
    });
    let app = createLocalApiApp({ dataDir, listPluginGenerators: timelineGeneratorRegistrations, ...hubAuthorities(hub) });
    const request = (body: object) => app.request("/api/v1/projects/legacy-project/host-command", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const listed = await request({ action: "list_timelines" });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { timelines: Array<{ id: string; revisionId: string }>; versions: Record<string, string> };
    expect(body.timelines).toMatchObject([{ id: "legacy-cut", revisionId: legacyRevision }]);
    await hub.inspectProject("legacy-project", (doc) => {
      expect(readProjectTimeline(doc, "legacy-cut")).toBeNull();
      expect(readProjectGenerator(doc, "legacy-cut")?.headRevisionId).toBe(legacyRevision);
    });
    await hub.close();
    const reopened = new LocalLoroRoomHub(dataDir, undefined, null);
    app = createLocalApiApp({ dataDir, listPluginGenerators: timelineGeneratorRegistrations, ...hubAuthorities(reopened) });
    const recovered = await request({ action: "list_timelines" });
    expect(await recovered.json()).toMatchObject({ timelines: [{ id: "legacy-cut", revisionId: legacyRevision }] });
    const deleted = await request({ action: "delete_timeline", timelineId: "legacy-cut", actorClientType: "browser", ifMatch: body.versions["legacy-cut"] });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: true, timelineId: "legacy-cut" });
    await reopened.inspectProject("legacy-project", (doc) => expect(readProjectGenerator(doc, "legacy-cut")).toBeNull());
    await reopened.close();
  });

  it("returns a migration conflict without retiring valid legacy data when another record is broken", async () => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    await hub.mutateProject("broken-project", (doc) => {
      const created = createProjectTimeline(doc, { id: "good-cut", name: "Good cut", state: { tracks: [] } });
      if (!created.ok) throw new Error(created.error);
      doc.getMap("timelines").set("broken-cut", { state: { tracks: "invalid" } });
      return { value: undefined, save: true };
    });
    const app = createLocalApiApp({ dataDir, listPluginGenerators: timelineGeneratorRegistrations, ...hubAuthorities(hub) });
    const response = await app.request("/api/v1/projects/broken-project/host-command", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list_timelines" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ generatorId: "broken-cut", error: expect.any(String) });
    await hub.inspectProject("broken-project", (doc) => {
      expect(readProjectTimeline(doc, "good-cut")).not.toBeNull();
      expect(doc.getMap("timelines").get("broken-cut")).toBeTruthy();
      expect(readProjectGenerator(doc, "good-cut")).toBeNull();
    });
    await hub.close();
  });

  it("returns structured validation errors", async () => {
    const response = await createLocalApiApp({ dataDir }).request(
      "/api/v1/projects/p1/host-command",
      { method: "POST", body: JSON.stringify({ action: "get" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid project host command",
      details: expect.arrayContaining([
        expect.objectContaining({ path: ["nodeId"] }),
      ]),
    });
  });

  it("serializes mutations into the local-api replica and serves later reads", async () => {
    const app = createLocalApiApp({ dataDir, userId: "trusted-local-user" });
    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      body: JSON.stringify({
        action: "add",
        canvasId: "main",
        type: "text",
        label: "Opening",
        content: "Hello",
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      node_id?: string;
      node?: { data?: Record<string, unknown> };
    };
    expect(createdBody.node_id).toBeTruthy();
    expect(createdBody.node?.data).toMatchObject({
      actorType: "user",
      actorUserId: "trusted-local-user",
    });

    const listed = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      body: JSON.stringify({ action: "list", canvasId: "main" }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({ id: createdBody.node_id, type: "text" }),
      ],
    });
  });

  it("submits a migrated Timeline as a pending native Generator ActionRun", async () => {
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const definition = await timelineGeneratorDefinition();
    const wokenProjects: string[] = [];
    const app = createLocalApiApp({
      dataDir,
      userId: "trusted-local-user",
      listPluginGenerators: timelineGeneratorRegistrations,
      resolveGeneratorDefinition: async () => definition,
      ...hubAuthorities(hub),
      processProjectWork: async (projectId) => { wokenProjects.push(projectId); },
    });
    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create_timeline",
        timelineId: "cut-1",
        name: "Cut",
        state: {
          durationInFrames: 24,
          tracks: [
            {
              id: "titles",
              items: [
                {
                  id: "title-1",
                  type: "text",
                  from: 0,
                  durationInFrames: 24,
                },
              ],
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      timeline: { id: "cut-1" },
    });

    const requested = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request_timeline_render",
        timelineId: "cut-1",
      }),
    });

    expect(requested.status).toBe(200);
    const submission = await requested.json() as {
      submitted: boolean;
      actionRunId: string;
      renderNodeId: string;
      sourceTimelineRevisionId: string;
      run: { status: string };
    };
    expect(submission).toMatchObject({ submitted: true, run: { status: "running" } });
    expect(submission.renderNodeId).toBe(submission.actionRunId);
    const facts = await hub.inspectProject("p1", (doc) => ({
      run: readProjectActionRun(doc, submission.actionRunId),
      legacyTimeline: readProjectTimeline(doc, "cut-1"),
      renderNode: new Canvas(doc, () => {}).readNode(submission.actionRunId),
    }));
    expect(facts.run).toMatchObject({
      actionRunId: submission.actionRunId,
      actionId: definition.projectionSurface!.primaryActionId,
      generatorRevision: {
        generatorId: "cut-1",
        generatorRevisionId: submission.sourceTimelineRevisionId,
      },
      status: "running",
    });
    expect(facts.legacyTimeline).toBeNull();
    expect(facts.renderNode).toBeNull();
    expect(wokenProjects).toEqual(["p1"]);
    await hub.close();
  });

  it("keeps an applied Timeline in the live Project replica across a Project Asset import", async () => {
    const projectId = "live-timeline-project";
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    await hub.room(projectId);
    const projectAssetReplica: LocalProjectAssetReplica = {
      inspect: (id, read) => hub.inspectProject(id, read),
      mutate: (id, mutation) => hub.mutateProject(id, mutation),
    };
    const definition = await timelineGeneratorDefinition();
    const app = createLocalApiApp({
      dataDir,
      clashRoot: dataDir,
      userId: "trusted-local-user",
      listPluginGenerators: timelineGeneratorRegistrations,
      resolveGeneratorDefinition: async () => definition,
      ...hubAuthorities(hub),
      inspectAssetResource: async ({ resource }) => ({
        width: 1,
        height: 1,
        rotationDegrees: 0,
        ...(resource.contentType ? { contentType: resource.contentType } : {}),
      }),
    });
    const command = (body: unknown) =>
      app.request(`/api/v1/projects/${projectId}/host-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    try {
      const created = await command({
        action: "create_timeline",
        timelineId: "cut-live",
        name: "Live cut",
        state: { durationInFrames: 24, tracks: [] },
      });
      expect(created.status).toBe(200);

      const applied = await command({
        action: "update_timeline_state",
        timelineId: "cut-live",
        state: {
          durationInFrames: 48,
          tracks: [
            {
              id: "titles",
              items: [
                {
                  id: "title-live",
                  type: "text",
                  from: 0,
                  durationInFrames: 48,
                  text: "Replica authority",
                },
              ],
            },
          ],
        },
      });
      expect(applied.status).toBe(200);

      const form = new FormData();
      form.set(
        "file",
        new File([new Uint8Array([1, 2, 3])], "shot.png", {
          type: "image/png",
        }),
      );
      form.set("kind", "image");
      form.set("projectAssetId", "director:shot-live");
      const imported = await app.request(
        `http://127.0.0.1/api/v1/projects/${projectId}/assets/import-file`,
        { method: "POST", body: form },
      );
      expect(imported.status, await imported.clone().text()).toBe(201);

      const liveGenerator = await hub.inspectProject(projectId, (doc) =>
        readProjectGenerator(doc, "cut-live"),
      );
      expect(liveGenerator).not.toBeNull();
      const legacyTimeline = await hub.inspectProject(projectId, (doc) =>
        readProjectTimeline(doc, "cut-live"),
      );
      expect(legacyTimeline).toBeNull();

      const listed = await command({ action: "list_timelines" });
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({
        timelines: [expect.objectContaining({ id: "cut-live" })],
      });

      const requested = await command({
        action: "request_timeline_render",
        timelineId: "cut-live",
      });
      expect(requested.status).toBe(200);
      const requestedBody = await requested.json() as { submitted: boolean; actionRunId: string; run: { status: string } };
      expect(requestedBody).toMatchObject({ submitted: true, run: { status: "running" } });
      const run = await hub.inspectProject(projectId, (doc) =>
        readProjectActionRun(doc, requestedBody.actionRunId),
      );
      expect(run).toMatchObject({ status: "running" });
    } finally {
      await hub.close();
    }
  });

  it("wakes Project work once after a native Timeline render submission", async () => {
    const wokenProjects: string[] = [];
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const definition = await timelineGeneratorDefinition();
    const app = createLocalApiApp({
      dataDir,
      userId: "trusted-local-user",
      processProjectWork: async (projectId) => {
        wokenProjects.push(projectId);
      },
      listPluginGenerators: timelineGeneratorRegistrations,
      resolveGeneratorDefinition: async () => definition,
      ...hubAuthorities(hub),
    });
    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create_timeline",
        timelineId: "cut-to-render",
        name: "Cut to render",
        state: {
          durationInFrames: 24,
          tracks: [
            {
              id: "titles",
              items: [
                {
                  id: "title-1",
                  type: "text",
                  from: 0,
                  durationInFrames: 24,
                },
              ],
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(200);
    expect(wokenProjects).toEqual([]);

    const requested = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request_timeline_render",
        timelineId: "cut-to-render",
      }),
    });

    expect(requested.status).toBe(200);
    await expect(requested.json()).resolves.toMatchObject({
      submitted: true,
      run: { status: "running" },
    });
    expect(wokenProjects).toEqual(["p1"]);
    await hub.close();
  });

  it("does not wake Project work for an invalid Timeline render request", async () => {
    const wokenProjects: string[] = [];
    const app = createLocalApiApp({
      dataDir,
      userId: "trusted-local-user",
      processProjectWork: async (projectId) => {
        wokenProjects.push(projectId);
      },
    });

    const response = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request_timeline_render" }),
    });

    expect(response.status).toBe(400);
    expect(wokenProjects).toEqual([]);
  });

  it("does not wake Project work when a Timeline render request is rejected", async () => {
    const wokenProjects: string[] = [];
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const definition = await timelineGeneratorDefinition();
    const app = createLocalApiApp({
      dataDir,
      userId: "trusted-local-user",
      processProjectWork: async (projectId) => {
        wokenProjects.push(projectId);
      },
      listPluginGenerators: timelineGeneratorRegistrations,
      resolveGeneratorDefinition: async () => definition,
      ...hubAuthorities(hub),
    });

    const response = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request_timeline_render",
        timelineId: "missing-cut",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: "PROJECT_GENERATOR_NOT_FOUND",
      error: "Project Generator missing-cut not found.",
    });
    expect(wokenProjects).toEqual([]);
    await hub.close();
  });

  it("returns structured errors for missing and ambiguous Timeline projection claimants", async () => {
    const request = (app: ReturnType<typeof createLocalApiApp>) =>
      app.request("/api/v1/projects/p1/host-command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list_timelines" }),
      });

    const missing = await request(
      createLocalApiApp({ dataDir, listPluginGenerators: async () => [] }),
    );
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({
      code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED",
    });

    const registration = (await timelineGeneratorRegistrations())[0]!;
    const ambiguous = await request(
      createLocalApiApp({
        dataDir,
        listPluginGenerators: async () => [
          registration,
          { ...registration, pluginId: "clash.other-remotion" },
        ],
      }),
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      code: "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS",
    });
  });

  it("resolves zero, ambiguous, and unique executable Director Stage claimants", async () => {
    const request = (app: ReturnType<typeof createLocalApiApp>, action = "list_director_stages") =>
      app.request("/api/v1/projects/p1/host-command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const missing = await request(createLocalApiApp({ dataDir, listPluginGenerators: async () => [] }));
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED" });
    const registration = (await directorStageGeneratorRegistrations())[0]!;
    const ambiguous = await request(createLocalApiApp({ dataDir, listPluginGenerators: async () => [registration, { ...registration, pluginId: "clash.other-director" }] }));
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({ code: "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS" });
    const successful = await request(createLocalApiApp({ dataDir, listPluginGenerators: directorStageGeneratorRegistrations }));
    expect(successful.status).toBe(200);
    await expect(successful.json()).resolves.toEqual({ stages: [], versions: {} });
  });

  it("rejects raw data and client-supplied user identity at the route schema", async () => {
    const response = await createLocalApiApp({ dataDir }).request(
      "/api/v1/projects/p1/host-command",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          type: "text",
          label: "Spoofed",
          data: { actorUserId: "other-user" },
          actorUserId: "other-user",
        }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid project host command",
      details: expect.arrayContaining([
        expect.objectContaining({ code: "unrecognized_keys" }),
      ]),
    });
  });

  it("accepts a model_gen add command and reaches the host handler like sibling *_gen types", async () => {
    const app = createLocalApiApp({ dataDir, userId: "trusted-local-user" });
    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add",
        canvasId: "main",
        type: "model_gen",
        label: "Statue",
        prompt: "Create a 3D statue",
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      node_id?: string;
      node?: { type?: string; data?: Record<string, unknown> };
    };
    expect(createdBody.node_id).toBeTruthy();
    expect(createdBody.node?.data).toMatchObject({
      actionType: "model-gen",
      modelId: expect.any(String),
    });
  });

  it("executes a model_gen action node through the real host-command route instead of rejecting it as 'not a generation node'", async () => {
    // Regression test for `Canvas.executeGeneration`'s built-in-actionType
    // gate: it used to enumerate only image/video/audio/text-gen, so any
    // model_gen action-badge (Tripo, Meshy, ...) failed execution before
    // ever reaching the provider with "Node ... is not a generation node".
    // Exercises the real `/host-command` HTTP route (add then execute) —
    // Canvas.execute is not mocked.
    const app = createLocalApiApp({ dataDir, userId: "trusted-local-user" });
    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add",
        canvasId: "main",
        type: "model_gen",
        label: "Statue",
        prompt: "Create a 3D statue",
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      node_id?: string;
    };
    const nodeId = createdBody.node_id;
    expect(nodeId).toBeTruthy();

    const executed = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        canvasId: "main",
        nodeId,
      }),
    });

    expect(executed.status).toBe(200);
    const executedBody = (await executed.json()) as {
      error?: string;
      executed?: boolean;
      kind?: string;
      childNodeId?: string;
      childNodeType?: string;
    };
    expect(executedBody.error).toBeUndefined();
    expect(executedBody.error).not.toBe(`Node ${nodeId} is not a generation node`);
    expect(executedBody.executed).toBe(true);
    expect(executedBody.kind).toBe("generation");
    expect(executedBody.childNodeType).toBe("model");
    expect(executedBody.childNodeId).toBeTruthy();

    const listed = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list", canvasId: "main" }),
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      nodes?: Array<{ id: string; type?: string; data?: Record<string, unknown> }>;
    };
    const child = listedBody.nodes?.find(
      (n) => n.id === executedBody.childNodeId,
    );
    expect(child?.type).toBe("model");
    expect(child?.data).toMatchObject({ status: "pending" });
  });

  it("resolves active plugin actions inside local-api before creating the node", async () => {
    const app = createLocalApiApp({
      dataDir,
      listPluginCards: async () => [
        {
          pluginId: "test.canvas-actions",
          version: "1.2.0",
          schemaHash: `sha256:${"c".repeat(64)}`,
          runtime: {
            kind: "local",
            transport: "stdio",
            entrypoint: "handler.mjs",
            args: [],
          },
          document: {
            apiVersion: "clash.card/v1",
            kind: "action-card",
            spec: {
              id: "test.caption-helper",
              name: "Caption Helper",
              outputType: "text",
              parameters: [],
              input: {
                requiresPrompt: true,
                inputMode: {},
                promptModalities: ["text"],
              },
              constraints: [],
              presentation: { type: "form" },
              functionExportId: "run-caption-helper",
            },
          },
        },
      ],
    });

    const created = await app.request("/api/v1/projects/p1/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add",
        type: "text_gen",
        label: "Caption",
        prompt: "Write a caption",
        actionId: "test.caption-helper",
      }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      node: {
        data: {
          customActionId: "test.caption-helper",
          outputType: "text",
          pluginBinding: {
            pluginId: "test.canvas-actions",
            version: "1.2.0",
            exportId: "run-caption-helper",
          },
        },
      },
    });
  });
});
