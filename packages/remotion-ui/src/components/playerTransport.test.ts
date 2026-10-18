import { describe, expect, it } from "vitest";
import {
  initialPlayerTransportState,
  playerTransportIsActive,
  playerTransportReducer,
  type PlayerTransportEvent,
} from "./playerTransport";

const run = (...events: PlayerTransportEvent[]) =>
  events.reduce(playerTransportReducer, initialPlayerTransportState);

describe("player transport state", () => {
  it("follows play, buffering and resume reported by the Player", () => {
    expect(run({ type: "play" }).status).toBe("playing");
    expect(run({ type: "play" }, { type: "waiting" }).status).toBe("buffering");
    expect(run({ type: "play" }, { type: "waiting" }, { type: "resume" }).status).toBe("playing");
    expect(run({ type: "play" }, { type: "ended" }).status).toBe("paused");
  });

  it("does not report buffering for a paused seek", () => {
    expect(run({ type: "waiting" }).status).toBe("paused");
  });

  it("reports buffering that started while paused once playback is requested", () => {
    const paused = run({ type: "waiting" });
    expect(paused.status).toBe("paused");
    expect(playerTransportReducer(paused, { type: "play" }).status).toBe("buffering");
    expect(run({ type: "waiting" }, { type: "play" }, { type: "resume" }).status).toBe("playing");
    expect(run({ type: "waiting" }, { type: "resume" }, { type: "play" }).status).toBe("playing");
  });

  it("keeps an error visible through the pause that stops the clock", () => {
    const state = run({ type: "play" }, { type: "waiting" }, { type: "error", message: "stalled" }, { type: "pause" });
    expect(state).toMatchObject({ status: "error", error: "stalled" });
    expect(playerTransportIsActive(state.status)).toBe(false);
    // A stray play event cannot hide the error; only an explicit retry clears it.
    expect(playerTransportReducer(state, { type: "play" }).status).toBe("error");
    expect(run({ type: "error", message: "x" }, { type: "retry" }, { type: "play" }).status).toBe("playing");
  });

  it("treats buffering as active so the button offers Pause", () => {
    expect(playerTransportIsActive("buffering")).toBe(true);
    expect(playerTransportIsActive("paused")).toBe(false);
  });
});
