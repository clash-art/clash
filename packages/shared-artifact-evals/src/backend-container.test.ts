import type * as ChildProcessModule from "node:child_process";
import type * as FsPromisesModule from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "./agent-isolation";
import { assertSealedRuntimeMatches, type AttemptUnit } from "./attempt-unit";
import { runAttemptUnit } from "./attempt-worker";
import {
  bundleContainerWorker,
  createContainerBackend,
  DEFAULT_CONTAINER_AGENT_USER,
  spawnContainerCommand,
  type ContainerCommandRunner,
} from "./backend-container";
import type { BenchmarkRuntimeClaim } from "./backend-types";
import {
  BenchmarkProcessScope,
  executeBenchmarkAttempt,
  runBenchmarkSuite,
} from "./runner";
import type { ArtifactBenchmarkCase, BenchmarkAgent } from "./types";

// This suite is not root, so it cannot switch uid. A process the worker starts
// as another uid is recorded and started as this one; a handover is recorded
// and skipped. Everything else runs unchanged.
const isolated = vi.hoisted(() => ({
  spawns: [] as Array<{ command: string; uid?: number; gid?: number }>,
  handovers: [] as Array<{ path: string; uid: number; gid: number }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  const spawn = ((
    command: string,
    args: readonly string[],
    options: ChildProcessModule.SpawnOptions,
  ) => {
    if (options?.uid === undefined && options?.gid === undefined) {
      return actual.spawn(command, args, options);
    }
    const { uid, gid, ...rest } = options;
    isolated.spawns.push({
      command,
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
    });
    return actual.spawn(command, args, rest);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    lchown: async (path: string, uid: number, gid: number) => {
      isolated.handovers.push({ path: String(path), uid, gid });
    },
  };
});

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

type EngineCall = { args: string[]; env: NodeJS.ProcessEnv; stdin?: string };

const WORKER_PROGRAM = "/* bundled worker */";
const bundleWorker = async () => WORKER_PROGRAM;
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const GRADER_SOURCES = ["evaluator.ts", "product-readback.ts", "runner.ts"].map(
  (name) => join(REPO_ROOT, "packages", "shared-artifact-evals", "src", name),
);

function mounts(args: string[]): Array<{ source: string; target: string }> {
  return args.flatMap((arg, index) => {
    if (args[index - 1] !== "--volume") return [];
    const [source, target] = arg.split(":");
    return [{ source: source!, target: target! }];
  });
}

/** Where the worker's grader inputs are mounted: inside the unit directory. */
function privateRootOf(args: string[]): string {
  return join(dirname(args[args.length - 1]!), "ro");
}

/** True when `path` is `root` or a file below it, so mounting `root` exposes it. */
function reaches(root: string, path: string): boolean {
  const local = relative(root, path);
  return !local.startsWith("..") && !isAbsolute(local);
}

/** The host file behind a container path: the deepest mount that covers it. */
function hostPathOf(
  mounted: Array<{ source: string; target: string }>,
  path: string,
): string | undefined {
  const covering = mounted
    .filter(({ target }) => reaches(target, path))
    .sort((left, right) => right.target.length - left.target.length)[0];
  return covering && join(covering.source, relative(covering.target, path));
}

async function permits(
  hostPath: string,
  who: ProcessIdentity,
  bit: number,
): Promise<boolean> {
  const info = await stat(hostPath);
  const shift = info.uid === who.uid ? 6 : info.gid === who.gid ? 3 : 0;
  return ((info.mode >> shift) & bit) !== 0;
}

/**
 * Whether `who` could open a container path under ordinary Unix permissions:
 * every mounted directory on the way must be searchable and the file readable.
 * Directories no mount covers come from the image and are taken as open.
 */
async function canRead(
  mounted: Array<{ source: string; target: string }>,
  path: string,
  who: ProcessIdentity,
): Promise<boolean> {
  const parts = path.split(sep).filter(Boolean);
  for (let depth = 1; depth < parts.length; depth += 1) {
    const directory = hostPathOf(
      mounted,
      `${sep}${parts.slice(0, depth).join(sep)}`,
    );
    if (directory && !(await permits(directory, who, 0o1))) return false;
  }
  const file = hostPathOf(mounted, path);
  return file !== undefined && (await permits(file, who, 0o4));
}

/** Every file a container sees through its mounts, by container path. */
async function mountedFiles(
  mounted: Array<{ source: string; target: string }>,
): Promise<string[]> {
  const files = new Set<string>();
  for (const { source, target } of mounted) {
    const info = await stat(source).catch(() => undefined);
    if (!info) continue;
    if (!info.isDirectory()) {
      files.add(target);
      continue;
    }
    for (const entry of await readdir(source, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile()) {
        files.add(
          join(target, relative(source, join(entry.parentPath, entry.name))),
        );
      }
    }
  }
  return [...files];
}

/**
 * Stands in for the engine's bind mounts: a target that is not the source's
 * own path becomes a link to the source, so the worker finds it.
 */
async function simulateMounts(args: string[]): Promise<void> {
  for (const { source, target } of mounts(args)) {
    if (source === target) continue;
    await rm(target, { recursive: true, force: true });
    await symlink(source, target);
  }
}

/** An engine that answers metadata calls and runs the worker with only the env it was handed by name. */
function fakeEngine(
  calls: EngineCall[],
  behavior: {
    version?: { code: number; stdout: string; stderr?: string };
    runWorker?: (
      args: string[],
      env: NodeJS.ProcessEnv,
    ) => Promise<{ code: number; stderr: string }>;
    /** The worker is container root unless this is false. */
    privileged?: boolean;
    /** Called while the container still exists, after the worker returned. */
    inspect?: (args: string[], unit: AttemptUnit) => Promise<void>;
  } = {},
): ContainerCommandRunner {
  return async (_command, args, options) => {
    calls.push({
      args,
      env: options.env,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
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
    const unit = JSON.parse(await readFile(unitPath, "utf8")) as AttemptUnit;
    await simulateMounts(args);
    const user = args[args.indexOf("--user") + 1];
    const root =
      behavior.privileged !== false && user === "0:0"
        ? vi.spyOn(process, "getuid").mockReturnValue(0)
        : undefined;
    try {
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
    } finally {
      root?.mockRestore();
    }
    await behavior.inspect?.(args, unit);
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
          bundleWorker,
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

  it("keeps grader source out of the container: no mount reaches it and the worker arrives on stdin", async () => {
    const { root, suiteRoot, outputRoot, suite } = await fixture();
    // A skill outside the suite root, as the shipped suites reference theirs.
    const skill = join(root, "plugin", "skills", "probe");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: probe\ndescription: Probe skill.\n---\nProbe.\n",
    );
    suite.cases[0]!.skills = [relative(suiteRoot, skill)];
    const calls: EngineCall[] = [];
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: REPO_ROOT,
          suiteFile: "suite.json",
          bundleWorker,
          run: fakeEngine(calls),
        }),
      ],
    });
    expect(report.status).toBe("pass");
    const call = calls.find(({ args }) => args[0] === "run")!;
    const mounted = mounts(call.args);
    for (const grader of GRADER_SOURCES) {
      await expect(readFile(grader, "utf8")).resolves.toContain("export");
      for (const { source, target } of mounted) {
        expect(reaches(source, grader), `${source} exposes ${grader}`).toBe(
          false,
        );
        expect(reaches(target, grader), `${target} exposes ${grader}`).toBe(
          false,
        );
      }
    }
    expect(mounted.map(({ source }) => source)).not.toContain(REPO_ROOT);
    // What the worker does need from outside the suite is mounted by itself,
    // beside the suite inside the private root, so its suite path resolves.
    expect(call.args).toContain(
      `${skill}:${join(privateRootOf(call.args), skill)}:ro`,
    );
    // The worker program is piped in rather than read from a mounted file.
    expect(call.stdin).toBe(WORKER_PROGRAM);
    expect(call.args).toContain("--interactive");
    expect(call.args.slice(call.args.indexOf("bench:bare") + 1, -1)).toEqual([
      "node",
      "--input-type=module",
      "-",
      "worker",
      "--unit",
    ]);
  });

  it("leaves the Agent no readable path to the rubrics and runs it as a uid apart from the worker's", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const rubric = "grader-only-rubric-7c41e2";
    suite.cases[0]!.rubric[0]!.id = rubric;
    await writeFile(join(suiteRoot, "suite.json"), JSON.stringify(suite));
    isolated.spawns.length = 0;
    isolated.handovers.length = 0;
    const calls: EngineCall[] = [];
    const graderInputs: string[] = [];
    const agentReadable: string[] = [];
    let unitIsolation: AttemptUnit["agentIsolation"];
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: REPO_ROOT,
          suiteFile: "suite.json",
          bundleWorker,
          run: fakeEngine(calls, {
            // While the container exists: the rubric is in the suite and in
            // the grading records the worker has written by now.
            inspect: async (args, unit) => {
              unitIsolation = unit.agentIsolation;
              const mounted = mounts(args);
              for (const path of await mountedFiles(mounted)) {
                const text = await readFile(hostPathOf(mounted, path)!, "utf8");
                if (!text.includes(rubric)) continue;
                graderInputs.push(path);
                if (await canRead(mounted, path, unit.agentIsolation!.agent)) {
                  agentReadable.push(path);
                }
              }
            },
          }),
        }),
      ],
    });
    expect(report.status).toBe("pass");
    // The worker still graded against the rubric it alone could read.
    expect(JSON.stringify(report.cases[0])).toContain(rubric);
    const runCall = calls.find(({ args }) => args[0] === "run")!;
    expect(graderInputs).toContain(
      join(privateRootOf(runCall.args), suiteRoot, "suite.json"),
    );
    expect(agentReadable).toEqual([]);

    const [workerUid] =
      runCall.args[runCall.args.indexOf("--user") + 1]!.split(":").map(Number);
    expect(workerUid).toBe(0);
    expect(runCall.args[runCall.args.indexOf("--security-opt") + 1]).toBe(
      "no-new-privileges",
    );
    const owner = { uid: process.getuid!(), gid: process.getgid!() };
    expect(unitIsolation).toEqual({
      agent: DEFAULT_CONTAINER_AGENT_USER,
      owner,
    });
    // Only the Agent is started as the Agent's uid, and that is not the worker's.
    expect(isolated.spawns).toEqual([
      // `agent` runs `process.execPath -e …`.
      { command: process.execPath, ...DEFAULT_CONTAINER_AGENT_USER },
    ]);
    expect(isolated.spawns[0]!.uid).not.toBe(workerUid);
    expect(isolated.spawns[0]!.uid).not.toBe(owner.uid);
    // The Agent owns its workspace; the dispatcher gets the Attempt back.
    expect(
      isolated.handovers.some(
        ({ path, uid }) =>
          uid === DEFAULT_CONTAINER_AGENT_USER.uid &&
          path.endsWith(`${sep}workspace${sep}outcome.json`),
      ),
    ).toBe(true);
    expect(isolated.handovers).toContainEqual({
      path: join(outputRoot, "run", "task"),
      ...owner,
    });
  });

  it("refuses an Agent uid that owns the private mounts, and a worker that cannot switch away from its own", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const shared = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "shared",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: REPO_ROOT,
          suiteFile: "suite.json",
          bundleWorker,
          agentUser: { uid: process.getuid!(), gid: process.getgid!() },
          run: fakeEngine(calls),
        }),
      ],
    });
    expect(shared.cases[0]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("must differ"),
    });
    expect(calls.some(({ args }) => args[0] === "run")).toBe(false);

    const unprivileged = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "unprivileged",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: REPO_ROOT,
          suiteFile: "suite.json",
          bundleWorker,
          run: fakeEngine([], { privileged: false }),
        }),
      ],
    });
    expect(unprivileged.cases[0]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("must run as root"),
    });
  });

  it("refuses a suite root that would mount the runner's grader source", async () => {
    const { outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot: REPO_ROOT,
      outputRoot,
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: REPO_ROOT,
          suiteFile: "suite.json",
          bundleWorker,
          run: fakeEngine(calls),
        }),
      ],
    });
    expect(report.cases[0]?.failure?.detail).toContain("grader source");
    expect(calls.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it("bundles the worker into one program that runs from stdin after its sources are gone", async () => {
    const runnerRoot = await mkdtemp(join(tmpdir(), "clash-bench-bundle-"));
    const packageRoot = join(runnerRoot, "packages", "shared-artifact-evals");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(join(packageRoot, "tsconfig.dev.json"), "{}");
    await writeFile(
      join(packageRoot, "src", "evaluator.ts"),
      "export const grade = (value: string): string => `graded:${value}`;\n",
    );
    await writeFile(
      join(packageRoot, "src", "cli.ts"),
      'import { grade } from "./evaluator";\nprocess.stdout.write(grade(process.argv.slice(2).join(" ")));\n',
    );
    const program = await bundleContainerWorker(runnerRoot);
    await rm(runnerRoot, { recursive: true, force: true });
    const result = await spawnContainerCommand(
      process.execPath,
      ["--input-type=module", "-", "worker", "--unit", "unit.json"],
      { env: process.env, stdin: program },
    );
    expect(result).toMatchObject({
      code: 0,
      stdout: "graded:worker --unit unit.json",
    });
  });

  it("mounts a managed ACP harness directory read-only and points the worker at it", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const acpBinDir = "/opt/clash-acp";
    await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: process.cwd(),
          bundleWorker,
          suiteFile: "suite.json",
          acpBinDir,
          run: fakeEngine(calls),
        }),
      ],
    });
    const args = calls.find((call) => call.args[0] === "run")!.args;
    expect(args).toContain(`${acpBinDir}:${acpBinDir}:ro`);
    expect(args[args.indexOf(`CLASH_BENCH_ACP_BIN_DIR=${acpBinDir}`) - 1]).toBe(
      "--env",
    );

    const refused = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "relative",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createContainerBackend({
          image: "bench:bare",
          runnerRoot: process.cwd(),
          bundleWorker,
          suiteFile: "suite.json",
          acpBinDir: "acp",
          run: fakeEngine([]),
        }),
      ],
    });
    expect(refused.cases[0]?.failure?.detail).toContain(
      "ACP bin directory must be absolute",
    );
  });

  it("passes credentials by name, mounts inputs read-only, and records the image id", async () => {
    const { suiteRoot, outputRoot, suite } = await fixture();
    const calls: EngineCall[] = [];
    const backend = createContainerBackend({
      image: "bench:test",
      runnerRoot: process.cwd(),
      bundleWorker,
      suiteFile: "suite.json",
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
    expect(volumes).toContain(
      `${suiteRoot}:${join(privateRootOf(runCall.args), suiteRoot)}:ro`,
    );
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
          bundleWorker,
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
          bundleWorker,
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
          bundleWorker,
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
          bundleWorker,
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
          bundleWorker,
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

    // A directory that already holds something is not adopted: the worker
    // refuses it and, with no lock of its own in it, cannot seal an Attempt.
    const occupied = join(runRoot, "occupied-task");
    await mkdir(occupied);
    await writeFile(join(occupied, "stray.txt"), "left behind");
    await expect(
      executeBenchmarkAttempt({
        ...attempt,
        caseRoot: occupied,
        adoptCaseRoot: true,
      }),
    ).rejects.toThrow(/ENOENT.*environment-lock\.json/u);
    expect(
      JSON.parse(await readFile(join(occupied, "case-report.json"), "utf8")),
    ).toMatchObject({
      failure: {
        classification: "infrastructure",
        phase: "dispatch",
        detail: expect.stringContaining("must be empty"),
      },
    });
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
