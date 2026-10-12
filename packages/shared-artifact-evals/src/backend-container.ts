import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { BENCHMARK_ACP_BIN_DIR_VARIABLE } from "./acp-harness";
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
  run?: ContainerCommandRunner;
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

/**
 * Runs each Attempt in a fresh container. Isolation that is actually
 * established, and therefore recorded: a private root filesystem from the
 * image, read-only suite/skill/plugin/unit mounts, one read-write mount (the
 * Attempt directory), the selected network mode, and a per-Attempt container
 * that is removed afterwards. The runner checkout is not mounted; the worker
 * arrives on standard input, so grader source is not a file the Agent can
 * read. The suite file and the worker's memory are not hidden from an Agent
 * that shares the worker's user. Not established: any resource limit, syscall
 * filtering beyond the engine default, or egress filtering in `default` mode.
 */
export function createContainerBackend(
  options: ContainerBackendOptions,
): ExecutionBackend {
  const engine = options.engine ?? "docker";
  const run = options.run ?? spawnContainerCommand;
  const network = options.network ?? "default";
  const bundleWorker = options.bundleWorker ?? bundleContainerWorker;
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
    const unitDir = await mkdtemp(join(tmpdir(), "clash-bench-unit-"));
    const containerName = `clash-bench-${randomUUID().slice(0, 12)}`;
    try {
      await mkdir(dirname(dispatch.caseRoot), { recursive: true });
      await mkdir(dispatch.caseRoot);
      const unit = createAttemptUnit({
        dispatch,
        suiteFile: options.suiteFile,
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
      const candidates = [
        ...new Set([
          dispatch.suiteRoot,
          // The Environment lock hashes the runner manifest by path.
          join(runnerPackage, "package.json"),
          ...(skillPack ? [resolve(dispatch.suiteRoot, skillPack.path)] : []),
          ...(
            await resolveTaskSkillPack(dispatch.benchmark, dispatch.suiteRoot)
          ).map((path) => resolve(dispatch.suiteRoot, path)),
          ...(options.runnerNode ? [options.runnerNode] : []),
          ...(options.acpBinDir ? [options.acpBinDir] : []),
          ...(dispatch.subject ? [dispatch.subject.pluginRoot] : []),
        ]),
      ];
      // A root nested in another mounted root is already visible read-only.
      const readOnlyRoots = candidates.filter(
        (path) =>
          !candidates.some((other) => other !== path && isInside(other, path)),
      );
      const exposed = readOnlyRoots.find((path) =>
        isInside(path, join(runnerPackage, "src")),
      );
      if (exposed) {
        throw new Error(
          `Refusing to mount ${exposed}: it contains the benchmark runner's grader source`,
        );
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
        "--user",
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        ...readOnlyRoots.flatMap((path) => ["--volume", `${path}:${path}:ro`]),
        "--volume",
        `${unitDir}:${unitDir}:ro`,
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
