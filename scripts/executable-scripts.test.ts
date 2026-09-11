import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native Node imports packaging helpers and CLI runner without executing their entrypoints", async () => {
  const paths = [
    "apps/desktop/scripts/prepare-clash-cli.ts",
    "apps/desktop/scripts/prepare-acp-harnesses.ts",
    "packages/cli/scripts/run-tests.ts",
  ];
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "-e",
    `
    const modules = await Promise.all(${JSON.stringify(paths.map((p) => pathToFileURL(join(repo, p)).href))}.map(p => import(p)));
    console.log(JSON.stringify(modules.map(m => Object.values(m).some(value => typeof value === 'function'))));
  `,
  ]);
  assert.deepEqual(
    JSON.parse(stdout),
    paths.map(() => true),
  );
});

test("native agent bundler stages declared plugin artifacts without recursively embedding agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-agent-bundle-"));
  try {
    const cli = join(root, "packages", "cli");
    const plugin = join(root, "plugins", "clash");
    await Promise.all([
      mkdir(join(cli, "scripts"), { recursive: true }),
      mkdir(join(cli, "assets", "agents", "clash"), { recursive: true }),
      mkdir(join(plugin, ".codex-plugin"), { recursive: true }),
      mkdir(join(plugin, "skills", "fixture"), { recursive: true }),
      mkdir(join(plugin, "runtime", "agents", "nested"), { recursive: true }),
    ]);
    const runtime = { agent_id: "fixture-agent", plugins: ["clash"] };
    const mcp = {
      mcpServers: { fixture: { command: "node", args: ["runtime/server.js"] } },
    };
    await Promise.all([
      cp(
        join(repo, "packages/cli/scripts/bundle-agents.ts"),
        join(cli, "scripts/bundle-agents.ts"),
      ),
      cp(
        join(repo, "packages/cli/scripts/package.json"),
        join(cli, "scripts/package.json"),
      ),
      writeFile(
        join(cli, "assets/agents/clash/runtime.json"),
        JSON.stringify(runtime),
      ),
      writeFile(
        join(plugin, ".codex-plugin/plugin.json"),
        JSON.stringify({ name: "fixture-plugin" }),
      ),
      writeFile(join(plugin, ".mcp.json"), JSON.stringify(mcp)),
      writeFile(
        join(plugin, "skills/fixture/SKILL.md"),
        "Fixture instructions",
      ),
      writeFile(
        join(plugin, "runtime/server.js"),
        "export const fixture = true;",
      ),
      writeFile(
        join(plugin, "runtime/agents/nested/marker"),
        "must not recurse",
      ),
    ]);
    await execute(process.execPath, [join(cli, "scripts/bundle-agents.ts")], {
      cwd: tmpdir(),
      env: { ...process.env, CLASH_BUILTIN_PLUGIN_ROOT: plugin },
    });
    const target = join(cli, "dist/agents/clash/plugins/clash");
    assert.deepEqual(
      JSON.parse(await readFile(join(target, ".mcp.json"), "utf8")),
      mcp,
    );
    assert.equal(
      await readFile(join(target, "runtime/server.js"), "utf8"),
      await readFile(join(plugin, "runtime/server.js"), "utf8"),
    );
    assert.equal(
      await readFile(join(target, "skills/fixture/SKILL.md"), "utf8"),
      "Fixture instructions",
    );
    await assert.rejects(
      readFile(join(target, "runtime/agents/nested/marker")),
      { code: "ENOENT" },
    );
    const manifest = JSON.parse(
      await readFile(join(cli, "dist/agents/manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.agents.map((entry: { agent_id: string }) => entry.agent_id),
      [runtime.agent_id],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
