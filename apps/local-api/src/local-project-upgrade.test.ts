import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { Canvas, MODEL_CARDS, createProjectTimeline, readProjectGenerator, ExecutablePluginCardRegistrationSchema } from "@clash/shared-types";
import { attachLocalSync, LocalLoroRoomHub } from "./sync.js";
import { createLocalProjectUpgrade } from "./local-project-upgrade.js";
import { createLocalProjectAssetService } from "./local-project-assets.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-project-upgrade-"));
  roots.push(dataDir);
  const definitions = await Promise.all([
    ["model-generation", "video", "clash.model-generation"],
    ["remotion", "timeline", "clash.remotion"],
    ["codex-imagegen", "codex-imagegen", "clash.codex-imagegen"],
  ].map(async ([directory, id, pluginId]) => ({ pluginId: pluginId!, version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
    document: JSON.parse(await readFile(new URL(`../../../plugins/${directory}/generators/${id}.json`, import.meta.url), "utf8")),
  })));
  const assets = createLocalProjectAssetService({ dataDir, projectionOrigin: "http://localhost" });
  const manifest = JSON.parse(await readFile(new URL("../../../plugins/codex-imagegen/manifest.json", import.meta.url), "utf8"));
  const card = ExecutablePluginCardRegistrationSchema.parse({ pluginId: manifest.id, version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`, runtime: manifest.runtime,
    document: JSON.parse(await readFile(new URL("../../../plugins/codex-imagegen/cards/codex-imagegen.json", import.meta.url), "utf8")) });
  return { dataDir, definitions, assets, card };
}
it.each(["Model", "Action"])("delivers only the upgraded initial WebSocket state and reopens the same persisted Generator (%s)", async (kind) => {
  const { dataDir, definitions, assets, card } = await fixture();
  const seed = new LocalLoroRoomHub(dataDir, undefined, null);
  await seed.mutateProject("project", (doc) => {
    new Canvas(doc, () => {}).createNode("draft", "action-badge", { ...(kind === "Model" ? { actionType: "video-gen", modelId: "minimax-h3" } : { actionType: "custom:codex-imagegen" }), content: "Opening scene" });
    expect(createProjectTimeline(doc, { id: "cut", name: "Cut", state: { tracks: [] } }).ok).toBe(true);
    return { value: undefined, save: true };
  });
  await seed.close();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const listDefinitions = vi.fn(async () => { await gate; return definitions; });
  const journal = createSqliteDurableRunJournal(dataDir);
  const upgrade = createLocalProjectUpgrade({ materializeDoc: assets.materializeDoc, listDefinitions, modelCards: async () => MODEL_CARDS, listActionCards: async () => [card], rememberDefinition: journal.rememberGeneratorDefinition });
  const process = vi.fn(async ({ doc }: { doc: LoroDoc }) => {
    expect(new Canvas(doc, () => {}).readNode("draft")!.data.generatorId).toEqual(expect.any(String));
    expect(readProjectGenerator(doc, "cut")).toBeTruthy();
    return false;
  });
  const hub = new LocalLoroRoomHub(dataDir, undefined, { process }, upgrade);
  const server = createServer();
  attachLocalSync(server, { dataDir, hub });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/sync/project`);
  const snapshots: LoroDoc[] = [];
  ws.on("message", (bytes, binary) => { if (binary) { const doc = new LoroDoc(); doc.import(new Uint8Array(bytes as Buffer)); snapshots.push(doc); } });
  try {
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await vi.waitFor(() => expect(listDefinitions).toHaveBeenCalled());
    expect(snapshots).toEqual([]);
    expect(process).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(snapshots[0]).toBeTruthy());
    const first = snapshots[0]!;
    const node = new Canvas(first, () => {}).readNode("draft")!;
    expect(node.data).toMatchObject({ generatorId: expect.any(String), content: "Opening scene" });
    expect(readProjectGenerator(first, "cut")).toBeTruthy();
    expect(first.getMap("timelines").size).toBe(0);
    const generatorId = node.data.generatorId;
    const head = readProjectGenerator(first, generatorId as string)!;
    expect(await journal.readGeneratorDefinition!(head.definitionRef)).toMatchObject(head.definitionRef);
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await hub.close();
    const restarted = new LocalLoroRoomHub(dataDir, undefined, null, upgrade);
    try {
      const restored = await restarted.inspectProject("project", (doc) => new Canvas(doc, () => {}).readNode("draft")!.data.generatorId);
      expect(restored).toBe(generatorId);
    } finally { await restarted.close(); }
  } finally {
    release(); ws.terminate(); await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const doc of snapshots) doc.free();
  }
});
it("keeps the previous checkpoint when an upgrade contains a broken legacy draft", async () => {
  const { dataDir, definitions, assets } = await fixture();
  const seed = new LocalLoroRoomHub(dataDir, undefined, null);
  await seed.mutateProject("broken", (doc) => {
    new Canvas(doc, () => {}).createNode("draft", "action-badge", { actionType: "video-gen", modelId: "minimax-h3", referenceImageAssetIds: ["missing"] });
    return { value: undefined, save: true };
  });
  const before = await seed.inspectProject("broken", (doc) => doc.getMap("nodes").toJSON());
  await seed.close();
  const upgrade = createLocalProjectUpgrade({ materializeDoc: assets.materializeDoc, listDefinitions: async () => definitions, modelCards: async () => MODEL_CARDS });
  const hub = new LocalLoroRoomHub(dataDir, undefined, null, upgrade);
  await expect(hub.room("broken")).rejects.toThrow(/missing/);
  const server = createServer();
  attachLocalSync(server, { dataDir, hub });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/sync/broken`);
  const initialState = vi.fn();
  const messages: unknown[] = [];
  socket.on("message", (_data, binary) => { if (binary) initialState(); });
  socket.on("message", (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
  try {
    const code = await new Promise<number>((resolve, reject) => { socket.once("close", resolve); socket.once("error", reject); });
    expect(code).toBe(1011);
    expect(initialState).not.toHaveBeenCalled();
    expect(logged.mock.calls.at(-1)?.[1]).toMatchObject({ name: "LocalProjectUpgradeError" });
    expect(messages).toContainEqual(expect.objectContaining({ type: "project.load-error", projectId: "broken", code: "PROJECT_UPGRADE_FAILED", message: expect.stringContaining("missing") }));
    expect(logged).toHaveBeenCalled();
  } finally {
    socket.terminate(); logged.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hub.close();
  }
  const recovered = new LocalLoroRoomHub(dataDir, undefined, null);
  try {
    await recovered.inspectProject("broken", (doc) => {
      expect(doc.getMap("nodes").toJSON()).toEqual(before);
      expect(new Canvas(doc, () => {}).readNode("draft")!.data).not.toHaveProperty("generatorId");
    });
  } finally { await recovered.close(); }
});


it.each(["Model", "Action"])("upgrades an incoming legacy graph before persistence, peer broadcast and pending work (%s)", async (kind) => {
  const { dataDir, definitions, assets, card } = await fixture();
  const upgrade = createLocalProjectUpgrade({ materializeDoc: assets.materializeDoc, listDefinitions: async () => definitions, modelCards: async () => MODEL_CARDS, listActionCards: async () => [card] });
  const process = vi.fn(async ({ doc }: { doc: LoroDoc }) => {
    const node = new Canvas(doc, () => {}).readNode("incoming-draft");
    if (node) expect(node.data.generatorId).toEqual(expect.any(String));
    return false;
  });
  const hub = new LocalLoroRoomHub(dataDir, undefined, { process }, upgrade);
  let generatorId: unknown;
  try {
    const room = await hub.room("incoming");
    const client = LoroDoc.fromSnapshot(room.snapshot());
    const observer = LoroDoc.fromSnapshot(room.snapshot());
    const originUpdates: Uint8Array[] = [];
    const peer = room.addPeer((bytes) => originUpdates.push(bytes));
    room.addPeer((bytes) => observer.import(bytes));
    const version = client.version();
    try {
      const canvas = new Canvas(client, () => {});
      canvas.createNode("context", "text", { content: "Frozen reference text" });
      canvas.createNode("incoming-draft", "action-badge", { ...(kind === "Model" ? { actionType: "video-gen", modelId: "minimax-h3" } : { actionType: "custom:codex-imagegen" }), content: "Scene" });
      canvas.insertEdge("context-input", "context", "incoming-draft");
      const update = client.export({ mode: "update", from: version });
      await room.receive(peer, update);
      const projected = new Canvas(observer, () => {}).readNode("incoming-draft")!;
      generatorId = projected.data.generatorId;
      expect(generatorId).toEqual(expect.any(String));
      expect(projected.data.content).toContain("Frozen reference text");
      expect(originUpdates.length).toBeGreaterThan(0);
      for (const bytes of originUpdates) client.import(bytes);
      expect(new Canvas(client, () => {}).readNode("incoming-draft")?.data.generatorId).toBe(generatorId);
      await room.receive(peer, update);
      expect(await hub.inspectProject("incoming", (doc) => new Canvas(doc, () => {}).readNode("incoming-draft")?.data.generatorId)).toBe(generatorId);
      const invalid = LoroDoc.fromSnapshot(room.snapshot());
      const invalidVersion = invalid.version();
      const before = invalid.toJSON();
      try {
        const broken = new Canvas(invalid, () => {});
        broken.createNode("invalid-draft", "action-badge", { actionType: "video-gen", modelId: "unavailable-model", content: "Invalid" });
        await expect(room.receive(peer, invalid.export({ mode: "update", from: invalidVersion }))).rejects.toThrow();
        expect(await hub.inspectProject("incoming", (doc) => doc.toJSON())).toEqual(before);
      } finally { invalidVersion.free(); invalid.free(); }
    } finally { version.free(); client.free(); observer.free(); }
  } finally { await hub.close(); }
  const reopened = new LocalLoroRoomHub(dataDir, undefined, null, upgrade);
  try {
    expect(await reopened.inspectProject("incoming", (doc) => new Canvas(doc, () => {}).readNode("incoming-draft")?.data.generatorId)).toBe(generatorId);
    expect(await reopened.inspectProject("incoming", (doc) => doc.getMap("nodes").get("invalid-draft"))).toBeUndefined();
  } finally { await reopened.close(); }
});
