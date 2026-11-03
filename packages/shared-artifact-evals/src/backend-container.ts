import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { BENCHMARK_ACP_BIN_DIR_VARIABLE } from "./acp-harness";
import {
  assertAgentIsolation,
  type AgentIsolation,
  type ProcessIdentity,
} from "./agent-isolation";
import {
  collectWorkerAttempt,
  createAttemptUnit,
  quarantineCaseRoot,
  writeAttemptUnit,
} from "./attempt-unit";
import type { BenchmarkRuntimeClaim } from "./backend-types";
import { resolveTaskSkillPack } from "./task-skill-pack";
import type {
  BenchmarkAttemptCompletion,
  BenchmarkAttemptDispatch,
  ExecutionBackend,
} from "./execution-backend";

export type ContainerCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Runs the engine CLI. `env` carries credential values; argv never does. */
export type ContainerCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Written to the engine's standard input, then closed. */
    stdin?: string;
    onSpawn?: (kill: () => void) => void;
  },
) => Promise<ContainerCommandResult>;

const TAIL_BYTES = 8_192;

export const spawnContainerCommand: ContainerCommandRunner = (
  command,
  args,
  options,
) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A worker that dies early closes the pipe; its exit status reports that.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
    let stdout = "";
    let stderr = "";
    const keepTail = (current: string, chunk: Buffer) =>
      (current + chunk.toString("utf8")).slice(-TAIL_BYTES);
    child.stdout.on(
      "data",
      (chunk: Buffer) => (stdout = keepTail(stdout, chunk)),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr = keepTail(stderr, chunk)),
    );
    options.onSpawn?.(() => child.kill("SIGTERM"));
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });

export type ContainerBackendOptions = {
  engine?: "docker" | "podman";
  /** Image reference. The lock records the engine's content id, not this tag. */
  image: string;
  /**
   * A checkout of this repository with dependencies installed and workspace
   * packages built. It is never mounted: the worker is bundled from it once and
   * piped to each container, so the Agent finds no runner source on disk.
   */
  runnerRoot: string;
  /** Suite file, relative to the suite root. */
  suiteFile: string;
  /** `none` is only useful for command Agents that need no model API. */
  network?: "default" | "none";
  concurrency?: number;
  /** Variables whose values the container inherits from this process by name. */
  forwardEnv?: string[];
  /** Hard wall-clock limit per Attempt. Defaults to two hours. */
  timeoutMs?: number;
  /** Produces the worker program text. Defaults to `bundleContainerWorker`. */
  bundleWorker?: (runnerRoot: string) => Promise<string>;
  /**
   * Absolute path of a Node binary on this machine that runs the worker. It is
   * mounted read-only at the same path and invoked by that path, so the image
   * needs no Node and none is put on the Agent's PATH.
   */
  runnerNode?: string;
  /**
   * Absolute path of a managed ACP harness directory on this machine (see
   * `installAcpHarness`). It is mounted read-only at the same path, because the
   * launchers in it name their install by absolute path, and the worker is
   * pointed at it, so the image needs no Agent harness of its own. This is the
   * benchmark's own directory, never a product's managed ACP bin directory.
   */
  acpBinDir?: string;
  /**
   * The unprivileged uid/gid the worker runs the Agent as. It must differ
   * from root and from this process's uid, which owns the private mounts.
   */
  agentUser?: ProcessIdentity;
  run?: ContainerCommandRunner;
};

/** The `nonroot` user of distroless images; any uid the host does not use works. */
export const DEFAULT_CONTAINER_AGENT_USER: ProcessIdentity = {
  uid: 65_532,
  gid: 65_532,
};

const RUNNER_PACKAGE = join("packages", "shared-artifact-evals");

/**
 * Bundles the worker CLI and everything it imports into one ES module that
 * runs from standard input with no file of its own. `import.meta.url` keeps
 * naming the source entry, so the runner manifest is still found beside it.
 */
export async function bundleContainerWorker(
  runnerRoot: string,
): Promise<string> {
  const packageRoot = join(runnerRoot, RUNNER_PACKAGE);
  const entry = join(packageRoot, "src", "cli.ts");
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [entry],
    tsconfig: join(packageRoot, "tsconfig.dev.json"),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
    // Only the dispatcher bundles; the worker never reaches this import.
    external: ["esbuild"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire("/");',
    },
    plugins: [
      {
        // The Node build of Loro reads its wasm from a sibling file.
        name: "inline-loro-wasm",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^loro-crdt$/u }, (args) =>
            pluginBuild.resolve("loro-crdt/base64", {
              kind: args.kind,
              resolveDir: args.resolveDir,
            }),
          );
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}

function isInside(parent: string, child: string): boolean {
  const local = relative(parent, child);
  return (
    local === "" ||
    (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
  );
}

/** Drops roots nested in another one: mounting the outer one exposes them. */
function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isInside(other, path)),
  );
}

/**
 * Runs each Attempt in a fresh container. Isolation that is actually
 * established, and therefore recorded: a private root filesystem from the
 * image, read-only suite/skill/plugin/unit mounts, one read-write mount (the
 * Attempt directory), the selected network mode, and a per-Attempt container
 * that is removed afterwards. The runner checkout is not mounted; the worker
 * arrives on standard input, so grader source is not a file the Agent can
 * read. The worker runs as container root and starts the Agent as
 * `agentUser`; the suite (rubrics included) and the task's skill sources are
 * mounted only inside the unit directory and the Attempt directory is mode
 * 0700, both owned by this process's uid, so the Agent cannot open them, and
 * the worker's `/proc` entries belong to another uid. Not established: any
 * resource limit, syscall filtering beyond the engine default, or egress
 * filtering in `default` mode.
 */
export function createContainerBackend(
  options: ContainerBackendOptions,
): ExecutionBackend {
  const engine = options.engine ?? "docker";
  const run = options.run ?? spawnContainerCommand;
  const network = options.network ?? "default";
  const bundleWorker = options.bundleWorker ?? bundleContainerWorker;
  const agentIsolation: AgentIsolation = {
    agent: options.agentUser ?? DEFAULT_CONTAINER_AGENT_USER,
    owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  };
  let claim: Promise<BenchmarkRuntimeClaim> | undefined;
  let worker: Promise<string> | undefined;

  const resolveClaim = async (): Promise<BenchmarkRuntimeClaim> => {
    const version = await run(
      engine,
      ["version", "--format", "{{.Server.Version}}"],
      { env: process.env },
    );
    if (version.code !== 0 || !version.stdout.trim()) {
      throw new Error(
        `Container engine '${engine}' is unavailable: ${version.stderr.trim() || "no version reported"}`,
      );
    }
    const inspected = await run(
      engine,
      ["image", "inspect", "--format", "{{.Id}}", options.image],
      { env: process.env },
    );
    const id = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(id)) {
      throw new Error(
        `Container image '${options.image}' was not found locally: ${inspected.stderr.trim()}`,
      );
    }
    return {
      kind: "container",
      engine: { name: engine, version: version.stdout.trim() },
      image: { id },
      network: network === "none" ? "none" : "engine-default",
    };
  };

  const runAttempt = async (
    dispatch: BenchmarkAttemptDispatch,
  ): Promise<BenchmarkAttemptCompletion> => {
    const claimed = await (claim ??= resolveClaim());
    const needsSubject = Boolean(
      (dispatch.agent as { clashHost?: unknown }).clashHost,
    );
    if (needsSubject && !dispatch.subject) {
      throw new Error(
        "A container Attempt that uses Clash needs an explicit subject to mount",
      );
    }
    // Owner-only (mkdtemp creates 0700): what is mounted below `privateRoot`
    // is reachable by the root worker and not by the Agent's uid.
    const unitDir = await mkdtemp(join(tmpdir(), "clash-bench-unit-"));
    const privateRoot = join(unitDir, "ro");
    const containerName = `clash-bench-${randomUUID().slice(0, 12)}`;
    try {
      assertAgentIsolation(agentIsolation, undefined);
      await mkdir(dirname(dispatch.caseRoot), { recursive: true });
      // The worker writes grading records here while the Agent still runs.
      await mkdir(dispatch.caseRoot, { mode: 0o700 });
      const unit = createAttemptUnit({
        dispatch,
        suiteFile: options.suiteFile,
        suiteRoot: join(privateRoot, dispatch.suiteRoot),
        agentIsolation,
        claim: claimed,
        forwardEnv: options.forwardEnv ?? [],
        ...(dispatch.subject
          ? {
              subject: {
                record: dispatch.subject.record,
                pluginRoot: dispatch.subject.pluginRoot,
              },
            }
          : {}),
      });
      const unitPath = join(unitDir, "unit.json");
      await writeAttemptUnit(unitPath, unit);

      if (options.runnerNode && !isAbsolute(options.runnerNode)) {
        throw new Error("The container runner Node must be an absolute path");
      }
      if (options.acpBinDir && !isAbsolute(options.acpBinDir)) {
        throw new Error("The container ACP bin directory must be absolute");
      }
      const runnerPackage = join(options.runnerRoot, RUNNER_PACKAGE);
      const skillPack = dispatch.benchmark.skillPack;
      // Grader inputs: the suite carries the rubrics, and the worker copies
      // the skills into the workspace. Mounted inside `privateRoot` at their
      // host path, so suite-relative paths still resolve.
      const privateRoots = outermost([
        dispatch.suiteRoot,
        ...(skillPack ? [resolve(dispatch.suiteRoot, skillPack.path)] : []),
        ...(
          await resolveTaskSkillPack(dispatch.benchmark, dispatch.suiteRoot)
        ).map((path) => resolve(dispatch.suiteRoot, path)),
      ]);
      // What the Agent's own processes run, at the host path they name.
      const sharedRoots = outermost([
        // The Environment lock hashes the runner manifest by path.
        join(runnerPackage, "package.json"),
        ...(options.runnerNode ? [options.runnerNode] : []),
        ...(options.acpBinDir ? [options.acpBinDir] : []),
        ...(dispatch.subject ? [dispatch.subject.pluginRoot] : []),
      ]);
      const exposed = [...privateRoots, ...sharedRoots].find((path) =>
        isInside(path, join(runnerPackage, "src")),
      );
      if (exposed) {
        throw new Error(
          `Refusing to mount ${exposed}: it contains the benchmark runner's grader source`,
        );
      }
      for (const shared of sharedRoots) {
        const hidden = privateRoots.find((path) => isInside(shared, path));
        if (hidden) {
          throw new Error(
            `Refusing to mount ${shared}: the Agent could read the grader input ${hidden} through it`,
          );
        }
      }
      // The unit directory is mounted read-only, so mount points must exist.
      for (const path of privateRoots) {
        const target = join(privateRoot, path);
        if ((await stat(path)).isDirectory()) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, "");
        }
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      const agentEnv = (dispatch.agent as { env?: Record<string, string> }).env;
      for (const [name, value] of Object.entries(agentEnv ?? {})) {
        env[name] = value;
      }
      const args = [
        "run",
        "--rm",
        "--interactive",
        "--name",
        containerName,
        ...(network === "none" ? ["--network", "none"] : []),
        // Root only to start the Agent as `agentUser`; nothing it starts can
        // gain privilege back through a setuid binary in the image.
        "--user",
        "0:0",
        "--security-opt",
        "no-new-privileges",
        ...sharedRoots.flatMap((path) => ["--volume", `${path}:${path}:ro`]),
        "--volume",
        `${unitDir}:${unitDir}:ro`,
        ...privateRoots.flatMap((path) => [
          "--volume",
          `${path}:${join(privateRoot, path)}:ro`,
        ]),
        "--volume",
        `${dispatch.caseRoot}:${dispatch.caseRoot}`,
        "--workdir",
        "/tmp",
        "--env",
        "HOME=/tmp",
        ...(options.acpBinDir
          ? ["--env", `${BENCHMARK_ACP_BIN_DIR_VARIABLE}=${options.acpBinDir}`]
          : []),
        ...[
          ...new Set([...unit.envNames, ...(unit.judgeEnvNames ?? [])]),
        ].flatMap((name) => ["--env", name]),
        options.image,
        options.runnerNode ?? "node",
        "--input-type=module",
        "-",
        "worker",
        "--unit",
        unitPath,
      ];

      let kill: (() => void) | undefined;
      const interrupted = () => {
        kill?.();
        void run(engine, ["kill", containerName], { env: process.env }).catch(
          () => undefined,
        );
      };
      const poll = setInterval(() => {
        if (dispatch.processScope.interruptedSignal) interrupted();
      }, 250);
      let result: ContainerCommandResult;
      try {
        result = await run(engine, args, {
          env,
          timeoutMs: options.timeoutMs ?? 2 * 60 * 60_000,
          stdin: await (worker ??= bundleWorker(options.runnerRoot)),
          onSpawn: (k) => (kill = k),
        });
      } finally {
        clearInterval(poll);
      }
      if (result.code !== 0) {
        // The engine may have outlived a killed client; make sure it is gone.
        await run(engine, ["rm", "--force", containerName], {
          env: process.env,
        }).catch(() => undefined);
        throw new Error(
          `Worker container exited ${result.code ?? result.signal}: ${result.stderr.trim().slice(-2_000)}`,
        );
      }
      return await collectWorkerAttempt({
        caseRoot: dispatch.caseRoot,
        suiteRoot: dispatch.suiteRoot,
        claim: claimed,
        requireAttempt: Boolean(dispatch.benchmark.execution?.environment),
      });
    } catch (error) {
      await quarantineCaseRoot({
        caseRoot: dispatch.caseRoot,
        runRoot: dispatch.runRoot,
      }).catch(() => undefined);
      throw error;
    } finally {
      await rm(unitDir, { recursive: true, force: true });
    }
  };

  return {
    kind: "container",
    maxConcurrency: options.concurrency ?? 1,
    runtimeClaim: () => (claim ??= resolveClaim()),
    runAttempt,
  };
}
