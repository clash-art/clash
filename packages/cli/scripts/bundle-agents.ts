#!/usr/bin/env node
/**
 * Build the bundled agent tree:
 *
 *   dist/agents/
 *   ├── manifest.json                         ← list of all agent templates + meta
 *   ├── clash/
 *   │   ├── runtime.json                      ← local-host-only (which CLI to spawn)
 *   │   └── plugins/clash/                    ← Skill + peer stdio MCP runtime
 *   ├── canvas-editor/...
 *   ...
 *
 * The plugin is the single source for both Skill content and MCP runtime.
 * Session startup links its canonical Skill directory into the selected
 * harness's native project discovery directory. MCP remains a separate tool
 * transport and never acts as a Skill reader.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const ASSETS = join(root, "assets");
const DIST = join(root, "dist", "agents");
const REPO_ROOT = join(root, "..", "..");
const CLASH_PLUGIN_ROOT =
  process.env.CLASH_BUILTIN_PLUGIN_ROOT || join(REPO_ROOT, "plugins", "clash");

const LABELS: Record<string, { label: string; summary: string }> = {
  "clash": {
    label: "Clash",
    summary: "Operates the Clash project through its native Skill and bundled MCP tools.",
  },
};

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const ids = (await readdir(join(ASSETS, "agents"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const manifest = [];

  for (const id of ids) {
    const src = join(ASSETS, "agents", id);
    const dst = join(DIST, id);
    await mkdir(dst, { recursive: true });

    // Navigation lives in the packaged Skill and stdio MCP menu. Do not
    // inject harness instruction files into a project workspace.
    await cp(join(src, "runtime.json"), join(dst, "runtime.json"));
    const runtime = JSON.parse(await readFile(join(dst, "runtime.json"), "utf-8"));
    for (const pluginId of runtime.plugins ?? []) {
      if (pluginId !== "clash") {
        throw new Error(`unknown built-in agent plugin: ${pluginId}`);
      }
      const pluginDst = join(dst, "plugins", pluginId);
      const pluginRuntimeSrc = join(CLASH_PLUGIN_ROOT, "runtime");
      const nestedAgentsDir = join(pluginRuntimeSrc, "agents");
      await Promise.all([
        cp(join(CLASH_PLUGIN_ROOT, ".codex-plugin"), join(pluginDst, ".codex-plugin"), { recursive: true }),
        cp(join(CLASH_PLUGIN_ROOT, ".mcp.json"), join(pluginDst, ".mcp.json")),
        cp(join(CLASH_PLUGIN_ROOT, "skills"), join(pluginDst, "skills"), { recursive: true }),
        cp(pluginRuntimeSrc, join(pluginDst, "runtime"), {
          recursive: true,
          filter: (source) =>
            source !== nestedAgentsDir
            && !source.startsWith(`${nestedAgentsDir}${sep}`),
        }),
      ]);
    }
    const meta = LABELS[id] ?? { label: id, summary: "" };
    manifest.push({
      id,
      label: meta.label,
      summary: meta.summary,
      agent_id: runtime.agent_id,
    });
  }

  await writeFile(join(DIST, "manifest.json"), JSON.stringify({ agents: manifest }, null, 2));
  process.stdout.write(`bundled ${ids.length} agents → dist/agents/\n`);
}

main().catch((e) => {
  process.stderr.write(`bundle-agents failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
