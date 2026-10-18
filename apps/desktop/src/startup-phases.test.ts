import { describe, expect, it } from "vitest";

import { createStartupPhaseRecorder } from "./startup-phases";

describe("createStartupPhaseRecorder", () => {
  it("logs each phase with whole milliseconds since process start and its context", () => {
    const events: unknown[] = [];
    const record = createStartupPhaseRecorder(
      { event: (level, event, context) => events.push({ level, event, context }) },
      () => 1234.6,
    );
    record("host.ready", { startedBy: "desktop" });
    expect(events).toEqual([
      {
        level: "info",
        event: "desktop.startup_phase",
        context: { phase: "host.ready", sinceProcessStartMs: 1235, startedBy: "desktop" },
      },
    ]);
  });
});
