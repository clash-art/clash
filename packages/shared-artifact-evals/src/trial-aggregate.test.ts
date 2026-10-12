import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTrialAggregateRecord,
  parseTrialAggregateRecord,
  summarizeTrialStats,
  taskTrialStats,
  unbiasedPassAtK,
  unbiasedPassPowK,
  writeTrialAggregateRecord,
  type TrialAttemptInput,
  type TrialOutcome,
} from "./trial-aggregate";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (char: string) => char.repeat(64);

function attempts(
  caseId: string,
  outcomes: TrialOutcome[],
  backend: TrialAttemptInput["backend"] = "native-local",
): TrialAttemptInput[] {
  return outcomes.map((outcome, index) => ({
    caseId,
    trial: index + 1,
    outcome,
    backend,
    attemptDigest: digest(String(index + 1)),
    subjectIdentity: digest("a"),
  }));
}

/** Exact binomial coefficient, independent of the product form under test. */
function choose(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  for (let i = 1; i <= k; i += 1) {
    result = (result * BigInt(n - k + i)) / BigInt(i);
  }
  return result;
}

describe("pass@1, pass@k and pass^k", () => {
  it("matches the published definitions 1 - C(n-c,k)/C(n,k) and C(c,k)/C(n,k)", () => {
    for (let n = 1; n <= 12; n += 1) {
      for (let c = 0; c <= n; c += 1) {
        for (let k = 1; k <= n; k += 1) {
          const total = Number(choose(n, k));
          expect(unbiasedPassAtK(n, c, k)).toBeCloseTo(
            1 - Number(choose(n - c, k)) / total,
            12,
          );
          expect(unbiasedPassPowK(n, c, k)).toBeCloseTo(
            Number(choose(c, k)) / total,
            12,
          );
        }
      }
    }
  });

  it("with k = n reduces to 'any trial passed' and 'every trial passed'", () => {
    expect(taskTrialStats(["pass", "fail", "fail"], 3)).toMatchObject({
      passAt1: 1 / 3,
      passAtK: 1,
      passPowK: 0,
    });
    expect(taskTrialStats(["pass", "pass", "pass"], 3)).toMatchObject({
      passAt1: 1,
      passAtK: 1,
      passPowK: 1,
    });
    expect(taskTrialStats(["fail", "fail", "fail"], 3)).toMatchObject({
      passAt1: 0,
      passAtK: 0,
      passPowK: 0,
    });
  });

  it("estimates pass@k from n > k trials instead of only the first k", () => {
    // n = 5, c = 2, k = 2: 1 - C(3,2)/C(5,2) = 1 - 3/10; C(2,2)/C(5,2) = 1/10.
    const stats = taskTrialStats(
      ["pass", "fail", "pass", "fail", "fail"],
      5,
      2,
    );
    expect(stats.passAtK).toBeCloseTo(0.7, 12);
    expect(stats.passPowK).toBeCloseTo(0.1, 12);
    expect(stats.passAt1).toBeCloseTo(0.4, 12);
  });

  it("for one trial all three coincide", () => {
    for (const outcome of ["pass", "fail"] as const) {
      const stats = taskTrialStats([outcome], 1);
      expect(stats.passAt1).toBe(outcome === "pass" ? 1 : 0);
      expect(stats.passAtK).toBe(outcome === "pass" ? 1 : 0);
      expect(stats.passPowK).toBe(outcome === "pass" ? 1 : 0);
    }
  });

  it("never counts an unscored trial as an Agent failure", () => {
    // Four scored trials still estimate k = 3; the unscored one is left out.
    const stats = taskTrialStats(
      ["pass", "pass", "pass", "pass", "unscored"],
      5,
      3,
    );
    expect(stats).toMatchObject({ scored: 4, passAt1: 1, passPowK: 1 });
  });

  it("does not estimate pass@k or pass^k from fewer than k scored trials", () => {
    const stats = taskTrialStats(["pass", "fail", "unscored"], 3);
    expect(stats.passAt1).toBe(0.5);
    expect(stats.passAtK).toBeNull();
    expect(stats.passPowK).toBeNull();
    // Trials that have not run yet are treated the same way.
    expect(taskTrialStats(["pass"], 3).passAtK).toBeNull();
  });

  it("averages only estimable tasks and reports how many were left out", () => {
    const summary = summarizeTrialStats([
      taskTrialStats(["pass", "pass"], 2),
      taskTrialStats(["pass", "fail"], 2),
      taskTrialStats(["unscored", "unscored"], 2),
    ]);
    expect(summary).toMatchObject({
      tasks: 3,
      indeterminateTasks: 1,
      passAt1: (1 + 0.5) / 2,
      passAtK: 1,
      passPowK: 0.5,
    });
  });

  it("rejects an invalid trial plan", () => {
    expect(() => taskTrialStats([], 0)).toThrow();
    expect(() => taskTrialStats(["pass", "pass"], 1)).toThrow();
    expect(() => taskTrialStats(["pass"], 2, 3)).toThrow(/k must/u);
    expect(() => taskTrialStats(["pass"], 2, 0)).toThrow(/k must/u);
  });
});

describe("per-backend statistics", () => {
  it("reports each backend separately when a task's trials stay on one backend", () => {
    const record = createTrialAggregateRecord({
      suiteId: "suite",
      runId: "run-1",
      trials: 2,
      attempts: [
        ...attempts("a-task", ["pass", "pass"], "native-local"),
        ...attempts("b-task", ["fail", "fail"], "container"),
      ],
    });
    expect(record.placement).toBe("per-task");
    expect(record.byBackend).toEqual([
      {
        backend: "container",
        experimental: false,
        summary: expect.objectContaining({ tasks: 1, passAtK: 0 }),
      },
      {
        backend: "native-local",
        experimental: false,
        summary: expect.objectContaining({ tasks: 1, passAtK: 1 }),
      },
    ]);
  });

  it("does not estimate pass@k for a backend that ran fewer than k of a task's trials", () => {
    const record = createTrialAggregateRecord({
      suiteId: "suite",
      runId: "run-1",
      trials: 2,
      placement: "spread",
      attempts: [
        { ...attempts("t", ["pass"], "native-local")[0]! },
        { ...attempts("t", ["pass", "fail"], "container")[1]! },
      ],
    });
    for (const { summary } of record.byBackend) {
      expect(summary.passAtK).toBeNull();
      expect(summary.indeterminateTasks).toBe(1);
    }
  });

  it("labels results from an experimental backend", () => {
    const record = createTrialAggregateRecord({
      suiteId: "suite",
      runId: "run-1",
      trials: 1,
      attempts: attempts("t", ["pass"], "claude-cloud"),
    });
    expect(record.byBackend).toEqual([
      expect.objectContaining({ backend: "claude-cloud", experimental: true }),
    ]);
  });
});

describe("Trial Aggregate record", () => {
  const record = () =>
    createTrialAggregateRecord({
      suiteId: "suite",
      runId: "run-1",
      trials: 3,
      attempts: [
        ...attempts("b-task", ["pass", "pass", "pass"], "container"),
        ...attempts("a-task", ["pass", "fail", "unscored"], "native-local"),
      ],
    });

  it("is canonical regardless of the order attempts arrive in", () => {
    const forward = record();
    const reversed = createTrialAggregateRecord({
      suiteId: "suite",
      runId: "run-1",
      trials: 3,
      attempts: [
        ...attempts("a-task", ["pass", "fail", "unscored"]).reverse(),
        ...attempts("b-task", ["pass", "pass", "pass"], "container").reverse(),
      ],
    });
    expect(reversed.digest).toBe(forward.digest);
    expect(forward.tasks.map(({ caseId }) => caseId)).toEqual([
      "a-task",
      "b-task",
    ]);
  });

  it("records which backend ran each trial", () => {
    const task = record().tasks.find(({ caseId }) => caseId === "b-task");
    expect(task?.attempts.every(({ backend }) => backend === "container")).toBe(
      true,
    );
  });

  it("rejects statistics that do not follow from the recorded attempts", () => {
    const forged = structuredClone(record()) as Record<string, any>;
    forged.tasks[0].stats.passAt1 = 1;
    expect(() => parseTrialAggregateRecord(forged)).toThrow(/do not follow/u);
  });

  it("rejects content that does not match its digest", () => {
    const forged = structuredClone(record()) as Record<string, any>;
    forged.runId = "run-2";
    expect(() => parseTrialAggregateRecord(forged)).toThrow(/digest/u);
  });

  it("publishes content-addressed bytes once and verifies re-publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-trial-aggregate-"));
    roots.push(root);
    const first = await writeTrialAggregateRecord({
      storeRoot: root,
      record: record(),
    });
    const second = await writeTrialAggregateRecord({
      storeRoot: root,
      record: record(),
    });
    expect(first.publication).toBe("created");
    expect(second.publication).toBe("existing");
    expect(first.path).toBe(`trial-aggregates/sha256/${record().digest}.json`);
    const stored = JSON.parse(await readFile(join(root, first.path), "utf8"));
    expect(parseTrialAggregateRecord(stored).digest).toBe(record().digest);
  });

  it("rejects a run whose trials measured different builds", () => {
    expect(() =>
      createTrialAggregateRecord({
        suiteId: "suite",
        runId: "run-1",
        trials: 2,
        attempts: [
          { ...attempts("t", ["pass"])[0]!, subjectIdentity: digest("a") },
          {
            ...attempts("t", ["pass", "pass"])[1]!,
            subjectIdentity: digest("b"),
          },
        ],
      }),
    ).toThrow(/exactly one subject/u);
    const forged = structuredClone(record()) as Record<string, any>;
    forged.subjectIdentities = [digest("a"), digest("b")];
    expect(() => parseTrialAggregateRecord(forged)).toThrow();
  });

  it("rejects per-backend statistics that do not follow from the tasks", () => {
    const forged = structuredClone(record()) as Record<string, any>;
    forged.byBackend[0].backend = "claude-cloud";
    expect(() => parseTrialAggregateRecord(forged)).toThrow(/per-backend/u);
  });
});
