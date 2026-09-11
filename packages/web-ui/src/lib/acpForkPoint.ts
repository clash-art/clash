import type { AcpForkPoint } from "@clash/shared-types";
import type { AgentUITurnState } from "@openma/common/agent-ui";

/** Count identical protocol messages in the visible prefix, not rendered segments. */
export function messageForkPoints(
  turns: readonly AgentUITurnState[],
): Map<string, AcpForkPoint> {
  const result = new Map<string, AcpForkPoint>();
  const occurrences = new Map<string, number>();
  for (const turn of turns) {
    const messages = new Map<string, string>();
    for (const item of turn.items) {
      if (item.kind !== "message" || item.role !== "assistant") continue;
      const id = item.messageId ?? item.id.replace(/:segment:\d+$/, "");
      messages.set(id, (messages.get(id) ?? "") + item.text);
    }
    let last: AcpForkPoint | undefined;
    for (const [messageId, messageText] of messages) {
      const messageOccurrence = (occurrences.get(messageText) ?? 0) + 1;
      occurrences.set(messageText, messageOccurrence);
      last = { messageId, messageText, messageOccurrence };
    }
    if (turn.status === "completed" && last) result.set(turn.id, last);
  }
  return result;
}
