import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildAcpHeadlessLaunch } from "@openma/common/acp-harnesses/headless-launch";
import { resolveKnownAgent } from "@openma/common/acp-harnesses/registry";
import { describe, expect, it } from "vitest";

import { writeManagedAcpInstall } from "./acp-install.fixture";

import { createPiAgentAdapter, runBenchmarkSuite } from "./runner";
import type { ArtifactBenchmarkSuite } from "./types";

const execFileAsync = promisify(execFile);

const FIXTURE_AGENT = fileURLToPath(
  new URL("./acp-agent.fixture.ts", import.meta.url),
);
/** A real Pi 1.1.0 session recorded through `@openma/pi-acp` 0.1.7. */
const RECORDED_SESSION = fileURLToPath(
  new URL("./acp-pi-session.fixture.jsonl", import.meta.url),
);

function suite(timeoutMs = 20_000): ArtifactBenchmarkSuite {
  return {
    schemaVersion: 1,
    id: "pi-suite",
    title: "Pi suite",
    cases: [
      {
        id: "pi-portable",
        title: "Pi portable",
        category: "timeline",
        outcome: {
          objective: "Create a report through Pi.",
          acceptanceCriteria: ["The report exists."],
          deliverables: [
            { artifactId: "result", kind: "report", description: "Result" },
          ],
        },
        passScore: 100,
        timeoutMs,
        skills: ["skills/test-skill"],
        rubric: [
          {
            id: "result",
            type: "artifact-exists",
            artifactId: "result",
            weight: 1,
            required: true,
          },
        ],
      },
    ],
  };
}

/** A launcher that starts the scripted ACP agent in place of the Pi harness. */
async function fixture(): Promise<{
  root: string;
  suiteRoot: string;
  outputRoot: string;
  launcher: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clash-pi-adapter-"));
  const suiteRoot = join(root, "suite");
  const skillRoot = join(suiteRoot, "skills", "test-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: test-skill\ndescription: Test skill\n---\nUse this skill.\n",
    "utf8",
  );
  const launcher = join(root, "fake-pi-acp");
  await writeFile(
    launcher,
    `#!/bin/sh\nexec '${process.execPath}' '${FIXTURE_AGENT}' "$@"\n`,
    "utf8",
  );
  await chmod(launcher, 0o755);
  return { root, suiteRoot, outputRoot: join(root, "runs"), launcher };
}

describe("Pi headless adapter", () => {
  it("constructs a first-class Pi agent", () => {
    expect(
      createPiAgentAdapter({
        provider: "anthropic-proxy",
        model: "anthropic-proxy/claude-sonnet-5",
        skills: ["/tmp/remotion-best-practices"],
      }),
    ).toEqual({
      adapter: "pi",
      provider: "anthropic-proxy",
      model: "anthropic-proxy/claude-sonnet-5",
      skills: ["/tmp/remotion-best-practices"],
    });
  });

  it("advertises Pi as a supported CLI adapter", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--help"],
      { cwd: new URL("..", import.meta.url) },
    );

    expect(stdout).toContain("--agent codex|claude|pi|command");
    expect(stdout).toContain("--agent-skill <path>");
    expect(stdout).toContain("acp-install --agent pi --bin-dir <directory>");
  });

  it("refuses an ACP install without an agent or a target directory", async () => {
    const run = (args: string[]) =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "acp-install", ...args],
        { cwd: new URL("..", import.meta.url) },
      );

    await expect(run(["--bin-dir", "/tmp/acp"])).rejects.toMatchObject({
      stderr: expect.stringContaining("acp-install requires --agent pi"),
    });
    await expect(run(["--agent", "pi"])).rejects.toMatchObject({
      stderr: expect.stringContaining("acp-install requires --bin-dir"),
    });
  }, 30_000);

  it("drives Pi through ACP and records the session/update stream", async () => {
    const { root, suiteRoot, outputRoot, launcher } = await fixture();
    const externalSkillRoot = join(root, "remotion-best-practices");
    await mkdir(externalSkillRoot, { recursive: true });
    await writeFile(
      join(externalSkillRoot, "SKILL.md"),
      "---\nname: remotion-best-practices\ndescription: Remotion guidance\n---\nUse this skill.\n",
      "utf8",
    );
    process.env.ACP_FIXTURE_HOST_SECRET = "must-not-reach-the-agent";
    // The operator's home holds user-level Pi configuration the Attempt must
    // not see: an extension, a skill, settings and a context file.
    const userHome = join(root, "operator-home");
    for (const file of [
      ".pi/agent/extensions/marker.ts",
      ".pi/agent/skills/marker/SKILL.md",
      ".pi/agent/settings.json",
      ".pi/agent/AGENTS.md",
      ".agents/skills/marker/SKILL.md",
    ]) {
      await mkdir(dirname(join(userHome, file)), { recursive: true });
      await writeFile(join(userHome, file), "{}", "utf8");
    }
    let report;
    try {
      report = await runBenchmarkSuite({
        suite: suite(),
        suiteRoot,
        outputRoot,
        runId: "pi-run",
        agent: createPiAgentAdapter({
          command: launcher,
          provider: "test-provider",
          model: "test-model",
          skills: [externalSkillRoot],
          inheritEnv: false,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: userHome,
            XDG_CONFIG_HOME: join(userHome, ".config"),
            ACP_FIXTURE_REPLAY: RECORDED_SESSION,
          },
        }),
      });
    } finally {
      delete process.env.ACP_FIXTURE_HOST_SECRET;
    }

    expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
    expect(report.cases[0]?.agent).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    const workspace = report.cases[0]!.workspace;
    const caseRoot = dirname(workspace);
    const observation = JSON.parse(
      await readFile(join(workspace, "acp-observation.json"), "utf8"),
    ) as {
      argv: string[];
      cwd: string;
      mcpServers: unknown[];
      prompt: string;
      inheritedSecret: string | null;
      home: Record<string, string>;
      homeEntries: string[];
    };
    expect(observation.cwd).toMatch(/clash-benchmark-workspace-/u);
    // The agent process gets the isolated Attempt environment, not the runner's.
    expect(observation.inheritedSecret).toBeNull();
    expect(observation.prompt).toContain("Create a report through Pi.");
    expect(observation.prompt).toContain("`remotion-best-practices`");
    expect(observation.mcpServers).toEqual([]);
    // The launch is exactly what the registry recipe builds from the generic
    // options: this package spells no harness flag.
    const agentDir = observation.home.PI_CODING_AGENT_DIR!;
    const sessionDir = join(dirname(agentDir), "sessions");
    const recipe = buildAcpHeadlessLaunch(resolveKnownAgent("pi-acp")!, {
      agentDir,
      sessionDir,
      trustProject: true,
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "medium",
    });
    expect(observation.argv).toEqual(recipe.args);
    expect(observation.home).toMatchObject(recipe.env);

    // The agent runs in a home of its own, not the operator's.
    const home = observation.home.HOME!;
    expect(home).toBe(join(dirname(agentDir), "home"));
    expect(home.startsWith(userHome)).toBe(false);
    expect(observation.homeEntries).not.toContain(".pi");
    expect(Object.keys(observation.home).sort()).toEqual([
      "HOME",
      "PI_CODING_AGENT_DIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    for (const [name, value] of Object.entries(observation.home)) {
      expect(value.startsWith(dirname(agentDir)), name).toBe(true);
    }
    expect(sessionDir).not.toContain(observation.cwd);
    // The home, with Pi's session transcript, is removed with the Attempt.
    await expect(stat(dirname(agentDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const skill of ["test-skill", "remotion-best-practices"]) {
      await expect(
        readFile(join(workspace, ".agents", "skills", skill, "SKILL.md")),
      ).resolves.toBeDefined();
    }

    const recorded = (await readFile(RECORDED_SESSION, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = (
      await readFile(join(caseRoot, "logs", "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(report.cases[0]?.agent.stdoutPath).toBe(
      join(caseRoot, "logs", "events.jsonl"),
    );
    expect(events[0]).toMatchObject({
      type: "acp.session",
      sessionId: "fixture-session",
      protocolVersion: 1,
      harness: { id: resolveKnownAgent("pi-acp")!.id },
      agent: { name: "fixture-acp-agent" },
    });
    // Every update the agent sent is logged unmodified, in order.
    expect(events.filter(({ type }) => type === "acp.session_update")).toEqual(
      recorded.filter(({ type }) => type === "acp.session_update"),
    );
    expect(events.at(-1)).toEqual(recorded.at(-1));

    const trajectory = JSON.parse(
      await readFile(join(caseRoot, "logs", "trajectory.json"), "utf8"),
    ) as {
      sourceTraces: Array<{ kind: string }>;
      actions: Array<{ source: string; kind: string; status: string }>;
      usage: Record<string, number>;
    };
    expect(trajectory.sourceTraces).toContainEqual(
      expect.objectContaining({ kind: "acp-events" }),
    );
    expect(trajectory.actions.filter(({ source }) => source === "pi")).toEqual([
      expect.objectContaining({
        kind: "shell",
        operation: "echo hi > note.txt",
        status: "started",
      }),
      expect.objectContaining({
        kind: "shell",
        operation: "echo hi > note.txt",
        status: "succeeded",
      }),
    ]);
    const usage = (recorded.at(-1) as { usage: Record<string, number> }).usage;
    expect(trajectory.usage).toMatchObject({
      turnCount: 2,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedReadTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.thoughtTokens,
    });
  }, 30_000);

  it("lends the harness the runner's Node when the Agent PATH has none", async () => {
    const { root, suiteRoot, outputRoot, launcher } = await fixture();
    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin);
    const report = await runBenchmarkSuite({
      suite: suite(),
      suiteRoot,
      outputRoot,
      runId: "pi-run",
      agent: createPiAgentAdapter({
        command: launcher,
        provider: "test-provider",
        model: "test-model",
        inheritEnv: false,
        env: { PATH: emptyBin, ACP_FIXTURE_REPLAY: RECORDED_SESSION },
      }),
    });

    expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
    const observation = JSON.parse(
      await readFile(
        join(report.cases[0]!.workspace, "acp-observation.json"),
        "utf8",
      ),
    ) as { path: string };
    expect(observation.path.split(delimiter)).toEqual([
      emptyBin,
      dirname(process.execPath),
    ]);
  }, 30_000);

  it("reports a rejected ACP turn as a failed Agent run", async () => {
    const { suiteRoot, outputRoot, launcher } = await fixture();
    const report = await runBenchmarkSuite({
      suite: suite(),
      suiteRoot,
      outputRoot,
      runId: "pi-run",
      agent: createPiAgentAdapter({
        command: launcher,
        provider: "test-provider",
        model: "test-model",
        env: { ACP_FIXTURE_MODE: "prompt-error" },
      }),
    });

    expect(report.cases[0]?.agent).toMatchObject({
      status: "failed",
      error: "Fixture provider rejected the turn",
    });
    const caseRoot = dirname(report.cases[0]!.workspace);
    const trajectory = JSON.parse(
      await readFile(join(caseRoot, "logs", "trajectory.json"), "utf8"),
    ) as { turns: Array<{ status: string; error?: string }> };
    expect(trajectory.turns).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Fixture provider rejected the turn",
      }),
    ]);
  }, 30_000);

  it("stops an ACP turn that exceeds the case timeout", async () => {
    const { suiteRoot, outputRoot, launcher } = await fixture();
    const report = await runBenchmarkSuite({
      suite: suite(1_000),
      suiteRoot,
      outputRoot,
      runId: "pi-run",
      agent: createPiAgentAdapter({
        command: launcher,
        provider: "test-provider",
        model: "test-model",
        env: { ACP_FIXTURE_MODE: "hang" },
      }),
    });

    expect(report.cases[0]?.agent).toMatchObject({
      status: "timed-out",
      error: "Agent exceeded timeout of 1000ms",
    });
  }, 30_000);

  it("resolves the launcher from the managed ACP bin directory by its registry name", async () => {
    const { root, suiteRoot, outputRoot, launcher } = await fixture();
    const binDir = join(root, "acp-bin");
    await mkdir(binDir);
    await writeManagedAcpInstall({
      binDir,
      harnessId: "pi-acp",
      launcher: await readFile(launcher, "utf8"),
    });
    const report = await runBenchmarkSuite({
      suite: suite(),
      suiteRoot,
      outputRoot,
      runId: "pi-run",
      agent: createPiAgentAdapter({
        provider: "test-provider",
        model: "test-model",
        env: {
          CLASH_ACP_BIN_DIR: binDir,
          ACP_FIXTURE_REPLAY: RECORDED_SESSION,
        },
      }),
    });

    expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
  }, 30_000);

  it("fails the Agent run with an install hint when the harness is not installed", async () => {
    const { root, suiteRoot, outputRoot } = await fixture();
    const report = await runBenchmarkSuite({
      suite: suite(),
      suiteRoot,
      outputRoot,
      runId: "pi-run",
      agent: createPiAgentAdapter({
        provider: "test-provider",
        model: "test-model",
        env: { CLASH_ACP_BIN_DIR: join(root, "empty") },
      }),
    });

    expect(report.cases[0]?.agent.status).toBe("spawn-error");
    expect(report.cases[0]?.agent.error).toMatch(
      /ACP harness 'pi-acp' is not installed.*acp-install --agent pi/u,
    );
  }, 30_000);
});
