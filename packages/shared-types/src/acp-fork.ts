import { z } from "zod";

/** Inclusive boundary: retain the selected assistant response and its preceding context. */
export const AcpForkPointSchema = z.object({
  messageId: z.string().trim().min(1).max(4096),
  messageText: z.string().max(2_000_000),
  messageOccurrence: z.number().int().positive(),
});
export type AcpForkPoint = z.infer<typeof AcpForkPointSchema>;

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

/**
 * Replace the runtime's fork refusal with the user-facing reason.
 * Capability detection stays in @openma/common. Other errors pass through.
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
