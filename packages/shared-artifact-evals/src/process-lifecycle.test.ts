import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const cleanupPids = new Set<number>();

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  describeState: () => string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for test process state\n${describeState()}`,
  );
}

async function waitForClose(child: ChildProcess): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Benchmark CLI did not exit after signal"));
    }, 15_000);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });
}

async function waitForGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

afterEach(() => {
  for (const pid of cleanupPids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process exited while the test was cleaning up.
      }
    }
  }
  cleanupPids.clear();
});

describe.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("benchmark process lifecycle on %s", (signal, expectedExitCode) => {
  it("terminates the agent process group and checkpoints the interrupted attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-bench-signal-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const suitePath = join(suiteRoot, "suite.json");
    const agentPath = join(root, "agent.cjs");
    const pidPath = join(root, "agent-pids.json");
    await mkdir(suiteRoot);
    await writeFile(
      suitePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "signal-suite",
          title: "Signal suite",
          cases: [
            {
              id: "interrupted-case",
              title: "Interrupted case",
              category: "timeline",
              outcome: {
                objective: "Leave recoverable partial evidence.",
                acceptanceCriteria: ["partial.txt exists"],
                deliverables: [
                  {
                    artifactId: "result",
                    kind: "report",
                    description: "Result",
                  },
                ],
              },
              passScore: 100,
              timeoutMs: 60_000,
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
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      agentPath,
      [
        `#!${process.execPath}`,
        'const {spawn} = require("node:child_process")',
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"})',
        "fs.writeFileSync(process.env.BENCH_SIGNAL_PID_PATH, JSON.stringify({agentPid:process.pid,grandchildPid:grandchild.pid}))",
        'fs.writeFileSync(path.join(process.env.CLASH_BENCH_WORKSPACE, "partial.txt"), "checkpoint")',
        'process.stdout.write("agent-ready\\n")',
        "setInterval(() => {}, 1000)",
      ].join("\n"),
      "utf8",
    );
    await chmod(agentPath, 0o755);

    const runner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(PACKAGE_ROOT, "src", "cli.ts"),
        "--suite",
        suitePath,
        "--out",
        outputRoot,
        "--run-id",
        "signal-run",
        "--agent-command",
        agentPath,
        "--max-infra-attempts",
        "1",
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, BENCH_SIGNAL_PID_PATH: pidPath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanupPids.add(runner.pid!);
    let runnerOutput = "";
    runner.stdout?.setEncoding("utf8");
    runner.stderr?.setEncoding("utf8");
    runner.stdout?.on("data", (chunk: string) => {
      runnerOutput += chunk;
    });
    runner.stderr?.on("data", (chunk: string) => {
      runnerOutput += chunk;
    });
    const pids = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(pidPath, "utf8")) as {
          agentPid: number;
          grandchildPid: number;
        };
      } catch {
        return undefined;
      }
    }, () => `runner exit=${runner.exitCode} signal=${runner.signalCode}\n${runnerOutput.slice(-4_000)}`,
    // Cold tsx start of the CLI under a fully parallel suite is the slow part;
    // the assertions below concern behaviour after the signal, not start time.
    20_000);
    cleanupPids.add(pids.agentPid);
    cleanupPids.add(pids.grandchildPid);

    runner.kill(signal);
    const result = await waitForClose(runner);

    expect(result).toEqual({ exitCode: expectedExitCode, signal: null });
    await expect(waitForGone(pids.agentPid)).resolves.toBe(true);
    await expect(waitForGone(pids.grandchildPid)).resolves.toBe(true);
    await expect(
      readFile(
        join(
          outputRoot,
          "signal-run",
          "interrupted-case",
          "workspace",
          "partial.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("checkpoint");
    const { attempts: ledger } = JSON.parse(
      await readFile(
        join(outputRoot, "signal-run", "suite-progress.json"),
        "utf8",
      ),
    ) as { attempts: Array<Record<string, unknown>> };
    expect(ledger.map(({ event }) => event)).toEqual(["started", "completed"]);
    await expect(
      readFile(
        join(outputRoot, "signal-run", "interrupted-case", "case-report.json"),
        "utf8",
      ),
    ).resolves.toContain('"signal": "SIGTERM"');
  }, 45_000);
});
