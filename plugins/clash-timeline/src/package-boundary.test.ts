import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const pluginRoot = join(import.meta.dirname, "..");
const repoRoot = join(pluginRoot, "..", "..");

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("ships as one installable Codex plugin package", () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));

  assert.equal(manifest.name, "clash-timeline");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.skills, "./skills/");
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
  assert.equal(manifest.interface.defaultPrompt.some((prompt: string) => /\bopen\b/i.test(prompt)), false);
  assert.deepEqual(mcp, {
    mcpServers: {
      "clash-timeline": {
        command: "node",
        args: ["./runtime/index.js"],
        cwd: ".",
        env: { CLASH_PROFILE: "prod" },
      },
    },
  });
  assert.equal(pkg.name, "@clash/timeline-plugin");
  assert.ok(pkg.files.includes("runtime"));
  assert.equal(pkg.dependencies?.["@clash/shared-runtime"], "workspace:*");
  assert.equal(pkg.dependencies?.["@clash/shared-types"], "workspace:*");
  assert.doesNotMatch(pkg.scripts?.build ?? "", /build-cli-runtime|clash-cli/);
  assert.equal(existsSync(join(pluginRoot, "runtime", "clash-cli.cjs")), false);
  assert.equal(existsSync(join(pluginRoot, "runtime", "loro_wasm_bg.wasm")), false);
});

test("ships agent guidance for discovering the complete annotated Timeline contract", () => {
  const skill = readFileSync(join(pluginRoot, "skills", "clash-timeline", "SKILL.md"), "utf8");

  assert.match(skill, /clash_timeline_schema/);
  assert.match(skill, /clash_timeline_validate/);
  assert.match(skill, /every root, track, common\s+item, and type-specific item field/);
  assert.match(skill, /operation catalog/);
  assert.match(skill, /stable semantic\s+rule IDs/);
  assert.match(skill, /maskPosition/);
  assert.match(skill, /maskSize/);
  assert.match(skill, /maskRotation/);
  assert.match(skill, /maskFeather/);
  assert.match(skill, /item-local/);
  assert.match(skill, /baseRevisionId/);
});

test("keeps plugin source inside the package and does not import Canvas MCP internals", () => {
  const source = filesUnder(join(pluginRoot, "src"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  assert.doesNotMatch(source, /packages\/mcp-server|canvas-app|clash_canvas_/);
  assert.doesNotMatch(source, /from\s+["']\.\.\/\.\.\//);
  assert.match(source, /@clash\/shared-types\/timeline-contract/);
  assert.match(source, /import type \{ ProjectHostCommand \} from ["']@clash\/shared-types["']/);
  const bundledServer = readFileSync(join(pluginRoot, "runtime", "server.js"), "utf8");
  assert.doesNotMatch(bundledServer, /loro-crdt|loro_wasm/);
});

test("Canvas App does not embed Timeline", () => {
  const canvasHtml = readFileSync(join(repoRoot, "packages", "mcp-server", "src", "canvas-app.ts"), "utf8");
  const canvasClient = readFileSync(join(repoRoot, "packages", "mcp-server", "src", "canvas-app-client.ts"), "utf8");

  assert.doesNotMatch(canvasHtml, /data-surface="timeline"|data-timeline-list/);
  assert.doesNotMatch(canvasClient, /clash_cli_timeline|refreshTimelines|renderTimelines/);
});

test("built runtime preserves structured host error codes", async () => {
  // Load the shipped artifact at runtime without borrowing its generated types
  // for the independent source quality check.
  const runtime = await import(new URL("../runtime/index.js", import.meta.url).href);
  assert.equal(typeof runtime.timelineToolErrorPayload, "function");

  assert.deepEqual(
    runtime.timelineToolErrorPayload(new Error(
      "STALE_READ: Timeline rough-cut changed after it was read",
    )),
    {
      code: "STALE_READ",
      message: "STALE_READ: Timeline rough-cut changed after it was read",
      retryTool: "clash_timeline_get",
    },
  );
});
