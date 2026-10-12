import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeWorkspaceBundleManifest } from "@clash/shared-runtime";
import {
  markActionAssetBindingAuthority,
  markDocumentAssetAuthority,
  markGeneratorAuthority,
  markProjectAssetAuthority,
} from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEvaluationRecord,
  parseEvaluationRecord,
  writeEvaluationRecord,
} from "./evaluation-records";
import { verifyBenchmarkAttempt } from "./attempt-manifest";
import { parseBenchmarkResultBundle } from "./result-bundle";
import { reevaluateBenchmarkRun, runBenchmarkSuite } from "./runner";
import type {
  ArtifactBenchmarkCase,
  ArtifactBenchmarkSuite,
  BenchmarkAgent,
} from "./types";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createInputWorkspace(root: string) {
  await mkdir(root, { recursive: true });
  const doc = new LoroDoc();
  doc.setPeerId(1);
  markProjectAssetAuthority(doc);
  markActionAssetBindingAuthority(doc);
  markGeneratorAuthority(doc);
  markDocumentAssetAuthority(doc);
  doc.commit();
  const snapshot = Buffer.from(
    doc.export({
      mode: "shallow-snapshot",
      frontiers: doc.oplogFrontiers(),
    }),
  );
  await writeFile(join(root, "project.bin"), snapshot);
  return writeWorkspaceBundleManifest(root, {
    schemaVersion: 1,
    kind: "clash.workspace.bundle",
    source: {
      projectId: "evaluation-decoupling-project",
      display: {
        name: "Evaluation decoupling fixture",
        description: "A minimal deterministic benchmark Workspace.",
      },
    },
    content: {
      workspaceRoot: "workspace",
      project: {
        path: "project.bin",
        codec: "loro-shallow-snapshot",
        codecVersion: 1,
      },
      resources: [],
      documentBodies: [],
      textRevisions: [],
    },
    semanticRequirements: {
      generatorDefinitions: [],
      modelReferences: [],
    },
    files: [
      {
        path: "project.bin",
        role: "project",
        bytes: snapshot.byteLength,
        sha256: sha256(snapshot),
        mode: "0644",
      },
    ],
    excluded: [],
  });
}

function benchmark(inputWorkspaceDigest: string): ArtifactBenchmarkCase {
  return {
    id: "evaluation-decoupling",
    title: "Evaluation decoupling",
    category: "mixed",
    outcome: {
      objective: "Create one image artifact in the imported Workspace.",
      acceptanceCriteria: ["The submitted image artifact exists."],
      deliverables: [
        {
          artifactId: "frame",
          kind: "image",
          description: "A deterministic image fixture.",
        },
      ],
    },
    passScore: 100,
    timeoutMs: 30_000,
    skills: [],
    execution: {
      profile: "clash-host",
      requiredCliCommands: ["project status"],
      environment: {
        profile: "clash-agent-environment-v1",
        track: "functional",
        initialState: {
          workspace: {
            format: "clash-workspace-v1",
            path: "environment",
            bundleDigest: inputWorkspaceDigest,
          },
        },
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
    rubric: [
      {
        id: "frame-exists",
        type: "artifact-exists",
        artifactId: "frame",
        kind: "image",
        minBytes: 4,
        weight: 1,
        required: true,
      },
    ],
  };
}

async function createAgent(
  root: string,
  counterPath: string,
  options: { createSnapshotBlockingLink?: boolean } = {},
): Promise<BenchmarkAgent> {
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      'const childProcess = require("node:child_process")',
      'if (process.argv.includes("--version")) { process.stdout.write("codex-cli 1.0.0\\n"); process.exit(0) }',
      "const workspace = process.env.CLASH_BENCH_WORKSPACE",
      "const counter = process.env.AGENT_COUNTER_PATH",
      'childProcess.execFileSync(process.env.CLASH_CLI_ENTRY_PATH, ["project", "status", "--json"], {cwd:workspace,env:process.env,stdio:"ignore"})',
      'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0")',
      "fs.writeFileSync(counter, String(count + 1))",
      'fs.writeFileSync(path.join(workspace, "frame.png"), Buffer.from([137,80,78,71,13,10,26,10]))',
      'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"evaluation-decoupling",artifacts:[{id:"frame",kind:"image",path:"frame.png"}]}))',
      ...(options.createSnapshotBlockingLink
        ? [
            'fs.symlinkSync("frame.png", path.join(workspace, "snapshot-blocker"))',
          ]
        : []),
      'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"evaluation-decoupling"}) + "\\n")',
      'process.stdout.write(JSON.stringify({type:"turn.started"}) + "\\n")',
      'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"message-1",type:"agent_message",text:"Created the requested fixture."}}) + "\\n")',
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}) + "\\n")',
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o755);
  return {
    adapter: "codex",
    command: executable,
    model: "gpt-5.6-sol",
    env: { AGENT_COUNTER_PATH: counterPath },
    clashHost: {
      pluginRoot: join(repositoryRoot, "plugins", "clash"),
      profile: "dev",
    },
  };
}

/** Pi runs through ACP: a scripted ACP agent stands in for the pi-acp harness. */
async function createPiAgent(
  root: string,
  counterPath: string,
  options: { unknownSessionUpdate?: boolean } = {},
): Promise<BenchmarkAgent> {
  const work = join(root, "fake-pi-work.cjs");
  await writeFile(
    work,
    [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      'const childProcess = require("node:child_process")',
      "const workspace = process.env.CLASH_BENCH_WORKSPACE",
      "const counter = process.env.AGENT_COUNTER_PATH",
      'childProcess.execFileSync(process.env.CLASH_CLI_ENTRY_PATH, ["project", "status", "--json"], {cwd:workspace,env:process.env,stdio:"ignore"})',
      'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0")',
      "fs.writeFileSync(counter, String(count + 1))",
      'fs.writeFileSync(path.join(workspace, "frame.png"), Buffer.from([137,80,78,71,13,10,26,10]))',
      'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"evaluation-decoupling",artifacts:[{id:"frame",kind:"image",path:"frame.png"}]}))',
    ].join("\n"),
    "utf8",
  );
  const update = (value: Record<string, unknown>) =>
    JSON.stringify({ type: "acp.session_update", update: value });
  const replay = join(root, "fake-pi-session.jsonl");
  await writeFile(
    replay,
    [
      update({
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-1",
        content: { type: "text", text: "PRIVATE_PI_REASONING" },
      }),
      ...(options.unknownSessionUpdate
        ? [update({ sessionUpdate: "future_pi_control", detail: "new" })]
        : []),
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "Created the requested fixture." },
      }),
      JSON.stringify({
        type: "acp.prompt_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 1 },
      }),
    ].join("\n"),
    "utf8",
  );
  const executable = join(root, "fake-pi-acp");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      'if [ "${1:-}" = "--version" ]; then echo 0.80.7; exit 0; fi',
      `exec '${process.execPath}' '${fileURLToPath(new URL("./acp-agent.fixture.ts", import.meta.url))}' "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o755);
  return {
    adapter: "pi",
    command: executable,
    provider: "test-provider",
    model: "test-model",
    env: {
      AGENT_COUNTER_PATH: counterPath,
      ACP_FIXTURE_WORK: work,
      ACP_FIXTURE_REPLAY: replay,
    },
    clashHost: {
      pluginRoot: join(repositoryRoot, "plugins", "clash"),
      profile: "dev",
    },
  };
}

async function evaluationFiles(caseRoot: string): Promise<string[]> {
  return (await readdir(join(caseRoot, "evaluations", "sha256")))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `evaluations/sha256/${name}`);
}

describe("runner Evaluation decoupling", () => {
  it("publishes Pi ATIF evidence through the fresh Environment Attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-runner-pi-atif-"));
    roots.push(root);
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "agent-count.txt");
    await mkdir(suiteRoot);
    const inputWorkspace = await createInputWorkspace(
      join(suiteRoot, "environment"),
    );
    const benchmarkCase = benchmark(inputWorkspace.integrity.bundleDigest);
    const agent = await createPiAgent(root, counterPath);

    const report = await runBenchmarkSuite({
      suite: {
        schemaVersion: 1,
        id: "pi-atif-suite",
        title: "Pi ATIF suite",
        cases: [benchmarkCase],
      },
      suiteRoot,
      outputRoot,
      runId: "pi-atif-run",
      agent,
      maxInfrastructureAttempts: 1,
    });

    expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
    const caseRoot = join(outputRoot, "pi-atif-run", benchmarkCase.id);
    const [trajectoryText, receiptText, attemptText] = await Promise.all([
      readFile(join(caseRoot, "logs", "trajectory.atif.json"), "utf8"),
      readFile(join(caseRoot, "logs", "trajectory.atif-receipt.json"), "utf8"),
      readFile(join(caseRoot, "attempt.json"), "utf8"),
    ]);
    const trajectory = JSON.parse(trajectoryText) as {
      schema_version: string;
      agent: { name: string; version: string; model_name: string };
      extra: { reasoning_content_retained: boolean };
    };
    const receipt = JSON.parse(receiptText) as {
      source: { format: string };
    };
    const attempt = JSON.parse(attemptText) as {
      evidence: {
        trajectories: { native: { adapter: string }; atif?: { path: string } };
        logs: Array<{ path: string }>;
      };
    };
    expect(trajectory).toMatchObject({
      schema_version: "ATIF-v1.7",
      agent: { name: "pi", version: "0.80.7", model_name: "test-model" },
      extra: { reasoning_content_retained: false },
    });
    expect(trajectoryText).not.toContain("PRIVATE_PI_REASONING");
    expect(receipt.source.format).toBe("acp-events");
    expect(attempt.evidence.trajectories).toMatchObject({
      native: { adapter: "pi" },
      atif: { path: "logs/trajectory.atif.json" },
    });
    expect(attempt.evidence.logs).toContainEqual(
      expect.objectContaining({
        path: "logs/trajectory.atif-receipt.json",
      }),
    );
  }, 90_000);

  it("keeps the trial scoreable when the Pi session carries an update type the projection does not know", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-runner-pi-atif-unknown-"));
    roots.push(root);
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "agent-count.txt");
    await mkdir(suiteRoot);
    const inputWorkspace = await createInputWorkspace(
      join(suiteRoot, "environment"),
    );
    const benchmarkCase = benchmark(inputWorkspace.integrity.bundleDigest);
    const agent = await createPiAgent(root, counterPath, {
      unknownSessionUpdate: true,
    });

    const report = await runBenchmarkSuite({
      suite: {
        schemaVersion: 1,
        id: "pi-atif-unknown-suite",
        title: "Pi ATIF unknown update suite",
        cases: [benchmarkCase],
      },
      suiteRoot,
      outputRoot,
      runId: "pi-atif-unknown-run",
      agent,
      maxInfrastructureAttempts: 1,
    });

    // An unknown event used to end the trial as an `atif-projection`
    // infrastructure failure. The ACP client drops an update it cannot
    // validate, and the rest of the session is projected.
    expect(report.cases[0]?.agent).toMatchObject({ status: "completed" });
    expect(report.cases[0]?.failure?.phase).not.toBe("atif-projection");
    const caseRoot = join(outputRoot, "pi-atif-unknown-run", benchmarkCase.id);
    const trajectory = JSON.parse(
      await readFile(join(caseRoot, "logs", "trajectory.atif.json"), "utf8"),
    ) as { steps: Array<{ message: string }> };
    expect(trajectory.steps.at(-1)?.message).toBe(
      "Created the requested fixture.",
    );
    const capture = JSON.parse(
      await readFile(join(caseRoot, "attempt-capture.json"), "utf8"),
    ) as { atif: { status: string } };
    expect(capture.atif.status).not.toBe("unsupported");
    await expect(
      verifyBenchmarkAttempt({ caseRoot, suiteRoot }),
    ).resolves.toMatchObject({ receipt: { path: "attempt.json" } });
  }, 90_000);

  it("preserves a completed rollout when final Workspace publication fails", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "clash-runner-post-agent-infrastructure-"),
    );
    roots.push(root);
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "agent-count.txt");
    await mkdir(suiteRoot);
    const inputWorkspace = await createInputWorkspace(
      join(suiteRoot, "environment"),
    );
    const benchmarkCase = benchmark(inputWorkspace.integrity.bundleDigest);
    const suite: ArtifactBenchmarkSuite = {
      schemaVersion: 1,
      id: "post-agent-infrastructure-suite",
      title: "Post-Agent infrastructure suite",
      cases: [benchmarkCase],
    };
    const agent = await createAgent(root, counterPath, {
      createSnapshotBlockingLink: true,
    });

    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "post-agent-infrastructure",
      agent,
      maxInfrastructureAttempts: 1,
    });

    const caseRoot = join(
      outputRoot,
      "post-agent-infrastructure",
      benchmarkCase.id,
    );
    expect(report.cases[0]).toMatchObject({
      status: "fail",
      agent: {
        status: "completed",
        exitCode: 0,
        signal: null,
        durationMs: expect.any(Number),
      },
      execution: { status: "fail" },
      evaluation: { status: "fail" },
      failure: {
        classification: "infrastructure",
        retryable: true,
        phase: "runner",
        detail: expect.stringMatching(/symbolic link/iu),
      },
    });
    expect(report.cases[0]!.agent.durationMs).toBeGreaterThan(0);

    const capture = JSON.parse(
      await readFile(join(caseRoot, "attempt-capture.json"), "utf8"),
    ) as {
      rollout: { status: string; durationMs: number };
      atif: { status: string };
      trajectory: {
        raw: { path: string; bytes: number };
        normalized: { path: string; bytes: number };
      };
    };
    expect(capture).toMatchObject({
      rollout: {
        status: "completed",
        durationMs: report.cases[0]!.agent.durationMs,
      },
      atif: { status: "complete" },
      trajectory: {
        raw: { path: "logs/events.jsonl", bytes: expect.any(Number) },
        normalized: {
          path: "logs/trajectory.json",
          bytes: expect.any(Number),
        },
      },
    });
    expect(capture.trajectory.raw.bytes).toBeGreaterThan(0);
    expect(capture.trajectory.normalized.bytes).toBeGreaterThan(0);
    await expect(
      verifyBenchmarkAttempt({ caseRoot, suiteRoot }),
    ).resolves.toMatchObject({
      record: {
        attempt: { status: "completed" },
        evidence: { trajectories: { atif: expect.any(Object) } },
      },
    });
  }, 90_000);

  it("keeps one immutable Attempt while independent Evaluations are appended and rebundled", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "clash-runner-evaluation-decoupling-"),
    );
    roots.push(root);
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const counterPath = join(root, "agent-count.txt");
    await mkdir(suiteRoot);
    const inputWorkspace = await createInputWorkspace(
      join(suiteRoot, "environment"),
    );
    const benchmarkCase = benchmark(inputWorkspace.integrity.bundleDigest);
    const suite: ArtifactBenchmarkSuite = {
      schemaVersion: 1,
      id: "evaluation-decoupling-suite",
      title: "Evaluation decoupling suite",
      cases: [benchmarkCase],
    };
    const agent = await createAgent(root, counterPath);

    const initial = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run-1",
      agent,
    });
    expect(initial.cases[0]?.failure).toBeUndefined();
    expect(initial).toMatchObject({ status: "pass" });
    expect(await readFile(counterPath, "utf8")).toBe("1");

    const caseRoot = join(outputRoot, "run-1", benchmarkCase.id);
    const attemptPath = join(caseRoot, "attempt.json");
    const attemptBytesBefore = await readFile(attemptPath);
    const attempt = JSON.parse(attemptBytesBefore.toString("utf8")) as {
      integrity: { attemptDigest: string };
    };
    const initialBundleBytes = await readFile(
      join(caseRoot, "result-bundle.json"),
    );
    const initialBundle = parseBenchmarkResultBundle(initialBundleBytes);
    const initialEvaluationPaths = await evaluationFiles(caseRoot);
    const initialEvaluationBytes = await Promise.all(
      initialEvaluationPaths.map((path) => readFile(join(caseRoot, path))),
    );
    expect(initialEvaluationPaths.length).toBeGreaterThan(0);
    expect(initialBundle.attempt.digest).toBe(attempt.integrity.attemptDigest);

    const independentEvidence = Buffer.from(
      '{"dimension":"independent-content","score":73}\n',
    );
    await writeFile(
      join(caseRoot, "independent-evaluation-evidence.json"),
      independentEvidence,
    );
    const independent = await writeEvaluationRecord({
      storeRoot: caseRoot,
      record: createEvaluationRecord({
        attemptDigest: attempt.integrity.attemptDigest,
        evaluator: {
          id: "independent.content-evaluator",
          version: "1",
          digest: sha256("independent.content-evaluator@1"),
        },
        spec: {
          id: "independent.content-effect",
          version: "1",
          digest: sha256("independent.content-effect@1"),
        },
        dimensions: [
          {
            id: "content.independent",
            score: 73,
            verdict: "pass",
          },
        ],
        evidence: [
          {
            path: "independent-evaluation-evidence.json",
            bytes: independentEvidence.byteLength,
            sha256: sha256(independentEvidence),
          },
        ],
      }),
    });

    const reevaluated = await reevaluateBenchmarkRun({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run-1",
      caseId: benchmarkCase.id,
    });
    expect(reevaluated).toMatchObject({ status: "pass", attempt: 1 });
    expect(await readFile(counterPath, "utf8")).toBe("1");

    const attemptBytesAfter = await readFile(attemptPath);
    expect(attemptBytesAfter).toEqual(attemptBytesBefore);
    expect(
      (
        JSON.parse(attemptBytesAfter.toString("utf8")) as {
          integrity: { attemptDigest: string };
        }
      ).integrity.attemptDigest,
    ).toBe(attempt.integrity.attemptDigest);

    const evaluationPathsAfter = await evaluationFiles(caseRoot);
    expect(evaluationPathsAfter).toEqual(
      expect.arrayContaining([...initialEvaluationPaths, independent.path]),
    );
    await Promise.all(
      initialEvaluationPaths.map(async (path, index) => {
        expect(await readFile(join(caseRoot, path))).toEqual(
          initialEvaluationBytes[index],
        );
      }),
    );
    for (const path of evaluationPathsAfter) {
      const record = parseEvaluationRecord(
        await readFile(join(caseRoot, path)),
      );
      expect(record.attemptDigest).toBe(attempt.integrity.attemptDigest);
    }

    const updatedBundleBytes = await readFile(
      join(caseRoot, "result-bundle.json"),
    );
    const updatedBundle = parseBenchmarkResultBundle(updatedBundleBytes);
    expect(updatedBundleBytes).not.toEqual(initialBundleBytes);
    expect(updatedBundle.integrity.resultBundleDigest).not.toBe(
      initialBundle.integrity.resultBundleDigest,
    );
    expect(updatedBundle.attempt).toEqual(initialBundle.attempt);
    expect(updatedBundle.evaluations.map(({ digest }) => digest)).toEqual(
      expect.arrayContaining([
        ...initialBundle.evaluations.map(({ digest }) => digest),
        independent.record.digest,
      ]),
    );

    const resumed = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run-1",
      agent,
      resume: true,
    });
    expect(resumed.status).toBe("pass");
    expect(await readFile(counterPath, "utf8")).toBe("1");
    expect(await readFile(attemptPath)).toEqual(attemptBytesBefore);

    await writeFile(
      join(caseRoot, "independent-evaluation-evidence.json"),
      "tampered\n",
    );
    await expect(
      reevaluateBenchmarkRun({
        suite,
        suiteRoot,
        outputRoot,
        runId: "run-1",
        caseId: benchmarkCase.id,
      }),
    ).rejects.toThrow(/Evaluation evidence|sha256|bytes/iu);
    expect(await readFile(counterPath, "utf8")).toBe("1");
    expect(await readFile(attemptPath)).toEqual(attemptBytesBefore);
  }, 90_000);
});
