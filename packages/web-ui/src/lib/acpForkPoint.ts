import type { AcpForkPoint } from "@openma/common/acp-runtime";
import type { AgentUITurnState } from "@openma/common/agent-ui";

/**
 * Fork points for completed turns. Segment ids are collapsed here because
 * `acpForkPointsFromMessages` lives in `@openma/common/acp-runtime`, whose
 * module imports `node:crypto` and cannot be bundled for the renderer.
 * Occurrence counting matches that function: 1-based identical text in order.
 */
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
