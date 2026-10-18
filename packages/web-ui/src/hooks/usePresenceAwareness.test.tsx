// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AwarenessBroadcastMessage } from "@clash/shared-types";
import {
  ACTIVE_WINDOW_MS,
  HEARTBEAT_MS,
  PEER_STALE_MS,
  usePresenceAwareness,
} from "./usePresenceAwareness";

interface AwarenessFrame {
  type: string;
  cursor: { x: number; y: number } | null;
  selectedNodeIds: string[];
}

let visibilityState: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
    // A heartbeat schedules its forced send with a zero-delay coalescing timer.
    vi.advanceTimersByTime(0);
  });
}

function awarenessFrames(sendSideband: ReturnType<typeof vi.fn>): AwarenessFrame[] {
  return sendSideband.mock.calls
    .map(([msg]) => msg as AwarenessFrame)
    .filter((msg) => msg.type === "awareness.update");
}

function renderPresence() {
  let deliver: ((msg: AwarenessBroadcastMessage) => void) | null = null;
  const registerOnAwareness = (
    handler: ((msg: AwarenessBroadcastMessage) => void) | null,
  ) => {
    deliver = handler;
  };
  const sendSideband = vi.fn();
  const view = renderHook(() =>
    usePresenceAwareness({ registerOnAwareness, sendSideband }),
  );
  return { ...view, sendSideband, deliver: () => deliver };
}

function peer(clientId: string): AwarenessBroadcastMessage {
  return {
    type: "awareness.broadcast",
    users: [
      {
        clientId,
        userId: "ann",
        userName: "Ann",
        kind: "human",
        cursor: { x: 1, y: 1 },
        selectedNodeIds: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("usePresenceAwareness", () => {
  it("keeps one peer per connection, so a user's other window and agent both show", () => {
    const { result, deliver } = renderPresence();

    act(() =>
      deliver()?.({
        type: "awareness.broadcast",
        users: [
          {
            clientId: "window",
            userId: "ann",
            userName: "Ann",
            kind: "human",
            cursor: { x: 1, y: 1 },
            selectedNodeIds: [],
          },
          {
            clientId: "agent",
            userId: "ann",
            userName: "Ann",
            kind: "agent",
            cursor: { x: 2, y: 2 },
            selectedNodeIds: ["node"],
          },
        ],
      }),
    );

    const peers = result.current.peers;
    expect(peers.map((p) => [p.clientId, p.kind])).toEqual([
      ["window", "human"],
      ["agent", "agent"],
    ]);
    expect(peers[1].color).toBe(peers[0].color);
    expect(peers[1].userName).toBe(peers[0].userName);
  });

  it("resends a still cursor every heartbeat while the tab is visible and active", () => {
    const { result, sendSideband } = renderPresence();

    act(() => result.current.setLocalCursor({ x: 10, y: 20 }));
    advance(0);
    expect(awarenessFrames(sendSideband)).toHaveLength(1);

    sendSideband.mockClear();
    for (let beat = 1; beat <= 2; beat++) {
      advance(HEARTBEAT_MS);
      const frames = awarenessFrames(sendSideband);
      expect(frames).toHaveLength(beat);
      expect(frames.at(-1)).toMatchObject({ cursor: { x: 10, y: 20 } });
    }

    // A still cursor stays alive as long as the user remains active.
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
    });
    sendSideband.mockClear();
    advance(HEARTBEAT_MS);
    expect(awarenessFrames(sendSideband)).toEqual([
      {
        type: "awareness.update",
        cursor: { x: 10, y: 20 },
        selectedNodeIds: [],
      },
    ]);
  });

  it("sends one clear frame when hidden and no heartbeats afterwards", () => {
    const { result, sendSideband } = renderPresence();

    act(() => result.current.setLocalCursor({ x: 1, y: 2 }));
    advance(0);
    sendSideband.mockClear();

    setVisibility("hidden");
    expect(awarenessFrames(sendSideband)).toEqual([
      { type: "awareness.update", cursor: null, selectedNodeIds: [] },
    ]);

    sendSideband.mockClear();
    advance(5 * 60_000);
    expect(awarenessFrames(sendSideband)).toHaveLength(0);
  });

  it("sends one clear frame after the activity window lapses, then stays quiet", () => {
    const { result, sendSideband } = renderPresence();

    act(() => result.current.setLocalCursor({ x: 3, y: 4 }));
    advance(0);
    sendSideband.mockClear();

    // Still active at 20s and 40s.
    advance(2 * HEARTBEAT_MS);
    expect(awarenessFrames(sendSideband)).toHaveLength(2);
    expect(awarenessFrames(sendSideband).at(-1)?.cursor).toEqual({ x: 3, y: 4 });

    sendSideband.mockClear();
    // The 60s tick sees no input in the last ACTIVE_WINDOW_MS.
    advance(ACTIVE_WINDOW_MS - 2 * HEARTBEAT_MS);
    expect(awarenessFrames(sendSideband)).toEqual([
      { type: "awareness.update", cursor: null, selectedNodeIds: [] },
    ]);

    sendSideband.mockClear();
    advance(5 * 60_000);
    expect(awarenessFrames(sendSideband)).toHaveLength(0);
  });

  it("resends the current cursor and selection immediately on input after away", () => {
    const { result, sendSideband } = renderPresence();

    act(() => {
      result.current.setLocalCursor({ x: 7, y: 8 });
      result.current.setLocalSelection(["node-a", "node-b"]);
    });
    advance(0);
    sendSideband.mockClear();

    advance(ACTIVE_WINDOW_MS);
    expect(awarenessFrames(sendSideband).at(-1)).toEqual({
      type: "awareness.update",
      cursor: null,
      selectedNodeIds: [],
    });

    sendSideband.mockClear();
    act(() => {
      window.dispatchEvent(new Event("keydown"));
    });
    advance(0);
    expect(awarenessFrames(sendSideband)).toEqual([
      {
        type: "awareness.update",
        cursor: { x: 7, y: 8 },
        selectedNodeIds: ["node-a", "node-b"],
      },
    ]);
  });

  it("resends the current state when the tab becomes visible again", () => {
    const { result, sendSideband } = renderPresence();

    act(() => result.current.setLocalSelection(["node-a"]));
    advance(0);
    setVisibility("hidden");
    expect(awarenessFrames(sendSideband).at(-1)).toEqual({
      type: "awareness.update",
      cursor: null,
      selectedNodeIds: [],
    });

    sendSideband.mockClear();
    setVisibility("visible");
    advance(0);
    expect(awarenessFrames(sendSideband)).toEqual([
      {
        type: "awareness.update",
        cursor: null,
        selectedNodeIds: ["node-a"],
      },
    ]);
  });

  it("never prunes a peer refreshed every heartbeat because PEER_STALE_MS has margin", () => {
    expect(PEER_STALE_MS).toBeGreaterThan(HEARTBEAT_MS);
    const { result, deliver } = renderPresence();

    act(() => deliver()?.(peer("window")));
    expect(result.current.peers).toHaveLength(1);

    for (let cycle = 0; cycle < 12; cycle++) {
      advance(HEARTBEAT_MS);
      act(() => deliver()?.(peer("window")));
      // The 2s sweep runs several times within each heartbeat cycle.
      advance(2_000);
      expect(result.current.peers.map((p) => p.clientId)).toEqual(["window"]);
    }
  });
});
