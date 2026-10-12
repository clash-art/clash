import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { watch, writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBenchmarkFixtureManifest,
  installBenchmarkInputFixture,
  verifyBenchmarkInputFixture,
} from "./fixture";
import { runBenchmarkSuite } from "./runner";
import { ArtifactBenchmarkCaseSchema } from "./schemas";
import type {
  ArtifactBenchmarkCase,
  ArtifactBenchmarkSuite,
  BenchmarkAgent,
} from "./types";

type CopyStepHook = (source: string, destination: string) => void;

const copyStep = vi.hoisted(() => ({
  before: undefined as CopyStepHook | undefined,
  after: undefined as CopyStepHook | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const cp: typeof actual.cp = async (source, destination, options) => {
    copyStep.before?.(String(source), String(destination));
    await actual.cp(source, destination, options);
    copyStep.after?.(String(source), String(destination));
  };
  return { ...actual, default: { ...actual, cp }, cp };
});

afterEach(() => {
  copyStep.before = undefined;
  copyStep.after = undefined;
});

async function interceptedInstallation(allowExistingWorkspace: boolean) {
  const root = await mkdtemp(join(tmpdir(), "clash-fixture-copy-step-"));
  const suiteRoot = join(root, "suite");
  const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
  const workspace = join(root, "workspace");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(workspace);
  if (allowExistingWorkspace) {
    await mkdir(join(workspace, ".clash"));
    await writeFile(join(workspace, ".clash", "project.toml"), "project");
  }
  await writeFile(join(fixtureRoot, "a-trigger.txt"), "original");
  await writeFile(join(fixtureRoot, "z-last.txt"), "last");
  const manifest = await createBenchmarkFixtureManifest(fixtureRoot);
  return {
    sourceTrigger: join(await realpath(fixtureRoot), "a-trigger.txt"),
    copiedTrigger: join(await realpath(workspace), "a-trigger.txt"),
    receiptPath: join(workspace, ".clash", "benchmark-input-fixture.json"),
    install: async () =>
      installBenchmarkInputFixture({
        suiteRoot: await realpath(suiteRoot),
        workspace: await realpath(workspace),
        fixture: {
          path: "fixtures/spoken-edit",
          manifestSha256: manifest.manifestSha256,
        },
        ...(allowExistingWorkspace ? { allowExistingWorkspace } : {}),
      }),
  };
}

function fixtureCase(
  inputFixture?: ArtifactBenchmarkCase["inputFixture"],
): ArtifactBenchmarkCase {
  return {
    id: "spoken-edit",
    title: "Spoken edit",
    category: "timeline",
    outcome: {
      objective: "Read the public input and create a report.",
      acceptanceCriteria: ["The report contains the supplied transcript."],
      deliverables: [
        {
          artifactId: "result",
          kind: "report",
          description: "Fixture-backed report",
        },
      ],
    },
    passScore: 100,
    timeoutMs: 10_000,
    skills: [],
    ...(inputFixture ? { inputFixture } : {}),
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

function fixtureSuite(
  benchmark: ArtifactBenchmarkCase,
): ArtifactBenchmarkSuite {
  return {
    schemaVersion: 1,
    id: "fixture-suite",
    title: "Fixture suite",
    cases: [benchmark],
  };
}

function fixtureReadingAgent(startedMarker?: string): BenchmarkAgent {
  const source = [
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const workspace = process.env.CLASH_BENCH_WORKSPACE",
    ...(startedMarker
      ? [`fs.writeFileSync(${JSON.stringify(startedMarker)}, "started")`]
      : []),
    'const transcript = fs.readFileSync(path.join(workspace, "inputs", "transcript.txt"), "utf8")',
    'if (!fs.existsSync(path.join(workspace, "media", "speaker.raw"))) process.exit(7)',
    'if (!fs.existsSync(path.join(workspace, ".clash", "benchmark-input-fixture.json"))) process.exit(8)',
    'fs.writeFileSync(path.join(workspace, "result.txt"), transcript)',
    'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"spoken-edit",artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
  ].join(";");
  return { command: process.execPath, args: ["-e", source] };
}

function fixtureMutatingAgent(): BenchmarkAgent {
  const source = [
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const workspace = process.env.CLASH_BENCH_WORKSPACE",
    'fs.writeFileSync(path.join(workspace, "inputs", "transcript.txt"), "easier prompt")',
    'fs.writeFileSync(path.join(workspace, "result.txt"), "finished")',
    'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"spoken-edit",artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
  ].join(";");
  return { command: process.execPath, args: ["-e", source] };
}

function fixtureLateMutatingAgent(input: {
  watcherReadyPath: string;
}): BenchmarkAgent {
  const source = [
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const workspace = process.env.CLASH_BENCH_WORKSPACE",
    `const watcherReadyPath = ${JSON.stringify(input.watcherReadyPath)}`,
    "const waitArray = new Int32Array(new SharedArrayBuffer(4))",
    "const deadline = Date.now() + 2000",
    "while (!fs.existsSync(watcherReadyPath) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 2)",
    "if (!fs.existsSync(watcherReadyPath)) process.exit(9)",
    'fs.writeFileSync(path.join(workspace, "result.txt"), "finished")',
    'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"spoken-edit",artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
  ].join(";");
  return { command: process.execPath, args: ["-e", source] };
}

function mutateFixtureAfterPostAgentCheck(input: {
  caseRoot: string;
  watcherReadyPath: string;
  donePath: string;
}): Promise<void> {
  const source = [
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const caseRoot = process.argv[1]",
    "const watcherReadyPath = process.argv[2]",
    "const donePath = process.argv[3]",
    "const waitArray = new Int32Array(new SharedArrayBuffer(4))",
    'fs.writeFileSync(watcherReadyPath, "ready")',
    "const deadline = Date.now() + 2000",
    'const findPartialName = () => { try { return fs.readdirSync(caseRoot).find((entry) => entry.startsWith("workspace.partial-")) } catch (error) { if (error && error.code === "ENOENT") return undefined; throw error } }',
    "let partialName = findPartialName()",
    "while (!partialName && Date.now() < deadline) { Atomics.wait(waitArray, 0, 0, 1); partialName = findPartialName() }",
    "if (!partialName) process.exit(3)",
    'const fixturePath = path.join(caseRoot, partialName, "inputs", "transcript.txt")',
    "while (!fs.existsSync(fixturePath) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 1)",
    "if (!fs.existsSync(fixturePath)) process.exit(4)",
    'fs.writeFileSync(fixturePath, "late background mutation")',
    'fs.writeFileSync(donePath, "done")',
  ].join(";");
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", source, input.caseRoot, input.watcherReadyPath, input.donePath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Fixture mutation watcher failed with ${signal ?? `exit ${exitCode}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

describe("benchmark input fixtures", () => {
  it("fails closed without a receipt when the source view changes during installation", async () => {
    for (const mutation of ["add", "rewrite"] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `clash-fixture-source-${mutation}-`),
      );
      const suiteRoot = join(root, "suite");
      const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
      const workspace = join(root, "workspace");
      await mkdir(fixtureRoot, { recursive: true });
      await mkdir(join(fixtureRoot, "m-delay"));
      await mkdir(join(fixtureRoot, "z-tail"));
      await mkdir(join(workspace, ".clash"), { recursive: true });
      await writeFile(join(workspace, ".clash", "project.toml"), "project");
      await writeFile(join(fixtureRoot, "a-trigger.txt"), "original");
      await writeFile(join(fixtureRoot, "z-tail", "last.txt"), "last");
      for (let index = 0; index < 128; index += 1) {
        await writeFile(
          join(
            fixtureRoot,
            "m-delay",
            `tail-${String(index).padStart(3, "0")}.txt`,
          ),
          `tail ${index}`,
        );
      }
      const manifest = await createBenchmarkFixtureManifest(fixtureRoot);

      let installationSettled = false;
      let changedDuringInstallation = false;
      let resolveMutation!: () => void;
      const mutationObserved = new Promise<void>((resolveMutationPromise) => {
        resolveMutation = resolveMutationPromise;
      });
      const watcher = watch(workspace, (_event, filename) => {
        if (filename !== "a-trigger.txt" || changedDuringInstallation) return;
        changedDuringInstallation = !installationSettled;
        if (mutation === "add") {
          writeFileSync(
            join(fixtureRoot, "z-tail", "injected.txt"),
            "not manifested",
          );
        } else {
          writeFileSync(join(fixtureRoot, "a-trigger.txt"), "rewritten");
        }
        resolveMutation();
      });

      try {
        const result = await installBenchmarkInputFixture({
          suiteRoot: await realpath(suiteRoot),
          workspace: await realpath(workspace),
          fixture: {
            path: "fixtures/spoken-edit",
            manifestSha256: manifest.manifestSha256,
          },
          allowExistingWorkspace: true,
        }).then(
          (value) => ({ status: "resolved" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        installationSettled = true;
        await mutationObserved;

        expect(changedDuringInstallation).toBe(true);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toEqual(
            expect.objectContaining({
              message: expect.stringMatching(/source.*changed.*installation/i),
            }),
          );
        }
        await expect(
          lstat(join(workspace, ".clash", "benchmark-input-fixture.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        if (mutation === "add") {
          await expect(
            lstat(join(workspace, "z-tail", "injected.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        watcher.close();
      }
    }
  });

  it.each([
    { workspaceKind: "imported", allowExistingWorkspace: true },
    { workspaceKind: "fresh", allowExistingWorkspace: false },
  ])(
    "reports the source change when it also corrupts the copy in a $workspaceKind workspace",
    async ({ allowExistingWorkspace }) => {
      const installation = await interceptedInstallation(
        allowExistingWorkspace,
      );
      let rewrites = 0;
      copyStep.before = (source) => {
        if (source !== installation.sourceTrigger) return;
        writeFileSync(source, "rewritten");
        rewrites += 1;
      };

      await expect(installation.install()).rejects.toThrow(
        /source changed during installation/i,
      );

      expect(rewrites).toBe(1);
      await expect(readFile(installation.copiedTrigger, "utf8")).resolves.toBe(
        "rewritten",
      );
      await expect(lstat(installation.receiptPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    {
      workspaceKind: "imported",
      allowExistingWorkspace: true,
      reason: /Copied benchmark input fixture failed verification/,
    },
    {
      workspaceKind: "fresh",
      allowExistingWorkspace: false,
      reason: /Copied benchmark input fixture manifest sha256 mismatch/,
    },
  ])(
    "reports a corrupted copy of an unchanged source in a $workspaceKind workspace",
    async ({ allowExistingWorkspace, reason }) => {
      const installation = await interceptedInstallation(
        allowExistingWorkspace,
      );
      let corruptions = 0;
      copyStep.after = (_source, destination) => {
        if (destination !== installation.copiedTrigger) return;
        writeFileSync(destination, "corrupted");
        corruptions += 1;
      };

      const failure = await installation.install().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(corruptions).toBe(1);
      expect(failure).toEqual(
        expect.objectContaining({ message: expect.stringMatching(reason) }),
      );
      expect(failure).not.toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/source changed/i),
        }),
      );
      await expect(readFile(installation.sourceTrigger, "utf8")).resolves.toBe(
        "original",
      );
      await expect(lstat(installation.receiptPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("installs task inputs into an imported Workspace without replacing its marker", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "clash-fixture-imported-workspace-"),
    );
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
    const workspace = join(root, "workspace");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    await mkdir(join(workspace, ".clash"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "inputs", "transcript.txt"),
      "task input",
      "utf8",
    );
    const marker = 'schema_version = 1\nproject_id = "imported"\n';
    await writeFile(join(workspace, ".clash", "project.toml"), marker, "utf8");
    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);

    const provenance = await installBenchmarkInputFixture({
      suiteRoot: await realpath(suiteRoot),
      workspace: await realpath(workspace),
      fixture: {
        path: "fixtures/spoken-edit",
        manifestSha256: manifest.manifestSha256,
      },
      allowExistingWorkspace: true,
    });

    await expect(
      readFile(join(workspace, ".clash", "project.toml"), "utf8"),
    ).resolves.toBe(marker);
    await expect(
      readFile(join(workspace, "inputs", "transcript.txt"), "utf8"),
    ).resolves.toBe("task input");
    expect(provenance.files).toEqual(manifest.files);
  });

  it("detects changed and missing public input files after an agent run", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "clash-fixture-integrity-"),
    );
    await mkdir(join(fixtureRoot, "inputs"));
    await writeFile(
      join(fixtureRoot, "inputs", "brief.txt"),
      "original brief",
      "utf8",
    );
    await writeFile(
      join(fixtureRoot, "inputs", "source.txt"),
      "source",
      "utf8",
    );
    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);

    await writeFile(
      join(fixtureRoot, "inputs", "brief.txt"),
      "rewritten brief",
      "utf8",
    );
    await rm(join(fixtureRoot, "inputs", "source.txt"));

    const integrity = await verifyBenchmarkInputFixture(fixtureRoot, manifest);
    expect(integrity).toMatchObject({
      status: "fail",
      changedFiles: ["inputs/brief.txt"],
      missingFiles: ["inputs/source.txt"],
    });
    expect(integrity.detail).toMatch(
      /changed.*inputs\/brief\.txt.*missing.*inputs\/source\.txt/i,
    );
  });

  it("rejects a fixture file reached through a replacement directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-parent-link-"));
    const fixtureRoot = join(root, "workspace");
    const outsideInputs = join(root, "outside-inputs");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "inputs", "brief.txt"),
      "unchanged bytes",
      "utf8",
    );
    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);
    await mkdir(outsideInputs);
    await writeFile(
      join(outsideInputs, "brief.txt"),
      "unchanged bytes",
      "utf8",
    );
    await rm(join(fixtureRoot, "inputs"), { recursive: true });
    await symlink(outsideInputs, join(fixtureRoot, "inputs"), "dir");

    const integrity = await verifyBenchmarkInputFixture(fixtureRoot, manifest);

    expect(integrity.status).toBe("fail");
    expect(integrity.changedFiles).toContain("inputs/brief.txt");
  });

  it("builds a canonical sorted file manifest with path, size, and sha256", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "clash-fixture-manifest-"),
    );
    await mkdir(join(fixtureRoot, "z"));
    await writeFile(join(fixtureRoot, "z", "speaker.raw"), "voice", "utf8");
    await writeFile(join(fixtureRoot, "brief.txt"), "hello", "utf8");

    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);
    const files = [
      {
        path: "brief.txt",
        bytes: 5,
        sha256: createHash("sha256").update("hello").digest("hex"),
      },
      {
        path: "z/speaker.raw",
        bytes: 5,
        sha256: createHash("sha256").update("voice").digest("hex"),
      },
    ];
    const expectedSha256 = createHash("sha256")
      .update(JSON.stringify({ schemaVersion: 1, files }))
      .digest("hex");

    expect(manifest).toEqual({
      schemaVersion: 1,
      files,
      manifestSha256: expectedSha256,
      totalBytes: 10,
    });
  });

  it("copies verified public inputs before the agent starts and records provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-run-"));
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
    const outputRoot = join(root, "runs");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    await mkdir(join(fixtureRoot, "media"));
    await writeFile(
      join(fixtureRoot, "inputs", "transcript.txt"),
      "hello host",
      "utf8",
    );
    await writeFile(join(fixtureRoot, "media", "speaker.raw"), "voice", "utf8");
    const expected = await createBenchmarkFixtureManifest(fixtureRoot);
    const benchmark = fixtureCase({
      path: "fixtures/spoken-edit",
      manifestSha256: expected.manifestSha256,
    });

    const report = await runBenchmarkSuite({
      suite: fixtureSuite(benchmark),
      suiteRoot,
      outputRoot,
      runId: "fixture-run",
      agent: fixtureReadingAgent(),
    });

    expect(report.status).toBe("pass");
    expect(report.cases[0]?.inputFixture).toMatchObject({
      sourcePath: "fixtures/spoken-edit",
      workspacePath: ".",
      manifestSha256: expected.manifestSha256,
      totalBytes: expected.totalBytes,
      receiptPath: ".clash/benchmark-input-fixture.json",
    });
    expect(report.cases[0]?.inputFixture?.files).toEqual(expected.files);
    const workspace = report.cases[0]!.workspace;
    await expect(readFile(join(workspace, "result.txt"), "utf8")).resolves.toBe(
      "hello host",
    );
    const receipt = JSON.parse(
      await readFile(
        join(workspace, ".clash", "benchmark-input-fixture.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      sourcePath: "fixtures/spoken-edit",
      manifestSha256: expected.manifestSha256,
    });
    const outcome = await readFile(join(workspace, "OUTCOME.md"), "utf8");
    expect(outcome).toContain("public input fixture");
    expect(outcome).toContain("fixtures/spoken-edit");
    expect(outcome).not.toContain("result-exists");
  });

  it("fails a completed agent run that rewrites a public input fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-mutation-"));
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
    const outputRoot = join(root, "runs");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "inputs", "transcript.txt"),
      "original prompt",
      "utf8",
    );
    const expected = await createBenchmarkFixtureManifest(fixtureRoot);

    const report = await runBenchmarkSuite({
      suite: fixtureSuite(
        fixtureCase({
          path: "fixtures/spoken-edit",
          manifestSha256: expected.manifestSha256,
        }),
      ),
      suiteRoot,
      outputRoot,
      runId: "fixture-mutation",
      agent: fixtureMutatingAgent(),
    });

    expect(report.cases[0]).toMatchObject({
      status: "fail",
      agent: { status: "completed" },
      execution: {
        status: "fail",
        detail: expect.stringMatching(
          /fixture changed.*inputs\/transcript\.txt/i,
        ),
      },
      failure: { classification: "product", retryable: false },
    });
    const integrity = JSON.parse(
      await readFile(
        join(
          outputRoot,
          "fixture-mutation",
          "spoken-edit",
          "fixture-integrity.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(integrity).toMatchObject({
      status: "fail",
      changedFiles: ["inputs/transcript.txt"],
    });
  });

  it("rejects a final snapshot changed by a background process after the post-agent check", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-late-mutation-"));
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
    const outputRoot = join(root, "runs");
    const runId = "fixture-late-mutation";
    const caseRoot = join(outputRoot, runId, "spoken-edit");
    const watcherReadyPath = join(root, "background-ready");
    const donePath = join(root, "background-done");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    for (let index = 0; index < 128; index += 1) {
      await writeFile(
        join(
          fixtureRoot,
          "inputs",
          `a-ballast-${String(index).padStart(3, "0")}.txt`,
        ),
        "ballast",
      );
    }
    await writeFile(
      join(fixtureRoot, "inputs", "transcript.txt"),
      "original prompt",
      "utf8",
    );
    const expected = await createBenchmarkFixtureManifest(fixtureRoot);

    const watcherReady = new Promise<void>((resolveReady, rejectReady) => {
      const readyWatcher = watch(root, (_event, filename) => {
        if (filename !== "background-ready") return;
        readyWatcher.close();
        resolveReady();
      });
      readyWatcher.once("error", (error) => {
        readyWatcher.close();
        rejectReady(error);
      });
    });
    const mutation = mutateFixtureAfterPostAgentCheck({
      caseRoot,
      watcherReadyPath,
      donePath,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await watcherReady;
    await expect(lstat(caseRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const [report, mutationResult] = await Promise.all([
      runBenchmarkSuite({
        suite: fixtureSuite(
          fixtureCase({
            path: "fixtures/spoken-edit",
            manifestSha256: expected.manifestSha256,
          }),
        ),
        suiteRoot,
        outputRoot,
        runId,
        agent: fixtureLateMutatingAgent({
          watcherReadyPath,
        }),
      }),
      mutation,
    ]);
    if (!mutationResult.ok) throw mutationResult.error;

    await expect(readFile(donePath, "utf8")).resolves.toBe("done");
    await expect(
      readFile(
        join(report.cases[0]!.workspace, "inputs", "transcript.txt"),
        "utf8",
      ),
    ).resolves.toBe("late background mutation");
    expect(report.cases[0]).toMatchObject({
      status: "fail",
      agent: { status: "completed" },
      execution: {
        status: "fail",
        detail: expect.stringMatching(
          /published final workspace snapshot.*changed/i,
        ),
      },
      failure: { classification: "product", retryable: false },
    });
    const integrity = JSON.parse(
      await readFile(join(caseRoot, "fixture-integrity.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(integrity).toMatchObject({
      status: "fail",
      changedFiles: ["inputs/transcript.txt"],
    });
  });

  it("rejects a mismatched manifest before starting the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-mismatch-"));
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "spoken-edit");
    const outputRoot = join(root, "runs");
    const startedMarker = join(root, "agent-started");
    await mkdir(join(fixtureRoot, "inputs"), { recursive: true });
    await mkdir(join(fixtureRoot, "media"));
    await writeFile(
      join(fixtureRoot, "inputs", "transcript.txt"),
      "tampered",
      "utf8",
    );
    await writeFile(join(fixtureRoot, "media", "speaker.raw"), "voice", "utf8");

    const report = await runBenchmarkSuite({
      suite: fixtureSuite(
        fixtureCase({
          path: "fixtures/spoken-edit",
          manifestSha256: "0".repeat(64),
        }),
      ),
      suiteRoot,
      outputRoot,
      runId: "fixture-mismatch",
      agent: fixtureReadingAgent(startedMarker),
      maxInfrastructureAttempts: 1,
    });

    expect(report.cases[0]).toMatchObject({
      status: "fail",
      agent: { status: "not-run" },
      failure: {
        classification: "infrastructure",
        phase: "runner",
      },
    });
    expect(report.cases[0]?.failure?.detail).toMatch(
      /manifest sha256 mismatch/i,
    );
    await expect(lstat(startedMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects path escapes, symbolic links, and runner-owned fixture paths", async () => {
    expect(
      ArtifactBenchmarkCaseSchema.safeParse({
        ...fixtureCase(),
        inputFixture: {
          path: "../private-gold",
          manifestSha256: "0".repeat(64),
        },
      }).success,
    ).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "clash-fixture-unsafe-"));
    const suiteRoot = join(root, "suite");
    const symlinkFixture = join(suiteRoot, "fixtures", "symlinked");
    const reservedFixture = join(suiteRoot, "fixtures", "reserved");
    const outputRoot = join(root, "runs");
    await mkdir(symlinkFixture, { recursive: true });
    await writeFile(join(root, "private-gold.txt"), "gold", "utf8");
    await symlink(
      join(root, "private-gold.txt"),
      join(symlinkFixture, "gold.txt"),
    );
    await expect(
      createBenchmarkFixtureManifest(symlinkFixture),
    ).rejects.toThrow(/symbolic link/i);

    await mkdir(reservedFixture, { recursive: true });
    await writeFile(join(reservedFixture, "OUTCOME.md"), "replace me", "utf8");
    const reservedManifest =
      await createBenchmarkFixtureManifest(reservedFixture);
    const report = await runBenchmarkSuite({
      suite: fixtureSuite(
        fixtureCase({
          path: "fixtures/reserved",
          manifestSha256: reservedManifest.manifestSha256,
        }),
      ),
      suiteRoot,
      outputRoot,
      runId: "reserved-fixture",
      agent: fixtureReadingAgent(),
      maxInfrastructureAttempts: 1,
    });
    expect(report.cases[0]?.failure?.detail).toMatch(
      /runner-owned path.*OUTCOME\.md/i,
    );
  });

  it("rejects an empty runner-owned directory that is absent from the file manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-fixture-reserved-dir-"));
    const suiteRoot = join(root, "suite");
    const fixtureRoot = join(suiteRoot, "fixtures", "reserved-dir");
    const outputRoot = join(root, "runs");
    await mkdir(join(fixtureRoot, ".agents"), { recursive: true });
    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);

    const report = await runBenchmarkSuite({
      suite: fixtureSuite(
        fixtureCase({
          path: "fixtures/reserved-dir",
          manifestSha256: manifest.manifestSha256,
        }),
      ),
      suiteRoot,
      outputRoot,
      runId: "reserved-directory-fixture",
      agent: fixtureReadingAgent(),
      maxInfrastructureAttempts: 1,
    });

    expect(report.cases[0]?.failure?.detail).toMatch(
      /runner-owned path.*\.agents/i,
    );
  });
});
