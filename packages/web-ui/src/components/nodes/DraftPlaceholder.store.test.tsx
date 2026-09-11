// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReactFlowProvider,
  useStoreApi,
  type Edge,
  type Node,
} from "@xyflow/react";
import DraftPlaceholder from "./DraftPlaceholder";
import * as buildPlan from "./buildPlan";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function graph(count: number) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      {
        id: `action-${i}`,
        type: "action-badge",
        position: { x: 0, y: 0 },
        data: {
          modelId: "fixture-model",
          label: "Fixture action",
          content: "Generate a scene",
        },
      },
      {
        id: `draft-${i}`,
        type: "image",
        position: { x: 400, y: 0 },
        data: { label: `Scene ${i}`, status: "draft" },
      },
    );
    edges.push({
      id: `output-${i}`,
      source: `action-${i}`,
      target: `draft-${i}`,
    });
    if (i > 0)
      edges.push({
        id: `input-${i}`,
        source: `draft-${i - 1}`,
        target: `action-${i}`,
      });
  }
  return { nodes, edges };
}

function setup(count: number, all = false) {
  const { nodes, edges } = graph(count);
  let store!: ReturnType<typeof useStoreApi>;
  function Controls() {
    store = useStoreApi();
    return null;
  }
  const tree = (nodeId: string) => (
    <ReactFlowProvider defaultNodes={nodes} defaultEdges={edges}>
      <Controls />
      {all ? (
        nodes
          .filter((node) => node.type === "image")
          .map((node) => (
            <DraftPlaceholder key={node.id} nodeId={node.id} modality="image" />
          ))
      ) : (
        <DraftPlaceholder nodeId={nodeId} modality="image" />
      )}
    </ReactFlowProvider>
  );
  const view = render(tree(`draft-${count - 1}`));
  return { ...view, store, select: (id: string) => view.rerender(tree(id)) };
}

describe("draft planning during canvas interaction", () => {
  it("does not traverse the build graph on pan, zoom, or selection-mode frames", () => {
    // Call through to the real planner; measure work even when React bails out.
    const planning = vi.spyOn(buildPlan, "computeBuildPlanFromGraph");
    const { store } = setup(40, true);
    planning.mockClear();
    for (let frame = 0; frame < 60; frame++) {
      act(() =>
        store.setState({ transform: [frame * 4, frame * 2, 1 - frame / 100] }),
      );
    }
    act(() => store.setState({ nodesSelectionActive: true }));
    expect(planning.mock.calls.length).toBe(0);
    expect(
      screen.getByRole("button", { name: "Build this draft" }),
    ).toBeTruthy();
  });

  it("refreshes the open build plan on upstream completion, prompt edits, and edge changes", () => {
    const { store } = setup(2);
    fireEvent.click(screen.getByRole("button", { name: /1 upstream draft/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Build 2 drafts",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    act(() =>
      store
        .getState()
        .setNodes(
          store
            .getState()
            .nodes.map((node) =>
              node.id === "draft-0"
                ? { ...node, data: { ...node.data, status: "completed" } }
                : node,
            ),
        ),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Build 1 draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    act(() =>
      store
        .getState()
        .setNodes(
          store
            .getState()
            .nodes.map((node) =>
              node.id === "action-1"
                ? { ...node, data: { ...node.data, content: "" } }
                : node,
            ),
        ),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: /no prompt/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    act(() =>
      store
        .getState()
        .setNodes(
          store
            .getState()
            .nodes.map((node) =>
              node.id === "action-1"
                ? {
                    ...node,
                    data: { ...node.data, content: "A revised scene" },
                  }
                : node,
            ),
        ),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Build 1 draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    act(() =>
      store
        .getState()
        .setEdges([
          ...store.getState().edges,
          { id: "cycle", source: "draft-1", target: "draft-1" },
        ]),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Cycle detected",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    act(() =>
      store
        .getState()
        .setEdges(store.getState().edges.filter((edge) => edge.id !== "cycle")),
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Build 1 draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Build 1 draft" }),
    );
    expect(
      store.getState().nodes.find((node) => node.id === "draft-1")?.data
        .runRequested,
    ).toBe(true);
    expect(
      store.getState().nodes.find((node) => node.id === "draft-0")?.data
        .runRequested,
    ).toBeUndefined();
  });

  it("uses the new target after a card changes identity", () => {
    const view = setup(2);
    expect(
      screen.getByRole("button", { name: /1 upstream draft/ }),
    ).toBeTruthy();
    view.select("draft-0");
    expect(
      screen.getByRole("button", { name: "Build this draft" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Build this draft" }));
    expect(
      screen.getByRole("dialog", { name: "Build plan for Scene 0" }),
    ).toBeTruthy();
  });
});
