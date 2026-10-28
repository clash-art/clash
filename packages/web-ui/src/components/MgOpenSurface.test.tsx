// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setNodes: vi.fn(),
  updateNode: vi.fn(),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>(
    "@xyflow/react",
  );
  return {
    ...actual,
    useReactFlow: () => ({
      setNodes: mocks.setNodes,
    }),
  };
});

vi.mock("./LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({
    updateNode: mocks.updateNode,
  }),
}));

vi.mock("./ui/dialog", () => ({
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

vi.mock("@remotion/player", () => ({
  Player: ({
    controls,
  }: {
    controls?: boolean;
  }) => (
    <div
      data-testid="remotion-player"
      data-controls={String(Boolean(controls))}
    />
  ),
}));

vi.mock("@clash/remotion-components", () => ({
  RemotionSourceComposition: () => null,
  HtmlSceneSurface: ({
    frame,
    source,
    elementEdit,
  }: {
    frame: number;
    source: string;
    elementEdit?: boolean;
  }) => (
    <div
      data-testid="html-scene-surface"
      data-frame={String(frame)}
      data-source-length={String(source.length)}
      data-element-edit={String(Boolean(elementEdit))}
    />
  ),
}));

import { MgOpenSurface, type MgOpenSession } from "./MgOpenSurface";

const remotionSession: MgOpenSession = {
  nodeId: "r1",
  kind: "remotion-component",
  label: "Greeting",
  source: "export default function(){return null}",
  width: 720,
  height: 1280,
  fps: 30,
  durationInFrames: 90,
  componentId: "Greeting",
};

const htmlSession: MgOpenSession = {
  nodeId: "h1",
  kind: "html-motion",
  label: "Lower third",
  source: `<!doctype html><html><body>
    <h1 data-mg-id="title" data-mg-editable="text,position" data-mg-x="0" data-mg-y="0">Hi</h1>
  </body></html>`,
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  documentId: "LowerThird",
};

describe("MgOpenSurface", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.setNodes.mockClear();
    mocks.updateNode.mockClear();
  });

  it("renders full-bleed Remotion stage + inspector transport + bottom progress bar", () => {
    const onClose = vi.fn();
    render(<MgOpenSurface session={remotionSession} onClose={onClose} />);

    const surface = screen.getByTestId("mg-open-surface");
    expect(surface.getAttribute("data-mg-kind")).toBe("remotion-component");
    expect(screen.getByTestId("mg-open-inspector")).toBeTruthy();
    expect(screen.getByTestId("mg-open-inspector-meta").textContent).toMatch(
      /720 × 1280/,
    );
    expect(screen.getByTestId("mg-open-transport")).toBeTruthy();
    expect(screen.getByTestId("mg-open-play-pause")).toBeTruthy();
    expect(screen.getByTestId("mg-open-progress-bar")).toBeTruthy();
    expect(screen.getByTestId("mg-open-progress-range")).toBeTruthy();
    expect(screen.getByTestId("remotion-player").dataset.controls).toBe(
      "false",
    );
    expect(screen.getByTestId("mg-open-remotion-element-note")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Close Remotion preview" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("renders HTML stage with progress bar and element text/position inspector", () => {
    render(<MgOpenSurface session={htmlSession} onClose={() => {}} />);

    expect(screen.getByTestId("mg-open-surface").getAttribute("data-mg-kind")).toBe(
      "html-motion",
    );
    expect(screen.getByTestId("mg-open-stage-html")).toBeTruthy();
    expect(screen.getByTestId("html-scene-surface").dataset.elementEdit).toBe(
      "true",
    );
    expect(screen.getByTestId("mg-open-progress-bar")).toBeTruthy();
    expect(screen.getByTestId("mg-open-element-inspector")).toBeTruthy();
    expect(screen.getByTestId("mg-open-element-text")).toBeTruthy();
    expect(screen.getByTestId("mg-open-element-x")).toBeTruthy();
    expect(screen.getByTestId("mg-open-element-y")).toBeTruthy();

    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "Edited title" },
    });
    expect(mocks.updateNode).toHaveBeenCalled();
    const last = mocks.updateNode.mock.calls.at(-1);
    expect(last?.[0]).toBe("h1");
    expect(String(last?.[1]?.data?.content ?? "")).toContain("Edited title");

    fireEvent.change(screen.getByTestId("mg-open-element-x"), {
      target: { value: "42" },
    });
    const afterPos = mocks.updateNode.mock.calls.at(-1);
    expect(String(afterPos?.[1]?.data?.content ?? "")).toMatch(
      /data-mg-x="42"/,
    );

    fireEvent.change(screen.getByTestId("mg-open-progress-range"), {
      target: { value: "12" },
    });
    expect(screen.getByTestId("html-scene-surface").dataset.frame).toBe("12");
  });
});
