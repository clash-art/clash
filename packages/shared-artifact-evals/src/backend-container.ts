import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  collectWorkerAttempt,
  createAttemptUnit,
  quarantineCaseRoot,
  writeAttemptUnit,
} from "./attempt-unit";
import type { BenchmarkRuntimeClaim } from "./backend-types";
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
      stdio: ["ignore", "pipe", "pipe"],
    });
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
   * A checkout of this repository with dependencies installed. It is mounted
   * read-only at the same absolute path so the in-image worker runs this
   * runner's exact sources.
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
  /** Argv that starts the worker inside the image, before `worker --unit`. */
  workerCommand?: string[];
  run?: ContainerCommandRunner;
};

function defaultWorkerCommand(runnerRoot: string): string[] {
  const pkg = join(runnerRoot, "packages", "shared-artifact-evals");
  return [
    "node",
    join(pkg, "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    join(pkg, "tsconfig.dev.json"),
    join(pkg, "src", "cli.ts"),
  ];
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
 * image, read-only suite/runner/plugin/unit mounts, one read-write mount (the
 * Attempt directory), the selected network mode, and a per-Attempt container
 * that is removed afterwards. Not established: any resource limit, syscall
 * filtering beyond the engine default, or egress filtering in `default` mode.
 */
export function createContainerBackend(
  options: ContainerBackendOptions,
): ExecutionBackend {
  const engine = options.engine ?? "docker";
  const run = options.run ?? spawnContainerCommand;
  const network = options.network ?? "default";
  let claim: Promise<BenchmarkRuntimeClaim> | undefined;

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

      const candidates = [
        ...new Set([
          dispatch.suiteRoot,
          options.runnerRoot,
          ...(dispatch.subject ? [dispatch.subject.pluginRoot] : []),
        ]),
      ];
      // A root nested in another mounted root is already visible read-only.
      const readOnlyRoots = candidates.filter(
        (path) =>
          !candidates.some((other) => other !== path && isInside(other, path)),
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      const agentEnv = (dispatch.agent as { env?: Record<string, string> }).env;
      for (const [name, value] of Object.entries(agentEnv ?? {})) {
        env[name] = value;
      }
      const args = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        network === "none" ? "none" : "bridge",
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
        ...unit.envNames.flatMap((name) => ["--env", name]),
        options.image,
        ...(options.workerCommand ?? defaultWorkerCommand(options.runnerRoot)),
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
