import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  ensureAgentCwd,
  resolveAgentMcpServers,
  resolveBundledAgentsDir,
} from "./session-cwd";

async function expectDirectory(path: string): Promise<void> {
  expect((await stat(path)).isDirectory()).toBe(true);
}

it("links native harness filenames to one hosted AGENTS.md and preserves existing files", async () => {
  const previous = process.env.CLASH_HOME;
  process.env.CLASH_HOME = await mkdtemp(
    join(tmpdir(), "clash-native-instructions-"),
  );
  try {
    const cwd = await ensureAgentCwd("clash", "native-instructions", {
      harnessId: "claude-acp",
    });
    const instructions = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(await readlink(join(cwd, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe(instructions);
    expect(await readlink(join(cwd, "CODEBUDDY.md"))).toBe("AGENTS.md");
    expect(await readlink(join(cwd, "GEMINI.md"))).toBe("AGENTS.md");
    const customGemini =
      "# My project\nKeep the existing Gemini instructions.\n";
    await unlink(join(cwd, "GEMINI.md"));
    await writeFile(join(cwd, "GEMINI.md"), customGemini);
    await ensureAgentCwd("clash", "native-instructions", {
      harnessId: "gemini",
    });
    expect(await readFile(join(cwd, "GEMINI.md"), "utf8")).toBe(customGemini);
  } finally {
    if (previous === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = previous;
  }
});

it("prefers an explicit packaged agent bundle root", async () => {
  const bundleRoot = await mkdtemp(join(tmpdir(), "clash-packaged-agents-"));
  expect(
    resolveBundledAgentsDir({
      CLASH_AGENT_BUNDLE_ROOT: bundleRoot,
    }),
  ).toBe(bundleRoot);
});

it("ensureAgentCwd writes a v1 project marker for managed project cwd", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    const cwd = await ensureAgentCwd("clash", "proj_managed");
    const marker = await readFile(join(cwd, ".clash", "project.toml"), "utf-8");

    expect(marker).toContain("schema_version = 1");
    expect(marker).toContain('project_id = "proj_managed"');
    expect(marker).toMatch(/workspace_id = "managed:[a-f0-9]{16}"/);
    expect(marker).not.toContain('workspace_id = "managed:proj_managed"');
    expect(marker).toContain('store = "managed"');
    expect(marker).not.toContain("[sync]");
    expect(marker).not.toContain("mode =");
    await expectDirectory(join(cwd, "drafts"));
    await expectDirectory(join(cwd, "projections", "text"));
    await expectDirectory(join(cwd, "projections", "timelines"));
    await expectDirectory(join(cwd, "timelines"));
    await expectDirectory(join(cwd, "assets", "links"));
    await expectDirectory(join(cwd, "sessions"));
    await expectDirectory(join(cwd, "runtime"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("ensureAgentCwd keeps the canonical project id in the marker when the cwd path is sanitized", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    const projectId = "project/with spaces";
    const cwd = await ensureAgentCwd("clash", projectId);
    const marker = await readFile(join(cwd, ".clash", "project.toml"), "utf-8");

    expect(cwd).toBe(
      join(home, ".clash", "projects", "project%2Fwith%20spaces"),
    );
    expect(marker).toContain(`project_id = ${JSON.stringify(projectId)}`);
    expect(marker).toMatch(/workspace_id = "managed:[a-f0-9]{16}"/);
    expect(marker).not.toContain("managed:project%2Fwith%20spaces");
    expect(marker).not.toContain('project_id = "project_with_spaces"');
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("ensureAgentCwd keeps the managed workspace id stable for the same project cwd", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    const cwd = await ensureAgentCwd("clash", "proj_stable_workspace");
    const firstMarker = await readFile(
      join(cwd, ".clash", "project.toml"),
      "utf-8",
    );
    await ensureAgentCwd("clash", "proj_stable_workspace");
    const secondMarker = await readFile(
      join(cwd, ".clash", "project.toml"),
      "utf-8",
    );

    const firstWorkspaceId = /workspace_id = "(managed:[a-f0-9]{16})"/.exec(
      firstMarker,
    )?.[1];
    const secondWorkspaceId = /workspace_id = "(managed:[a-f0-9]{16})"/.exec(
      secondMarker,
    )?.[1];
    expect(firstWorkspaceId).toBeDefined();
    expect(secondWorkspaceId).toBe(firstWorkspaceId);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("ensureAgentCwd uses collision-resistant cwd paths for distinct project ids", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    const slashCwd = await ensureAgentCwd("clash", "project/one");
    const underscoreCwd = await ensureAgentCwd("clash", "project_one");

    expect(slashCwd).not.toBe(underscoreCwd);
    expect(slashCwd).toContain("project%2Fone");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("ensureAgentCwd rejects unknown agent templates instead of starting bare", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    await expect(
      ensureAgentCwd("missing-agent", "proj_missing"),
    ).rejects.toThrow(/unknown agent template/i);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("ensureAgentCwd honors CLASH_HOME for managed project cwd", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await mkdtemp(join(tmpdir(), "clash-session-cwd-home-"));
  process.env.CLASH_HOME = clashHome;
  try {
    const cwd = await ensureAgentCwd("clash", "proj_home_override");

    expect(cwd).toBe(join(clashHome, "projects", "proj_home_override"));
    await expectDirectory(join(cwd, "projections", "text"));
    await expectDirectory(join(cwd, ".clash"));
  } finally {
    if (originalClashHome === undefined) {
      delete process.env.CLASH_HOME;
    } else {
      process.env.CLASH_HOME = originalClashHome;
    }
  }
});

it("ensureAgentCwd seeds native project instructions once and links the canonical Clash skill", async () => {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-"));
  process.env.HOME = home;
  try {
    const cwd = await ensureAgentCwd("clash", "proj_setup_guidance", {
      harnessId: "codex-acp",
    });
    const bundledSkillDir = join(
      fileURLToPath(
        new URL("../../../../../../plugins/clash/", import.meta.url),
      ),
      "skills",
      "clash",
    );
    const clashSkill = await readFile(
      join(bundledSkillDir, "SKILL.md"),
      "utf-8",
    );

    const instructionsPath = join(cwd, "AGENTS.md");
    const instructions = await readFile(instructionsPath, "utf8");
    expect(instructions.trim()).not.toBe("");
    const originalStat = await stat(instructionsPath);
    await ensureAgentCwd("clash", "proj_setup_guidance", {
      harnessId: "codex-acp",
    });
    expect((await stat(instructionsPath)).mtimeMs).toBe(originalStat.mtimeMs);
    const userInstructions = instructions + "\nPrefer Chinese subtitles.\n";
    await writeFile(instructionsPath, userInstructions);
    await ensureAgentCwd("clash", "proj_setup_guidance", {
      harnessId: "codex-acp",
    });
    expect(await readFile(instructionsPath, "utf8")).toBe(userInstructions);
    for (const filename of ["CLAUDE.md", "CODEBUDDY.md", "GEMINI.md"]) {
      expect(await readlink(join(cwd, filename))).toBe("AGENTS.md");
      expect(await readFile(join(cwd, filename), "utf8")).toBe(
        userInstructions,
      );
    }
    expect(clashSkill).toBe(
      await readFile(join(bundledSkillDir, "SKILL.md"), "utf8"),
    );
    const codexSkill = join(cwd, ".agents", "skills", "clash");
    expect((await lstat(codexSkill)).isSymbolicLink()).toBe(true);
    expect(await readlink(codexSkill)).toBe(bundledSkillDir);
    expect(await readFile(join(codexSkill, "SKILL.md"), "utf8")).toBe(clashSkill);
    for (const [, reference] of clashSkill.matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(await readFile(join(codexSkill, reference!), "utf8")).toBe(
        await readFile(join(bundledSkillDir, reference!), "utf8"),
      );
    }

    const nativePaths = [
      ["claude-acp", ".claude/skills"],
      ["gemini", ".agents/skills"],
      ["qwen-code", ".qwen/skills"],
      ["cursor", ".agents/skills"],
      ["kilo", ".kilocode/skills"],
      ["goose", ".goose/skills"],
    ] as const;
    for (const [harnessId, projectSkillDirectory] of nativePaths) {
      const harnessCwd = await ensureAgentCwd(
        "clash",
        `proj_setup_guidance_${harnessId}`,
        { harnessId },
      );
      const skill = join(harnessCwd, projectSkillDirectory, "clash");
      expect((await lstat(skill)).isSymbolicLink()).toBe(true);
      expect(await readlink(skill)).toBe(bundledSkillDir);
    }

    await expect(
      stat(join(home, ".codex", "skills", "clash")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(home, ".claude", "skills", "clash")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

it("uses the host plugin root for agent skills without requiring a process-global override", async () => {
  const originalHome = process.env.HOME;
  const originalAgentRoot = process.env.CLASH_AGENT_BUNDLE_ROOT;
  const originalPluginRoot = process.env.CLASH_BUILTIN_PLUGIN_ROOT;
  const home = await mkdtemp(join(tmpdir(), "clash-session-cwd-source-"));
  const agentRoot = await mkdtemp(join(tmpdir(), "clash-source-agents-"));
  const pluginRoot = await mkdtemp(join(tmpdir(), "clash-source-plugin-"));
  await mkdir(join(agentRoot, "clash"), { recursive: true });
  await writeFile(
    join(agentRoot, "clash", "runtime.json"),
    JSON.stringify({ agent_id: "codex-acp", plugins: ["clash"] }),
  );
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "clash"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "clash", skills: "./skills" }),
  );
  await writeFile(
    join(pluginRoot, "skills", "clash", "SKILL.md"),
    "source skill\n",
  );
  process.env.HOME = home;
  process.env.CLASH_AGENT_BUNDLE_ROOT = agentRoot;
  delete process.env.CLASH_BUILTIN_PLUGIN_ROOT;
  try {
    const cwd = await ensureAgentCwd(
      "clash",
      "proj_source_skill",
      { harnessId: "codex-acp" },
      { CLASH_BUILTIN_PLUGIN_ROOT: pluginRoot },
    );
    const installed = join(cwd, ".agents", "skills", "clash");
    expect(await readlink(installed)).toBe(join(pluginRoot, "skills", "clash"));
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toBe(
      "source skill\n",
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentRoot === undefined)
      delete process.env.CLASH_AGENT_BUNDLE_ROOT;
    else process.env.CLASH_AGENT_BUNDLE_ROOT = originalAgentRoot;
    if (originalPluginRoot === undefined)
      delete process.env.CLASH_BUILTIN_PLUGIN_ROOT;
    else process.env.CLASH_BUILTIN_PLUGIN_ROOT = originalPluginRoot;
  }
});

it("ensureAgentCwd does not guess a Skill directory or overwrite a user's workspace entry", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await mkdtemp(
    join(tmpdir(), "clash-session-cwd-skill-conflict-"),
  );
  process.env.CLASH_HOME = clashHome;
  try {
    const withoutSkill = await ensureAgentCwd(
      "clash",
      "proj_without_native_skill",
    );
    await expect(
      stat(join(withoutSkill, ".agents", "skills", "clash")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const projectId = "proj_existing_native_skill";
    const existingSkill = join(
      clashHome,
      "projects",
      projectId,
      ".agents",
      "skills",
      "clash",
    );
    await mkdir(existingSkill, { recursive: true });
    await writeFile(join(existingSkill, "SKILL.md"), "user-owned\n", "utf8");

    await ensureAgentCwd("clash", projectId, { harnessId: "codex-acp" });
    await expect(
      readFile(join(existingSkill, "SKILL.md"), "utf8"),
    ).resolves.toBe("user-owned\n");
  } finally {
    if (originalClashHome === undefined) {
      delete process.env.CLASH_HOME;
    } else {
      process.env.CLASH_HOME = originalClashHome;
    }
  }
});

it("resolves the source Clash plugin as an ACP stdio MCP descriptor in development", async () => {
  const electron = "/Applications/Clash.app/Contents/MacOS/Clash";
  const [server] = await resolveAgentMcpServers("clash", {
    CLASH_NODE_EXEC_PATH: electron,
    CLASH_PROJECT_ID: "project-mcp",
    CLASH_HOME: "/Users/me/.clash",
    CLASH_WORKSPACE_ROOT: "/Users/me/.clash/projects/project-mcp",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  });

  expect(server).toMatchObject({
    name: "clash",
    command: electron,
    args: [
      expect.stringMatching(/plugins\/clash\/runtime\/dispatcher\.js$/),
      "mcp",
    ],
    _meta: {
      "io.modelcontextprotocol/ui": {
        host: "clash",
        mimeTypes: ["text/html;profile=mcp-app"],
      },
      "clash.plugin": "builtin",
      "clash.renderer": "product",
    },
  });
  if (!("env" in server)) throw new Error("expected stdio MCP descriptor");
  expect(server.env).toEqual(
    expect.arrayContaining([
      { name: "CLASH_PROJECT_ID", value: "project-mcp" },
      { name: "CLASH_HOME", value: "/Users/me/.clash" },
      {
        name: "CLASH_WORKSPACE_ROOT",
        value: "/Users/me/.clash/projects/project-mcp",
      },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ]),
  );
  const entry = "args" in server ? server.args[0] : undefined;
  expect(entry).toBeDefined();
  expect((await stat(entry!)).isFile()).toBe(true);
});

it("injects the host-owned Clash MCP when the agent runtime does not declare plugins", async () => {
  const originalAgentRoot = process.env.CLASH_AGENT_BUNDLE_ROOT;
  const originalPluginRoot = process.env.CLASH_BUILTIN_PLUGIN_ROOT;
  const agentRoot = await mkdtemp(join(tmpdir(), "clash-agent-root-"));
  const pluginRoot = await mkdtemp(join(tmpdir(), "clash-plugin-root-"));
  await mkdir(join(agentRoot, "clash"), { recursive: true });
  await writeFile(
    join(agentRoot, "clash", "runtime.json"),
    JSON.stringify({ agent_id: "codex-acp" }),
  );
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "runtime"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "clash", mcpServers: "./.mcp.json" }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        clash: {
          command: "node",
          args: ["./runtime/dispatcher.js", "mcp"],
          cwd: ".",
        },
      },
    }),
  );
  await writeFile(join(pluginRoot, "runtime", "dispatcher.js"), "");
  process.env.CLASH_AGENT_BUNDLE_ROOT = agentRoot;
  process.env.CLASH_BUILTIN_PLUGIN_ROOT = pluginRoot;

  try {
    const [server] = await resolveAgentMcpServers("clash", {
      CLASH_PROJECT_ID: "project-host-root",
    });

    expect(server).toMatchObject({
      name: "clash",
      args: [join(pluginRoot, "runtime", "dispatcher.js"), "mcp"],
    });
  } finally {
    if (originalAgentRoot === undefined) {
      delete process.env.CLASH_AGENT_BUNDLE_ROOT;
    } else {
      process.env.CLASH_AGENT_BUNDLE_ROOT = originalAgentRoot;
    }
    if (originalPluginRoot === undefined) {
      delete process.env.CLASH_BUILTIN_PLUGIN_ROOT;
    } else {
      process.env.CLASH_BUILTIN_PLUGIN_ROOT = originalPluginRoot;
    }
  }
});
