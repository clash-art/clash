/**
 * A small FIFO work queue with a hard concurrency bound and two priorities.
 *
 * Derivation (sharp/ffmpeg) is expensive and user-visible work must not wait
 * behind idle-time transcodes, so foreground work always drains first and a
 * single background task may run only when no foreground task is pending.
 */
export type WorkPriority = "foreground" | "background";

interface QueuedWork {
  priority: WorkPriority;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface BoundedWorkQueue {
  enqueue<T>(priority: WorkPriority, task: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
  /** Rejects work that has not started; already-running work settles normally. */
  close(): void;
}

export const WORK_QUEUE_CLOSED = "WORK_QUEUE_CLOSED";

export class WorkQueueClosedError extends Error {
  readonly code = WORK_QUEUE_CLOSED;

  constructor() {
    super("The work queue is closed.");
    this.name = "WorkQueueClosedError";
  }
}

export function createBoundedWorkQueue(options: {
  concurrency: number;
}): BoundedWorkQueue {
  const { concurrency } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("A work queue concurrency must be a positive integer.");
  }

  const foreground: QueuedWork[] = [];
  const background: QueuedWork[] = [];
  let active = 0;
  let backgroundActive = 0;
  let closed = false;

  const drain = (): void => {
    while (!closed && active < concurrency) {
      const next =
        foreground.shift() ??
        (backgroundActive === 0 ? background.shift() : undefined);
      if (!next) return;
      active += 1;
      if (next.priority === "background") backgroundActive += 1;
      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          if (next.priority === "background") backgroundActive -= 1;
          drain();
        });
    }
  };

  return {
    enqueue<T>(priority: WorkPriority, task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new WorkQueueClosedError());
      return new Promise<T>((resolve, reject) => {
        (priority === "foreground" ? foreground : background).push({
          priority,
          task,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        drain();
      });
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return foreground.length + background.length;
    },
    close() {
      closed = true;
      for (const work of foreground.splice(0)) {
        work.reject(new WorkQueueClosedError());
      }
      for (const work of background.splice(0)) {
        work.reject(new WorkQueueClosedError());
      }
    },
  };
}
