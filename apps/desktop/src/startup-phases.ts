import { performance } from "node:perf_hooks";

import type { DesktopControllerLogger } from "./controller/types";

export type DesktopStartupPhase = (
  phase: string,
  context?: Record<string, unknown>,
) => void;

/**
 * Records `desktop.startup_phase` events with milliseconds since this
 * process started (`performance.now()` is process-relative in Node), so a
 * user's log alone shows where a slow launch spent its time.
 */
export function createStartupPhaseRecorder(
  log: Pick<DesktopControllerLogger, "event">,
  now: () => number = () => performance.now(),
): DesktopStartupPhase {
  return (phase, context) => {
    log.event?.("info", "desktop.startup_phase", {
      phase,
      sinceProcessStartMs: Math.round(now()),
      ...context,
    });
  };
}
