import { describe, expect, it } from "vitest";
import {
  LONG_TASK_THRESHOLD_MS,
  createLongTaskRecorder,
  summarizeLongTasks,
} from "./metrics";

describe("preview isolation metric", () => {
  it("summarizes observed long tasks", () => {
    const metric = summarizeLongTasks({
      scenario: "remotion-timeline-1080p",
      hostMode: "main-thread",
      windowMs: 4000,
      durations: [120, 80.4, 60],
    });
    expect(metric).toEqual({
      scenario: "remotion-timeline-1080p",
      hostMode: "main-thread",
      longTasks: 3,
      totalLongTaskMs: 260,
      longestLongTaskMs: 120,
      windowMs: 4000,
    });
  });

  it("reports no long tasks for a thread that stayed responsive", () => {
    const metric = summarizeLongTasks({
      scenario: "remotion-timeline-1080p",
      hostMode: "iframe",
      windowMs: 4000,
      durations: [],
    });
    expect(metric.longTasks).toBe(0);
    expect(metric.totalLongTaskMs).toBe(0);
    expect(metric.longestLongTaskMs).toBe(0);
  });

  it("ignores values that are not measurements", () => {
    const metric = summarizeLongTasks({
      scenario: "remotion-timeline-1080p",
      hostMode: "iframe",
      windowMs: 1000,
      durations: [Number.NaN, 90, Infinity],
    });
    expect(metric.longTasks).toBe(1);
    expect(metric.totalLongTaskMs).toBe(90);
  });

  it("records the long tasks observed during the window", () => {
    let clock = 1000;
    const recorder = createLongTaskRecorder({
      scenario: "remotion-timeline-1080p",
      hostMode: "iframe",
      now: () => clock,
      observe: (onEntry) => {
        onEntry(150);
        onEntry(70);
        return { disconnect: () => undefined };
      },
    });
    clock = 5000;
    const metric = recorder.stop();
    expect(metric).toEqual({
      scenario: "remotion-timeline-1080p",
      hostMode: "iframe",
      longTasks: 2,
      totalLongTaskMs: 220,
      longestLongTaskMs: 150,
      windowMs: 4000,
    });
  });

  it("uses the long task threshold the browser uses", () => {
    expect(LONG_TASK_THRESHOLD_MS).toBe(50);
  });
});
