import { z } from "zod";

import { BENCHMARK_BACKEND_KINDS } from "./backend-types";
import {
  publishRecord,
  recordDigest,
  type EvaluationRecordReceipt,
} from "./evaluation-records";

/**
 * Repeated-trial statistics over independently evaluated Attempts.
 *
 * Each task is run `trials` times. An Attempt is *scored* when the Agent had a
 * fair chance at the task: it passed, or it failed for a reason that is not
 * runner infrastructure. Infrastructure failures, blocked cases, and pending
 * reviews are *unscored* and never counted as a task failure, so a flaky
 * backend cannot be mistaken for a weak Agent.
 *
 * - pass@1: scored passes / scored trials, an estimate of one-shot success.
 * - pass@k: at least one of the k trials passed.
 * - pass^k: every one of the k trials passed.
 *
 * pass@k and pass^k are three-valued. They are `null` while the unscored
 * trials could still change the answer.
 */

export type TrialOutcome = "pass" | "fail" | "unscored";

export type TrialAttemptInput = Readonly<{
  caseId: string;
  trial: number;
  outcome: TrialOutcome;
  backend: (typeof BENCHMARK_BACKEND_KINDS)[number];
  attemptDigest?: string;
  subjectIdentity?: string;
}>;

export type TaskTrialStats = Readonly<{
  trials: number;
  scored: number;
  passed: number;
  passAt1: number | null;
  passAtK: boolean | null;
  passPowK: boolean | null;
}>;

export function taskTrialStats(
  outcomes: readonly TrialOutcome[],
  trials: number,
): TaskTrialStats {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("Trial count must be a positive integer");
  }
  if (outcomes.length > trials) {
    throw new Error("More outcomes than planned trials");
  }
  const passed = outcomes.filter((outcome) => outcome === "pass").length;
  const failed = outcomes.filter((outcome) => outcome === "fail").length;
  const scored = passed + failed;
  // Trials that never produced an outcome can still pass or fail.
  const undecided = trials - scored;
  return {
    trials,
    scored,
    passed,
    passAt1: scored === 0 ? null : passed / scored,
    passAtK: passed > 0 ? true : undecided === 0 ? false : null,
    passPowK:
      failed > 0 ? false : undecided === 0 && passed === trials ? true : null,
  };
}

export type TrialAggregateSummary = Readonly<{
  tasks: number;
  /** Tasks whose pass@k / pass^k is still undetermined by unscored trials. */
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
  const at1 = stats.flatMap(({ passAt1 }) =>
    passAt1 === null ? [] : [passAt1],
  );
  const atK = stats.flatMap(({ passAtK }) =>
    passAtK === null ? [] : [passAtK ? 1 : 0],
  );
  const powK = stats.flatMap(({ passPowK }) =>
    passPowK === null ? [] : [passPowK ? 1 : 0],
  );
  return {
    tasks: stats.length,
    indeterminateTasks: stats.filter(
      ({ passAtK, passPowK }) => passAtK === null || passPowK === null,
    ).length,
    passAt1: mean(at1),
    passAtK: mean(atK),
    passPowK: mean(powK),
  };
}

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdSchema = z.string().min(1).max(200);
const StatsSchema = z
  .object({
    trials: z.number().int().min(1),
    scored: z.number().int().min(0),
    passed: z.number().int().min(0),
    passAt1: z.number().min(0).max(1).nullable(),
    passAtK: z.boolean().nullable(),
    passPowK: z.boolean().nullable(),
  })
  .strict();
const AttemptSchema = z
  .object({
    trial: z.number().int().min(1),
    outcome: z.enum(["pass", "fail", "unscored"]),
    backend: z.enum(BENCHMARK_BACKEND_KINDS),
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
const TrialAggregateRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.benchmark.trial-aggregate"),
    suiteId: IdSchema,
    runId: IdSchema,
    trials: z.number().int().min(1),
    /** More than one entry means the trials measured different builds. */
    subjectIdentities: z.array(DigestSchema),
    tasks: z.array(TaskSchema),
    summary: SummarySchema,
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
  if (parsed.digest !== recordDigest(unsigned(parsed))) {
    throw new Error("Trial Aggregate digest does not match its content");
  }
  return parsed;
}

export function createTrialAggregateRecord(input: {
  suiteId: string;
  runId: string;
  trials: number;
  attempts: readonly TrialAttemptInput[];
}): BenchmarkTrialAggregateRecord {
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
  const candidate = {
    schemaVersion: 1 as const,
    kind: "clash.benchmark.trial-aggregate" as const,
    suiteId: input.suiteId,
    runId: input.runId,
    trials: input.trials,
    subjectIdentities,
    tasks,
    summary: summarizeTrialStats(tasks.map(({ stats }) => stats)),
  };
  return parseTrialAggregateRecord({
    ...candidate,
    digest: recordDigest(candidate),
  });
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
