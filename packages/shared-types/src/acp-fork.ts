import { z } from "zod";

/** Inclusive boundary: retain the selected assistant response and its preceding context. */
export const AcpForkPointSchema = z.object({
  messageId: z.string().trim().min(1).max(4096),
  messageText: z.string().max(2_000_000),
  messageOccurrence: z.number().int().positive(),
});
export type AcpForkPoint = z.infer<typeof AcpForkPointSchema>;

/**
 * Message-point fork is not ACP `session/fork`. `@openma/common` v0.7.1
 * builds `_meta.jetbrains.air.fork` in `acpForkRequestMeta()` and copies it
 * onto `sessionRequestMeta` without reading it. `supportsSessionFork` is only
 * `agentCapabilities.sessionCapabilities.fork != null`. `agentCapabilities`
 * and `initializeMeta` are exposed, and neither carries a key that means the
 * adapter honors that object. These floors are the versions whose sources
 * were checked for that extension (Codex `SessionFork.ts` at 1.10.0, Claude
 * `fork-session.ts` at 0.75.1). They are not a gate for whole-session fork.
 */
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

/**
 * Error thrown by `@openma/common` v0.7.1 when `session/fork` is requested
 * but initialize omitted `sessionCapabilities.fork` or the agent has no
 * `unstable_forkSession` method.
 */
export const OPENMA_SESSION_FORK_UNSUPPORTED =
  "ACP agent does not support unstable session/fork";

/** Shown when a whole-session fork was requested and the agent did not advertise it. */
export const ACP_SESSION_FORK_UNSUPPORTED =
  "This agent does not advertise ACP session/fork, so Clash cannot fork this session.";

/** Shown when a message boundary was requested from an adapter outside the checked versions. */
export const ACP_MESSAGE_FORK_UNSUPPORTED =
  "This harness version does not support forking at a message. Update the harness first.";

/**
 * Replace the runtime's internal whole-session fork refusal with the
 * user-facing reason. Message-point rejection is separate and happens
 * before the agent is started. Other errors pass through.
 */
export function describeAcpForkFailure(
  message: string,
  requestedFork: boolean,
): string {
  if (requestedFork && message === OPENMA_SESSION_FORK_UNSUPPORTED) {
    return ACP_SESSION_FORK_UNSUPPORTED;
  }
  return message;
}
