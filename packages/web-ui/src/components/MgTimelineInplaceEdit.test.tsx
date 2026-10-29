// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositionItem } from "@clash/remotion-core";

const mocks = vi.hoisted(() => ({
  setNodes: vi.fn(),
  updateNode: vi.fn(),
}));

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    setNodes: mocks.setNodes,
  }),
}));

vi.mock("./LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({
    updateNode: mocks.updateNode,
  }),
}));

import {
  MgTimelineCompositionInspector,
  type MgTimelineDraftChange,
} from "./MgTimelineInplaceEdit";

const htmlItem: CompositionItem = {
  id: "timeline-html",
  type: "composition",
  compositionKind: "motion-graphics",
  runtime: "html",
  compositionId: "LowerThird",
  sourcePath: "html/lower-third.html",
  sourceNodeId: "h1",
  from: 0,
  durationInFrames: 60,
};

const remotionItem: CompositionItem = {
  id: "timeline-remotion",
  type: "composition",
  compositionKind: "custom",
  runtime: "remotion",
  compositionId: "Greeting",
  sourcePath: "components/greeting.tsx",
  sourceNodeId: "r1",
  from: 0,
  durationInFrames: 90,
};

const htmlRuntimeNodes = [
  {
    id: "h1",
    type: "html-motion",
    data: {
      content: `<!doctype html><html><body>
        <h1 data-mg-id="title" data-mg-editable="text,position" data-mg-x="0" data-mg-y="0">Hi</h1>
      </body></html>`,
      elementOverrides: {},
    },
  },
];

const remotionSource = `export default function Component(props) {
  const title = props.mgElementOverrides?.title;
  const text = title?.text ?? "Hi Remotion";
  const x = title?.x ?? 0;
  const y = title?.y ?? 0;
  return (
    <div
      data-mg-id="title"
      data-mg-editable="text,position"
      data-mg-default-text="Hi Remotion"
      data-mg-default-x={0}
      data-mg-default-y={0}
      data-mg-x={x}
      data-mg-y={y}
    >{text}</div>
  );
}`;

const remotionRuntimeNodes = [
  {
    id: "r1",
    type: "remotion-component",
    data: {
      content: remotionSource,
      elementOverrides: {},
    },
  },
];

describe("MgTimelineCompositionInspector", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    mocks.setNodes.mockClear();
    mocks.updateNode.mockClear();
  });

  it("edits an html-motion composition in place and writes overrides + derived content", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn<MgTimelineDraftChange>();
    render(
      <MgTimelineCompositionInspector
        item={htmlItem}
        runtimeNodes={htmlRuntimeNodes}
        onDraftChange={onDraftChange}
      />,
    );

    expect(screen.getByTestId("mg-element-inspector")).toBeTruthy();
    expect(
      (screen.getByTestId("mg-element-text") as HTMLInputElement).value,
    ).toBe("Hi");

    fireEvent.change(screen.getByTestId("mg-element-text"), {
      target: { value: "Edited in Timeline" },
    });

    // Live preview patch is immediate; Canvas persistence is debounced.
    const preview = onDraftChange.mock.calls.at(-1);
    expect(preview?.[0]).toBe("h1");
    expect(preview?.[1]?.elementOverrides?.title?.text).toBe(
      "Edited in Timeline",
    );
    expect(String(preview?.[1]?.content ?? "")).toContain("Edited in Timeline");
    expect(mocks.updateNode).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    const [nodeId, patch] = mocks.updateNode.mock.calls[0]!;
    expect(nodeId).toBe("h1");
    expect(patch?.data?.elementOverrides?.title?.text).toBe(
      "Edited in Timeline",
    );
    expect(String(patch?.data?.content ?? "")).toContain("Edited in Timeline");
    expect(String(patch?.data?.content ?? "")).toMatch(/data-mg-x="0"/);
  });

  it("writes remotion edits as elementOverrides only and never rewrites TSX", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn<MgTimelineDraftChange>();
    render(
      <MgTimelineCompositionInspector
        item={remotionItem}
        runtimeNodes={remotionRuntimeNodes}
        onDraftChange={onDraftChange}
      />,
    );

    expect(
      (screen.getByTestId("mg-element-text") as HTMLInputElement).value,
    ).toBe("Hi Remotion");

    fireEvent.change(screen.getByTestId("mg-element-text"), {
      target: { value: "Edited Remotion" },
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    const [nodeId, patch] = mocks.updateNode.mock.calls[0]!;
    expect(nodeId).toBe("r1");
    expect(patch?.data?.elementOverrides?.title?.text).toBe("Edited Remotion");
    expect(patch?.data?.content).toBeUndefined();
    expect(remotionRuntimeNodes[0]!.data.content).toBe(remotionSource);

    // Remotion preview patches only carry the override map.
    const preview = onDraftChange.mock.calls.at(-1);
    expect(preview?.[1]?.elementOverrides?.title?.text).toBe("Edited Remotion");
    expect(preview?.[1]?.content).toBeUndefined();
  });

  it("persists stage pointerup patches immediately through registered handlers", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn<MgTimelineDraftChange>();
    const onRegisterHandlers = vi.fn();
    render(
      <MgTimelineCompositionInspector
        item={htmlItem}
        runtimeNodes={htmlRuntimeNodes}
        onDraftChange={onDraftChange}
        onRegisterHandlers={onRegisterHandlers}
      />,
    );

    const handlers = onRegisterHandlers.mock.calls.at(-1)?.[0];
    expect(handlers?.activeSourceNodeId).toBe("h1");

    act(() => {
      handlers.onElementEdit("h1", "title", { x: 99, y: 12 });
    });

    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    const [nodeId, patch] = mocks.updateNode.mock.calls[0]!;
    expect(nodeId).toBe("h1");
    expect(patch?.data?.elementOverrides?.title).toMatchObject({
      x: 99,
      y: 12,
    });
    expect(String(patch?.data?.content ?? "")).toMatch(/data-mg-x="99"/);
    expect(String(patch?.data?.content ?? "")).toMatch(/data-mg-y="12"/);
  });

  it("flushes a pending draft and clears the live preview patch on unmount", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn<MgTimelineDraftChange>();
    const { unmount } = render(
      <MgTimelineCompositionInspector
        item={htmlItem}
        runtimeNodes={htmlRuntimeNodes}
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.change(screen.getByTestId("mg-element-text"), {
      target: { value: "Persist on deselect" },
    });
    expect(mocks.updateNode).not.toHaveBeenCalled();

    unmount();

    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    expect(
      mocks.updateNode.mock.calls[0]?.[1]?.data?.elementOverrides?.title?.text,
    ).toBe("Persist on deselect");
    expect(onDraftChange).toHaveBeenLastCalledWith("h1", null);
  });

  it("does not render for unsupported composition runtimes", () => {
    const reactItem: CompositionItem = {
      ...remotionItem,
      id: "timeline-react",
      runtime: "react",
      sourceNodeId: "react-node",
    };
    render(
      <MgTimelineCompositionInspector
        item={reactItem}
        runtimeNodes={[
          { id: "react-node", type: "remotion-component", data: {} },
        ]}
        onDraftChange={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("mg-timeline-composition-inspector"),
    ).toBeNull();
  });
});
