// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setNodes: vi.fn(),
  getNode: vi.fn(),
  updateNode: vi.fn(),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>(
    "@xyflow/react",
  );
  return {
    ...actual,
    useReactFlow: () => ({
      getNode: mocks.getNode,
      setNodes: mocks.setNodes,
    }),
    Handle: () => null,
  };
});

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
    updateNode: mocks.updateNode,
  }),
}));

vi.mock("@clash/remotion-components", () => ({
  HtmlSceneSurface: ({
    source,
    frame,
  }: {
    source: string;
    frame: number;
  }) => (
    <div
      data-testid="html-scene-surface"
      data-source-length={String(source.length)}
      data-frame={String(frame)}
    />
  ),
  RemotionSourceComposition: () => null,
}));

import { MgPreviewProvider } from "../MgPreviewContext";
import HtmlMotionNode, {
  calculateHtmlMotionNodeDimensions,
  DEFAULT_HTML_MOTION_SOURCE,
} from "./HtmlMotionNode";

const baseProps = {
  id: "html-lower-third",
  selected: false,
  type: "html-motion",
  dragging: false,
  draggable: true,
  selectable: true,
  deletable: true,
  zIndex: 1,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  data: {
    label: "Lower third",
    documentId: "LowerThird",
    content: DEFAULT_HTML_MOTION_SOURCE,
    compositionWidth: 1920,
    compositionHeight: 1080,
    fps: 30,
    durationInFrames: 90,
  },
} as const;

function renderNode(ui: React.ReactElement = <HtmlMotionNode {...baseProps} />) {
  return render(<MgPreviewProvider>{ui}</MgPreviewProvider>);
}

describe("HtmlMotionNode", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.updateNode.mockClear();
    mocks.setNodes.mockClear();
    mocks.getNode.mockReset();
  });

  it("sizes the Canvas node from the HTML composition", () => {
    const dimensions = calculateHtmlMotionNodeDimensions(1920, 1080);
    expect(dimensions.width).toBe(dimensions.preview.width);
    expect(dimensions.height).toBeGreaterThan(dimensions.preview.height);
  });

  it("renders a distinct html-motion node with in-node sandboxed paint and no HTML-edit chrome", () => {
    renderNode();

    expect(screen.getByTestId("html-motion-node")).toBeTruthy();
    expect(screen.getByTestId("html-motion-preview")).toBeTruthy();
    expect(
      screen.getAllByTestId("html-scene-surface").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Edit HTML" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    expect(screen.getByText("Lower third")).toBeTruthy();
    expect(
      screen.queryByText(/Double-click for fullscreen/i),
    ).toBeNull();
  });

  it("opens Hilo-homage MG surface (stage + inspector) on double-click without HTML-edit chrome", () => {
    renderNode();

    fireEvent.doubleClick(screen.getByTestId("html-motion-node"));

    expect(screen.getByTestId("mg-open-surface")).toBeTruthy();
    expect(screen.getByTestId("mg-open-inspector")).toBeTruthy();
    expect(screen.getByTestId("mg-open-transport")).toBeTruthy();
    expect(screen.getByTestId("html-motion-fullscreen-preview")).toBeTruthy();
    expect(screen.getByTestId("mg-open-stage-html")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close HTML Motion preview" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit HTML" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
  });
});
