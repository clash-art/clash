// @vitest-environment jsdom
import { Profiler } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReactFlowProvider,
  useStoreApi,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import GroupNode from "./GroupNode";
import { LayoutActionsProvider } from "../LayoutActionsContext";

afterEach(cleanup);
const group: NodeProps<Node<Record<string, unknown>>> = {
  id: "group",
  type: "group",
  data: { label: "Scene" },
  selected: false,
  dragging: false,
  draggable: true,
  selectable: true,
  deletable: true,
  isConnectable: true,
  zIndex: 0,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

function setup() {
  let store: ReturnType<typeof useStoreApi>;
  function Controls() {
    store = useStoreApi();
    return null;
  }
  const actions = { ungroup: vi.fn(), relayoutParent: vi.fn() };
  const commits = vi.fn();
  const tree = (selected: boolean) => (
    <ReactFlowProvider>
      <Controls />
      <LayoutActionsProvider value={actions}>
        <Profiler id="group" onRender={commits}>
          <GroupNode {...group} selected={selected} />
        </Profiler>
      </LayoutActionsProvider>
    </ReactFlowProvider>
  );
  const view = render(tree(false));
  commits.mockClear();
  return {
    ...view,
    actions,
    commits,
    select: (selected: boolean) => view.rerender(tree(selected)),
    transform: (x: number, y: number, zoom: number) =>
      act(() => store.setState({ transform: [x, y, zoom] })),
  };
}

describe("group viewport subscriptions", () => {
  it("does not render unselected groups during pan or zoom", () => {
    const view = setup();
    view.transform(100, 40, 1);
    view.transform(200, 80, 0.5);
    expect(view.commits).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Scene")).toBeTruthy();
  });

  it("keeps selected actions stationary in screen size and working after zoom, without pan rerenders", () => {
    const view = setup();
    view.transform(0, 0, 0.5);
    view.select(true);
    const layout = screen.getByRole("button", { name: "Layout" });
    const cluster = layout.closest<HTMLElement>('[style*="transform-origin"]')!;
    expect(cluster.style.transform).toBe("scale(2)");
    expect(cluster.style.marginBottom).toBe("16px");
    view.commits.mockClear();
    view.transform(100, 20, 0.5);
    expect(view.commits).not.toHaveBeenCalled();
    view.transform(100, 20, 0.25);
    expect(cluster.style.transform).toBe("scale(4)");
    fireEvent.click(layout);
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    expect(view.actions.relayoutParent).toHaveBeenCalledWith("group");
    expect(view.actions.ungroup).toHaveBeenCalledWith("group");
    view.select(false);
    expect(screen.queryByRole("button", { name: "Layout" })).toBeNull();
  });
});

it("keeps a large set of groups out of pan commits", () => {
  let store: ReturnType<typeof useStoreApi>;
  function Controls() {
    store = useStoreApi();
    return null;
  }
  const commits = vi.fn();
  const actions = { ungroup: vi.fn(), relayoutParent: vi.fn() };
  render(
    <ReactFlowProvider>
      <Controls />
      <LayoutActionsProvider value={actions}>
        {Array.from({ length: 100 }, (_, index) => (
          <Profiler key={index} id={String(index)} onRender={commits}>
            <GroupNode {...group} id={`group-${index}`} />
          </Profiler>
        ))}
      </LayoutActionsProvider>
    </ReactFlowProvider>,
  );
  commits.mockClear();
  for (const x of [10, 20, 30])
    act(() => store.setState({ transform: [x, 0, 1] }));
  expect(commits).not.toHaveBeenCalled();
});
