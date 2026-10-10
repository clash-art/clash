import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertSafeArchive,
  createClaudeCloudBackend,
  pruneCloudResultBranches,
  renderCloudWorkerScript,
  spawnCloudCommand,
} from "./backend-claude-cloud";
import { runBenchmarkSuite } from "./runner";
import type { ArtifactBenchmarkCase, BenchmarkAgent } from "./types";

const SECRET = "sk-cloud-secret-held-only-by-the-session-environment";

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
  // Only the name is dispatched. The value is the session environment's secret.
  env: { PROVIDER_API_KEY: "placeholder-never-sent" },
  args: [
    "-e",
    `
    const fs = require("node:fs"), path = require("node:path");
    const w = process.env.CLASH_BENCH_WORKSPACE, c = process.env.CLASH_BENCH_CASE_ID;
    fs.writeFileSync(path.join(w, "result.txt"), process.env.PROVIDER_API_KEY === ${JSON.stringify(SECRET)} ? "session-secret" : "wrong-secret");
    fs.writeFileSync(path.join(w, "submission.json"), JSON.stringify({schemaVersion:1,taskId:c,artifacts:[{id:"result",kind:"report",path:"result.txt"}]}));
  `,
  ],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A stand-in for the cloud: an origin repository plus a `claude` command that
 * clones it into a fresh directory, runs the script it was given with the
 * session's own secret in its environment, and then discards the worker's
 * filesystem, so the only way results can return is the pushed branch.
 */
async function simulatedCloud(options: { skipScript?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "clash-bench-cloud-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  const suiteRoot = join(repo, "bench");
  await mkdir(suiteRoot);
  const suite = {
    schemaVersion: 1,
    id: "cloud-suite",
    title: "Cloud suite",
    cases: [benchmarkCase("task")],
  };
  await writeFile(join(suiteRoot, "suite.json"), JSON.stringify(suite));
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@invalid",
    "commit",
    "-q",
    "-m",
    "suite",
  );
  git(repo, "push", "-q", "origin", "HEAD:main");

  const argvLog = join(root, "claude-argv.json");
  const fake = join(root, "claude");
  await writeFile(
    fake,
    `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
const prompt = argv[argv.indexOf("--cloud") + 1];
const script = /\`\`\`sh\\n([\\s\\S]*?)\\n\`\`\`/.exec(prompt)[1];
if (${JSON.stringify(options.skipScript ?? false)}) process.exit(0);
const session = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-session-"));
execFileSync("git", ["clone", "-q", ${JSON.stringify(origin)}, session + "/repo"]);
execFileSync("sh", ["-c", script], {
  cwd: session + "/repo",
  env: { ...process.env, PROVIDER_API_KEY: ${JSON.stringify(SECRET)} },
  stdio: "inherit",
});
// The worker's disk is not the dispatcher's: leave nothing behind but the branch.
const caseRoot = JSON.parse(Buffer.from(/printf %s '([^']+)'/.exec(script)[1], "base64").toString()).caseRoot;
for (const entry of fs.readdirSync(caseRoot)) fs.rmSync(path.join(caseRoot, entry), { recursive: true, force: true });
`,
  );
  await chmod(fake, 0o755);
  const pkg = join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "shared-artifact-evals",
  );
  return {
    root,
    origin,
    repo,
    suiteRoot,
    suite,
    fake,
    argvLog,
    workerCommand: [
      process.execPath,
      join(pkg, "node_modules", "tsx", "dist", "cli.mjs"),
      "--tsconfig",
      join(pkg, "tsconfig.dev.json"),
      join(pkg, "src", "cli.ts"),
    ],
  };
}

describe("claude cloud backend (simulated session)", () => {
  it("returns a sealed Attempt through the result branch and never dispatches the credential", async () => {
    const cloud = await simulatedCloud();
    const backend = createClaudeCloudBackend({
      experimental: true,
      command: cloud.fake,
      environmentId: "ccpool_selfhosted01",
      repoRoot: cloud.repo,
      remote: cloud.origin,
      suiteFile: "bench/suite.json",
      installCommand: ["true"],
      workerCommand: cloud.workerCommand,
      pollIntervalMs: 50,
      resultTimeoutMs: 120_000,
    });
    const outputRoot = join(cloud.root, "runs");
    const report = await runBenchmarkSuite({
      suite: cloud.suite as never,
      suiteRoot: cloud.suiteRoot,
      outputRoot,
      runId: "run",
      agent,
      // Without the end-of-run sweep, so the per-Attempt delete is what is tested.
      backends: [{ ...backend, dispose: undefined }],
    });
    expect(report.cases[0]).toMatchObject({ status: "pass" });
    // The credential the Agent used was the session's secret, and it came back only as bytes the Agent wrote.
    expect(
      await readFile(
        join(outputRoot, "run", "task", "workspace", "result.txt"),
        "utf8",
      ),
    ).toBe("session-secret");

    const argv = JSON.parse(await readFile(cloud.argvLog, "utf8")) as string[];
    expect(argv).toContain("--environment");
    expect(argv[argv.indexOf("--environment") + 1]).toBe("ccpool_selfhosted01");
    expect(argv.join("\n")).not.toContain(SECRET);
    expect(argv.join("\n")).not.toContain("placeholder-never-sent");

    await expect(backend.runtimeClaim()).resolves.toEqual({
      kind: "claude-cloud",
      pool: { kind: "self-hosted", environmentId: "ccpool_selfhosted01" },
    });
    // The result branch was read once and then deleted from the remote.
    expect(git(cloud.repo, "ls-remote", cloud.origin)).not.toContain(
      "bench-results/",
    );
  });

  it("keeps the result branch only when asked to", async () => {
    const cloud = await simulatedCloud();
    const report = await runBenchmarkSuite({
      suite: cloud.suite as never,
      suiteRoot: cloud.suiteRoot,
      outputRoot: join(cloud.root, "runs"),
      runId: "run",
      agent,
      backends: [
        createClaudeCloudBackend({
          experimental: true,
          keepResultBranches: true,
          command: cloud.fake,
          repoRoot: cloud.repo,
          remote: cloud.origin,
          suiteFile: "bench/suite.json",
          installCommand: ["true"],
          workerCommand: cloud.workerCommand,
          pollIntervalMs: 50,
          resultTimeoutMs: 120_000,
        }),
      ],
    });
    expect(report.cases[0]).toMatchObject({ status: "pass" });
    expect(git(cloud.repo, "ls-remote", cloud.origin)).toContain(
      "bench-results/run/task-t1-a1-",
    );
  });

  it("is refused unless explicitly enabled as experimental", () => {
    expect(() =>
      createClaudeCloudBackend({
        repoRoot: ".",
        suiteFile: "x",
      } as never),
    ).toThrow(/experimental/u);
    expect(
      createClaudeCloudBackend({
        experimental: true,
        repoRoot: ".",
        suiteFile: "x",
      }).experimental,
    ).toBe(true);
  });

  it("reports a missing result branch as an infrastructure failure", async () => {
    const cloud = await simulatedCloud({ skipScript: true });
    const report = await runBenchmarkSuite({
      suite: cloud.suite as never,
      suiteRoot: cloud.suiteRoot,
      outputRoot: join(cloud.root, "runs"),
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      backends: [
        createClaudeCloudBackend({
          experimental: true,
          command: cloud.fake,
          repoRoot: cloud.repo,
          remote: cloud.origin,
          suiteFile: "bench/suite.json",
          pollIntervalMs: 20,
          resultTimeoutMs: 400,
        }),
      ],
    });
    expect(report.cases[0]?.failure).toMatchObject({
      classification: "infrastructure",
      detail: expect.stringContaining("No result branch"),
    });
  });

  it("refuses a working-tree subject because the session cannot see uncommitted files", async () => {
    const cloud = await simulatedCloud();
    const report = await runBenchmarkSuite({
      suite: cloud.suite as never,
      suiteRoot: cloud.suiteRoot,
      outputRoot: join(cloud.root, "runs"),
      runId: "run",
      agent,
      maxInfrastructureAttempts: 1,
      subject: {
        pluginRoot: cloud.repo,
        dispose: async () => {},
        record: {
          kind: "working-tree",
          version: "1.0.0",
          commit: "a".repeat(40),
          dirty: true,
          dirtyDigest: "b".repeat(64),
          artifact: { kind: "built-runtime-tree", sha256: "c".repeat(64) },
          runtimeSha256: "c".repeat(64),
        },
      },
      backends: [
        createClaudeCloudBackend({
          experimental: true,
          command: cloud.fake,
          repoRoot: cloud.repo,
          remote: cloud.origin,
          suiteFile: "bench/suite.json",
        }),
      ],
    });
    expect(report.cases[0]?.failure?.detail).toContain(
      "cannot see a working tree",
    );
  });

  it("rejects a malformed self-hosted pool id", () => {
    expect(() =>
      createClaudeCloudBackend({
        experimental: true,
        environmentId: "not-a-pool; rm -rf /",
        repoRoot: ".",
        suiteFile: "x",
      }),
    ).toThrow(/ccpool_/u);
  });
});

describe("result branch pruning", () => {
  it("deletes one run's result branches and leaves everything else", async () => {
    const cloud = await simulatedCloud();
    const head = git(cloud.repo, "rev-parse", "HEAD");
    for (const branch of [
      "bench-results/run-a/task-t1-a1-0001",
      "bench-results/run-a/task-t2-a1-0002",
      "bench-results/run-b/task-t1-a1-0003",
      "feature/bench-results/run-a",
    ]) {
      git(
        cloud.repo,
        "push",
        "-q",
        cloud.origin,
        `${head}:refs/heads/${branch}`,
      );
    }
    const deleted = await pruneCloudResultBranches({
      repoRoot: cloud.repo,
      remote: cloud.origin,
      runId: "run-a",
    });
    expect(deleted.sort()).toEqual([
      "bench-results/run-a/task-t1-a1-0001",
      "bench-results/run-a/task-t2-a1-0002",
    ]);
    const remaining = git(cloud.repo, "ls-remote", "--heads", cloud.origin);
    expect(remaining).not.toContain("bench-results/run-a/");
    expect(remaining).toContain("bench-results/run-b/task-t1-a1-0003");
    expect(remaining).toContain("feature/bench-results/run-a");
    expect(remaining).toContain("refs/heads/main");

    await pruneCloudResultBranches({
      repoRoot: cloud.repo,
      remote: cloud.origin,
    });
    expect(git(cloud.repo, "ls-remote", "--heads", cloud.origin)).not.toContain(
      "refs/heads/bench-results/",
    );
  });

  it("sweeps a run's leftover branches when the backend is disposed", async () => {
    const cloud = await simulatedCloud();
    const head = git(cloud.repo, "rev-parse", "HEAD");
    const backend = createClaudeCloudBackend({
      experimental: true,
      command: cloud.fake,
      repoRoot: cloud.repo,
      remote: cloud.origin,
      suiteFile: "bench/suite.json",
      installCommand: ["true"],
      workerCommand: cloud.workerCommand,
      pollIntervalMs: 50,
      resultTimeoutMs: 120_000,
    });
    // A session that pushed after the dispatcher stopped waiting for it.
    git(
      cloud.repo,
      "push",
      "-q",
      cloud.origin,
      `${head}:refs/heads/bench-results/run/task-t1-a9-late`,
    );
    await runBenchmarkSuite({
      suite: cloud.suite as never,
      suiteRoot: cloud.suiteRoot,
      outputRoot: join(cloud.root, "runs"),
      runId: "run",
      agent,
      backends: [backend],
    });
    expect(git(cloud.repo, "ls-remote", "--heads", cloud.origin)).not.toContain(
      "bench-results/",
    );
  });
});

describe("cloud worker script", () => {
  const input = {
    runnerRev: "a".repeat(40),
    unitBase64: Buffer.from("{}").toString("base64"),
    suiteRootRelative: "bench",
    caseRoot: "/tmp/it's a case",
    branch: "bench-results/run/x",
    installCommand: ["pnpm", "install"],
    workerCommand: ["node", "cli.ts"],
  };

  it("quotes every dispatched value so a hostile name cannot add commands", () => {
    const script = renderCloudWorkerScript({
      ...input,
      branch: "x'; touch /tmp/pwned; echo '",
    });
    expect(script).toContain(`'x'\\''; touch /tmp/pwned; echo '\\'''`);
    expect(script).toContain(`'/tmp/it'\\''s a case'`);
  });
});

describe("result archive validation", () => {
  async function archiveWith(
    setup: (dir: string) => Promise<void>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "clash-bench-archive-"));
    const content = join(dir, "content");
    await mkdir(content);
    await setup(content);
    const archive = join(dir, "a.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", content, "."]);
    return archive;
  }

  it("accepts ordinary files and in-tree relative links", async () => {
    const archive = await archiveWith(async (dir) => {
      await writeFile(join(dir, "file.txt"), "x");
      await symlink("file.txt", join(dir, "link"));
    });
    await expect(
      assertSafeArchive(archive, spawnCloudCommand),
    ).resolves.toBeUndefined();
  });

  it("rejects a link that points outside the Attempt", async () => {
    const archive = await archiveWith(async (dir) => {
      await symlink("../../etc/passwd", join(dir, "link"));
    });
    await expect(assertSafeArchive(archive, spawnCloudCommand)).rejects.toThrow(
      /leaves the Attempt/u,
    );
  });

  it("rejects an absolute link target", async () => {
    const archive = await archiveWith(async (dir) => {
      await symlink("/etc/passwd", join(dir, "link"));
    });
    await expect(
      assertSafeArchive(archive, spawnCloudCommand),
    ).rejects.toThrow();
  });

  it("rejects entries that escape the extraction directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clash-bench-archive-"));
    await writeFile(join(dir, "payload"), "x");
    const archive = join(dir, "escape.tar.gz");
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      dir,
      "--transform",
      "s,payload,../payload,",
      "payload",
    ]);
    await expect(assertSafeArchive(archive, spawnCloudCommand)).rejects.toThrow(
      /escapes/u,
    );
    expect(await readdir(dir)).toContain("payload");
  });
});
