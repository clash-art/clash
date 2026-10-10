import type {
  BenchmarkBackendKind,
  BenchmarkRuntimeClaim,
} from "./backend-types";
import type { BenchmarkAttemptExecutionInput } from "./runner";
import type { BenchmarkAttemptReceipt } from "./attempt-manifest";
import type { ArtifactBenchmarkCase, BenchmarkCaseReport } from "./types";

/**
 * Where one Attempt runs. A backend owns *placement and transport only*: the
 * Attempt pipeline itself (lock, Workspace import, Agent run, readback, seal)
 * is always `executeBenchmarkAttempt`, executed in process for native-local
 * and inside a worker everywhere else. That keeps one Attempt contract, so an
 * Attempt produced by any backend verifies and evaluates identically.
 *
 * A backend must not report an isolation level it did not establish. It states
 * what it asserts through `runtimeClaim()`; the worker's lock then records what
 * it could observe, and the dispatcher rejects an Attempt whose sealed lock
 * disagrees with the claim.
 */
export interface ExecutionBackend {
  readonly kind: BenchmarkBackendKind;
  /** Attempts this backend may run at once. */
  readonly maxConcurrency: number;
  /** Resolve and freeze the isolation claim once, before any Attempt is placed. */
  runtimeClaim(): Promise<BenchmarkRuntimeClaim>;
  runAttempt(
    dispatch: BenchmarkAttemptDispatch,
  ): Promise<BenchmarkAttemptCompletion>;
  dispose?(): Promise<void>;
}

export type BenchmarkAttemptDispatch = Omit<
  BenchmarkAttemptExecutionInput,
  "runtime" | "adoptCaseRoot" | "dispatchFailure"
>;

export type BenchmarkAttemptCompletion = {
  report: BenchmarkCaseReport;
  attemptReceipt?: BenchmarkAttemptReceipt;
};

export type TrialUnit = {
  benchmark: ArtifactBenchmarkCase;
  /** 1-based; trial 1 keeps the pre-trial on-disk layout. */
  trial: number;
  /** Position in the deterministic case-major, trial-minor plan. */
  index: number;
  backend: ExecutionBackend;
};

/** Runs async tasks one at a time, in call order. */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}

class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.available = limit;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

/**
 * Plans trials across backends deterministically: unit `i` belongs to backend
 * `i mod n`, so the trials of one task land on different backends and a resumed
 * run places the same unit on the same backend. Each backend runs at most its
 * own concurrency; `parallelism` additionally caps the total.
 */
export async function scheduleTrialUnits(input: {
  units: readonly TrialUnit[];
  backends: readonly ExecutionBackend[];
  parallelism?: number;
  stopped: () => boolean;
  run: (unit: TrialUnit) => Promise<void>;
}): Promise<void> {
  const total = input.parallelism ?? Number.POSITIVE_INFINITY;
  if (!(total >= 1)) throw new Error("parallelism must be at least 1");
  const global = new Semaphore(
    Number.isFinite(total) ? total : input.units.length || 1,
  );
  const queues = new Map<ExecutionBackend, TrialUnit[]>(
    input.backends.map((backend) => [backend, []]),
  );
  for (const unit of input.units) queues.get(unit.backend)!.push(unit);
  const failures: unknown[] = [];
  await Promise.all(
    input.backends.flatMap((backend) => {
      if (
        !Number.isInteger(backend.maxConcurrency) ||
        backend.maxConcurrency < 1
      ) {
        throw new Error(
          `Backend ${backend.kind} concurrency must be a positive integer`,
        );
      }
      const queue = queues.get(backend)!;
      return Array.from({ length: backend.maxConcurrency }, async () => {
        for (let unit = queue.shift(); unit; unit = queue.shift()) {
          if (input.stopped() || failures.length > 0) return;
          const release = await global.acquire();
          try {
            if (input.stopped() || failures.length > 0) return;
            await input.run(unit);
          } catch (error) {
            failures.push(error);
          } finally {
            release();
          }
        }
      });
    }),
  );
  if (failures.length > 0) throw failures[0];
}
