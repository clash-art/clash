import { z } from "zod";

import {
  BENCHMARK_BACKEND_KINDS,
  isExperimentalBackend,
  type BenchmarkBackendKind,
} from "./backend-types";
import {
  publishRecord,
  recordDigest,
  type EvaluationRecordReceipt,
} from "./evaluation-records";

/**
 * Repeated-trial statistics over independently evaluated Attempts.
 *
 * Each task is run `n` times (`trials`) and estimated at `k` (1 <= k <= n). An
 * Attempt is *scored* when the Agent had a fair chance at the task: it passed,
 * or it failed for a reason that is not runner infrastructure. Infrastructure
 * failures, blocked cases, and pending reviews are *unscored* and never counted
 * as a task failure, so a flaky backend cannot be mistaken for a weak Agent.
 * The runner retries infrastructure failures (bounded) so that unscored trials
 * are the exception; the statistics below never pretend they were scored.
 *
 * With `s` scored trials of which `c` passed:
 * - pass@1 = c / s, an estimate of one-shot success.
 * - pass@k = 1 - C(s-c, k) / C(s, k), the unbiased estimator of "at least one
 *   of k independent trials passes" (Chen et al. 2021, "Evaluating Large
 *   Language Models Trained on Code", eq. 1).
 * - pass^k = C(c, k) / C(s, k), the unbiased estimator of "all k independent
 *   trials pass" (Yao et al. 2024, "tau-bench", section 5).
 *
 * With s = k these reduce to "any trial passed" and "every trial passed". Both
 * are `null` while fewer than k trials are scored: an estimate from fewer
 * samples than k is not defined, and the runner says so instead of computing
 * on what it has.
 */

export type TrialOutcome = "pass" | "fail" | "unscored";

/** How a run's trials are placed on its backends. */
export type TrialPlacement = "per-task" | "spread";

export type TrialAttemptInput = Readonly<{
  caseId: string;
  trial: number;
  outcome: TrialOutcome;
  backend: BenchmarkBackendKind;
  /** Sealed Attempt number in this trial; above 1 means infrastructure retries preceded it. */
  attempt?: number;
  attemptDigest?: string;
  subjectIdentity?: string;
}>;

export type TaskTrialStats = Readonly<{
  /** Planned trials (n). */
  trials: number;
  scored: number;
  passed: number;
  passAt1: number | null;
  passAtK: number | null;
  passPowK: number | null;
}>;

/** 1 - C(n-c, k) / C(n, k), in the numerically stable product form. */
export function unbiasedPassAtK(n: number, c: number, k: number): number {
  assertEstimatorInput(n, c, k);
  if (n - c < k) return 1;
  let miss = 1;
  for (let i = n - c + 1; i <= n; i += 1) miss *= 1 - k / i;
  return 1 - miss;
}

/** C(c, k) / C(n, k), in product form. */
export function unbiasedPassPowK(n: number, c: number, k: number): number {
  assertEstimatorInput(n, c, k);
  if (c < k) return 0;
  let all = 1;
  for (let i = 0; i < k; i += 1) all *= (c - i) / (n - i);
  return all;
}

function assertEstimatorInput(n: number, c: number, k: number): void {
  if (![n, c, k].every(Number.isInteger) || k < 1 || c < 0 || c > n || n < k) {
    throw new Error(
      "Estimator needs integers with 0 <= c <= n and 1 <= k <= n",
    );
  }
}

export function taskTrialStats(
  outcomes: readonly TrialOutcome[],
  trials: number,
  k: number = trials,
): TaskTrialStats {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("Trial count must be a positive integer");
  }
  if (!Number.isInteger(k) || k < 1 || k > trials) {
    throw new Error("k must be an integer between 1 and the trial count");
  }
  if (outcomes.length > trials) {
    throw new Error("More outcomes than planned trials");
  }
  const passed = outcomes.filter((outcome) => outcome === "pass").length;
  const failed = outcomes.filter((outcome) => outcome === "fail").length;
  const scored = passed + failed;
  const estimable = scored >= k;
  return {
    trials,
    scored,
    passed,
    passAt1: scored === 0 ? null : passed / scored,
    passAtK: estimable ? unbiasedPassAtK(scored, passed, k) : null,
    passPowK: estimable ? unbiasedPassPowK(scored, passed, k) : null,
  };
}

export type TrialAggregateSummary = Readonly<{
  tasks: number;
  /** Tasks with fewer than k scored trials; pass@k and pass^k leave them out. */
  indeterminateTasks: number;
  passAt1: number | null;
  passAtK: number | null;
  passPowK: number | null;
}>;

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeTrialStats(
  stats: readonly TaskTrialStats[],
): TrialAggregateSummary {
  const present = (values: ReadonlyArray<number | null>) =>
    values.filter((value): value is number => value !== null);
  return {
    tasks: stats.length,
    indeterminateTasks: stats.filter(({ passAtK }) => passAtK === null).length,
    passAt1: mean(present(stats.map(({ passAt1 }) => passAt1))),
    passAtK: mean(present(stats.map(({ passAtK }) => passAtK))),
    passPowK: mean(present(stats.map(({ passPowK }) => passPowK))),
  };
}

type BackendAttempt = { backend: BenchmarkBackendKind; outcome: TrialOutcome };

/**
 * The same statistics restricted to each backend. Under `per-task` placement a
 * task's trials all ran on one backend, so each backend's numbers are complete
 * estimates. Under `spread` a backend sees only some of a task's trials, so its
 * pass@k is `null` whenever it scored fewer than k of them.
 */
export function backendTrialStats(input: {
  tasks: ReadonlyArray<{ attempts: readonly BackendAttempt[] }>;
  k: number;
}): Array<{
  backend: BenchmarkBackendKind;
  experimental: boolean;
  summary: TrialAggregateSummary;
}> {
  const kinds = [
    ...new Set(
      input.tasks.flatMap(({ attempts }) =>
        attempts.map(({ backend }) => backend),
      ),
    ),
  ].sort(compareText);
  return kinds.map((backend) => {
    const stats = input.tasks.flatMap(({ attempts }) => {
      const outcomes = attempts
        .filter((attempt) => attempt.backend === backend)
        .map(({ outcome }) => outcome);
      if (outcomes.length === 0) return [];
      // A backend that ran fewer than k trials of a task cannot estimate pass@k.
      const planned = Math.max(outcomes.length, input.k);
      return [taskTrialStats(outcomes, planned, input.k)];
    });
    return {
      backend,
      experimental: isExperimentalBackend(backend),
      summary: summarizeTrialStats(stats),
    };
  });
}

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdSchema = z.string().min(1).max(200);
const StatsSchema = z
  .object({
    trials: z.number().int().min(1),
    scored: z.number().int().min(0),
    passed: z.number().int().min(0),
    passAt1: z.number().min(0).max(1).nullable(),
    passAtK: z.number().min(0).max(1).nullable(),
    passPowK: z.number().min(0).max(1).nullable(),
  })
  .strict();
const AttemptSchema = z
  .object({
    trial: z.number().int().min(1),
    outcome: z.enum(["pass", "fail", "unscored"]),
    backend: z.enum(BENCHMARK_BACKEND_KINDS),
    attempt: z.number().int().min(1).optional(),
    attemptDigest: DigestSchema.optional(),
    subjectIdentity: DigestSchema.optional(),
  })
  .strict();
const TaskSchema = z
  .object({
    caseId: IdSchema,
    attempts: z.array(AttemptSchema).min(1),
    stats: StatsSchema,
  })
  .strict();
const SummarySchema = z
  .object({
    tasks: z.number().int().min(0),
    indeterminateTasks: z.number().int().min(0),
    passAt1: z.number().min(0).max(1).nullable(),
    passAtK: z.number().min(0).max(1).nullable(),
    passPowK: z.number().min(0).max(1).nullable(),
  })
  .strict();
const BackendSummarySchema = z
  .object({
    backend: z.enum(BENCHMARK_BACKEND_KINDS),
    experimental: z.boolean(),
    summary: SummarySchema,
  })
  .strict();
const TrialAggregateRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.benchmark.trial-aggregate"),
    suiteId: IdSchema,
    runId: IdSchema,
    /** Planned trials per task (n). */
    trials: z.number().int().min(1),
    /** The k of pass@k and pass^k; at most `trials`. */
    k: z.number().int().min(1),
    placement: z.enum(["per-task", "spread"]),
    /** One run measures one build; a second identity is rejected, not recorded. */
    subjectIdentities: z.array(DigestSchema).max(1),
    tasks: z.array(TaskSchema),
    summary: SummarySchema,
    /** The same statistics per backend, so backends are compared, not blended. */
    byBackend: z.array(BackendSummarySchema),
    digest: DigestSchema,
  })
  .strict();

export type BenchmarkTrialAggregateRecord = Readonly<
  z.infer<typeof TrialAggregateRecordSchema>
>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsigned(record: BenchmarkTrialAggregateRecord) {
  const { digest: _digest, ...rest } = record;
  return rest;
}

export function parseTrialAggregateRecord(
  value: unknown,
): BenchmarkTrialAggregateRecord {
  const parsed = TrialAggregateRecordSchema.parse(value);
  if (parsed.k > parsed.trials) {
    throw new Error("Trial Aggregate k must not exceed its trial count");
  }
  const ids = parsed.tasks.map(({ caseId }) => caseId);
  if (
    ids.some((id, index) => index > 0 && compareText(ids[index - 1]!, id) >= 0)
  ) {
    throw new Error(
      "Trial Aggregate tasks must be unique and in canonical order",
    );
  }
  for (const task of parsed.tasks) {
    const trialNumbers = task.attempts.map(({ trial }) => trial);
    if (
      trialNumbers.some(
        (trial, index) =>
          trial > parsed.trials ||
          (index > 0 && trial <= trialNumbers[index - 1]!),
      )
    ) {
      throw new Error("Trial Aggregate trials must be unique and ascending");
    }
    const expected = taskTrialStats(
      task.attempts.map(({ outcome }) => outcome),
      parsed.trials,
      parsed.k,
    );
    if (JSON.stringify(expected) !== JSON.stringify(task.stats)) {
      throw new Error(
        `Trial Aggregate statistics for '${task.caseId}' do not follow from its Attempts`,
      );
    }
  }
  const expectedSummary = summarizeTrialStats(
    parsed.tasks.map(({ stats }) => stats),
  );
  if (JSON.stringify(expectedSummary) !== JSON.stringify(parsed.summary)) {
    throw new Error("Trial Aggregate summary does not follow from its tasks");
  }
  const expectedByBackend = backendTrialStats({
    tasks: parsed.tasks,
    k: parsed.k,
  });
  if (JSON.stringify(expectedByBackend) !== JSON.stringify(parsed.byBackend)) {
    throw new Error(
      "Trial Aggregate per-backend statistics do not follow from its tasks",
    );
  }
  if (parsed.digest !== recordDigest(unsigned(parsed))) {
    throw new Error("Trial Aggregate digest does not match its content");
  }
  return parsed;
}

export function createTrialAggregateRecord(input: {
  suiteId: string;
  runId: string;
  trials: number;
  /** Defaults to `trials`. */
  k?: number;
  placement?: TrialPlacement;
  attempts: readonly TrialAttemptInput[];
}): BenchmarkTrialAggregateRecord {
  const k = input.k ?? input.trials;
  const byCase = new Map<string, TrialAttemptInput[]>();
  for (const attempt of input.attempts) {
    const list = byCase.get(attempt.caseId) ?? [];
    list.push(attempt);
    byCase.set(attempt.caseId, list);
  }
  const tasks = [...byCase.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([caseId, attempts]) => {
      const ordered = [...attempts].sort((a, b) => a.trial - b.trial);
      return {
        caseId,
        attempts: ordered.map((attempt) => ({
          trial: attempt.trial,
          outcome: attempt.outcome,
          backend: attempt.backend,
          ...(attempt.attempt !== undefined
            ? { attempt: attempt.attempt }
            : {}),
          ...(attempt.attemptDigest
            ? { attemptDigest: attempt.attemptDigest }
            : {}),
          ...(attempt.subjectIdentity
            ? { subjectIdentity: attempt.subjectIdentity }
            : {}),
        })),
        stats: taskTrialStats(
          ordered.map(({ outcome }) => outcome),
          input.trials,
          k,
        ),
      };
    });
  const subjectIdentities = [
    ...new Set(
      input.attempts.flatMap(({ subjectIdentity }) =>
        subjectIdentity ? [subjectIdentity] : [],
      ),
    ),
  ].sort(compareText);
  assertSingleSubject(subjectIdentities);
  const candidate = {
    schemaVersion: 1 as const,
    kind: "clash.benchmark.trial-aggregate" as const,
    suiteId: input.suiteId,
    runId: input.runId,
    trials: input.trials,
    k,
    placement: input.placement ?? "per-task",
    subjectIdentities,
    tasks,
    summary: summarizeTrialStats(tasks.map(({ stats }) => stats)),
    byBackend: backendTrialStats({ tasks, k }),
  };
  return parseTrialAggregateRecord({
    ...candidate,
    digest: recordDigest(candidate),
  });
}

/**
 * One run measures one build. Trials of different builds are different
 * experiments, and averaging them would report a number neither build earned.
 */
export function assertSingleSubject(identities: readonly string[]): void {
  const distinct = [...new Set(identities)];
  if (distinct.length > 1) {
    throw new Error(
      `A benchmark run must measure exactly one subject, but its Attempts recorded ${distinct.length}: ${distinct.join(", ")}. Start a separate run per subject.`,
    );
  }
}

export function writeTrialAggregateRecord(input: {
  storeRoot: string;
  record: BenchmarkTrialAggregateRecord;
}): Promise<EvaluationRecordReceipt<BenchmarkTrialAggregateRecord>> {
  const record = parseTrialAggregateRecord(input.record);
  return publishRecord({
    storeRoot: input.storeRoot,
    category: "trial-aggregates",
    record,
    digest: record.digest,
  });
}
