/**
 * The metric API the preview isolation work is measured with.
 *
 * The numbers that matter for this work are main-thread long tasks: a task
 * longer than 50 ms blocks the editor's UI thread, which is exactly what
 * moving preview frame production off that thread is meant to stop.
 *
 * `summarizeLongTasks` is the whole contract and is unit tested. The browser
 * harness (`apps/web/e2e/preview-iframe-longtask.ts`) collects the raw
 * durations with a `PerformanceObserver` and reports them through this shape,
 * so a measurement and a test speak the same language.
 */
import type { PreviewHostMode } from "./types";

export interface PreviewMainThreadMetric {
  /** What was measured, e.g. `"remotion-timeline-1080p"`. */
  scenario: string;
  /** Where the producer ran while the metric was collected. */
  hostMode: PreviewHostMode;
  /** Number of long tasks (over 50 ms) observed on the measured thread. */
  longTasks: number;
  /** Sum of the long task durations, in milliseconds. */
  totalLongTaskMs: number;
  /** Longest single long task, in milliseconds. */
  longestLongTaskMs: number;
  /** Wall-clock length of the measured window, in milliseconds. */
  windowMs: number;
}

export interface LongTaskSummaryInput {
  scenario: string;
  hostMode: PreviewHostMode;
  windowMs: number;
  /** Durations of the observed long tasks, in milliseconds. */
  durations: number[];
}

/**
 * Reduces observed long task durations to the reported metric. Rounding keeps
 * two runs of the same scenario comparable in a diff.
 */
export function summarizeLongTasks(
  input: LongTaskSummaryInput,
): PreviewMainThreadMetric {
  const durations = input.durations.filter(
    (duration) => typeof duration === "number" && Number.isFinite(duration),
  );
  const totalLongTaskMs = durations.reduce(
    (total, duration) => total + duration,
    0,
  );
  const longestLongTaskMs = durations.reduce(
    (longest, duration) => (duration > longest ? duration : longest),
    0,
  );
  return {
    scenario: input.scenario,
    hostMode: input.hostMode,
    longTasks: durations.length,
    totalLongTaskMs: Math.round(totalLongTaskMs),
    longestLongTaskMs: Math.round(longestLongTaskMs),
    windowMs: Math.round(input.windowMs),
  };
}

/** Long tasks are tasks over this length. Matches the Long Tasks API. */
export const LONG_TASK_THRESHOLD_MS = 50;

/**
 * Observes long tasks on the current thread only.
 *
 * `buffered` is left off on purpose: a measurement window must not include
 * work that happened before the window opened.
 */
export type LongTaskObserver = (onEntry: (duration: number) => void) => {
  disconnect(): void;
};

export interface LongTaskRecorderOptions {
  scenario: string;
  hostMode: PreviewHostMode;
  now?: () => number;
  /** Test seam. Defaults to a `PerformanceObserver` on the current thread. */
  observe?: LongTaskObserver;
}

export interface LongTaskRecorder {
  /** Stops observing and returns the collected metric. */
  stop(): PreviewMainThreadMetric;
}

interface PerformanceObserverLike {
  observe(init: { type: string }): void;
  disconnect(): void;
}

const defaultObserver: LongTaskObserver = (onEntry) => {
  const Observer = (
    globalThis as unknown as {
      PerformanceObserver?: new (
        callback: (list: {
          getEntries(): { duration: number }[];
        }) => void,
      ) => PerformanceObserverLike;
    }
  ).PerformanceObserver;
  if (!Observer) {
    // No Long Tasks API (older browsers, jsdom, Node). The recorder still
    // returns a well-formed metric with no observations.
    return { disconnect: () => undefined };
  }
  const observer = new Observer((list) => {
    for (const entry of list.getEntries()) {
      onEntry(entry.duration);
    }
  });
  observer.observe({ type: "longtask" });
  return {
    disconnect() {
      observer.disconnect();
    },
  };
};

/**
 * Records long tasks on the current thread.
 *
 * This is the recording stub the measurement harness and the future
 * integration test share. It observes the current thread only, so it reports
 * the editor's own jank and not the hosted frame's.
 */
export function createLongTaskRecorder(
  options: LongTaskRecorderOptions,
): LongTaskRecorder {
  const now = options.now ?? (() => Date.now());
  const observe = options.observe ?? defaultObserver;
  const startedAt = now();
  const durations: number[] = [];

  const observer = observe((duration) => {
    durations.push(duration);
  });

  return {
    stop() {
      observer.disconnect();
      return summarizeLongTasks({
        scenario: options.scenario,
        hostMode: options.hostMode,
        windowMs: now() - startedAt,
        durations,
      });
    },
  };
}
