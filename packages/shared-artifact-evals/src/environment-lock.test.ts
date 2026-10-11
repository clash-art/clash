import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentEnvironmentLock,
  captureBenchmarkExecutionLock,
  verifyBenchmarkExecutionLock,
} from "./environment-lock";
import { runBenchmarkSuite } from "./runner";
import { ArtifactBenchmarkCaseSchema } from "./schemas";
import type { ArtifactBenchmarkCase } from "./types";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function benchmark(): ArtifactBenchmarkCase {
  return {
    id: "execution-lock",
    title: "Execution lock",
    category: "workflow",
    outcome: {
      objective: "Exercise the configured Environment.",
      acceptanceCriteria: ["The Environment is reproducible."],
      deliverables: [
        {
          artifactId: "review",
          kind: "report",
          description: "Environment review",
        },
      ],
    },
    passScore: 100,
    timeoutMs: 10_000,
    skills: [],
    execution: {
      profile: "clash-host",
      requiredCapabilities: ["workspace-export"],
      requiredProductOperations: ["asset.get"],
      preflight: {
        status: "ready",
        checks: [
          {
            capability: "workspace-export",
            status: "available",
            detail: "The capability is available.",
          },
        ],
      },
      evidence: { traceRequired: true, submissionRequired: true },
      productReadback: {
        required: true,
        mechanism: "project-asset-receipt",
        artifactIds: ["review"],
        description: "Read the Asset back from the Host.",
      },
      environment: {
        profile: "clash-workspace-v1",
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
    rubric: [
      {
        id: "review",
        type: "artifact-exists",
        artifactId: "review",
        weight: 1,
        required: true,
      },
    ],
  };
}

async function createReadyFixture(root: string) {
  const executable = join(root, "codex-fixture");
  const executableBytes = "#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n";
  const pluginRoot = join(root, "private-plugin-root");
  const skillRoot = join(root, "skills", "clash");
  await Promise.all([
    mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true }),
    mkdir(join(pluginRoot, "runtime"), { recursive: true }),
    mkdir(skillRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executable, executableBytes, "utf8"),
    writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "clash", version: "1.4.2" })}\n`,
      "utf8",
    ),
    writeFile(join(pluginRoot, "runtime", "index.js"), "runtime-v1\n", "utf8"),
    writeFile(join(skillRoot, "SKILL.md"), "# Clash skill\n", "utf8"),
  ]);
  await chmod(executable, 0o755);
  return { executable, executableBytes, pluginRoot, skillRoot };
}

describe("benchmark Environment execution lock", () => {
  it("parses the Agent Environment separately from its initial Workspace", () => {
    const candidate = benchmark() as unknown as Record<string, unknown>;
    const execution = candidate.execution as Record<string, unknown>;
    execution.environment = {
      profile: "clash-agent-environment-v1",
      track: "functional",
      initialState: {
        workspace: {
          format: "clash-workspace-v1",
          path: "environments/base-v1",
          bundleDigest: "a".repeat(64),
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
    };

    const parsed = ArtifactBenchmarkCaseSchema.parse(candidate);

    expect(parsed.execution?.environment).toMatchObject({
      profile: "clash-agent-environment-v1",
      initialState: {
        workspace: {
          format: "clash-workspace-v1",
          path: "environments/base-v1",
          bundleDigest: "a".repeat(64),
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('"inputWorkspace"');
  });

  it("normalizes the legacy Workspace-named Environment without publishing the alias", () => {
    const candidate = benchmark();
    candidate.execution!.environment!.inputWorkspace = {
      path: "environments/base-v1",
      bundleDigest: "a".repeat(64),
    };

    const parsed = ArtifactBenchmarkCaseSchema.parse(candidate);

    expect(parsed.execution?.environment).toMatchObject({
      profile: "clash-agent-environment-v1",
      initialState: {
        workspace: {
          format: "clash-workspace-v1",
          path: "environments/base-v1",
          bundleDigest: "a".repeat(64),
        },
      },
    });
    expect(parsed.execution?.environment?.inputWorkspace).toEqual({
      path: "environments/base-v1",
      bundleDigest: "a".repeat(64),
    });
    expect(JSON.stringify(parsed)).not.toContain('"inputWorkspace"');
  });

  it("rejects a ready Environment without an explicit Agent model", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: { adapter: "codex" },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/explicit Agent model/u);
  });

  it("rejects a model whose published identity differs from the value passed to the Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: " gpt-5.6-sol ",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/safe public identity/u);
  });

  it("rejects the ambiguous command adapter for a ready Environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: { adapter: "command", command: "/bin/echo" },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/command adapter.*provider/iu);
  });

  it("rejects native Agent arguments that can override the bound provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          args: ["--oss=true"],
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/override.*provider/iu);
  });

  it("requires Pi to declare its provider independently from its model", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: { adapter: "pi", model: "claude-sonnet-5" },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/explicit Pi provider/u);
  });

  it("rejects a provider-prefixed Pi model that disagrees with its provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "pi",
          command: fixture.executable,
          provider: "openai",
          model: "anthropic/claude-sonnet-5",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/Pi model.*provider/iu);
  });

  it("rejects adapter environment flags that switch Claude away from Anthropic", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "claude",
          command: fixture.executable,
          model: "claude-sonnet-5",
          env: { CLAUDE_CODE_USE_BEDROCK: "1" },
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/environment.*provider/iu);
  });

  it("writes a public lock for the exact Agent, Clash runtime, skills, and semantic requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const benchmarkCase = benchmark();
    benchmarkCase.skills = ["skills/clash"];
    benchmarkCase.execution!.forbiddenProductOperations = [
      "timeline.validate",
      "asset.list",
    ];
    benchmarkCase.execution!.environment!.requirements = {
      plugins: ["clash-asr"],
      models: ["whisper-local"],
      providers: ["local-runtime"],
    };

    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmarkCase,
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        env: { OPENAI_API_KEY: "sk-private-test-value" },
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      executionIntent: "execute",
    });

    expect(receipt.lock).toMatchObject({
      schemaVersion: 1,
      kind: "clash.benchmark.environment-lock",
      executionIntent: "execute",
      agent: {
        adapter: "codex",
        provider: { kind: "adapter-bound", id: "openai" },
        model: { kind: "explicit", id: "gpt-5.6-sol" },
        executable: {
          name: "codex-fixture",
          bytes: Buffer.byteLength(fixture.executableBytes),
          sha256: createHash("sha256")
            .update(fixture.executableBytes)
            .digest("hex"),
          reportedVersion: "1.2.3",
        },
      },
      clash: {
        id: "clash",
        version: "1.4.2",
        profile: "dev",
        runtime: {
          files: 1,
          bytes: 11,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
      skills: [
        {
          id: "clash",
          state: "locked",
          files: 1,
          bytes: 14,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      requirements: {
        capabilities: ["workspace-export"],
        productOperations: ["asset.get", "asset.list", "timeline.validate"],
        generatorDefinitions: [],
        plugins: ["clash", "clash-asr"],
        models: ["gpt-5.6-sol", "whisper-local"],
        providers: ["local-runtime", "openai"],
      },
    });
    const serialized = await readFile(receipt.lockFile, "utf8");
    expect(JSON.parse(serialized)).toEqual(receipt.lock);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("sk-private-test-value");
  });

  it("resolves the native runtime, isolation, phase policies, and canonical inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const benchmarkCase = benchmark();
    benchmarkCase.inputFixture = {
      path: "fixtures/input-v1",
      manifestSha256: "b".repeat(64),
    };
    benchmarkCase.execution!.environment!.inputWorkspace = {
      path: "environments/base-v1",
      bundleDigest: "a".repeat(64),
    };
    const taskBytes = '{"kind":"clash.benchmark.task","schemaVersion":1}\n';
    await writeFile(join(caseRoot, "task.json"), taskBytes, "utf8");

    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmarkCase,
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        inheritEnv: false,
        env: { OPENAI_API_KEY: "sk-private-test-value" },
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      executionIntent: "execute",
    });

    expect(receipt.lock.resolvedEnvironment).toMatchObject({
      schemaVersion: 1,
      profile: "clash-agent-environment-v1",
      track: "functional",
      executionIntent: "execute",
      initialState: {
        workspace: {
          state: "locked",
          format: "clash-workspace-v1",
          bundleDigest: "a".repeat(64),
          materialization: "fresh-directory-import",
        },
        fixture: {
          state: "locked",
          manifestSha256: "b".repeat(64),
        },
      },
      runtime: {
        kind: "native-local",
        platform: {
          os: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
        },
        isolation: {
          container: "none",
          workspace: "fresh-temporary-directory",
          clashHome: "fresh-per-case-directory",
        },
      },
      phases: {
        agent: {
          process: "native-child-process",
          productInterfaces: {
            clash: {
              policy: "auto",
              exposed: ["mcp", "cli"],
            },
          },
          network: {
            access: "enabled",
            enforcement: "codex-adapter",
          },
          credentials: {
            source: "explicit-only",
            filtering: "benchmark-identity-and-package-context",
          },
          filesystem: {
            workspace: "read-write",
            hostIsolation: "codex-workspace-write-sandbox",
          },
        },
      },
      participants: {
        runner: {
          id: "@clash/artifact-evals",
          version: "0.1.0",
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        agent: receipt.lock.agent,
      },
      evidenceInputs: {
        task: {
          state: "locked",
          sha256: createHash("sha256").update(taskBytes).digest("hex"),
        },
      },
      resolvedEnvironmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(receipt.lock.resolvedEnvironment)).not.toContain(
      root,
    );
    expect(JSON.stringify(receipt.lock.resolvedEnvironment)).not.toContain(
      "sk-private-test-value",
    );
  });

  it("locks the exact Clash product interface exposed to the Agent phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const fixture = await createReadyFixture(root);
    const resolved: Array<{
      transport: "mcp" | "cli";
      clash: {
        policy: "auto" | "mcp" | "cli";
        exposed: Array<"mcp" | "cli">;
      };
      digest: string;
    }> = [];

    for (const transport of ["mcp", "cli"] as const) {
      const caseRoot = join(root, transport);
      await mkdir(caseRoot);
      await writeFile(
        join(caseRoot, "task.json"),
        '{"kind":"clash.benchmark.task","schemaVersion":1}\n',
        "utf8",
      );
      const benchmarkCase = benchmark();
      benchmarkCase.execution!.transport = transport;
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmarkCase,
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      });
      resolved.push({
        transport,
        clash:
          receipt.lock.resolvedEnvironment.phases.agent.productInterfaces.clash,
        digest: receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest,
      });
    }

    expect(resolved).toEqual([
      {
        transport: "mcp",
        clash: { policy: "mcp", exposed: ["mcp"] },
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      {
        transport: "cli",
        clash: { policy: "cli", exposed: ["cli"] },
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    expect(resolved[0]?.digest).not.toBe(resolved[1]?.digest);
  });

  it("derives the same resolved Environment digest outside machine-specific paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const fixture = await createReadyFixture(root);
    const benchmarkCase = benchmark();
    benchmarkCase.execution!.environment!.inputWorkspace = {
      path: "environments/base-v1",
      bundleDigest: "a".repeat(64),
    };
    const digests: string[] = [];
    for (const name of ["case-a", "case-b"]) {
      const caseRoot = join(root, name);
      await mkdir(caseRoot);
      await writeFile(
        join(caseRoot, "task.json"),
        '{"kind":"clash.benchmark.task","schemaVersion":1}\n',
        "utf8",
      );
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmarkCase,
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      });
      digests.push(receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest);
    }

    expect(digests[0]).toBe(digests[1]);
  });

  it("keeps the Agent Environment identical across judges and records each judge in its own section", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const fixture = await createReadyFixture(root);
    const reviewerA = join(root, "reviewer-a");
    const reviewerB = join(root, "reviewer-b");
    await Promise.all([
      writeFile(reviewerA, "#!/bin/sh\nprintf 'codex-cli 2.0.1\\n'\n", "utf8"),
      writeFile(reviewerB, "#!/bin/sh\nprintf 'codex-cli 3.0.0\\n'\n", "utf8"),
    ]);
    await Promise.all([chmod(reviewerA, 0o755), chmod(reviewerB, 0o755)]);

    const gemini = {
      adapter: "gemini" as const,
      provider: "google" as const,
      model: "gemini-judge",
      apiKeyEnv: "CLASH_TEST_JUDGE_KEY",
      baseUrl: "https://relay.example",
      baseUrlEnv: "CLASH_TEST_JUDGE_BASE_URL",
    };
    const selections = [
      undefined,
      {
        adapter: "codex" as const,
        command: reviewerA,
        provider: "openai" as const,
        model: "gpt-5.6-sol",
      },
      {
        adapter: "codex" as const,
        command: reviewerB,
        provider: "openai" as const,
        model: "gpt-5.7-sol",
      },
      gemini,
      { ...gemini, model: "gemini-judge-next" },
      { ...gemini, baseUrl: "https://other-relay.example" },
      { ...gemini, apiKeyEnv: "CLASH_TEST_OTHER_JUDGE_KEY" },
    ];
    const captures: Array<{
      digest: string;
      agentEnvironment: string;
      judge: unknown;
    }> = [];
    for (const [index, qualityReviewer] of selections.entries()) {
      const caseRoot = join(root, `case-${index}`);
      await mkdir(caseRoot);
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        ...(qualityReviewer ? { qualityReviewer } : {}),
        executionIntent: "execute",
      });
      const written = JSON.parse(
        await readFile(receipt.lockFile, "utf8"),
      ) as Record<string, unknown>;
      captures.push({
        digest: receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest,
        agentEnvironment: JSON.stringify(agentEnvironmentLock(written)),
        judge: written.qualityJudge,
      });
    }

    for (const capture of captures) {
      expect(capture.digest).toBe(captures[0]!.digest);
      expect(capture.agentEnvironment).toBe(captures[0]!.agentEnvironment);
    }
    expect(captures[0]!.judge).toBeUndefined();
    const judges = captures.slice(1).map(({ judge }) => JSON.stringify(judge));
    expect(new Set(judges).size).toBe(judges.length);
    expect(captures[3]!.judge).toEqual({
      kind: "gemini",
      provider: gemini.provider,
      model: gemini.model,
      endpointHost: new URL(gemini.baseUrl).host,
      env: { apiKey: gemini.apiKeyEnv, baseUrl: gemini.baseUrlEnv },
    });
  });

  it("records the judge's variable names in the lock and never a value they hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const secret = "judge-key-value-that-must-stay-private";
    process.env.CLASH_TEST_JUDGE_KEY = secret;
    try {
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        qualityReviewer: {
          adapter: "gemini",
          provider: "google",
          model: "gemini-judge",
          apiKeyEnv: "CLASH_TEST_JUDGE_KEY",
          baseUrl: "https://relay.example/private/path",
        },
        executionIntent: "execute",
      });
      const bytes = await readFile(receipt.lockFile, "utf8");

      expect(bytes).toContain("CLASH_TEST_JUDGE_KEY");
      expect(bytes).not.toContain(secret);
      expect(bytes).not.toContain("private/path");
    } finally {
      delete process.env.CLASH_TEST_JUDGE_KEY;
    }
  });

  it("refuses a pasted key where the judge's key variable name belongs", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        qualityReviewer: {
          adapter: "gemini",
          provider: "google",
          model: "gemini-judge",
          apiKeyEnv: "AIzaSyPastedKeyInsteadOfAName",
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/environment variable name/u);
  });

  it("publishes only rollout phases and participants in the Agent Environment lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const reviewerExecutable = join(root, "codex-review-fixture");
    await writeFile(
      reviewerExecutable,
      "#!/bin/sh\nprintf 'codex-cli 2.0.1\\n'\n",
      "utf8",
    );
    await chmod(reviewerExecutable, 0o755);

    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      qualityReviewer: {
        adapter: "codex",
        command: reviewerExecutable,
        provider: "openai",
        model: "review-model-v2",
      },
      executionIntent: "execute",
    });

    expect(Object.keys(receipt.lock.resolvedEnvironment.phases)).toEqual([
      "agent",
    ]);
    expect(
      Object.keys(receipt.lock.resolvedEnvironment.participants).sort(),
    ).toEqual(["agent", "clash", "runner", "skills"]);
    expect(receipt.lock).not.toHaveProperty("qualityReviewer");
    expect(receipt.lock.requirements.models).toEqual(["gpt-5.6-sol"]);
    expect(receipt.lock.requirements.providers).toEqual(["openai"]);
  });

  it("changes the resolved Environment digest when canonical task or initial state changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const fixture = await createReadyFixture(root);
    const digests: string[] = [];
    for (const [index, digestByte] of ["a", "b"].entries()) {
      const caseRoot = join(root, `case-${index}`);
      await mkdir(caseRoot);
      await writeFile(
        join(caseRoot, "task.json"),
        `{"kind":"clash.benchmark.task","variant":${index}}\n`,
        "utf8",
      );
      const benchmarkCase = benchmark();
      benchmarkCase.inputFixture = {
        path: "fixtures/input-v1",
        manifestSha256: digestByte.repeat(64),
      };
      benchmarkCase.execution!.environment!.inputWorkspace = {
        path: "environments/base-v1",
        bundleDigest: digestByte.repeat(64),
      };
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmarkCase,
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      });
      digests.push(receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest);
    }

    expect(digests[0]).not.toBe(digests[1]);
  });

  it("invalidates the lock when the selected Agent executable bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      executionIntent: "execute",
    });

    await writeFile(
      fixture.executable,
      "#!/bin/sh\nprintf 'codex-cli 9.9.9\\n'\n",
      "utf8",
    );

    await expect(verifyBenchmarkExecutionLock(receipt)).rejects.toThrow(
      /Agent executable changed/u,
    );
  });

  it("rejects an Agent executable that changes while its version is queried", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    await writeFile(
      fixture.executable,
      "#!/bin/sh\nprintf '#!/bin/sh\\nprintf changed\\n' > \"$0\"\nprintf 'codex-cli 1.2.3\\n'\n",
      "utf8",
    );
    await chmod(fixture.executable, 0o755);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/changed while.*version/iu);
  });

  it("invalidates the lock when a Clash runtime byte changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      executionIntent: "execute",
    });

    await writeFile(
      join(fixture.pluginRoot, "runtime", "index.js"),
      "runtime-v2\n",
      "utf8",
    );

    await expect(verifyBenchmarkExecutionLock(receipt)).rejects.toThrow(
      /Clash plugin runtime changed/u,
    );
  });

  it("invalidates the lock when either installed copy of a skill changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    const workspace = join(root, "workspace");
    await Promise.all([mkdir(caseRoot), mkdir(workspace)]);
    const fixture = await createReadyFixture(root);
    const benchmarkCase = benchmark();
    benchmarkCase.skills = ["skills/clash"];
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmarkCase,
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      executionIntent: "execute",
    });
    await Promise.all(
      [".agents", ".claude"].map(async (rootName) => {
        const destination = join(workspace, rootName, "skills", "clash");
        await mkdir(join(workspace, rootName, "skills"), { recursive: true });
        await cp(fixture.skillRoot, destination, { recursive: true });
      }),
    );
    const installed = { workspace, installedSkillNames: ["clash"] };
    await expect(
      verifyBenchmarkExecutionLock(receipt, installed),
    ).resolves.toBeUndefined();

    await writeFile(
      join(workspace, ".agents", "skills", "clash", "SKILL.md"),
      "# Mutated skill\n",
      "utf8",
    );

    await expect(
      verifyBenchmarkExecutionLock(receipt, installed),
    ).rejects.toThrow(/installed skill 'clash' changed/iu);
  });

  it("rejects token-shaped model identities instead of publishing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "openai/sk_live_supersecretvalue",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/safe public identity/u);
  });

  it("rejects home-shaped relative model identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "users/minimax/private-model",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/safe public identity/u);
  });

  it("keeps a quality reviewer's executable binding outside the public Environment lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const reviewerExecutable = join(root, "codex-review-fixture");
    const reviewerBytes = "#!/bin/sh\nprintf 'codex-cli 2.0.1\\n'\n";
    await writeFile(reviewerExecutable, reviewerBytes, "utf8");
    await chmod(reviewerExecutable, 0o755);

    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      qualityReviewer: {
        adapter: "codex",
        command: reviewerExecutable,
        provider: "openai",
        model: "review-model-v2",
        inheritEnv: false,
        env: { OPENAI_API_KEY: "sk-private-reviewer-value" },
      },
      executionIntent: "execute",
    });

    expect(receipt.sources.qualityReviewerExecutable?.path).toMatch(
      /\/codex-review-fixture$/u,
    );
    expect(receipt.sources.qualityReviewerExecutable?.evidence).toEqual({
      bytes: Buffer.byteLength(reviewerBytes),
      sha256: createHash("sha256").update(reviewerBytes).digest("hex"),
    });
    expect(receipt.lock).not.toHaveProperty("qualityReviewer");
    expect(receipt.lock.qualityJudge).toEqual({
      kind: "codex",
      provider: "openai",
      model: "review-model-v2",
    });
    expect(JSON.stringify(receipt.lock)).not.toContain("codex-review-fixture");
    expect(JSON.stringify(receipt.lock)).not.toContain(
      "sk-private-reviewer-value",
    );
  });

  it("rejects a Codex quality reviewer that is not bound to OpenAI", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        qualityReviewer: {
          adapter: "codex",
          command: fixture.executable,
          provider: "anthropic" as "openai",
          model: "gpt-5.6-sol",
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/reviewer provider.*openai/iu);
  });

  it("rejects a Gemini quality reviewer that is not bound to Google", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    await expect(
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent: {
          adapter: "codex",
          command: fixture.executable,
          model: "gpt-5.6-sol",
          clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
        },
        qualityReviewer: {
          adapter: "gemini",
          provider: "openai" as "google",
          model: "gemini-judge",
        },
        executionIntent: "execute",
      }),
    ).rejects.toThrow(/reviewer provider.*google/iu);
  });

  it("binds no local executable for the HTTP Gemini quality reviewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);

    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      qualityReviewer: {
        adapter: "gemini",
        provider: "google",
        model: "gemini-judge",
      },
      executionIntent: "execute",
    });

    expect(receipt.sources).not.toHaveProperty("qualityReviewerExecutable");
    await expect(
      verifyBenchmarkExecutionLock(receipt),
    ).resolves.toBeUndefined();
  });

  it("rejects a mutated privately bound quality reviewer executable before review", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const caseRoot = join(root, "case");
    await mkdir(caseRoot);
    const fixture = await createReadyFixture(root);
    const reviewerExecutable = join(root, "codex-review-fixture");
    await writeFile(
      reviewerExecutable,
      "#!/bin/sh\nprintf 'codex-cli 2.0.1\\n'\n",
      "utf8",
    );
    await chmod(reviewerExecutable, 0o755);
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent: {
        adapter: "codex",
        command: fixture.executable,
        model: "gpt-5.6-sol",
        clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" },
      },
      qualityReviewer: {
        adapter: "codex",
        command: reviewerExecutable,
        provider: "openai",
        model: "gpt-5.6-sol",
      },
      executionIntent: "execute",
    });

    await writeFile(
      reviewerExecutable,
      "#!/bin/sh\nprintf 'codex-cli 2.0.2\\n'\n",
      "utf8",
    );

    await expect(verifyBenchmarkExecutionLock(receipt)).rejects.toThrow(
      /Quality reviewer executable changed/u,
    );
  });

  it("publishes a truthful non-executed lock for a blocked suite case", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const benchmarkCase = benchmark();
    benchmarkCase.execution = {
      ...benchmarkCase.execution!,
      lane: "blocked-contract",
      preflight: {
        status: "blocked",
        checks: [
          {
            capability: "workspace-export",
            status: "missing",
            detail: "The capability is deliberately unavailable.",
          },
        ],
      },
    };

    const result = await runBenchmarkSuite({
      suite: {
        schemaVersion: 1,
        id: "blocked-lock-suite",
        title: "Blocked lock suite",
        cases: [benchmarkCase],
      },
      suiteRoot: root,
      outputRoot: join(root, "output"),
      runId: "run-1",
      agent: { adapter: "codex" },
    });

    expect(result.status).toBe("blocked");
    const lock = JSON.parse(
      await readFile(
        join(
          root,
          "output",
          "run-1",
          benchmarkCase.id,
          "environment-lock.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(lock).toMatchObject({
      executionIntent: "blocked-no-run",
      agent: {
        adapter: "codex",
        provider: { kind: "adapter-bound", id: "openai" },
        model: { kind: "unselected" },
      },
    });
    const task = JSON.parse(
      await readFile(
        join(root, "output", "run-1", benchmarkCase.id, "task.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(task).toMatchObject({
      schemaVersion: 1,
      kind: "clash.benchmark.task",
      suiteId: "blocked-lock-suite",
      track: "functional",
      benchmark: { id: benchmarkCase.id },
    });
    const attempt = JSON.parse(
      await readFile(
        join(root, "output", "run-1", benchmarkCase.id, "attempt.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(attempt).toMatchObject({
      kind: "clash.benchmark.attempt",
      attempt: {
        suiteId: "blocked-lock-suite",
        runId: "run-1",
        caseId: benchmarkCase.id,
        attempt: 1,
        status: "not-run",
      },
      evidence: {
        workspaces: {
          input: { status: "not-admitted" },
          modified: { status: "blocked" },
        },
      },
    });
    const progress = JSON.parse(
      await readFile(
        join(root, "output", "run-1", "suite-progress.json"),
        "utf8",
      ),
    ) as { attempts: Array<Record<string, unknown>> };
    expect(progress.attempts.at(-1)).toMatchObject({
      event: "completed",
      attemptPath: `${benchmarkCase.id}/attempt.json`,
      attemptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      attemptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("makes --model mandatory at the CLI boundary for a ready Environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-environment-lock-"));
    roots.push(root);
    const benchmarkCase = benchmark();
    benchmarkCase.execution!.environment!.inputWorkspace = {
      path: "environments/base-v1",
      bundleDigest: "a".repeat(64),
    };
    const suitePath = join(root, "suite.json");
    await writeFile(
      suitePath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "ready-environment",
        title: "Ready Environment",
        cases: [benchmarkCase],
      })}\n`,
      "utf8",
    );

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "--suite",
          suitePath,
          "--out",
          join(root, "output"),
          "--agent",
          "codex",
        ],
        { cwd: new URL("..", import.meta.url) },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/--model.*ready Environment/iu),
    });
  });

  it("requires an explicit provider and model for the Codex quality reviewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-quality-lock-"));
    roots.push(root);
    const benchmarkCase = benchmark();
    benchmarkCase.tags = ["content-effect"];
    benchmarkCase.qualityCriteria = [
      {
        id: "visual-effect",
        description: "The result has a clear visual hierarchy.",
        weight: 1,
        evidenceArtifactIds: ["review"],
      },
    ];
    benchmarkCase.execution!.environment = {
      ...benchmarkCase.execution!.environment!,
      track: "content-effect",
      inputWorkspace: {
        path: "environments/base-v1",
        bundleDigest: "a".repeat(64),
      },
    };
    const suitePath = join(root, "suite.json");
    await writeFile(
      suitePath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "quality-environment",
        title: "Quality Environment",
        cases: [benchmarkCase],
      })}\n`,
      "utf8",
    );

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "--suite",
          suitePath,
          "--out",
          join(root, "output"),
          "--agent",
          "codex",
          "--model",
          "gpt-5.6-sol",
          "--quality-reviewer",
          "codex",
          "--quality-model",
          "gpt-5.6-sol",
        ],
        { cwd: new URL("..", import.meta.url) },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/--quality-provider.*openai/iu),
    });
  });
});
