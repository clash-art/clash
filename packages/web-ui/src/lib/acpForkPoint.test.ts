import { describe, expect, it } from "vitest";
import { messageForkPoints } from "./acpForkPoint";
import type { AgentUITurnState } from "@openma/common/agent-ui";

describe("historical fork boundaries", () => {
  it("counts identical replies and combines split segments without including later replies", () => {
    const turns: AgentUITurnState[] = [
      {
        id: "old",
        status: "completed",
        items: [
          {
            id: "a:segment:0",
            messageId: "a",
            kind: "message",
            role: "assistant",
            status: "complete",
            text: "he",
          },
          {
            id: "a:segment:1",
            messageId: "a",
            kind: "message",
            role: "assistant",
            status: "complete",
            text: "llo",
          },
        ],
      },
      {
        id: "next",
        status: "completed",
        items: [
          {
            id: "b",
            kind: "message",
            role: "assistant",
            status: "complete",
            text: "hello",
          },
        ],
      },
      { id: "running", status: "running", items: [] },
    ];
    const points = messageForkPoints(turns);
    expect(points.get("old")).toEqual({
      messageId: "a",
      messageText: "hello",
      messageOccurrence: 1,
    });
    expect(points.get("next")).toEqual({
      messageId: "b",
      messageText: "hello",
      messageOccurrence: 2,
    });
    expect(points.has("running")).toBe(false);
  });
});
