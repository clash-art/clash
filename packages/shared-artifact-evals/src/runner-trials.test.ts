import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ExecutionBackend } from "./execution-backend";
import { createNativeLocalBackend, runBenchmarkSuite } from "./runner";
import { parseTrialAggregateRecord } from "./trial-aggregate";
import type {
  ArtifactBenchmarkCase,
  ArtifactBenchmarkSuite,
  BenchmarkAgent,
} from "./types";

function benchmarkCase(id: string): ArtifactBenchmarkCase {
  return {
    id,
    title: id,
    category: "timeline",
    outcome: {
      objective: `Create the ${id} artifact.`,
      acceptanceCriteria: ["The report artifact exists."],
      deliverables: [
        { artifactId: "result", kind: "report", description: "Result" },
      ],
    },
    passScore: 100,
    timeoutMs: 20_000,
    skills: [],
    rubric: [
      {
        id: "result-exists",
        type: "artifact-exists",
        artifactId: "result",
        kind: "report",
        weight: 1,
        required: true,
      },
    ],
  };
}

function suite(ids: string[]): ArtifactBenchmarkSuite {
  return {
    schemaVersion: 1,
    id: "trial-suite",
    title: "Trial suite",
    cases: ids.map(benchmarkCase),
  };
}

/**
 * The agent appends to `log` on every rollout and only delivers its artifact
 * when `shouldPass(n)` says so, where n is how many rollouts of this case
 * have started. That makes pass/fail depend on the trial, like a flaky Agent.
 */
function scriptedAgent(
  log: string,
  passOn: number[],
  holdMs = 0,
): BenchmarkAgent {
  const source = `
    const fs = require("node:fs");
    const path = require("node:path");
    const workspace = process.env.CLASH_BENCH_WORKSPACE;
    const caseId = process.env.CLASH_BENCH_CASE_ID;
    const log = ${JSON.stringify(log)};
    const passOn = ${JSON.stringify(passOn)};
    const prior = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").split("\\n").filter((l) => l.startsWith(caseId + " start")).length
      : 0;
    const n = prior + 1;
    fs.appendFileSync(log, caseId + " start " + n + " " + Date.now() + "\\n");
    const finish = () => {
      if (passOn.includes(n)) {
        fs.writeFileSync(path.join(workspace, "result.txt"), "artifact");
        fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:caseId,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}));
      }
      fs.appendFileSync(log, caseId + " end " + n + " " + Date.now() + "\\n");
    };
    setTimeout(finish, ${holdMs});
  `;
  return { command: process.execPath, args: ["-e", source] };
}

async function scratch(): Promise<{
  suiteRoot: string;
  outputRoot: string;
  log: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clash-bench-trials-"));
  const suiteRoot = join(root, "suite");
  await mkdir(suiteRoot);
  return {
    suiteRoot,
    outputRoot: join(root, "runs"),
    log: join(root, "agent.log"),
  };
}

function maxOverlap(log: string): number {
  const events = log
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "))
    .map(([, kind, , at]) => ({ kind, at: Number(at) }))
    .sort((a, b) => a.at - b.at || (a.kind === "end" ? -1 : 1));
  let running = 0;
  let max = 0;
  for (const event of events) {
    running += event.kind === "start" ? 1 : -1;
    max = Math.max(max, running);
  }
  return max;
}

describe("repeated trials", () => {
  it("runs every case k times as independent Attempts and reports pass@1, pass@k and pass^k", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    // Trial 1 and 3 deliver the artifact, trial 2 does not.
    const report = await runBenchmarkSuite({
      suite: suite(["flaky"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1, 3]),
      trials: 3,
    });

    expect(report.cases.map(({ trial, status }) => [trial, status])).toEqual([
      [1, "pass"],
      [2, "fail"],
      [3, "pass"],
    ]);
    expect(report.status).toBe("fail");
    expect(report.trials).toBe(3);
    expect(report.trialAggregate?.summary).toMatchObject({
      tasks: 1,
      passAt1: 2 / 3,
      passAtK: 1,
      passPowK: 0,
    });

    const runRoot = join(outputRoot, "run");
    // Each trial is its own Attempt directory; trial 1 keeps the original layout.
    for (const dir of [
      join(runRoot, "flaky"),
      join(runRoot, "trials", "002", "flaky"),
      join(runRoot, "trials", "003", "flaky"),
    ]) {
      expect((await readdir(dir)).includes("case-report.json")).toBe(true);
    }

    const stored = JSON.parse(
      await readFile(join(runRoot, report.trialAggregate!.path), "utf8"),
    );
    const aggregate = parseTrialAggregateRecord(stored);
    expect(aggregate.tasks[0]?.attempts.map(({ outcome }) => outcome)).toEqual([
      "pass",
      "fail",
      "pass",
    ]);

    const progress = JSON.parse(
      await readFile(join(runRoot, "suite-progress.json"), "utf8"),
    ) as { attempts: Array<{ trial?: number; event: string }> };
    expect(
      progress.attempts
        .filter(({ event }) => event === "completed")
        .map(({ trial }) => trial ?? 1),
    ).toEqual([1, 2, 3]);
  });

  it("leaves single-run output unchanged when trials are not requested", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    const report = await runBenchmarkSuite({
      suite: suite(["once"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1]),
    });
    expect(report.trials).toBeUndefined();
    expect(report.trialAggregate).toBeUndefined();
    expect(report.cases[0]?.trial).toBeUndefined();
    await expect(
      readdir(join(outputRoot, "run", "trial-aggregates")),
    ).rejects.toThrow();
    const manifest = JSON.parse(
      await readFile(join(outputRoot, "run", "run-manifest.json"), "utf8"),
    );
    expect(manifest.execution).toBeUndefined();
  });

  it("does not count a backend failure as an Agent failure", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    const native = createNativeLocalBackend();
    let calls = 0;
    const flaky: ExecutionBackend = {
      ...native,
      runAttempt: async (dispatch) => {
        calls += 1;
        if (dispatch.trial === 2) throw new Error("worker pool unreachable");
        return native.runAttempt(dispatch);
      },
    };
    const report = await runBenchmarkSuite({
      suite: suite(["task"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1, 2, 3]),
      trials: 3,
      maxInfrastructureAttempts: 1,
      backends: [flaky],
    });
    expect(calls).toBe(3);
    const stats = report.trialAggregate?.summary;
    expect(stats).toMatchObject({ tasks: 1, indeterminateTasks: 1 });
    // Two scored passes and one unscored trial: pass^k is not claimed.
    expect(stats?.passAt1).toBe(1);
    expect(stats?.passPowK).toBeNull();
    expect(report.cases[1]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("worker pool unreachable"),
    });
  });

  it("spreads the trials of one task over the configured backends", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    const seen: Array<[string, number]> = [];
    const tagged = (name: string): ExecutionBackend => {
      const native = createNativeLocalBackend({ concurrency: 2 });
      return {
        ...native,
        runAttempt: (dispatch) => {
          seen.push([name, dispatch.trial]);
          return native.runAttempt(dispatch);
        },
      };
    };
    await runBenchmarkSuite({
      suite: suite(["task"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1, 2, 3, 4]),
      trials: 4,
      backends: [tagged("a"), tagged("b")],
    });
    const byBackend = (name: string) =>
      seen
        .filter(([n]) => n === name)
        .map(([, trial]) => trial)
        .sort();
    expect(byBackend("a")).toEqual([1, 3]);
    expect(byBackend("b")).toEqual([2, 4]);
  });
});

describe("parallel dispatch", () => {
  it("runs Attempts concurrently up to the backend and global limits", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    await runBenchmarkSuite({
      suite: suite(["a", "b"]),
      suiteRoot,
      outputRoot,
      runId: "wide",
      agent: scriptedAgent(log, [1, 2], 600),
      trials: 2,
      backends: [createNativeLocalBackend({ concurrency: 4 })],
    });
    expect(maxOverlap(await readFile(log, "utf8"))).toBeGreaterThan(1);

    const narrow = await scratch();
    await runBenchmarkSuite({
      suite: suite(["a", "b"]),
      suiteRoot: narrow.suiteRoot,
      outputRoot: narrow.outputRoot,
      runId: "narrow",
      agent: scriptedAgent(narrow.log, [1, 2], 300),
      trials: 2,
      backends: [createNativeLocalBackend({ concurrency: 4 })],
      parallelism: 1,
    });
    expect(maxOverlap(await readFile(narrow.log, "utf8"))).toBe(1);
  });

  it("keeps ledger and progress consistent when Attempts finish concurrently", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    await runBenchmarkSuite({
      suite: suite(["a", "b", "c"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1, 2, 3], 100),
      trials: 3,
      backends: [createNativeLocalBackend({ concurrency: 9 })],
    });
    const progress = JSON.parse(
      await readFile(join(outputRoot, "run", "suite-progress.json"), "utf8"),
    ) as { attempts: Array<{ event: string }>; completedCases: unknown[] };
    const count = (event: string) =>
      progress.attempts.filter((entry) => entry.event === event).length;
    expect(count("started")).toBe(9);
    expect(count("completed")).toBe(9);
    expect(progress.completedCases).toHaveLength(9);
  });
});

describe("resume with trials", () => {
  it("does not rerun completed trials and refuses a different trial count", async () => {
    const { suiteRoot, outputRoot, log } = await scratch();
    const common = {
      suite: suite(["task"]),
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: scriptedAgent(log, [1, 2]),
    };
    await runBenchmarkSuite({ ...common, trials: 2 });
    const before = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean).length;
    const resumed = await runBenchmarkSuite({
      ...common,
      trials: 2,
      resume: true,
    });
    expect(resumed.cases).toHaveLength(2);
    expect(
      (await readFile(log, "utf8")).split("\n").filter(Boolean).length,
    ).toBe(before);
    await expect(
      runBenchmarkSuite({ ...common, trials: 3, resume: true }),
    ).rejects.toThrow(/trial count or selected subject/u);
    await appendFile(log, "");
    await writeFile(join(suiteRoot, ".keep"), "");
  });
});
