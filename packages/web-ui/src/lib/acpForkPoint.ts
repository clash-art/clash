import {
  acpForkPointsFromMessages,
  type AcpForkPoint,
} from "@openma/common/acp-runtime";
import type { AgentUITurnState } from "@openma/common/agent-ui";

/** Map completed turns onto fork points. Segment ids are collapsed before
 * `@openma/common` numbers identical assistant text. */
export function messageForkPoints(
  turns: readonly AgentUITurnState[],
): Map<string, AcpForkPoint> {
  const flat: Array<{ turnId: string | null; messageId: string; text: string }> = [];
  for (const turn of turns) {
    const messages = new Map<string, string>();
    for (const item of turn.items) {
      if (item.kind !== "message" || item.role !== "assistant") continue;
      const id = item.messageId ?? item.id.replace(/:segment:\d+$/, "");
      messages.set(id, (messages.get(id) ?? "") + item.text);
    }
    const entries = [...messages];
    entries.forEach(([messageId, text], index) => {
      flat.push({
        turnId:
          turn.status === "completed" && index === entries.length - 1
            ? turn.id
            : null,
        messageId,
        text,
      });
    });
  }
  const points = acpForkPointsFromMessages(
    flat.map(({ messageId, text }) => ({ messageId, text })),
  );
  const result = new Map<string, AcpForkPoint>();
  flat.forEach((message, index) => {
    const point = points[index];
    if (message.turnId && point) result.set(message.turnId, point);
  });
  return result;
}
