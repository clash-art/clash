// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InteractiveCanvas } from "../index";

const player = vi.hoisted(() => ({
  listeners: new Map<string, Set<() => void>>(),
  addEventListener: null as null | { mock: { calls: unknown[][] } },
}));

vi.mock("@remotion/player", async () => {
  const ReactModule = await import("react");
  const { vi: mockVi } = await import("vitest");
  player.addEventListener = mockVi.fn((name: string, handler: () => void) => {
    if (!player.listeners.has(name)) player.listeners.set(name, new Set());
    player.listeners.get(name)!.add(handler);
  });
  const handle = {
    addEventListener: player.addEventListener,
    removeEventListener: mockVi.fn((name: string, handler: () => void) => {
      player.listeners.get(name)?.delete(handler);
    }),
    getCurrentFrame: mockVi.fn(() => 7),
    pause: mockVi.fn(),
    play: mockVi.fn(),
    seekTo: mockVi.fn(),
  };
  return {
    Player: ReactModule.forwardRef((_props, ref) => {
      ReactModule.useImperativeHandle(ref, () => handle, []);
      return <div />;
    }),
  };
});

vi.mock("react-moveable", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  player.listeners.clear();
});

it("keeps one set of Player listeners across frame updates and calls the latest callback", () => {
  const draw = (currentFrame: number, onFrameUpdate: (frame: number) => void) => (
    <InteractiveCanvas
      tracks={[]}
      selectedItemId={null}
      currentFrame={currentFrame}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      durationInFrames={300}
      playing
      onFrameUpdate={onFrameUpdate}
      onPlayingChange={() => {}}
      onUpdateItem={() => {}}
    />
  );

  const first = vi.fn();
  const { rerender } = render(draw(0, first));
  const frameListenersAdded = () =>
    player.addEventListener!.mock.calls.filter(([name]) => name === "frameupdate").length;
  const added = frameListenersAdded();

  // A parent re-rendering every frame passes a new inline callback each time.
  const latest = vi.fn();
  for (let frame = 1; frame <= 5; frame += 1) {
    rerender(draw(frame, frame === 5 ? latest : vi.fn()));
  }

  expect(frameListenersAdded()).toBe(added);
  for (const handler of player.listeners.get("frameupdate") ?? []) handler();
  expect(latest).toHaveBeenCalledWith(7);
  expect(first).not.toHaveBeenCalled();
});
