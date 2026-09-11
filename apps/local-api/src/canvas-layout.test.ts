import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, expect, it, vi } from "vitest";
import { Canvas, ensureProjectCanvas } from "@clash/shared-types";
import { LocalLoroRoomHub } from "./sync.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])("auto-inserts without moving a referenced collision victim (referenced=%s)", (referenced) => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  try {
    canvas.insertNodeRecord("source", { type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 });
    canvas.insertNodeRecord("obstacle", { type: "text", position: { x: 160, y: 0 }, width: 100, height: 100 });
    canvas.insertNodeRecord("dependent", { type: "text", position: { x: 2000, y: 0 } });
    if (referenced) canvas.insertEdge("pinned", "obstacle", "dependent");
    const before = doc.getMap("nodes").get("obstacle");
    const result = canvas.createLinkedNode({ nodeId: "new", nodeType: "text", data: {}, sourceNodeId: "source", parentId: null });
    const obstacle = canvas.readNode("obstacle")!;
    const inserted = canvas.readNode("new")!;
    if (referenced) {
      expect(doc.getMap("nodes").get("obstacle")).toEqual(before);
      expect(result.pushedNodeIds).not.toContain("obstacle");
      expect(inserted.position.y).toBeGreaterThanOrEqual(obstacle.position.y + obstacle.height!);
    } else {
      expect(obstacle.position.y).toBeGreaterThan(0);
    }
    expect(canvas.listEdges()).toEqual(expect.arrayContaining([expect.objectContaining({ source: "source", target: "new" })]));
  } finally { doc.free(); }
});

function seedPendingLayout(doc: LoroDoc) {
  const canvas = new Canvas(doc, () => {});
  canvas.insertNodeRecord("anchor", { type: "text", position: { x: 80, y: 60 }, width: 200, height: 100 });
  canvas.insertNodeRecord("missing-position", { type: "text", data: { content: "Unplaced draft" } });
  canvas.insertNodeRecord("pinned-placeholder", { type: "text", position: { x: -1, y: -1 } });
  canvas.insertNodeRecord("pinned-output", { type: "text", position: { x: 900, y: 500 } });
  canvas.insertEdge("pinned", "pinned-placeholder", "pinned-output");
  ensureProjectCanvas(doc, "other");
  const other = new Canvas(doc, () => {}, "other");
  // A separate Canvas must not participate in Main's collision layout.
  other.insertNodeRecord("other-draft", { type: "text", position: { x: -1, y: -1 } });
}

function expectCompletedLayout(doc: LoroDoc) {
  const nodes = doc.getMap("nodes");
  const draft = nodes.get("missing-position") as { position?: { x: number; y: number }; data: unknown };
  expect(draft.position).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  expect(draft.position!.y).toBeGreaterThan(160);
  expect(draft.data).toEqual({ content: "Unplaced draft" });
  expect(nodes.get("pinned-placeholder")).toMatchObject({ position: { x: -1, y: -1 } });
  const other = nodes.get("other-draft") as { position: { x: number; y: number } };
  expect(other.position).not.toEqual({ x: -1, y: -1 });
  expect(other.position.y).toBeLessThan(draft.position!.y);
}

it("persists pending layout before publishing the initial snapshot, without changing referenced history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-layout-load-"));
  roots.push(dataDir);
  const seed = new LocalLoroRoomHub(dataDir, undefined, null);
  try {
    await seed.mutateProject("project", (doc) => { seedPendingLayout(doc); return { value: undefined, save: true }; });
  } finally { await seed.close(); }
  let saved: unknown;
  const hub = new LocalLoroRoomHub(dataDir, undefined, null);
  try {
    const room = await hub.room("project");
    const snapshot = LoroDoc.fromSnapshot(room.snapshot());
    try { expectCompletedLayout(snapshot); saved = snapshot.getMap("nodes").toJSON(); }
    finally { snapshot.free(); }
  } finally { await hub.close(); }
  const reopened = new LocalLoroRoomHub(dataDir, undefined, null);
  try {
    expect(await reopened.inspectProject("project", (doc) => doc.getMap("nodes").toJSON())).toEqual(saved);
  } finally { await reopened.close(); }
});

it("admits a peer's pending layout atomically and sends the Host result back to its origin", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-layout-peer-"));
  roots.push(dataDir);
  const process = vi.fn(async ({ doc }: { doc: LoroDoc }) => {
    if (doc.getMap("nodes").get("missing-position")) expectCompletedLayout(doc);
    return false;
  });
  const hub = new LocalLoroRoomHub(dataDir, undefined, { process });
  try {
    const room = await hub.room("project");
    const client = LoroDoc.fromSnapshot(room.snapshot());
    const observer = LoroDoc.fromSnapshot(room.snapshot());
    const version = client.version();
    const originUpdates: Uint8Array[] = [];
    const origin = room.addPeer((bytes) => originUpdates.push(bytes));
    room.addPeer((bytes) => observer.import(bytes));
    try {
      seedPendingLayout(client);
      const update = client.export({ mode: "update", from: version });
      await room.receive(origin, update);
      expectCompletedLayout(observer);
      expect(originUpdates.length).toBeGreaterThan(0);
      for (const bytes of originUpdates) client.import(bytes);
      expectCompletedLayout(client);
      const accepted = observer.getMap("nodes").toJSON();
      await room.receive(origin, update);
      expect(observer.getMap("nodes").toJSON()).toEqual(accepted);
    } finally { version.free(); client.free(); observer.free(); }
  } finally { await hub.close(); }
});
