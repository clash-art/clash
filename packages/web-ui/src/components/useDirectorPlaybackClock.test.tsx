// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIRECTOR_PLAYHEAD_UI_HZ, useDirectorPlaybackClock } from "./useDirectorPlaybackClock";

let frameCallbacks: FrameRequestCallback[] = [];
let now = 0;

beforeEach(() => {
  frameCallbacks = [];
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frameCallbacks = [];
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function advanceFrames(count: number, frameMs = 1000 / 60) {
  for (let index = 0; index < count; index += 1) {
    now += frameMs;
    const pending = frameCallbacks;
    frameCallbacks = [];
    act(() => pending.forEach((callback) => callback(now)));
  }
}

it("advances the clock every frame but publishes React state at the UI rate", () => {
  const renders: number[] = [];
  let clock: { readonly current: number } | undefined;
  let seek: ((seconds: number) => void) | undefined;
  let setPlaying: ((playing: boolean) => void) | undefined;
  const Probe = () => {
    const [playing, setPlayingState] = useState(true);
    const [playheadSeconds, setPlayheadSeconds] = useState(0);
    clock = useDirectorPlaybackClock({ playing, durationSeconds: 10, playheadSeconds, setPlayheadSeconds });
    seek = setPlayheadSeconds;
    setPlaying = setPlayingState;
    renders.push(playheadSeconds);
    return null;
  };
  render(<Probe />);
  const initialRenders = renders.length;

  advanceFrames(60);

  expect(clock!.current).toBeCloseTo(1, 5);
  const publishes = renders.length - initialRenders;
  // Product requirement: UI follows playback at 10-15 Hz, never per frame.
  expect(publishes).toBeGreaterThanOrEqual(10);
  expect(publishes).toBeLessThanOrEqual(Math.min(15, DIRECTOR_PLAYHEAD_UI_HZ));

  // A seek during playback moves the clock.
  act(() => seek!(4));
  advanceFrames(1);
  expect(clock!.current).toBeCloseTo(4 + 1 / 60, 5);

  // Stopping publishes the exact clock value.
  act(() => setPlaying!(false));
  expect(renders.at(-1)).toBeCloseTo(clock!.current, 5);
});
