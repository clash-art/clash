// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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

vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({
    updateNode: mocks.updateNode,
  }),
}));

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

  it("renders a distinct html-motion node with a placeholder preview and no HTML-edit chrome", () => {
    render(<HtmlMotionNode {...baseProps} />);

    expect(screen.getByTestId("html-motion-node")).toBeTruthy();
    expect(screen.getByTestId("html-motion-preview").textContent).toMatch(
      /HTML Motion source/,
    );
    expect(screen.queryByRole("button", { name: "Edit HTML" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    expect(screen.getByText("Lower third")).toBeTruthy();
  });
});
