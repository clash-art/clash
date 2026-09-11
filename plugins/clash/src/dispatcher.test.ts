import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isDirectExecution,
  normalizeClashArgv,
  resolveClashDistributionVersion,
  runClashEntrypoint,
  selectClashEntrypoint,
  shouldStartCliHost,
  type ClashEntrypoint,
} from "./dispatcher.js";

test("log queries work when the local Host is unavailable", () => {
  assert.equal(shouldStartCliHost(["node", "clash", "logs"]), false);
  assert.equal(shouldStartCliHost(["node", "clash", "--profile", "dev", "logs", "--json"]), false);
  assert.equal(shouldStartCliHost(["node", "clash", "--profile=dev", "logs"]), false);
  assert.equal(shouldStartCliHost(["node", "clash", "canvas", "list"]), true);
});

test("the dispatcher reads the public version from the distribution manifest", async () => {
  const packageJson = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ),
  ) as { version: string };
  assert.equal(resolveClashDistributionVersion(), packageJson.version);
});

test("the single clash executable reserves only the mcp subcommand for stdio", () => {
  assert.equal(selectClashEntrypoint(["node", "clash", "mcp"]), "mcp");
  assert.equal(
    selectClashEntrypoint(["node", "clash", "--profile", "dev", "mcp"]),
    "mcp",
  );
  assert.equal(
    selectClashEntrypoint(["node", "clash", "--profile=dev", "mcp"]),
    "mcp",
  );
  assert.equal(selectClashEntrypoint(["node", "clash", "projects"]), "cli");
  assert.equal(selectClashEntrypoint(["node", "clash"]), "cli");
  assert.equal(
    selectClashEntrypoint([
      "node",
      "clash",
      "--profile",
      "dev",
      "--",
      "mcp",
    ]),
    "mcp",
  );
});

test("npm-script separators are removed before the CLI parses arguments", () => {
  assert.deepEqual(
    normalizeClashArgv([
      "node",
      "clash",
      "--profile",
      "dev",
      "--",
      "--help",
    ]),
    ["node", "clash", "--profile", "dev", "--help"],
  );
  assert.deepEqual(
    normalizeClashArgv(["node", "clash", "canvas", "--", "--literal"]),
    ["node", "clash", "canvas", "--", "--literal"],
  );
});

test("the dispatcher loads exactly one peer runtime", async () => {
  const loaded: ClashEntrypoint[] = [];
  const loaders = {
    cli: async () => loaded.push("cli"),
    mcp: async () => loaded.push("mcp"),
  };

  await runClashEntrypoint(["node", "clash", "mcp"], loaders);
  assert.deepEqual(loaded, ["mcp"]);

  loaded.length = 0;
  await runClashEntrypoint(["node", "clash", "canvas", "list"], loaders);
  assert.deepEqual(loaded, ["cli"]);
});

test("the packaged MCP loader starts stdio instead of only importing its library", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./dispatcher.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /serveClashPluginStdio\(/);
  assert.match(source, /CLASH_SOURCE_RUNTIME/);
  assert.match(source, /createPluginHostManager/);
  assert.match(source, /packages\/cli\/src\/index\.ts/);
  assert.doesNotMatch(source, /packages\/cli\/src\/plugin\.ts/);
  assert.match(source, /sourceRuntime \? "\.\/index\.ts" : "\.\/index\.js"/);
});

test("direct execution detection works for the installed npm bin", () => {
  const cwd = "/opt/clash-package";
  const moduleUrl = "file:///opt/clash-package/runtime/dispatcher.js";
  assert.equal(
    isDirectExecution(moduleUrl, "runtime/dispatcher.js", cwd),
    true,
  );
  assert.equal(isDirectExecution(moduleUrl, "runtime/index.js", cwd), false);

  const runDir = mkdtempSync(join(tmpdir(), "clash-dispatcher-bin-"));
  const sourcePath = fileURLToPath(new URL("./dispatcher.ts", import.meta.url));
  const binPath = join(runDir, "clash");
  try {
    symlinkSync(sourcePath, binPath);
    assert.equal(
      isDirectExecution(pathToFileURL(sourcePath).href, binPath),
      true,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
