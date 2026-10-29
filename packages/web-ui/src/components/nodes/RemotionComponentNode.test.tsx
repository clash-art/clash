// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MgPreviewProvider } from "../MgPreviewContext";
import RemotionComponentNode from "./RemotionComponentNode";

const mocks = vi.hoisted(() => ({
  updateNode: vi.fn(() => true),
  applyTimelineState: vi.fn(
    (_id: string, _state: Record<string, unknown>) => true,
  ),
  setNodes: vi.fn(),
  getNode: vi.fn(),
  timeline: {
    id: "timeline-main",
    name: "Main cut",
    state: { tracks: [], fps: 30, durationInFrames: 180 },
  },
}));

vi.mock("@xyflow/react", () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <div data-testid={`${type}-handle-${position}`} />
  ),
  Position: { Left: "left", Right: "right" },
  useReactFlow: () => ({
    setNodes: mocks.setNodes,
    getNode: mocks.getNode,
  }),
}));

vi.mock("@remotion/player", () => ({
  Player: ({
    inputProps,
    controls,
  }: {
    inputProps: { source: string };
    controls?: boolean;
  }) => (
    <div
      data-testid="remotion-player"
      data-source={inputProps.source}
      data-controls={String(Boolean(controls))}
    />
  ),
}));

vi.mock("@clash/remotion-components", () => ({
  RemotionSourceComposition: () => null,
  HtmlSceneSurface: () => null,
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    ariaLabel,
  }: {
    open: boolean;
    children: any;
    ariaLabel?: string;
  }) =>
    open ? (
      <div role="dialog" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null,
}));

vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({
    timelines: [mocks.timeline],
    updateNode: mocks.updateNode,
    applyTimelineState: mocks.applyTimelineState,
  }),
}));

vi.mock("../ui/select", () => ({
  SelectMenu: ({ value }: { value: string }) => (
    <div data-testid="timeline-select">{value}</div>
  ),
}));

const baseProps = {
  id: "remotion-greeting",
  selected: false,
  type: "remotion-component",
  dragging: false,
  draggable: true,
  selectable: true,
  deletable: true,
  zIndex: 1,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  data: {
    label: "Greeting",
    componentId: "Greeting",
    content: "export default function Greeting(){ return <div>Before</div>; }",
    compositionWidth: 720,
    compositionHeight: 1280,
    fps: 30,
    durationInFrames: 120,
  },
} as const;

function renderNode(
  ui: React.ReactElement = <RemotionComponentNode {...baseProps} />,
) {
  return render(<MgPreviewProvider>{ui}</MgPreviewProvider>);
}

describe("RemotionComponentNode", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.updateNode.mockClear();
    mocks.applyTimelineState.mockClear();
    mocks.setNodes.mockClear();
    mocks.getNode.mockReset();
  });

  it("is a distinct Remotion node with a real Player preview and no code-edit chrome", () => {
    renderNode();

    expect(
      screen.getByTestId("remotion-player").getAttribute("data-source"),
    ).toContain("Before");
    expect(screen.queryByRole("button", { name: "Edit code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /render|export/i })).toBeNull();
  });

  it("shapes the Canvas node preview from the component composition", () => {
    const { rerender } = renderNode();

    const portraitNode = screen.getByTestId("remotion-component-node");
    const portraitPreview = screen.getByTestId("remotion-component-preview");
    const portraitWidth = Number.parseFloat(portraitPreview.style.width);
    const portraitHeight = Number.parseFloat(portraitPreview.style.height);

    expect(portraitWidth / portraitHeight).toBeCloseTo(720 / 1280, 2);
    expect(portraitNode.style.width).toBe(portraitPreview.style.width);

    rerender(
      <MgPreviewProvider>
        <RemotionComponentNode
          {...baseProps}
          data={{
            ...baseProps.data,
            compositionWidth: 1920,
            compositionHeight: 1080,
          }}
        />
      </MgPreviewProvider>,
    );

    const landscapeNode = screen.getByTestId("remotion-component-node");
    const landscapePreview = screen.getByTestId("remotion-component-preview");
    const landscapeWidth = Number.parseFloat(landscapePreview.style.width);
    const landscapeHeight = Number.parseFloat(landscapePreview.style.height);

    expect(landscapeWidth / landscapeHeight).toBeCloseTo(1920 / 1080, 2);
    expect(landscapeNode.style.width).toBe(landscapePreview.style.width);
    expect(landscapeWidth).toBeGreaterThan(portraitWidth);
  });

  it("keeps the Canvas preview available as a node drag surface", () => {
    renderNode();

    const preview = screen.getByTestId("remotion-component-preview");
    expect(preview.className).toContain("pointer-events-none");
    expect(preview.className).not.toContain("nodrag");
    expect(screen.getByTestId("remotion-player").dataset.controls).toBe(
      "false",
    );
  });

  it("repairs a legacy React Flow hitbox to match the visible component card", () => {
    let projected = [
      {
        id: baseProps.id,
        width: 420,
        height: 320,
        style: { width: 420, height: 320, zIndex: 1000 },
      },
    ];
    mocks.getNode.mockReturnValue(projected[0]);
    mocks.setNodes.mockImplementationOnce(
      (update: (nodes: typeof projected) => typeof projected) => {
        projected = update(projected);
      },
    );

    renderNode(
      <RemotionComponentNode {...baseProps} width={420} height={320} />,
    );

    expect(projected[0]).toMatchObject({
      width: 281,
      height: 544,
      style: { width: 281, height: 544, zIndex: 1000 },
    });
    expect(mocks.updateNode).toHaveBeenCalledWith(baseProps.id, {
      width: 281,
      height: 544,
      style: { width: 281, height: 544, zIndex: 1000 },
    });
  });

  it("uses a Canvas connection as its only Timeline handoff", () => {
    renderNode();

    expect(screen.getByTestId("source-handle-right")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add to Timeline" }),
    ).toBeNull();
    expect(screen.queryByTestId("timeline-select")).toBeNull();
  });

  it("opens Hilo-homage MG surface with trusted transport (no stock Player controls as chrome)", () => {
    renderNode();

    fireEvent.doubleClick(screen.getByTestId("remotion-component-node"));

    expect(screen.getByTestId("mg-open-surface")).toBeTruthy();
    expect(screen.getByTestId("mg-open-inspector")).toBeTruthy();
    expect(screen.getByTestId("mg-open-transport")).toBeTruthy();
    expect(
      screen.getByTestId("remotion-component-fullscreen-preview"),
    ).toBeTruthy();
    expect(screen.getByTestId("mg-open-stage-remotion")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close Remotion preview" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    const openPlayers = screen
      .getAllByTestId("remotion-player")
      .filter((el) => el.closest('[data-testid="mg-open-surface"]'));
    expect(openPlayers.length).toBeGreaterThan(0);
    expect(openPlayers.every((player) => player.dataset.controls === "false")).toBe(
      true,
    );
  });
});
