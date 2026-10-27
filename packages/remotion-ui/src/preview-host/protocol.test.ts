import { describe, expect, it } from "vitest";
import {
  PREVIEW_HOST_PROTOCOL,
  isPreviewHostCommand,
  isPreviewHostEvent,
} from "./protocol";
import {
  playerTransportReducer,
  initialPlayerTransportState,
  type PlayerTransportEvent,
} from "../components/playerTransport";

const command = (value: unknown) => ({
  protocol: PREVIEW_HOST_PROTOCOL,
  ...(value as Record<string, unknown>),
});

describe("preview host protocol", () => {
  it("accepts the transport intent commands the editor sends", () => {
    expect(isPreviewHostCommand(command({ type: "play" }))).toBe(true);
    expect(isPreviewHostCommand(command({ type: "pause" }))).toBe(true);
    expect(isPreviewHostCommand(command({ type: "unmount" }))).toBe(true);
    expect(isPreviewHostCommand(command({ type: "seek", frame: 42 }))).toBe(true);
    expect(
      isPreviewHostCommand(
        command({
          type: "mount",
          parentOrigin: "http://localhost:5173",
          composition: {
            width: 1920,
            height: 1080,
            fps: 30,
            durationInFrames: 300,
            tracks: [],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isPreviewHostCommand(
        command({
          type: "mount",
          composition: {
            width: 1920,
            height: 1080,
            fps: 30,
            durationInFrames: 300,
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects commands from another protocol or with a broken payload", () => {
    expect(
      isPreviewHostCommand({
        protocol: "clash.timeline-render.v1",
        type: "play",
      }),
    ).toBe(false);
    expect(isPreviewHostCommand(command({ type: "seek" }))).toBe(false);
    expect(isPreviewHostCommand(command({ type: "seek", frame: "12" }))).toBe(
      false,
    );
    expect(isPreviewHostCommand(command({ type: "mount" }))).toBe(false);
    expect(
      isPreviewHostCommand(
        command({
          type: "mount",
          composition: { width: 1920, height: 1080, fps: 30 },
        }),
      ),
    ).toBe(false);
    expect(isPreviewHostCommand(command({ type: "rewind" }))).toBe(false);
  });

  it("accepts the facts a hosted producer reports", () => {
    expect(isPreviewHostEvent(command({ type: "ready" }))).toBe(true);
    expect(isPreviewHostEvent(command({ type: "frame", frame: 7 }))).toBe(true);
    expect(
      isPreviewHostEvent(
        command({ type: "transport", event: { type: "waiting" } }),
      ),
    ).toBe(true);
    expect(
      isPreviewHostEvent(command({ type: "error", message: "boom" })),
    ).toBe(true);
  });

  it("rejects an unknown transport fact and the editor-only retry action", () => {
    expect(
      isPreviewHostEvent(
        command({ type: "transport", event: { type: "scrubbing" } }),
      ),
    ).toBe(false);
    // `retry` remounts the editor's own media; it never crosses the boundary.
    expect(
      isPreviewHostEvent(
        command({ type: "transport", event: { type: "retry" } }),
      ),
    ).toBe(false);
  });
});

describe("preview transport vocabulary", () => {
  it("feeds the editor transport reducer with the facts the host reports", () => {
    const facts: PlayerTransportEvent[] = [
      { type: "play" },
      { type: "waiting" },
      { type: "resume" },
      { type: "ended" },
    ];
    const state = facts.reduce(
      playerTransportReducer,
      initialPlayerTransportState,
    );
    expect(state.status).toBe("paused");
  });

  it("keeps an error reported by a hosted producer visible", () => {
    const state = playerTransportReducer(initialPlayerTransportState, {
      type: "error",
      message: "media failed",
    });
    expect(state).toMatchObject({ status: "error", error: "media failed" });
  });
});
