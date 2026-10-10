import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BenchmarkObservedRuntime,
  BenchmarkRuntimeClaim,
} from "./backend-types";
import {
  captureBenchmarkExecutionLock,
  verifyBenchmarkExecutionLock,
} from "./environment-lock";
import { resolveBenchmarkSubject, subjectIdentity } from "./subject";
import type { ArtifactBenchmarkCase } from "./types";

const roots: string[] = [];

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

const container: BenchmarkRuntimeClaim = {
  kind: "container",
  engine: { name: "docker", version: "27.1.0" },
  image: { id: `sha256:${"d".repeat(64)}` },
  network: "engine-default",
};
const cloud: BenchmarkRuntimeClaim = {
  kind: "claude-cloud",
  pool: { kind: "anthropic-managed" },
};

const observed =
  (containerMarker: boolean): (() => BenchmarkObservedRuntime) =>
  () => ({
    platform: { os: "linux", arch: "x64", nodeVersion: "v24.0.0" },
    containerMarker,
  });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "clash-lock-backends-"));
  roots.push(root);
  const caseRoot = join(root, "case");
  await mkdir(caseRoot);
  const fixture = await createReadyFixture(root);
  const agent = {
    adapter: "codex" as const,
    command: fixture.executable,
    model: "gpt-5.6-sol",
    inheritEnv: false,
    env: { OPENAI_API_KEY: "sk-private-test-value" },
    clashHost: { pluginRoot: fixture.pluginRoot, profile: "dev" as const },
  };
  return { root, caseRoot, fixture, agent };
}

describe("Environment lock runtime and subject", () => {
  it("keeps the native-local record exactly as it was before backends existed", async () => {
    const { root, caseRoot, agent } = await setup();
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent,
      executionIntent: "execute",
    });
    const runtime = receipt.lock.resolvedEnvironment.runtime;
    expect(runtime.kind).toBe("native-local");
    expect(Object.keys(runtime).sort()).toEqual([
      "isolation",
      "kind",
      "platform",
    ]);
    expect(receipt.lock.clash?.subject).toBeUndefined();
  });

  it("records a container only when the worker observed one", async () => {
    const { root, caseRoot, agent } = await setup();
    const capture = (marker: boolean) =>
      captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent,
        executionIntent: "execute",
        runtime: container,
        observeRuntime: observed(marker),
      });
    await expect(capture(false)).rejects.toThrow(
      /observed no container marker/u,
    );
    const receipt = await capture(true);
    expect(receipt.lock.resolvedEnvironment.runtime).toMatchObject({
      kind: "container",
      platform: { os: "linux", arch: "x64" },
      isolation: {
        level: "container",
        network: "engine-default",
        hostAccess: "read-only-inputs-and-attempt-directory",
      },
      backend: container,
      attestation: "dispatcher-asserted-worker-observed",
      observed: { containerMarker: true },
    });
  });

  it("labels a cloud session as declared, not verified, whatever the worker saw", async () => {
    const { root, caseRoot, agent } = await setup();
    for (const marker of [false, true]) {
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent,
        executionIntent: "execute",
        runtime: cloud,
        observeRuntime: observed(marker),
      });
      expect(receipt.lock.resolvedEnvironment.runtime).toMatchObject({
        kind: "claude-cloud",
        isolation: {
          level: "provider-managed-vm",
          network: "environment-policy",
        },
        attestation: "dispatcher-declared",
        observed: { containerMarker: marker },
      });
    }
  });

  it("does not require a container marker for a case that never runs", async () => {
    const { root, caseRoot, agent } = await setup();
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent,
      executionIntent: "blocked-no-run",
      runtime: container,
      observeRuntime: observed(false),
    });
    expect(receipt.lock.resolvedEnvironment.runtime).toMatchObject({
      isolation: {
        workspace: "not-materialized",
        clashHome: "not-materialized",
      },
    });
  });

  it("makes the backend part of the resolved Environment identity", async () => {
    const { root, caseRoot, agent } = await setup();
    const digest = async (runtime?: BenchmarkRuntimeClaim) =>
      (
        await captureBenchmarkExecutionLock({
          caseRoot,
          suiteRoot: root,
          benchmark: benchmark(),
          agent,
          executionIntent: "execute",
          ...(runtime ? { runtime } : {}),
          observeRuntime: observed(true),
        })
      ).lock.resolvedEnvironment.resolvedEnvironmentDigest;
    const digests = await Promise.all([
      digest(),
      digest(container),
      digest(cloud),
    ]);
    expect(new Set(digests).size).toBe(3);
  });

  it("locks the selected subject and ties it to the runtime tree it measured", async () => {
    const { root, caseRoot, agent, fixture } = await setup();
    const subject = await resolveBenchmarkSubject({
      kind: "release",
      artifact: { kind: "installed-directory", path: fixture.pluginRoot },
      workRoot: join(root, "work"),
      expectedVersion: "1.4.2",
    });
    const receipt = await captureBenchmarkExecutionLock({
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent,
      executionIntent: "execute",
      subject,
    });
    expect(receipt.lock.clash?.subject).toEqual(subject.record);
    expect(receipt.lock.clash?.subject?.runtimeSha256).toBe(
      receipt.lock.clash?.runtime.sha256,
    );
    expect(
      receipt.lock.resolvedEnvironment.participants.clash?.subject,
    ).toEqual(subject.record);
    // The record is public: no host path and no credential.
    const serialized = await readFile(receipt.lockFile, "utf8");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("sk-private-test-value");
    await expect(
      verifyBenchmarkExecutionLock(receipt),
    ).resolves.toBeUndefined();
  });

  it("changes the Environment identity when the subject changes", async () => {
    const { root, caseRoot, agent, fixture } = await setup();
    const lock = async () => {
      const subject = await resolveBenchmarkSubject({
        kind: "release",
        artifact: { kind: "installed-directory", path: fixture.pluginRoot },
        workRoot: join(root, "work"),
      });
      const receipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: root,
        benchmark: benchmark(),
        agent,
        executionIntent: "execute",
        subject,
      });
      return { receipt, subject };
    };
    const first = await lock();
    await writeFile(
      join(fixture.pluginRoot, "runtime", "index.js"),
      "runtime-v2\n",
    );
    const second = await lock();
    expect(subjectIdentity(second.subject.record)).not.toBe(
      subjectIdentity(first.subject.record),
    );
    expect(
      second.receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest,
    ).not.toBe(
      first.receipt.lock.resolvedEnvironment.resolvedEnvironmentDigest,
    );
  });

  it("refuses a subject record that does not describe the plugin the Agent will run", async () => {
    const { root, caseRoot, agent, fixture } = await setup();
    const subject = await resolveBenchmarkSubject({
      kind: "release",
      artifact: { kind: "installed-directory", path: fixture.pluginRoot },
      workRoot: join(root, "work"),
    });
    const base = {
      caseRoot,
      suiteRoot: root,
      benchmark: benchmark(),
      agent,
      executionIntent: "execute" as const,
    };
    await expect(
      captureBenchmarkExecutionLock({
        ...base,
        subject: {
          ...subject,
          record: { ...subject.record, runtimeSha256: "0".repeat(64) },
        },
      }),
    ).rejects.toThrow(/does not match the Clash plugin runtime on disk/u);
    await expect(
      captureBenchmarkExecutionLock({
        ...base,
        subject: {
          ...subject,
          record: { ...subject.record, version: "9.9.9" },
        },
      }),
    ).rejects.toThrow(/does not match the Clash plugin runtime on disk/u);

    const other = await mkdtemp(join(tmpdir(), "clash-other-plugin-"));
    roots.push(other);
    await mkdir(join(other, ".codex-plugin"), { recursive: true });
    await writeFile(join(other, ".codex-plugin", "plugin.json"), "{}");
    await expect(
      captureBenchmarkExecutionLock({
        ...base,
        subject: { ...subject, pluginRoot: other },
      }),
    ).rejects.toThrow(/not the Clash plugin the Agent will run/u);
  });
});
