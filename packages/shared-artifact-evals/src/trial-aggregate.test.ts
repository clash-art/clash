import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTrialAggregateRecord,
  parseTrialAggregateRecord,
  summarizeTrialStats,
  taskTrialStats,
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

describe("pass@1, pass@k and pass^k", () => {
  it("separates a task that sometimes passes from one that always passes", () => {
    expect(taskTrialStats(["pass", "fail", "fail"], 3)).toMatchObject({
      passAt1: 1 / 3,
      passAtK: true,
      passPowK: false,
    });
    expect(taskTrialStats(["pass", "pass", "pass"], 3)).toMatchObject({
      passAt1: 1,
      passAtK: true,
      passPowK: true,
    });
    expect(taskTrialStats(["fail", "fail", "fail"], 3)).toMatchObject({
      passAt1: 0,
      passAtK: false,
      passPowK: false,
    });
  });

  it("for one trial all three coincide", () => {
    for (const outcome of ["pass", "fail"] as const) {
      const stats = taskTrialStats([outcome], 1);
      expect(stats.passAt1).toBe(outcome === "pass" ? 1 : 0);
      expect(stats.passAtK).toBe(outcome === "pass");
      expect(stats.passPowK).toBe(outcome === "pass");
    }
  });

  it("never counts an unscored trial as an Agent failure", () => {
    const stats = taskTrialStats(["pass", "pass", "unscored"], 3);
    expect(stats.passAt1).toBe(1);
    expect(stats.passAtK).toBe(true);
    // One trial is unknown, so "every trial passed" cannot be claimed yet.
    expect(stats.passPowK).toBeNull();
    // A scored failure settles pass^k regardless of what is unscored.
    expect(taskTrialStats(["fail", "unscored", "unscored"], 3).passPowK).toBe(
      false,
    );
    expect(
      taskTrialStats(["fail", "unscored", "unscored"], 3).passAtK,
    ).toBeNull();
  });

  it("treats trials that have not run yet like unscored ones", () => {
    const stats = taskTrialStats(["pass"], 3);
    expect(stats.passAtK).toBe(true);
    expect(stats.passPowK).toBeNull();
  });

  it("averages only determinate tasks and reports how many were left out", () => {
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
    forged.tasks[0].stats.passPowK = true;
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

  it("flags a run whose trials measured different builds", () => {
    const mixed = createTrialAggregateRecord({
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
    });
    expect(mixed.subjectIdentities).toHaveLength(2);
  });
});
