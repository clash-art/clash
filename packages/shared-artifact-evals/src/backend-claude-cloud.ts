import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import {
  collectWorkerAttempt,
  createAttemptUnit,
  quarantineCaseRoot,
} from "./attempt-unit";
import type { BenchmarkRuntimeClaim } from "./backend-types";
import type {
  BenchmarkAttemptCompletion,
  BenchmarkAttemptDispatch,
  ExecutionBackend,
} from "./execution-backend";

const execFileAsync = promisify(execFile);

export type CloudCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const TAIL_BYTES = 8_192;

export const spawnCloudCommand: CloudCommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const tail = (current: string, chunk: Buffer) =>
      (current + chunk.toString("utf8")).slice(-TAIL_BYTES);
    child.stdout.on("data", (c: Buffer) => (stdout = tail(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = tail(stderr, c)));
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });

export type ClaudeCloudBackendOptions = {
  /** Defaults to `claude`. */
  command?: string;
  /** A self-hosted pool (`ccpool_…`). Omit to use the Anthropic-managed pool. */
  environmentId?: string;
  /**
   * A checkout of the repository the cloud session works in. Every selected
   * revision and the suite must already be pushed to `remote`.
   */
  repoRoot: string;
  /** Remote name or URL both this machine and the session can reach. */
  remote?: string;
  /** Revision of the runner the session checks out. Defaults to `HEAD`. */
  runnerRev?: string;
  /** Suite file relative to the repository root. */
  suiteFile: string;
  /** How the session installs dependencies after checkout. */
  installCommand?: string[];
  /** Argv that starts the worker in the session, before `worker --unit`. */
  workerCommand?: string[];
  /** Variable names the session's environment must provide as secrets. */
  forwardEnv?: string[];
  concurrency?: number;
  /** How long to wait for a result branch. Defaults to two hours. */
  resultTimeoutMs?: number;
  pollIntervalMs?: number;
  run?: CloudCommandRunner;
};

const RESULT_ARCHIVE = "attempt.tar.gz";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The session is asked to run one fixed script. Nothing in it is left to the
 * Agent's judgement, and nothing in it carries a credential: provider keys
 * come from the cloud environment's own secrets, by the names in the unit.
 */
export function renderCloudWorkerScript(input: {
  runnerRev: string;
  subjectRev?: string;
  unitBase64: string;
  suiteRootRelative: string;
  caseRoot: string;
  branch: string;
  installCommand: string[];
  workerCommand: string[];
}): string {
  const lines = [
    "set -eu",
    `git fetch --quiet origin ${shellQuote(input.runnerRev)}`,
    ...(input.subjectRev && input.subjectRev !== input.runnerRev
      ? [`git fetch --quiet origin ${shellQuote(input.subjectRev)}`]
      : []),
    `git checkout --quiet --detach ${shellQuote(input.runnerRev)}`,
    input.installCommand.map(shellQuote).join(" "),
    'UNIT="$(mktemp)"',
    `printf %s ${shellQuote(input.unitBase64)} | base64 -d > "$UNIT"`,
    `mkdir -p ${shellQuote(dirname(input.caseRoot))}`,
    `${input.workerCommand.map(shellQuote).join(" ")} worker --unit "$UNIT" --suite-root "$PWD/${input.suiteRootRelative}"`,
    'OUT="$(mktemp -d)"',
    `tar -czf "$OUT/${RESULT_ARCHIVE}" -C ${shellQuote(input.caseRoot)} .`,
    `git checkout --quiet --orphan ${shellQuote(input.branch)}`,
    "git rm -rf --quiet --cached . > /dev/null 2>&1 || true",
    `cp "$OUT/${RESULT_ARCHIVE}" ./${RESULT_ARCHIVE}`,
    `git add -f ${RESULT_ARCHIVE}`,
    'git -c user.name=clash-bench -c user.email=clash-bench@invalid commit --quiet -m "benchmark attempt result"',
    `git push --quiet origin ${shellQuote(input.branch)}`,
  ];
  return lines.join("\n");
}

export function renderCloudPrompt(script: string): string {
  return [
    "You are a benchmark worker, not a developer. Do not interpret, improve, or",
    "explain the task. Run the following shell script exactly once from the",
    "repository root, and stop when it finishes. If any command fails, stop and",
    "report the failing command and its output. Never print environment variables.",
    "",
    "```sh",
    script,
    "```",
  ].join("\n");
}

export async function assertSafeArchive(
  archive: string,
  run: CloudCommandRunner,
): Promise<void> {
  const listing = await run("tar", ["-tzvf", archive], {});
  if (listing.code !== 0) throw new Error("Result archive is unreadable");
  for (const line of listing.stdout.split("\n").filter(Boolean)) {
    // `tar -tv` prints `name -> target` for symbolic links and `link to` for hard links.
    const linkTarget = /-> (.*)$/u.exec(line)?.[1];
    if (/^h/u.test(line) || / link to /u.test(line)) {
      throw new Error("Result archive must not contain hard links");
    }
    if (
      linkTarget &&
      (isAbsolute(linkTarget) || linkTarget.split("/").includes(".."))
    ) {
      throw new Error("Result archive contains a link that leaves the Attempt");
    }
  }
  const names = await run("tar", ["-tzf", archive], {});
  for (const name of names.stdout.split("\n").filter(Boolean)) {
    if (isAbsolute(name) || name.split("/").includes("..")) {
      throw new Error(`Result archive entry escapes the Attempt: ${name}`);
    }
  }
}

/**
 * Dispatches each Attempt to a Claude Code cloud session (`claude --cloud`,
 * optionally on a self-hosted pool via `--environment`). The runner cannot
 * observe the session's isolation, so the lock records it as
 * `dispatcher-declared`. Results travel back as one archive on a result branch
 * of the shared repository: suited to text-heavy Attempts, not large media.
 */
export function createClaudeCloudBackend(
  options: ClaudeCloudBackendOptions,
): ExecutionBackend {
  const run = options.run ?? spawnCloudCommand;
  const remote = options.remote ?? "origin";
  if (
    options.environmentId !== undefined &&
    !/^ccpool_[A-Za-z0-9_-]+$/u.test(options.environmentId)
  ) {
    throw new Error("environmentId must be a self-hosted pool id (ccpool_…)");
  }
  const claim: BenchmarkRuntimeClaim = {
    kind: "claude-cloud",
    pool: options.environmentId
      ? { kind: "self-hosted", environmentId: options.environmentId }
      : { kind: "anthropic-managed" },
  };

  const git = async (args: string[], cwd = options.repoRoot) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  };

  const runAttempt = async (
    dispatch: BenchmarkAttemptDispatch,
  ): Promise<BenchmarkAttemptCompletion> => {
    const repoRoot = await realpath(options.repoRoot);
    const subject = dispatch.subject?.record;
    if (subject?.kind === "working-tree") {
      throw new Error(
        "A cloud session cannot see a working tree. Select a pushed commit or a released version.",
      );
    }
    const suiteRootRelative = relative(repoRoot, dispatch.suiteRoot);
    if (
      !suiteRootRelative ||
      suiteRootRelative.startsWith(`..${sep}`) ||
      isAbsolute(suiteRootRelative)
    ) {
      throw new Error("The suite must live inside the shared repository");
    }
    const runnerRev = (
      await git([
        "rev-parse",
        "--verify",
        `${options.runnerRev ?? "HEAD"}^{commit}`,
      ])
    ).trim();
    const branch = `bench-results/${dispatch.runId}/${dispatch.benchmark.id}-t${dispatch.trial}-a${dispatch.attempt}-${randomUUID().slice(0, 8)}`;
    const unit = createAttemptUnit({
      dispatch,
      suiteFile: relative(
        dispatch.suiteRoot,
        join(repoRoot, options.suiteFile),
      ),
      claim,
      forwardEnv: options.forwardEnv ?? [],
      ...(subject
        ? {
            subject: {
              record: subject,
              acquire:
                subject.kind === "commit"
                  ? { kind: "commit" as const, rev: subject.commit! }
                  : {
                      kind: "npm" as const,
                      spec: `clash@${subject.version}`,
                    },
            },
          }
        : {}),
    });
    const script = renderCloudWorkerScript({
      runnerRev,
      ...(subject?.commit ? { subjectRev: subject.commit } : {}),
      unitBase64: Buffer.from(JSON.stringify(unit)).toString("base64"),
      suiteRootRelative,
      caseRoot: dispatch.caseRoot,
      branch,
      installCommand: options.installCommand ?? [
        "pnpm",
        "install",
        "--frozen-lockfile",
      ],
      workerCommand: options.workerCommand ?? [
        "node",
        "packages/shared-artifact-evals/node_modules/tsx/dist/cli.mjs",
        "--tsconfig",
        "packages/shared-artifact-evals/tsconfig.dev.json",
        "packages/shared-artifact-evals/src/cli.ts",
      ],
    });

    const scratch = await mkdtemp(join(tmpdir(), "clash-bench-cloud-"));
    try {
      await mkdir(dirname(dispatch.caseRoot), { recursive: true });
      await mkdir(dispatch.caseRoot);
      const launch = await run(
        options.command ?? "claude",
        [
          "--cloud",
          renderCloudPrompt(script),
          ...(options.environmentId
            ? ["--environment", options.environmentId]
            : []),
        ],
        { cwd: repoRoot, timeoutMs: 5 * 60_000 },
      );
      if (launch.code !== 0) {
        throw new Error(
          `claude --cloud exited ${launch.code}: ${launch.stderr.trim().slice(-2_000)}`,
        );
      }
      const deadline =
        Date.now() + (options.resultTimeoutMs ?? 2 * 60 * 60_000);
      for (;;) {
        if (dispatch.processScope.interruptedSignal) {
          throw new Error("Interrupted while waiting for the cloud session");
        }
        const listed = await git(["ls-remote", remote, `refs/heads/${branch}`]);
        if (listed.trim()) break;
        if (Date.now() > deadline) {
          throw new Error(
            `No result branch ${branch} appeared before the timeout; the session may have failed`,
          );
        }
        await new Promise((r) =>
          setTimeout(r, options.pollIntervalMs ?? 15_000),
        );
      }
      await git(["fetch", "--quiet", remote, `refs/heads/${branch}`]);
      const archive = join(scratch, RESULT_ARCHIVE);
      const blob = await execFileAsync(
        "git",
        ["show", `FETCH_HEAD:${RESULT_ARCHIVE}`],
        { cwd: repoRoot, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
      );
      await writeFile(archive, blob.stdout);
      await assertSafeArchive(archive, run);
      const extracted = await run(
        "tar",
        ["-xzf", archive, "-C", dispatch.caseRoot],
        {},
      );
      if (extracted.code !== 0) {
        throw new Error(
          `Result archive did not unpack: ${extracted.stderr.trim()}`,
        );
      }
      return await collectWorkerAttempt({
        caseRoot: dispatch.caseRoot,
        suiteRoot: dispatch.suiteRoot,
        claim,
        requireAttempt: Boolean(dispatch.benchmark.execution?.environment),
      });
    } catch (error) {
      await quarantineCaseRoot({
        caseRoot: dispatch.caseRoot,
        runRoot: dispatch.runRoot,
      }).catch(() => undefined);
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  return {
    kind: "claude-cloud",
    maxConcurrency: options.concurrency ?? 1,
    runtimeClaim: async () => claim,
    runAttempt,
  };
}
