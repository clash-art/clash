import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertSealedRuntimeMatches } from "./attempt-unit";
import { runAttemptUnit } from "./attempt-worker";
import {
  createContainerBackend,
  type ContainerCommandRunner,
} from "./backend-container";
import type { BenchmarkRuntimeClaim } from "./backend-types";
import {
  BenchmarkProcessScope,
  executeBenchmarkAttempt,
  runBenchmarkSuite,
} from "./runner";
import type { ArtifactBenchmarkCase, BenchmarkAgent } from "./types";

const SECRET = "sk-test-credential-that-must-never-leave-the-environment";
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function benchmarkCase(id: string): ArtifactBenchmarkCase {
  return {
    id,
    title: id,
    category: "timeline",
    outcome: {
      objective: "Create the artifact.",
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

const agent: BenchmarkAgent = {
  command: process.execPath,
  env: { PROVIDER_API_KEY: SECRET },
  args: [
    "-e",
    `
    const fs = require("node:fs"), path = require("node:path");
    const w = process.env.CLASH_BENCH_WORKSPACE, c = process.env.CLASH_BENCH_CASE_ID;
    fs.writeFileSync(path.join(w, "result.txt"), process.env.PROVIDER_API_KEY ? "has-credential" : "no-credential");
    fs.writeFileSync(path.join(w, "submission.json"), JSON.stringify({schemaVersion:1,taskId:c,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}));
  `,
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clash-bench-container-"));
  const suiteRoot = join(root, "suite");
  await mkdir(suiteRoot);
  const suite = {
    schemaVersion: 1 as const,
    id: "container-suite",
    title: "Container suite",
    cases: [benchmarkCase("task")],
  };
  await writeFile(join(suiteRoot, "suite.json"), JSON.stringify(suite));
  return { root, suiteRoot, outputRoot: join(root, "runs"), suite };
}

type EngineCall = { args: string[]; env: NodeJS.ProcessEnv };

/** An engine that answers metadata calls and runs the worker with only the env it was handed by name. */
function fakeEngine(
  calls: EngineCall[],
  behavior: {
    version?: { code: number; stdout: string; stderr?: string };
    runWorker?: (
      args: string[],
      env: NodeJS.ProcessEnv,
    ) => Promise<{ code: number; stderr: string }>;
  } = {},
): ContainerCommandRunner {
  return async (_command, args, options) => {
    calls.push({ args, env: options.env });
    const ok = (stdout: string) => ({
      code: 0,
      signal: null,
      stdout,
      stderr: "",
    });
    if (args[0] === "version") {
      const v = behavior.version ?? { code: 0, stdout: "27.1.0\n" };
      return {
        code: v.code,
        signal: null,
        stdout: v.stdout,
        stderr: v.stderr ?? "",
      };
    }
    if (args[0] === "image") return ok(`${IMAGE_ID}\n`);
    if (args[0] === "kill" || args[0] === "rm") return ok("");
    const named = new Set(
      args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : [])),
    );
    const containerEnv = Object.fromEntries(
      [...named].flatMap((name) =>
        options.env[name] === undefined ? [] : [[name, options.env[name]!]],
      ),
    );
    const unitPath = args[args.length - 1]!;
    if (behavior.runWorker) {
      const result = await behavior.runWorker(args, containerEnv);
      return {
        code: result.code,
        signal: null,
        stdout: "",
        stderr: result.stderr,
      };
    }
    await runAttemptUnit(unitPath, { env: containerEnv });
    return ok("");
  };
}

describe("container backend", () => {
  it("mounts a named runner Node read-only and starts the worker with it, so the image needs none", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const runnerNode = "/opt/runner-toolchain/bin/node";
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          runnerNode,
          run: fakeEngine(calls),
        }),
      ],
    });
    expect(report.status).toBe("pass");
    const { args } = calls.find((call) => call.args[0] === "run")!;
    expect(args).toContain(`${runnerNode}:${runnerNode}:ro`);
    expect(args[args.indexOf("bench:bare") + 1]).toBe(runnerNode);
  });

  it("passes credentials by name, mounts inputs read-only, and records the image id", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const backend = createContainerBackend({
      image: "bench:test",
      runnerRoot: process.cwd(),
      suiteFile: "suite.json",
      workerCommand: ["worker-entry"],
      network: "none",
      run: fakeEngine(calls),
    });
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      backends: [backend],
    });
    expect(report.status).toBe("pass");

    const runCall = calls.find(({ args }) => args[0] === "run")!;
    // The credential reaches the engine only through its process environment.
    expect(JSON.stringify(runCall.args)).not.toContain(SECRET);
    expect(runCall.args).toContain("PROVIDER_API_KEY");
    expect(runCall.args[runCall.args.indexOf("--network") + 1]).toBe("none");
    const volumes = runCall.args.flatMap((arg, index) =>
      runCall.args[index - 1] === "--volume" ? [arg] : [],
    );
    expect(volumes).toContain(`${suiteRoot}:${suiteRoot}:ro`);
    const caseRoot = join(outputRoot, "run", "task");
    expect(volumes).toContain(`${caseRoot}:${caseRoot}`);
    expect(runCall.args).toContain("--rm");
    // The default network is left to the engine rather than guessed at.
    const defaultCalls: EngineCall[] = [];
    await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot: join(outputRoot, "default-network"),
      runId: "run",
      agent,
      backends: [
        createContainerBackend({
          image: "bench:test",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          run: fakeEngine(defaultCalls),
        }),
      ],
    });
    expect(
      defaultCalls.find(({ args }) => args[0] === "run")!.args,
    ).not.toContain("--network");

    await expect(backend.runtimeClaim()).resolves.toEqual({
      kind: "container",
      engine: { name: "docker", version: "27.1.0" },
      image: { id: IMAGE_ID },
      network: "none",
    });
    // The Agent saw the credential inside the "container", and nothing on disk has it.
    expect(
      await readFile(join(caseRoot, "workspace", "result.txt"), "utf8"),
    ).toBe("has-credential");
    const everyFile = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { withFileTypes: true })).flatMap((entry) =>
        entry.isDirectory() ? [] : [join(dir, entry.name)],
      );
    for (const file of await everyFile(join(outputRoot, "run"))) {
      expect(await readFile(file, "utf8").catch(() => "")).not.toContain(
        SECRET,
      );
    }
  });

  it("seals a missing worker credential as an infrastructure failure, naming the variable", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:test",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          run: fakeEngine([], {
            // The engine forgot to forward the variable.
            runWorker: async (args) => {
              const unitPath = args[args.length - 1]!;
              await runAttemptUnit(unitPath, { env: {} }).catch((error) => {
                throw error;
              });
              return { code: 0, stderr: "" };
            },
          }),
        }),
      ],
    });
    expect(report.cases[0]?.status).toBe("fail");
    expect(report.cases[0]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("PROVIDER_API_KEY"),
    });
  });

  it("turns an unavailable engine into a sealed infrastructure failure", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:test",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          run: fakeEngine([], {
            version: {
              code: 1,
              stdout: "",
              stderr: "Cannot connect to the daemon",
            },
          }),
        }),
      ],
    });
    expect(report.cases[0]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("Cannot connect to the daemon"),
    });
  });

  it("keeps a crashed worker's output as evidence instead of sealing it as an Attempt", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:test",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          run: fakeEngine([], {
            runWorker: async (args) => {
              void args;
              const target = join(
                outputRoot,
                "run",
                "task",
                "half-written.txt",
              );
              await writeFile(target, "partial");
              return { code: 137, stderr: "Killed" };
            },
          }),
        }),
      ],
    });
    expect(report.cases[0]?.failure?.detail).toContain("exited 137");
    const rejected = join(outputRoot, "run", ".rejected-worker-output", "task");
    expect(await readFile(join(rejected, "half-written.txt"), "utf8")).toBe(
      "partial",
    );
  });
});

/** A case whose capability contract blocks it before any Agent runs. */
function blockedCase(id: string): ArtifactBenchmarkCase {
  return {
    ...benchmarkCase(id),
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
  };
}

describe("preflight-blocked cases", () => {
  async function blockedFixture() {
    const base = await fixture();
    const suite = { ...base.suite, cases: [blockedCase("blocked-task")] };
    await writeFile(join(base.suiteRoot, "suite.json"), JSON.stringify(suite));
    return { ...base, suite };
  }

  async function expectBlockedRecord(
    outputRoot: string,
    report: Awaited<ReturnType<typeof runBenchmarkSuite>>,
  ) {
    expect(report.status).toBe("blocked");
    expect(report.cases[0]).toMatchObject({
      status: "blocked",
      attempt: 1,
      agent: { status: "not-run" },
      failure: { classification: "preflight", retryable: false },
    });
    const runRoot = join(outputRoot, "run");
    const caseRoot = join(runRoot, "blocked-task");
    expect(await readdir(runRoot)).not.toContain(".rejected-worker-output");
    expect(
      JSON.parse(await readFile(join(caseRoot, "preflight.json"), "utf8")),
    ).toMatchObject({ status: "blocked" });
    const sealed = await readdir(caseRoot);
    expect(sealed).toEqual(
      expect.arrayContaining(["environment-lock.json", "attempt.json"]),
    );
  }

  it("records the not-run Attempt in the dispatcher on the container backend, without starting a worker", async () => {
    const { suiteRoot, outputRoot, suite } = await blockedFixture();
    const calls: EngineCall[] = [];
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: { adapter: "pi", provider: "test-provider", model: "test-model" },
      backends: [
        createContainerBackend({
          image: "bench:test",
          runnerRoot: process.cwd(),
          suiteFile: "suite.json",
          run: fakeEngine(calls),
        }),
      ],
    });

    await expectBlockedRecord(outputRoot, report);
    expect(calls.filter(({ args }) => args[0] === "run")).toEqual([]);
  });

  it("records the not-run Attempt without dispatching on the native backend", async () => {
    const { suiteRoot, outputRoot, suite } = await blockedFixture();
    let dispatched = 0;
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent: { adapter: "pi", provider: "test-provider", model: "test-model" },
      backends: [
        {
          kind: "native-local",
          maxConcurrency: 1,
          runtimeClaim: async () => ({ kind: "native-local" }),
          runAttempt: async (dispatch) => {
            dispatched += 1;
            return executeBenchmarkAttempt(dispatch);
          },
        },
      ],
    });

    await expectBlockedRecord(outputRoot, report);
    expect(dispatched).toBe(0);
  });

  it("lets a worker seal a blocked case into the directory its dispatcher created", async () => {
    const { suiteRoot, outputRoot, suite } = await blockedFixture();
    const runRoot = join(outputRoot, "run");
    const caseRoot = join(runRoot, "blocked-task");
    await mkdir(caseRoot, { recursive: true });
    const processScope = new BenchmarkProcessScope();
    const attempt = {
      suiteId: suite.id,
      runId: "run",
      benchmark: suite.cases[0]!,
      agent: {
        adapter: "pi",
        provider: "test-provider",
        model: "test-model",
      } satisfies BenchmarkAgent,
      suiteRoot,
      runRoot,
      caseRoot,
      attempt: 1,
      trial: 1,
      forced: false,
      startedAt: new Date().toISOString(),
      processScope,
    };

    // Without adoption the worker refuses the existing directory and then
    // cannot seal: the ENOENT a blocked case used to end in on this backend.
    await expect(executeBenchmarkAttempt(attempt)).rejects.toThrow(
      /ENOENT.*environment-lock\.json/u,
    );

    await rm(caseRoot, { recursive: true });
    await mkdir(caseRoot);
    const adopted = await executeBenchmarkAttempt({
      ...attempt,
      adoptCaseRoot: true,
    });
    expect(adopted.report).toMatchObject({
      status: "blocked",
      failure: { classification: "preflight", retryable: false },
    });
    expect(adopted.attemptReceipt).toBeDefined();
  });
});

describe("sealed runtime check", () => {
  const container: BenchmarkRuntimeClaim = {
    kind: "container",
    engine: { name: "docker", version: "27" },
    image: { id: IMAGE_ID },
    network: "engine-default",
  };
  const lockOf = (runtime: unknown) => ({
    resolvedEnvironment: {
      runtime: runtime as { kind?: string; backend?: unknown },
    },
  });

  it("accepts an Attempt sealed with the dispatched backend claim", () => {
    expect(() =>
      assertSealedRuntimeMatches(
        lockOf({ kind: "container", backend: container }),
        container,
      ),
    ).not.toThrow();
  });

  it("rejects an Attempt that was sealed as running somewhere else", () => {
    expect(() =>
      assertSealedRuntimeMatches(lockOf({ kind: "native-local" }), container),
    ).toThrow(/not the dispatched 'container' backend/u);
  });

  it("rejects an Attempt sealed against a different image", () => {
    const otherImage = {
      ...container,
      image: { id: `sha256:${"c".repeat(64)}` },
    };
    expect(() =>
      assertSealedRuntimeMatches(
        lockOf({ kind: "container", backend: otherImage }),
        container,
      ),
    ).toThrow();
  });
});
