import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BenchmarkRuntimeClaim } from "./backend-types";
import type { ExecutionBackend } from "./execution-backend";
import {
  createNativeLocalBackend,
  executeBenchmarkAttempt,
  runBenchmarkSuite,
} from "./runner";
import type {
  ArtifactBenchmarkCase,
  ArtifactBenchmarkSuite,
  BenchmarkAgent,
} from "./types";

function benchmarkCase(
  id: string,
  overrides: Partial<ArtifactBenchmarkCase> = {},
): ArtifactBenchmarkCase {
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
    timeoutMs: 10_000,
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
    ...overrides,
  };
}

function suite(cases: ArtifactBenchmarkCase[]): ArtifactBenchmarkSuite {
  return {
    schemaVersion: 1,
    id: "resume-suite",
    title: "Resume suite",
    cases,
  };
}

function successfulAgent(extraSource = ""): BenchmarkAgent {
  const source = [
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const workspace = process.env.CLASH_BENCH_WORKSPACE",
    "const caseId = process.env.CLASH_BENCH_CASE_ID",
    extraSource,
    'fs.writeFileSync(path.join(workspace, "result.txt"), "artifact")',
    'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:caseId,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
  ]
    .filter(Boolean)
    .join(";");
  return { command: process.execPath, args: ["-e", source] };
}

/** A preflight-blocked Environment case: it seals an Attempt without launching an Agent. */
function blockedEnvironmentCase(id: string): ArtifactBenchmarkCase {
  return benchmarkCase(id, {
    execution: {
      profile: "clash-host",
      lane: "blocked-contract",
      requiredProductOperations: ["asset.get"],
      requiredCapabilities: ["generator-agent-surface"],
      preflight: {
        status: "blocked",
        checks: [
          {
            capability: "generator-agent-surface",
            status: "missing",
            detail: "The agent-facing contract is intentionally absent.",
          },
        ],
      },
      evidence: { traceRequired: true, submissionRequired: true },
      productReadback: {
        required: true,
        mechanism: "generator-authority-readback",
        artifactIds: ["result"],
        description: "Read the frozen Generator authority.",
      },
      environment: {
        profile: "clash-agent-environment-v1",
        track: "functional",
        outputs: {
          modifiedWorkspace: true,
          rawTrajectory: true,
          normalizedTrajectory: "clash-normalized-v1",
          atifTrajectory: "ATIF-v1.7-when-supported",
          otlpTrace: "otlp-json",
          attempt: "clash-attempt-v1",
        },
      },
    },
  });
}

/** A remote-kind backend that runs the Attempt in process under its claim. */
function containerClaimBackend(): ExecutionBackend {
  const claim: BenchmarkRuntimeClaim = {
    kind: "container",
    engine: { name: "docker", version: "0.0.0" },
    image: { id: `sha256:${"0".repeat(64)}` },
    network: "none",
  };
  return {
    kind: "container",
    maxConcurrency: 1,
    runtimeClaim: async () => claim,
    runAttempt: (dispatch) =>
      executeBenchmarkAttempt({ ...dispatch, runtime: claim }),
  };
}

type TestRunProgress = {
  schemaVersion: number;
  status: "in-progress" | "pass" | "fail" | "blocked" | "pending-review";
  attempts: Array<Record<string, unknown>>;
};

async function readRunProgress(
  outputRoot: string,
  runId: string,
): Promise<TestRunProgress> {
  return JSON.parse(
    await readFile(join(outputRoot, runId, "suite-progress.json"), "utf8"),
  ) as TestRunProgress;
}

describe("benchmark batch recovery", () => {
  it("finalizes suite progress with the terminal suite status", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-progress-final-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);

    const report = await runBenchmarkSuite({
      suite: suite([benchmarkCase("completed-case")]),
      suiteRoot,
      outputRoot,
      runId: "completed-run",
      agent: successfulAgent(),
    });

    expect(report.status).toBe("pass");
    await expect(
      readRunProgress(outputRoot, "completed-run"),
    ).resolves.toMatchObject({
      status: "pass",
      completedCases: [{ id: "completed-case", status: "pass", attempt: 1 }],
    });
  });

  it("rejects Environment resume when the selected model changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-env-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([
      benchmarkCase("blocked-environment", {
        execution: {
          profile: "clash-host",
          lane: "blocked-contract",
          requiredProductOperations: ["asset.get"],
          requiredCapabilities: ["generator-agent-surface"],
          preflight: {
            status: "blocked",
            checks: [
              {
                capability: "generator-agent-surface",
                status: "missing",
                detail: "The agent-facing contract is intentionally absent.",
              },
            ],
          },
          evidence: { traceRequired: true, submissionRequired: true },
          productReadback: {
            required: true,
            mechanism: "generator-authority-readback",
            artifactIds: ["result"],
            description: "Read the frozen Generator authority.",
          },
          environment: {
            profile: "clash-agent-environment-v1",
            track: "functional",
            outputs: {
              modifiedWorkspace: true,
              rawTrajectory: true,
              normalizedTrajectory: "clash-normalized-v1",
              atifTrajectory: "ATIF-v1.7-when-supported",
              otlpTrace: "otlp-json",
              attempt: "clash-attempt-v1",
            },
          },
        },
      }),
    ]);

    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "environment-selection",
      agent: { adapter: "codex", model: "gpt-5.6-sol" },
    });

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "environment-selection",
        agent: { adapter: "codex", model: "gpt-5.6-sol" },
        resume: true,
      }),
    ).resolves.toMatchObject({ status: "blocked", resumed: true });

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "environment-selection",
        agent: { adapter: "codex", model: "gpt-5.6-terra" },
        resume: true,
      }),
    ).rejects.toThrow(
      'agent.model (stored "gpt-5.6-sol", requested "gpt-5.6-terra")',
    );
  });

  it("rejects a resumed model switch for a case that sealed no Environment lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-model-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    // Stands in for the Agent executable: it ignores its arguments and exits.
    const agentPath = join(root, "agent.cjs");
    await writeFile(agentPath, "#!/usr/bin/env node\n", "utf8");
    await chmod(agentPath, 0o755);
    const common = {
      suite: suite([benchmarkCase("plain-case")]),
      suiteRoot,
      outputRoot,
      runId: "model-switch",
    };
    const agent = {
      adapter: "codex" as const,
      command: agentPath,
      model: "deepseek-flash",
    };

    await runBenchmarkSuite({ ...common, agent });
    const progressPath = join(
      outputRoot,
      "model-switch",
      "suite-progress.json",
    );
    const sealed = await readFile(progressPath, "utf8");

    await expect(
      runBenchmarkSuite({
        ...common,
        agent: { ...agent, model: "another-model" },
        resume: true,
      }),
    ).rejects.toThrow(
      'agent.model (stored "deepseek-flash", requested "another-model")',
    );
    // A refused resume leaves the run as it was.
    expect(await readFile(progressPath, "utf8")).toBe(sealed);

    await expect(
      runBenchmarkSuite({ ...common, agent, resume: true }),
    ).resolves.toMatchObject({ resumed: true });
  });

  it("names every run configuration field a resume changes, with both values", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-config-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    const cases = [
      blockedEnvironmentCase("first-case"),
      blockedEnvironmentCase("second-case"),
    ];
    const original = {
      suite: suite(cases),
      suiteRoot,
      outputRoot,
      runId: "config-run",
      agent: {
        adapter: "pi" as const,
        provider: "deepseek",
        model: "deepseek-flash",
        args: ["--verbose"],
      },
      trials: 2,
    };
    await runBenchmarkSuite(original);

    const changes: Array<[Partial<typeof original> | object, string]> = [
      [
        { agent: { ...original.agent, adapter: "codex" as const } },
        'agent.adapter (stored "pi", requested "codex")',
      ],
      [
        { agent: { ...original.agent, provider: "openrouter" } },
        'agent.provider (stored "deepseek", requested "openrouter")',
      ],
      [
        { agent: { adapter: "pi" as const, provider: "deepseek" } },
        'agent.model (stored "deepseek-flash", requested (not recorded))',
      ],
      [
        { agent: { ...original.agent, args: [] } },
        'agent.args (stored ["--verbose"], requested (not recorded))',
      ],
      [
        { backends: [containerClaimBackend()] },
        'backends (stored ["native-local"], requested ["container"])',
      ],
      [
        {
          backends: [createNativeLocalBackend(), createNativeLocalBackend()],
        },
        'backends (stored ["native-local"], requested ["native-local","native-local"])',
      ],
      [
        { suite: suite([cases[0]!]) },
        'cases (stored ["first-case","second-case"], requested ["first-case"])',
      ],
      [{ trials: 3 }, "execution.trials (stored 2, requested 3)"],
      [
        { placement: "spread" as const },
        'execution.placement (stored "per-task", requested "spread")',
      ],
    ];
    for (const [change, mismatch] of changes) {
      const resumed = runBenchmarkSuite({
        ...original,
        ...change,
        resume: true,
      });
      await expect(resumed).rejects.toThrow(
        "Cannot resume run 'config-run': the requested configuration differs from the existing run manifest",
      );
      await expect(resumed).rejects.toThrow(mismatch);
    }

    // One error reports every changed field.
    const combined = runBenchmarkSuite({
      ...original,
      agent: { ...original.agent, model: "another-model" },
      trials: 3,
      resume: true,
    });
    await expect(combined).rejects.toThrow(
      /agent\.model .*; execution\.trials /u,
    );

    await expect(
      runBenchmarkSuite({ ...original, resume: true }),
    ).resolves.toMatchObject({ resumed: true });
  });

  it("refuses to resume a run manifest that does not record its Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-legacy-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    const common = {
      suite: suite([blockedEnvironmentCase("blocked-environment")]),
      suiteRoot,
      outputRoot,
      runId: "unrecorded-agent",
      agent: { adapter: "codex" as const, model: "gpt-5.6-sol" },
    };
    await runBenchmarkSuite(common);
    const manifestPath = join(
      outputRoot,
      "unrecorded-agent",
      "run-manifest.json",
    );
    const { agent: _agent, ...unrecorded } = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify(unrecorded), "utf8");

    await expect(
      runBenchmarkSuite({ ...common, resume: true }),
    ).rejects.toThrow(
      'agent.model (stored (not recorded), requested "gpt-5.6-sol")',
    );
  });

  it("resumes an Environment under a different judge and keeps the judge the Attempt recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-judge-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([
      benchmarkCase("blocked-environment", {
        execution: {
          profile: "clash-host",
          lane: "blocked-contract",
          requiredProductOperations: ["asset.get"],
          requiredCapabilities: ["generator-agent-surface"],
          preflight: {
            status: "blocked",
            checks: [
              {
                capability: "generator-agent-surface",
                status: "missing",
                detail: "The agent-facing contract is intentionally absent.",
              },
            ],
          },
          evidence: { traceRequired: true, submissionRequired: true },
          productReadback: {
            required: true,
            mechanism: "generator-authority-readback",
            artifactIds: ["result"],
            description: "Read the frozen Generator authority.",
          },
          environment: {
            profile: "clash-agent-environment-v1",
            track: "functional",
            outputs: {
              modifiedWorkspace: true,
              rawTrajectory: true,
              normalizedTrajectory: "clash-normalized-v1",
              atifTrajectory: "ATIF-v1.7-when-supported",
              otlpTrace: "otlp-json",
              attempt: "clash-attempt-v1",
            },
          },
        },
      }),
    ]);

    const judge = {
      adapter: "gemini" as const,
      provider: "google" as const,
      model: "gemini-judge",
      apiKeyEnv: "CLASH_TEST_JUDGE_KEY",
    };
    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "judge-selection",
      agent: { adapter: "codex", model: "gpt-5.6-sol" },
      qualityReviewer: judge,
    });
    const progress = await readRunProgress(outputRoot, "judge-selection");
    const lockPath = join(
      outputRoot,
      "judge-selection",
      progress.attempts[0]!.caseRoot as string,
      "environment-lock.json",
    );
    const sealed = await readFile(lockPath, "utf8");
    expect(JSON.parse(sealed)).toMatchObject({
      qualityJudge: { kind: "gemini", model: judge.model },
    });

    for (const qualityReviewer of [
      { ...judge, model: "gemini-judge-next" },
      { ...judge, baseUrl: "https://relay.example" },
      undefined,
    ]) {
      await expect(
        runBenchmarkSuite({
          suite: benchmarkSuite,
          suiteRoot,
          outputRoot,
          runId: "judge-selection",
          agent: { adapter: "codex", model: "gpt-5.6-sol" },
          ...(qualityReviewer ? { qualityReviewer } : {}),
          resume: true,
        }),
      ).resolves.toMatchObject({ status: "blocked", resumed: true });
    }
    expect(await readFile(lockPath, "utf8")).toBe(sealed);

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "judge-selection",
        agent: { adapter: "codex", model: "gpt-5.6-terra" },
        qualityReviewer: judge,
        resume: true,
      }),
    ).rejects.toThrow(
      'agent.model (stored "gpt-5.6-sol", requested "gpt-5.6-terra")',
    );
  });

  it("ignores Evaluation changes on resume but rejects a mutated immutable Attempt", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "clash-bench-env-bundle-resume-"),
    );
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([
      benchmarkCase("blocked-environment", {
        execution: {
          profile: "clash-host",
          lane: "blocked-contract",
          requiredProductOperations: ["asset.get"],
          requiredCapabilities: ["generator-agent-surface"],
          preflight: {
            status: "blocked",
            checks: [
              {
                capability: "generator-agent-surface",
                status: "missing",
                detail: "The agent-facing contract is intentionally absent.",
              },
            ],
          },
          evidence: { traceRequired: true, submissionRequired: true },
          productReadback: {
            required: true,
            mechanism: "generator-authority-readback",
            artifactIds: ["result"],
            description: "Read the frozen Generator authority.",
          },
          environment: {
            profile: "clash-agent-environment-v1",
            track: "functional",
            outputs: {
              modifiedWorkspace: true,
              rawTrajectory: true,
              normalizedTrajectory: "clash-normalized-v1",
              atifTrajectory: "ATIF-v1.7-when-supported",
              otlpTrace: "otlp-json",
              attempt: "clash-attempt-v1",
            },
          },
        },
      }),
    ]);

    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "environment-bundle",
      agent: { adapter: "codex", model: "gpt-5.6-sol" },
    });
    const progress = await readRunProgress(outputRoot, "environment-bundle");
    const completed = progress.attempts.find(
      ({ event }) => event === "completed",
    );
    expect(completed).toBeDefined();
    expect(typeof completed?.reportPath).toBe("string");
    const reportPath = join(
      outputRoot,
      "environment-bundle",
      completed!.reportPath as string,
    );
    const report = await readFile(reportPath, "utf8");
    await writeFile(reportPath, `${report.trimEnd()}\n\n`, "utf8");

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "environment-bundle",
        agent: { adapter: "codex", model: "gpt-5.6-sol" },
        resume: true,
      }),
    ).resolves.toMatchObject({ resumed: true, status: "blocked" });

    expect(typeof completed?.attemptPath).toBe("string");
    const attemptPath = join(
      outputRoot,
      "environment-bundle",
      completed!.attemptPath as string,
    );
    const attempt = await readFile(attemptPath, "utf8");
    await writeFile(attemptPath, `${attempt.trimEnd()}\n\n`, "utf8");

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "environment-bundle",
        agent: { adapter: "codex", model: "gpt-5.6-sol" },
        resume: true,
      }),
    ).rejects.toThrow(/immutable Attempt.*does not match/iu);
  });

  it("isolates a case setup crash, retries only that infrastructure failure, and continues the suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-isolation-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);

    const report = await runBenchmarkSuite({
      suite: suite([
        benchmarkCase("broken-setup", { skills: ["skills/does-not-exist"] }),
        benchmarkCase("still-runs"),
      ]),
      suiteRoot,
      outputRoot,
      runId: "isolated-run",
      agent: successfulAgent(),
      maxInfrastructureAttempts: 2,
    });

    expect(report.status).toBe("fail");
    expect(report.cases).toHaveLength(2);
    expect(report.cases[0]).toMatchObject({
      id: "broken-setup",
      status: "fail",
      attempt: 2,
      failure: { classification: "infrastructure", retryable: true },
      agent: { status: "not-run" },
    });
    expect(report.cases[1]).toMatchObject({
      id: "still-runs",
      status: "pass",
      attempt: 1,
    });
    await expect(
      readFile(
        join(
          outputRoot,
          "isolated-run",
          "still-runs",
          "workspace",
          "result.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("artifact");
    await expect(
      readFile(
        join(
          outputRoot,
          "isolated-run",
          "broken-setup",
          "workspace",
          "outcome.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("broken-setup");
    await expect(
      readFile(
        join(
          outputRoot,
          "isolated-run",
          "broken-setup",
          "attempts",
          "002",
          "runner-error.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("does-not-exist");

    const ledger = (await readRunProgress(outputRoot, "isolated-run")).attempts;
    expect(
      ledger.map(({ caseId, attempt, event, status }) => ({
        caseId,
        attempt,
        event,
        status,
      })),
    ).toEqual([
      {
        caseId: "broken-setup",
        attempt: 1,
        event: "started",
        status: undefined,
      },
      {
        caseId: "broken-setup",
        attempt: 1,
        event: "completed",
        status: "fail",
      },
      {
        caseId: "broken-setup",
        attempt: 2,
        event: "started",
        status: undefined,
      },
      {
        caseId: "broken-setup",
        attempt: 2,
        event: "completed",
        status: "fail",
      },
      { caseId: "still-runs", attempt: 1, event: "started", status: undefined },
      { caseId: "still-runs", attempt: 1, event: "completed", status: "pass" },
    ]);
  });

  it("resumes an infrastructure failure into a new preserved attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-resume-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const agentPath = join(root, "late-agent");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([benchmarkCase("recoverable")]);

    const first = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "resume-run",
      agent: { command: agentPath },
      maxInfrastructureAttempts: 1,
    });
    expect(first.cases[0]).toMatchObject({
      attempt: 1,
      failure: { classification: "infrastructure", retryable: true },
      agent: { status: "spawn-error" },
    });

    await writeFile(
      agentPath,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        "const workspace = process.env.CLASH_BENCH_WORKSPACE",
        "const caseId = process.env.CLASH_BENCH_CASE_ID",
        'fs.writeFileSync(path.join(workspace, "result.txt"), "recovered")',
        'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:caseId,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
      ].join("\n"),
      "utf8",
    );
    await chmod(agentPath, 0o755);

    const resumed = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "resume-run",
      agent: { command: agentPath },
      resume: true,
      maxInfrastructureAttempts: 2,
    });

    expect(resumed).toMatchObject({ status: "pass", resumed: true });
    expect(resumed.cases[0]).toMatchObject({ attempt: 2, status: "pass" });
    expect(resumed.cases[0]?.workspace).toBe(
      await realpath(
        join(
          outputRoot,
          "resume-run",
          "recoverable",
          "attempts",
          "002",
          "workspace",
        ),
      ),
    );
    await expect(
      readFile(
        join(outputRoot, "resume-run", "recoverable", "logs", "stderr.log"),
        "utf8",
      ),
    ).resolves.toMatch(/ENOENT|spawn/i);
    const gallery = await readFile(
      join(outputRoot, "resume-run", "report.html"),
      "utf8",
    );
    expect(gallery).toContain("recoverable/attempts/002/workspace/result.txt");
  }, 15_000);

  it("does not rerun evaluation failures when resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-no-mask-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "counter.txt");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([benchmarkCase("creative-failure")]);
    const failingAgent: BenchmarkAgent = {
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs")',
          'const current = Number(fs.existsSync(process.env.COUNTER_PATH) ? fs.readFileSync(process.env.COUNTER_PATH, "utf8") : "0")',
          "fs.writeFileSync(process.env.COUNTER_PATH, String(current + 1))",
        ].join(";"),
      ],
      env: { COUNTER_PATH: counterPath },
    };

    const first = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "no-mask-run",
      agent: failingAgent,
      maxInfrastructureAttempts: 2,
    });
    expect(first.cases[0]).toMatchObject({
      attempt: 1,
      failure: { classification: "evaluation", retryable: false },
    });

    const resumed = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "no-mask-run",
      agent: successfulAgent(
        'fs.writeFileSync(process.env.COUNTER_PATH, "999")',
      ),
      resume: true,
      maxInfrastructureAttempts: 10,
    });
    expect(resumed.cases[0]).toMatchObject({
      attempt: 1,
      failure: { classification: "evaluation", retryable: false },
    });
    expect(await readFile(counterPath, "utf8")).toBe("1");
    const ledger = (await readRunProgress(outputRoot, "no-mask-run")).attempts;
    expect(ledger.filter(({ event }) => event === "started")).toHaveLength(1);
  });

  it("records force-pending after each failed forced retry before granting the next one", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-force-pending-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "counter.txt");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([benchmarkCase("creative-failure")]);
    const failingAgent: BenchmarkAgent = {
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs")',
          'const current = Number(fs.existsSync(process.env.COUNTER_PATH) ? fs.readFileSync(process.env.COUNTER_PATH, "utf8") : "0")',
          "fs.writeFileSync(process.env.COUNTER_PATH, String(current + 1))",
        ].join(";"),
      ],
      env: { COUNTER_PATH: counterPath },
    };

    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-run",
      agent: failingAgent,
      maxInfrastructureAttempts: 1,
    });

    const firstForced = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-run",
      agent: failingAgent,
      resume: true,
      force: true,
      maxInfrastructureAttempts: 1,
    });
    expect(firstForced.cases[0]).toMatchObject({
      attempt: 2,
      status: "fail",
      forcePending: true,
      failure: { classification: "evaluation", retryable: false },
    });
    expect(await readFile(counterPath, "utf8")).toBe("2");

    const resumedWithoutForce = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-run",
      agent: successfulAgent(
        'fs.writeFileSync(process.env.COUNTER_PATH, "999")',
      ),
      resume: true,
      maxInfrastructureAttempts: 1,
    });
    expect(resumedWithoutForce.cases[0]).toMatchObject({
      attempt: 2,
      status: "fail",
      forcePending: true,
    });
    expect(await readFile(counterPath, "utf8")).toBe("2");

    const secondForced = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-run",
      agent: failingAgent,
      resume: true,
      force: true,
      maxInfrastructureAttempts: 1,
    });
    expect(secondForced.cases[0]).toMatchObject({
      attempt: 3,
      status: "fail",
      forcePending: true,
    });
    expect(await readFile(counterPath, "utf8")).toBe("3");

    const runProgress = await readRunProgress(outputRoot, "force-run");
    expect(runProgress.schemaVersion).toBe(2);
    const ledger = runProgress.attempts;
    expect(
      ledger.map(({ attempt, event, forced }) => ({ attempt, event, forced })),
    ).toEqual([
      { attempt: 1, event: "started", forced: undefined },
      { attempt: 1, event: "completed", forced: undefined },
      { attempt: 2, event: "started", forced: true },
      { attempt: 2, event: "completed", forced: true },
      { attempt: 2, event: "force-pending", forced: true },
      { attempt: 3, event: "started", forced: true },
      { attempt: 3, event: "completed", forced: true },
      { attempt: 3, event: "force-pending", forced: true },
    ]);
    await expect(
      readFile(join(outputRoot, "force-run", "attempts.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second forced retry when the previous forced failure has no force-pending record", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-force-guard-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "counter.txt");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([benchmarkCase("creative-failure")]);
    const failingAgent: BenchmarkAgent = {
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs")',
          'const current = Number(fs.existsSync(process.env.COUNTER_PATH) ? fs.readFileSync(process.env.COUNTER_PATH, "utf8") : "0")',
          "fs.writeFileSync(process.env.COUNTER_PATH, String(current + 1))",
        ].join(";"),
      ],
      env: { COUNTER_PATH: counterPath },
    };

    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "guard-run",
      agent: failingAgent,
      maxInfrastructureAttempts: 1,
    });
    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "guard-run",
      agent: failingAgent,
      resume: true,
      force: true,
      maxInfrastructureAttempts: 1,
    });

    const progressPath = join(outputRoot, "guard-run", "suite-progress.json");
    const progress = await readRunProgress(outputRoot, "guard-run");
    await writeFile(
      progressPath,
      `${JSON.stringify(
        {
          ...progress,
          attempts: progress.attempts.filter(
            ({ event }) => event !== "force-pending",
          ),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      runBenchmarkSuite({
        suite: benchmarkSuite,
        suiteRoot,
        outputRoot,
        runId: "guard-run",
        agent: failingAgent,
        resume: true,
        force: true,
        maxInfrastructureAttempts: 1,
      }),
    ).rejects.toThrow(/force-pending.*creative-failure/i);
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });

  it("does not turn a failed forced retry into an automatic infrastructure retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-force-infra-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "counter.txt");
    await mkdir(suiteRoot);
    const benchmarkSuite = suite([benchmarkCase("forced-infra")]);
    const initialFailure: BenchmarkAgent = {
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs")',
          'fs.writeFileSync(process.env.COUNTER_PATH, "1")',
        ].join(";"),
      ],
      env: { COUNTER_PATH: counterPath },
    };

    await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-infra-run",
      agent: initialFailure,
      maxInfrastructureAttempts: 1,
    });
    const firstForced = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-infra-run",
      agent: { command: join(root, "missing-agent") },
      resume: true,
      force: true,
      maxInfrastructureAttempts: 10,
    });
    expect(firstForced.cases[0]).toMatchObject({
      attempt: 2,
      failure: { classification: "infrastructure", retryable: true },
    });

    const plainResume = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-infra-run",
      agent: successfulAgent(
        'fs.writeFileSync(process.env.COUNTER_PATH, "999")',
      ),
      resume: true,
      maxInfrastructureAttempts: 10,
    });
    expect(plainResume.cases[0]).toMatchObject({
      attempt: 2,
      failure: { classification: "infrastructure", retryable: true },
    });
    expect(await readFile(counterPath, "utf8")).toBe("1");

    const secondForced = await runBenchmarkSuite({
      suite: benchmarkSuite,
      suiteRoot,
      outputRoot,
      runId: "force-infra-run",
      agent: {
        ...successfulAgent('fs.writeFileSync(process.env.COUNTER_PATH, "2")'),
        env: { COUNTER_PATH: counterPath },
      },
      resume: true,
      force: true,
      maxInfrastructureAttempts: 10,
    });
    expect(secondForced.cases[0]).toMatchObject({ attempt: 3, status: "pass" });
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });

  it("records blocked preflight cases without launching the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-blocked-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const launchedPath = join(root, "launched.txt");
    await mkdir(suiteRoot);

    const report = await runBenchmarkSuite({
      suite: suite([
        benchmarkCase("blocked-case", {
          execution: {
            profile: "clash-host",
            requiredMcpTools: ["clash"],
            requiredCapabilities: ["timeline-headless-render"],
            preflight: {
              status: "blocked",
              checks: [
                {
                  capability: "timeline-headless-render",
                  status: "missing",
                  detail: "No renderer is installed in the packaged host.",
                },
              ],
            },
            evidence: {
              traceRequired: true,
              submissionRequired: true,
            },
            productReadback: {
              required: true,
              mechanism: "timeline-render-readback",
              artifactIds: ["result"],
              description:
                "Read the rendered timeline back from the product daemon.",
            },
          },
        }),
      ]),
      suiteRoot,
      outputRoot,
      runId: "blocked-run",
      agent: successfulAgent(
        `fs.writeFileSync(${JSON.stringify(launchedPath)}, "launched")`,
      ),
    });

    expect(report.status).toBe("blocked");
    expect(report.cases[0]).toMatchObject({
      status: "blocked",
      attempt: 1,
      failure: { classification: "preflight", retryable: false },
      agent: { status: "not-run" },
      execution: { status: "blocked" },
      evaluation: { status: "not-run" },
      outcome: { status: "blocked" },
    });
    await expect(readFile(launchedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(
        join(outputRoot, "blocked-run", "blocked-case", "preflight.json"),
        "utf8",
      ),
    ).resolves.toContain("timeline-headless-render");
  });
});
