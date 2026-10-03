/**
 * TODO: replace with the @openma/common fork-support API.
 *
 * v0.7.1 only exposes `AcpSession.supportsSessionFork`
 * (`agentCapabilities.sessionCapabilities.fork != null`). Inclusive
 * message-point fork is `_meta.jetbrains.air.fork` from `acpForkRequestMeta`,
 * and that release has no initialize key for it. Until the API lands, the
 * message-point offer follows the same advertisement as whole-session fork.
 * Do not add harness names or versions here.
 */
export function supportsMessagePointFork(supportsSessionFork: boolean): boolean {
  return supportsSessionFork;
}
