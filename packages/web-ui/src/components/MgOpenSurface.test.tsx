// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    onElementEdit,
  }: {
    frame: number;
    source: string;
    elementEdit?: boolean;
    onElementEdit?: (event: {
      elementId: string;
      patch: { x?: number; y?: number; text?: string };
    }) => void;
  }) => (
    <div
      data-testid="html-scene-surface"
      data-frame={String(frame)}
      data-source-length={String(source.length)}
      data-element-edit={String(Boolean(elementEdit))}
    >
      <button
        type="button"
        data-testid="html-scene-stage-commit"
        onClick={() =>
          onElementEdit?.({ elementId: "title", patch: { x: 99, y: 12 } })
        }
      >
        stage commit
      </button>
    </div>
  ),
}));

import { MgOpenSurface, type MgOpenSession } from "./MgOpenSurface";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

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
    vi.useFakeTimers();
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
    // Local UI updates immediately (input value) without Canvas/loro persist yet.
    expect(
      (screen.getByTestId("mg-open-element-text") as HTMLInputElement).value,
    ).toBe("Edited title");
    expect(mocks.updateNode).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.updateNode).toHaveBeenCalled();
    const last = mocks.updateNode.mock.calls.at(-1);
    expect(last?.[0]).toBe("h1");
    expect(String(last?.[1]?.data?.content ?? "")).toContain("Edited title");
    expect(last?.[1]?.data?.elementOverrides?.title?.text).toBe("Edited title");

    mocks.updateNode.mockClear();
    fireEvent.change(screen.getByTestId("mg-open-element-x"), {
      target: { value: "42" },
    });
    expect(mocks.updateNode).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const afterPos = mocks.updateNode.mock.calls.at(-1);
    expect(String(afterPos?.[1]?.data?.content ?? "")).toMatch(
      /data-mg-x="42"/,
    );
    expect(afterPos?.[1]?.data?.elementOverrides?.title?.x).toBe(42);

    fireEvent.change(screen.getByTestId("mg-open-progress-range"), {
      target: { value: "12" },
    });
    expect(screen.getByTestId("html-scene-surface").dataset.frame).toBe("12");
  });

  it("debounces rapid inspector patches into a single Canvas/loro persist", () => {
    vi.useFakeTimers();
    render(<MgOpenSurface session={htmlSession} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "A" },
    });
    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "AB" },
    });
    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "ABC" },
    });

    expect(mocks.updateNode).not.toHaveBeenCalled();
    expect(mocks.setNodes).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(mocks.updateNode).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    expect(mocks.setNodes).toHaveBeenCalledTimes(1);
    expect(String(mocks.updateNode.mock.calls[0]?.[1]?.data?.content ?? "")).toContain(
      "ABC",
    );
    expect(
      mocks.updateNode.mock.calls[0]?.[1]?.data?.elementOverrides?.title?.text,
    ).toBe("ABC");
  });

  it("flushes pending inspector draft on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <MgOpenSurface session={htmlSession} onClose={() => {}} />,
    );

    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "Persist on close" },
    });
    expect(mocks.updateNode).not.toHaveBeenCalled();

    unmount();
    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    expect(String(mocks.updateNode.mock.calls[0]?.[1]?.data?.content ?? "")).toContain(
      "Persist on close",
    );
    expect(
      mocks.updateNode.mock.calls[0]?.[1]?.data?.elementOverrides?.title?.text,
    ).toBe("Persist on close");
  });

  it("flushes pending inspector draft when closing the surface", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<MgOpenSurface session={htmlSession} onClose={onClose} />);

    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "Flush on X" },
    });
    expect(mocks.updateNode).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Close HTML Motion preview" }),
    );
    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    expect(String(mocks.updateNode.mock.calls[0]?.[1]?.data?.content ?? "")).toContain(
      "Flush on X",
    );
    expect(
      mocks.updateNode.mock.calls[0]?.[1]?.data?.elementOverrides?.title?.text,
    ).toBe("Flush on X");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("skips persist when draft matches last written overrides", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <MgOpenSurface session={htmlSession} onClose={() => {}} />,
    );

    fireEvent.change(screen.getByTestId("mg-open-element-text"), {
      target: { value: "Same" },
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    mocks.updateNode.mockClear();
    mocks.setNodes.mockClear();

    // No further edits — unmount should not rewrite identical content.
    unmount();
    expect(mocks.updateNode).not.toHaveBeenCalled();
    expect(mocks.setNodes).not.toHaveBeenCalled();
  });

  it("persists stage pointerup commits immediately (one-shot)", () => {
    vi.useFakeTimers();
    render(<MgOpenSurface session={htmlSession} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("html-scene-stage-commit"));
    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    expect(String(mocks.updateNode.mock.calls[0]?.[1]?.data?.content ?? "")).toMatch(
      /data-mg-x="99"/,
    );
    expect(mocks.updateNode.mock.calls[0]?.[1]?.data?.elementOverrides?.title).toMatchObject(
      { x: 99, y: 12 },
    );
  });

  it("loads session elementOverrides into draft without rewriting Canvas until edit", () => {
    vi.useFakeTimers();
    const sessionWithOverrides = {
      ...htmlSession,
      elementOverrides: { title: { text: "From map", x: 7, y: 8 } },
    };
    render(<MgOpenSurface session={sessionWithOverrides} onClose={() => {}} />);
    expect(
      (screen.getByTestId("mg-open-element-text") as HTMLInputElement).value,
    ).toBe("From map");
    expect(
      (screen.getByTestId("mg-open-element-x") as HTMLInputElement).value,
    ).toBe("7");
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });

  it("keeps MG element autosave delay aligned with text document autosave", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "MgOpenSurface.tsx"), "utf8");
    expect(source).toContain("MG_ELEMENT_AUTOSAVE_DELAY_MS = 500");
  });
});
