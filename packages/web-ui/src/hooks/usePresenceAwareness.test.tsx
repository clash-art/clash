// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AwarenessBroadcastMessage } from "@clash/shared-types";
import { usePresenceAwareness } from "./usePresenceAwareness";

describe("usePresenceAwareness", () => {
  it("keeps one peer per connection, so a user's other window and agent both show", () => {
    let deliver: ((msg: AwarenessBroadcastMessage) => void) | null = null;
    const registerOnAwareness = (
      handler: ((msg: AwarenessBroadcastMessage) => void) | null,
    ) => {
      deliver = handler;
    };
    const sendSideband = vi.fn();
    const { result } = renderHook(() =>
      usePresenceAwareness({ registerOnAwareness, sendSideband }),
    );

    act(() =>
      deliver?.({
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
    expect(peers.map((peer) => [peer.clientId, peer.kind])).toEqual([
      ["window", "human"],
      ["agent", "agent"],
    ]);
    expect(peers[1].color).toBe(peers[0].color);
    expect(peers[1].userName).toBe(peers[0].userName);
  });
});
