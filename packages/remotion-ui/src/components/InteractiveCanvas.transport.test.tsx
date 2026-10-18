// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InteractiveCanvas } from "../index";
import { PLAYER_STALL_TIMEOUT_MS } from "./playerTransport";

type Listener = (event: { detail: unknown }) => void;
const player = vi.hoisted(() => ({
  listeners: new Map<string, Set<Listener>>(),
  playing: false,
  inputProps: null as null | { onMediaError?: (e: { src: string; message: string }) => void },
  pause: null as null | { mock: { calls: unknown[][] } },
}));

vi.mock("@remotion/player", async () => {
  const ReactModule = await import("react");
  const { vi: mockVi } = await import("vitest");
  const emit = (name: string, detail?: unknown) => {
    for (const handler of player.listeners.get(name) ?? []) handler({ detail });
  };
  const pause = mockVi.fn(() => {
    if (!player.playing) return;
    player.playing = false;
    emit("pause");
  });
  player.pause = pause;
  const handle = {
    addEventListener: (name: string, handler: Listener) => {
      if (!player.listeners.has(name)) player.listeners.set(name, new Set());
      player.listeners.get(name)!.add(handler);
    },
    removeEventListener: (name: string, handler: Listener) => {
      player.listeners.get(name)?.delete(handler);
    },
    getCurrentFrame: () => 0,
    isPlaying: () => player.playing,
    pause,
    play: () => {
      player.playing = true;
      emit("play");
    },
    seekTo: () => {},
  };
  return {
    Player: ReactModule.forwardRef((props: { inputProps: typeof player.inputProps }, ref) => {
      player.inputProps = props.inputProps;
      ReactModule.useImperativeHandle(ref, () => handle, []);
      return <div />;
    }),
  };
});

vi.mock("react-moveable", () => ({ default: () => null }));

const emit = (name: string, detail?: unknown) => {
  for (const handler of player.listeners.get(name) ?? []) handler({ detail });
};

beforeEach(() => {
  vi.useFakeTimers();
  player.playing = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  player.listeners.clear();
});

function mount() {
  const events: Array<{ type: string; message?: string }> = [];
  const playingChanges: boolean[] = [];
  const draw = (playing: boolean) => (
    <InteractiveCanvas
      tracks={[]}
      selectedItemId={null}
      currentFrame={0}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      durationInFrames={300}
      playing={playing}
      onPlayingChange={(next) => playingChanges.push(next)}
      onTransportEvent={(event) => events.push(event)}
      onUpdateItem={() => {}}
    />
  );
  // Mount paused, then request play like the editor does.
  const { rerender } = render(draw(false));
  rerender(draw(true));
  return { events, playingChanges };
}

it("reports buffering and turns a stall that never resolves into a paused error", () => {
  const { events, playingChanges } = mount();
  expect(player.playing).toBe(true);

  act(() => emit("waiting"));
  expect(events.at(-1)).toEqual({ type: "waiting" });

  act(() => vi.advanceTimersByTime(PLAYER_STALL_TIMEOUT_MS - 1));
  expect(player.playing).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  expect(player.playing).toBe(false);
  expect(playingChanges.at(-1)).toBe(false);
});

it("a buffering stall that resolves keeps playing", () => {
  const { events } = mount();
  act(() => emit("waiting"));
  act(() => emit("resume"));
  act(() => vi.advanceTimersByTime(PLAYER_STALL_TIMEOUT_MS * 2));
  expect(events.map((event) => event.type)).not.toContain("error");
  expect(player.playing).toBe(true);
});

it("a terminal media failure is an explicit error and stops the clock", () => {
  const { events, playingChanges } = mount();
  act(() =>
    player.inputProps!.onMediaError!({
      src: "https://media.example/clip-performance-4k.mp4?sig=1",
      message: "Code 4",
    }),
  );
  // The message names the failing file (not the signed URL) and keeps the cause.
  const error = events.find((event) => event.type === "error")!;
  expect(error.message).toContain("clip-performance-4k.mp4");
  expect(error.message).toContain("Code 4");
  expect(error.message).not.toContain("sig=1");
  expect(player.playing).toBe(false);
  expect(playingChanges.at(-1)).toBe(false);
});

it("a render error inside the Player is reported and leaves the editor paused", () => {
  const { events, playingChanges } = mount();
  act(() => emit("error", { error: new Error("boom") }));
  expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  expect(playingChanges.at(-1)).toBe(false);
});
