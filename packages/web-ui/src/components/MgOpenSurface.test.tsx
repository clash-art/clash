// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  HtmlSceneSurface: ({ frame }: { frame: number }) => (
    <div data-testid="html-scene-surface" data-frame={String(frame)} />
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
  source: "<!doctype html><html><body>Hi</body></html>",
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  documentId: "LowerThird",
};

describe("MgOpenSurface", () => {
  afterEach(cleanup);

  it("renders full-bleed Remotion stage + inspector transport (not a rounded dialog card)", () => {
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
    expect(screen.getByTestId("remotion-player").dataset.controls).toBe(
      "false",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close Remotion preview" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("renders HTML sandboxed stage + inspector seek chrome", () => {
    render(<MgOpenSurface session={htmlSession} onClose={() => {}} />);

    expect(screen.getByTestId("mg-open-surface").getAttribute("data-mg-kind")).toBe(
      "html-motion",
    );
    expect(screen.getByTestId("mg-open-stage-html")).toBeTruthy();
    expect(screen.getByTestId("html-scene-surface")).toBeTruthy();
    expect(screen.getByTestId("mg-open-inspector-name").textContent).toBe(
      "Lower third",
    );
    fireEvent.click(screen.getByTestId("mg-open-play-pause"));
    expect(screen.getByTestId("mg-open-play-pause").textContent).toMatch(
      /Play|Pause/,
    );
  });
});
