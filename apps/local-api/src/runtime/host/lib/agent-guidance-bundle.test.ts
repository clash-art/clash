import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPackageRoot = fileURLToPath(
  new URL("../../../../../../packages/cli", import.meta.url),
);

let bundleRoot = "";
let bundledGuidance = "";
let isolatedPackage = "";

async function writeFakeClashPlugin(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, ".codex-plugin"), { recursive: true }),
    mkdir(join(root, "skills", "clash"), { recursive: true }),
    mkdir(join(root, "runtime", "agents"), { recursive: true }),
  ]);
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "clash",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    }),
  );
  await writeFile(
    join(root, ".mcp.json"),
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
  await writeFile(
    join(root, "skills", "clash", "SKILL.md"),
    [
      "---",
      "name: clash",
      "description: Test Clash product skill.",
      "---",
      "",
      "# Clash product skill",
      "",
      "clash timeline list --json",
      "clash timeline pull --timeline <id> --file timelines/<id>.timeline.yaml --json",
      "clash timeline apply --timeline <id> --file timelines/<id>.timeline.yaml --json",
      "data.timelineId",
    ].join("\n"),
  );
  await writeFile(
    join(root, "runtime", "index.js"),
    "process.stdin.resume();\n",
  );
  await writeFile(
    join(root, "runtime", "dispatcher.js"),
    "await import('./index.js');\n",
  );
  await writeFile(join(root, "runtime", "agents", "manifest.json"), "{}");
}

async function readMarkdownTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return readMarkdownTree(path);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      return [await readFile(path, "utf8")];
    }),
  );
  return contents.flat();
}

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "clash-agent-guidance-"));
  isolatedPackage = join(bundleRoot, "clash-cli");
  const pluginRoot = join(bundleRoot, "clash-plugin");
  await cp(join(cliPackageRoot, "assets"), join(isolatedPackage, "assets"), {
    recursive: true,
  });
  await cp(
    join(cliPackageRoot, "scripts", "bundle-agents.ts"),
    join(isolatedPackage, "scripts", "bundle-agents.ts"),
  );
  await writeFakeClashPlugin(pluginRoot);
  await execFileAsync(
    process.execPath,
    [join(isolatedPackage, "scripts", "bundle-agents.ts")],
    {
      env: {
        ...process.env,
        CLASH_BUILTIN_PLUGIN_ROOT: pluginRoot,
      },
    },
  );
  bundledGuidance = (
    await readMarkdownTree(join(isolatedPackage, "dist", "agents"))
  ).join("\n");
});

afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
});

it("bundles public Project Timeline guidance and rejects removed command spellings", () => {
  expect(bundledGuidance).toContain("clash timeline list --json");
  expect(bundledGuidance).toMatch(/clash timeline pull --timeline <[^>]+>/);
  expect(bundledGuidance).toMatch(/clash timeline apply --timeline <[^>]+>/);
  expect(bundledGuidance).toContain("timelines/<id>.timeline.yaml");
  expect(bundledGuidance).toContain("data.timelineId");

  expect(bundledGuidance).not.toMatch(
    /clash\s+canvas\s+timeline\s+(?:pull|push)\b/i,
  );
  expect(bundledGuidance).not.toMatch(
    /clash\s+timeline\s+(?:history|content|restore)\b/i,
  );
});

it("bundles one canonical Clash plugin skill and MCP runtime for built-in agents", async () => {
  const agentRoot = join(isolatedPackage, "dist", "agents", "clash");
  const [pluginSkill, pluginManifest, pluginMcp, runtime] = await Promise.all([
    readFile(
      join(agentRoot, "plugins", "clash", "skills", "clash", "SKILL.md"),
      "utf8",
    ),
    readFile(
      join(agentRoot, "plugins", "clash", ".codex-plugin", "plugin.json"),
      "utf8",
    ),
    readFile(join(agentRoot, "plugins", "clash", ".mcp.json"), "utf8"),
    readFile(join(agentRoot, "runtime.json"), "utf8"),
  ]);

  for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    await expect(
      access(join(agentRoot, "template", filename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(pluginSkill).toContain("# Clash product skill");
  await expect(
    access(
      join(agentRoot, "template", ".agents", "skills", "clash", "SKILL.md"),
    ),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    access(
      join(agentRoot, "template", ".claude", "skills", "clash", "SKILL.md"),
    ),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(pluginManifest).toContain('"name":"clash"');
  expect(pluginMcp).toContain('"./runtime/dispatcher.js"');
  expect(pluginMcp).toContain('"mcp"');
  expect(JSON.parse(runtime)).toMatchObject({
    agent_id: "codex-acp",
    plugins: ["clash"],
  });
  await expect(
    access(join(agentRoot, "plugins", "clash", "runtime", "agents")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
