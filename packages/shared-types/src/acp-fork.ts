import { z } from "zod";

/** Inclusive boundary: retain the selected assistant response and its preceding context. */
export const AcpForkPointSchema = z.object({
  messageId: z.string().trim().min(1).max(4096),
  messageText: z.string().max(2_000_000),
  messageOccurrence: z.number().int().positive(),
});
export type AcpForkPoint = z.infer<typeof AcpForkPointSchema>;

/** Verified implementations of the jetbrains.air.fork v1 extension.
 * Codex: SessionFork.ts in 1.10.0; Claude: fork-session.ts in 0.75.1.
 * Plain ACP session/fork alone does not imply support for historical boundaries. */
export function supportsAcpMessageFork(
  name: string | undefined,
  version: string | undefined,
): boolean {
  const minimum =
    name === "codex-acp" || name === "@agentclientprotocol/codex-acp"
      ? [1, 10, 0]
      : name === "claude-acp" ||
          name === "@agentclientprotocol/claude-agent-acp"
        ? [0, 75, 1]
        : undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!minimum || !match) return false;
  for (let index = 0; index < 3; index++) {
    const actual = Number(match[index + 1]);
    if (actual !== minimum[index]) return actual > minimum[index]!;
  }
  return true;
}
