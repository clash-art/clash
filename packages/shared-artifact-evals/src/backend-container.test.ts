import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { runBenchmarkSuite } from "./runner";
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
