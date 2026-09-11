import { describe, expect, it, vi } from "vitest";
import {
  nodeChangesRequireZIndexNormalization,
  nodeChangesRequireStructuralSanitize,
  isUserResizeChange,
  normalizeCanvasNodeZIndex,
  sanitizeNodesForReactFlow,
} from "./canvasNodeOrder";

it("separates ResizeObserver measurements from user resize changes", () => {
  // ReactFlow's ResizeObserver omits resizing; NodeResizeControl supplies
  // true during the gesture and false on its final dimension change.
  expect(isUserResizeChange({ type: "dimensions" })).toBe(false);
  expect(isUserResizeChange({ type: "dimensions", resizing: true })).toBe(true);
  expect(isUserResizeChange({ type: "dimensions", resizing: false })).toBe(true);
  expect(isUserResizeChange({ type: "position" })).toBe(false);
});

describe("sanitizeNodesForReactFlow", () => {
  it("keeps an already valid parent-first node array by reference", () => {
    const parent = { id: "parent", position: { x: 0, y: 0 }, data: {} };
    const child = { id: "child", parentId: "parent", position: { x: 8, y: 8 }, data: {} };
    const nodes = [parent, child];

    expect(sanitizeNodesForReactFlow(nodes)).toBe(nodes);
  });

  it("orders parents before children without cloning unchanged nodes", () => {
    const parent = { id: "parent", position: { x: 0, y: 0 }, data: {} };
    const child = { id: "child", parentId: "parent", position: { x: 8, y: 8 }, data: {} };

    const result = sanitizeNodesForReactFlow([child, parent]);

    expect(result.map((node) => node.id)).toEqual(["parent", "child"]);
    expect(result[0]).toBe(parent);
    expect(result[1]).toBe(child);
  });

  it("cleans invalid parents once and reports them to the caller", () => {
    const onInvalidParent = vi.fn();
    const child = {
      id: "child",
      parentId: "missing",
      extent: "parent",
      position: { x: 8, y: 8 },
      data: {},
    };

    const nodes = [child];
    const result = sanitizeNodesForReactFlow(nodes, { onInvalidParent });

    expect(result).not.toBe(nodes);
    expect(result[0]).not.toBe(child);
    expect(result[0]).toMatchObject({
      id: "child",
      parentId: undefined,
      extent: undefined,
    });
    expect(onInvalidParent).toHaveBeenCalledWith(child, "missing");
  });
});

describe("nodeChangesRequireStructuralSanitize", () => {
  it("skips the structural scan for drag and selection-only frames", () => {
    expect(
      nodeChangesRequireStructuralSanitize([
        { type: "position" },
        { type: "select" },
      ]),
    ).toBe(false);
  });

  it.each(["dimensions", "add", "remove", "replace"] as const)(
    "keeps the structural scan for %s changes",
    (type) => {
      expect(nodeChangesRequireStructuralSanitize([{ type }])).toBe(true);
    },
  );
});

describe("nodeChangesRequireZIndexNormalization", () => {
  it("keeps drag and selection frames off the full-graph z-index path", () => {
    expect(
      nodeChangesRequireZIndexNormalization([
        { type: "position" },
        { type: "select" },
      ]),
    ).toBe(false);
  });

  it.each(["dimensions", "add", "remove", "replace"] as const)(
    "normalizes z-index after %s changes",
    (type) => {
      expect(nodeChangesRequireZIndexNormalization([{ type }])).toBe(true);
    },
  );
});

describe("normalizeCanvasNodeZIndex", () => {
  it("keeps an already-normalized graph by reference", () => {
    const nodes = [
      { id: "group", type: "group", style: { zIndex: 0 } },
      { id: "child", parentId: "group", style: { zIndex: 1001 } },
    ];

    expect(normalizeCanvasNodeZIndex(nodes)).toBe(nodes);
  });

  it("updates only nodes whose derived depth changed", () => {
    const group = { id: "group", type: "group", style: { zIndex: 0 } };
    const child = { id: "child", parentId: "group", style: { zIndex: 1000 } };

    const result = normalizeCanvasNodeZIndex([group, child]);

    expect(result[0]).toBe(group);
    expect(result[1]).not.toBe(child);
    expect(result[1].style?.zIndex).toBe(1001);
  });
});
