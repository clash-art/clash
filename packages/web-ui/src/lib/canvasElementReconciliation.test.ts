import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { ACTION_BADGE_NODE_SIZE } from "@clash/shared-layout";
import {
  reconcileSyncedCanvasEdges,
  reconcileSyncedCanvasNodes,
} from "./canvasElementReconciliation";

function createNode(index: number): Node {
  return {
    id: `node-${index}`,
    type: "text",
    position: { x: index * 8, y: index * 4 },
    data: {
      label: `Node ${index}`,
      metadata: { tags: ["canvas", String(index)] },
    },
  };
}

describe("reconcileSyncedCanvasNodes", () => {
  it("projects fixed Action bounds without rewriting the received node", () => {
    const stored: Node = { id: "native", type: "action-badge", position: { x: 10, y: 20 },
      width: 320, height: 220, style: { width: 320, height: 220, opacity: 0.8 },
      data: { generatorId: "draft", actionCardId: "agent-text" } };
    const before = structuredClone(stored);
    const view = reconcileSyncedCanvasNodes<Node>([], [stored]);
    expect(view[0]).toMatchObject({ ...ACTION_BADGE_NODE_SIZE, style: { ...ACTION_BADGE_NODE_SIZE, opacity: 0.8 } });
    expect(stored).toEqual(before);
    expect(view[0].data).toBe(stored.data);
    expect(reconcileSyncedCanvasNodes(view, [stored])).toBe(view);
  });

  it("reuses the array when an incoming snapshot is structurally unchanged", () => {
    const current = Array.from({ length: 20 }, (_, index) => createNode(index));
    const synced = structuredClone(current);

    expect(reconcileSyncedCanvasNodes(current, synced)).toBe(current);
  });

  it("replaces only the changed node in a large incoming snapshot", () => {
    const current = Array.from({ length: 1000 }, (_, index) =>
      createNode(index),
    );
    current[500] = { ...current[500], selected: true };
    const synced = structuredClone(current).map(
      ({ selected: _selected, ...node }) => node,
    );
    synced[500] = {
      ...synced[500],
      data: { ...synced[500].data, label: "Changed" },
    };

    const result = reconcileSyncedCanvasNodes(current, synced);
    const reusedCount = result.filter(
      (node, index) => node === current[index],
    ).length;

    expect(result).not.toBe(current);
    expect(reusedCount).toBe(999);
    expect(result[500]).not.toBe(current[500]);
    expect(result[500].selected).toBe(true);
    expect(result[500].data.label).toBe("Changed");
  });

  it("preserves local geometry while a node is being dragged", () => {
    const current: Node[] = [
      {
        ...createNode(0),
        position: { x: 320, y: 180 },
        dragging: true,
      },
    ];
    const synced: Node[] = [
      {
        ...createNode(0),
        position: { x: 0, y: 0 },
      },
    ];

    const result = reconcileSyncedCanvasNodes(current, synced);

    expect(result).toBe(current);
    expect(result[0].position).toEqual({ x: 320, y: 180 });
  });
});

describe("reconcileSyncedCanvasEdges", () => {
  it("keeps unchanged edges stable while preserving local selection", () => {
    const current: Edge[] = [
      { id: "a-b", source: "a", target: "b", selected: true },
      { id: "b-c", source: "b", target: "c" },
    ];
    const synced: Edge[] = [
      { id: "a-b", source: "a", target: "b" },
      { id: "b-c", source: "b", target: "c", label: "Changed" },
    ];

    const result = reconcileSyncedCanvasEdges(current, synced);

    expect(result[0]).toBe(current[0]);
    expect(result[0].selected).toBe(true);
    expect(result[1]).not.toBe(current[1]);
    expect(result[1].label).toBe("Changed");
  });
});

describe("geometry-only synchronization", () => {
  it("keeps node data and measurements stable when only position changes", () => {
    const current = [
      { ...createNode(0), measured: { width: 300, height: 400 } },
    ];
    const synced = [
      { ...structuredClone(createNode(0)), position: { x: 500, y: 200 } },
    ];
    const [next] = reconcileSyncedCanvasNodes(current, synced);
    expect(next.position).toEqual({ x: 500, y: 200 });
    expect(next.data).toBe(current[0].data);
    expect(next.measured).toBe(current[0].measured);
  });
});
