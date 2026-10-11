import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(PACKAGE_ROOT, "src", "cli.ts"), ...args],
      { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function portableSuite() {
  const root = await mkdtemp(join(tmpdir(), "clash-bench-cli-trials-"));
  const suiteRoot = join(root, "suite");
  await mkdir(suiteRoot);
  const suitePath = join(suiteRoot, "suite.json");
  await writeFile(
    suitePath,
    JSON.stringify({
      schemaVersion: 1,
      id: "cli-suite",
      title: "CLI suite",
      cases: [
        {
          id: "task",
          title: "task",
          category: "timeline",
          passScore: 100,
          timeoutMs: 20_000,
          skills: [],
          outcome: {
            objective: "Create the artifact.",
            acceptanceCriteria: ["The report artifact exists."],
            deliverables: [
              { artifactId: "result", kind: "report", description: "Result" },
            ],
          },
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
    }),
  );
  // Delivers the artifact on every trial except the second rollout of this run.
  const agentPath = join(root, "agent.cjs");
  await writeFile(
    agentPath,
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const w = process.env.CLASH_BENCH_WORKSPACE, c = process.env.CLASH_BENCH_CASE_ID;
const counter = ${JSON.stringify(join(root, "count"))};
fs.appendFileSync(counter, "x");
const n = fs.readFileSync(counter, "utf8").length;
if (n !== 2) {
  fs.writeFileSync(path.join(w, "result.txt"), "artifact");
  fs.writeFileSync(path.join(w, "submission.json"), JSON.stringify({schemaVersion:1,taskId:c,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}));
}
`,
    { mode: 0o755 },
  );
  return { root, suitePath, agentPath, outputRoot: join(root, "runs") };
}

describe("clash-artifact-bench trials and backends", () => {
  it("runs repeated trials and prints the pass@1, pass@k, pass^k summary", async () => {
    const { suitePath, agentPath, outputRoot } = await portableSuite();
    const result = await runCli([
      "--suite",
      suitePath,
      "--out",
      outputRoot,
      "--run-id",
      "cli-run",
      "--agent-command",
      agentPath,
      "--trials",
      "3",
      "--max-infra-attempts",
      "1",
    ]);
    // One of three trials failed, so the suite is not green.
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      trials: number;
      trialAggregate: { summary: Record<string, number> };
      cases: Array<{ trial: number; status: string }>;
    };
    expect(report.trials).toBe(3);
    expect(report.cases.map(({ trial }) => trial).sort()).toEqual([1, 2, 3]);
    expect(report.trialAggregate.summary).toMatchObject({
      passAtK: 1,
      passPowK: 0,
    });
    expect(report.trialAggregate.summary.passAt1).toBeCloseTo(2 / 3);
    await expect(
      readFile(join(outputRoot, "cli-run", "run-manifest.json"), "utf8"),
    ).resolves.toContain('"trials": 3');
  }, 60_000);

  it.each([
    [["--trials", "0"], /--trials must be a positive integer/u],
    [["--backend", "kubernetes"], /--backend must be/u],
    [["--container-network", "host"], /--container-network must be/u],
    [["--pass-k", "2"], /--pass-k requires --trials/u],
    [["--trials", "2", "--pass-k", "3"], /--pass-k must not exceed --trials/u],
    [["--spread-trials"], /--spread-trials requires at least two --backend/u],
    [
      ["--backend", "claude-cloud"],
      /claude-cloud is experimental.*--experimental-claude-cloud/u,
    ],
  ])(
    "rejects invalid option %j",
    async (extra, message) => {
      const { suitePath, agentPath, outputRoot } = await portableSuite();
      const result = await runCli([
        "--suite",
        suitePath,
        "--out",
        outputRoot,
        "--agent-command",
        agentPath,
        ...extra,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
    },
    60_000,
  );

  it("requires an image for the container backend", async () => {
    const { suitePath, agentPath, outputRoot } = await portableSuite();
    const result = await runCli([
      "--suite",
      suitePath,
      "--out",
      outputRoot,
      "--agent-command",
      agentPath,
      "--backend",
      "container",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--container-image is required/u);
  }, 60_000);

  it("refuses a subject when no case uses Clash", async () => {
    const { suitePath, agentPath, outputRoot } = await portableSuite();
    const result = await runCli([
      "--suite",
      suitePath,
      "--out",
      outputRoot,
      "--agent-command",
      agentPath,
      "--subject",
      "working-tree",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /--subject needs at least one runnable clash-host case/u,
    );
  }, 60_000);
});
