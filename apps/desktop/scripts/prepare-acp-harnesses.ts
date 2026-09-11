import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(scriptDir);

export const BUILTIN_ACP_WRAPPERS = ["codex-acp", "claude-agent-acp"];

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function packageRoot(packageName: string, packageRequire = require) {
  return dirname(packageRequire.resolve(`${packageName}/package.json`));
}

function packageBinPath(packageName: string, binName: string, packageRequire = require) {
  const root = packageRoot(packageName, packageRequire);
  const pkg = packageRequire(`${packageName}/package.json`);
  const bin = typeof pkg.bin === "string"
    ? pkg.bin
    : pkg.bin?.[binName] ?? (Object.keys(pkg.bin ?? {}).length === 1 ? Object.values(pkg.bin)[0] : undefined);
  if (!bin) throw new Error(`${packageName} does not expose bin ${binName}`);
  return join(root, bin);
}

function packageNodeModulesDir(packageName: string) {
  return dirname(dirname(packageRoot(packageName)));
}

export function renderNodeAcpWrapper({ packagedScriptPath, devScriptPath }: { packagedScriptPath: string; devScriptPath: string }) {
  return [
    "#!/bin/sh",
    "set -eu",
    "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "RESOURCES_DIR=$(CDPATH= cd -- \"$DIR/..\" && pwd)",
    `PACKAGED_SCRIPT="${packagedScriptPath}"`,
    "if [ -f \"$PACKAGED_SCRIPT\" ]; then",
    "  SCRIPT=\"$PACKAGED_SCRIPT\"",
    "else",
    `  SCRIPT=${shellQuote(devScriptPath)}`,
    "fi",
    "if [ -n \"${CLASH_NODE_EXEC_PATH:-}\" ]; then",
    "  export ELECTRON_RUN_AS_NODE=1",
    "  exec \"$CLASH_NODE_EXEC_PATH\" \"$SCRIPT\" \"$@\"",
    "fi",
    "if command -v node >/dev/null 2>&1; then",
    "  exec node \"$SCRIPT\" \"$@\"",
    "fi",
    "echo \"Unable to run agent harness: CLASH_NODE_EXEC_PATH is not set and node is not on PATH\" >&2",
    "exit 127",
    "",
  ].join("\n");
}

export function renderNodeAcpWindowsWrapper({ packagedScriptPath, devScriptPath }: { packagedScriptPath: string; devScriptPath: string }) {
  return [
    "@echo off",
    "setlocal",
    "set \"RESOURCES_DIR=%~dp0..\"",
    `set "PACKAGED_SCRIPT=${packagedScriptPath}"`,
    "if exist \"%PACKAGED_SCRIPT%\" (",
    "  set \"SCRIPT=%PACKAGED_SCRIPT%\"",
    ") else (",
    `  set "SCRIPT=${devScriptPath}"`,
    ")",
    "if defined CLASH_NODE_EXEC_PATH (",
    "  set \"ELECTRON_RUN_AS_NODE=1\"",
    "  \"%CLASH_NODE_EXEC_PATH%\" \"%SCRIPT%\" %*",
    "  exit /b %errorlevel%",
    ")",
    "where node >nul 2>nul",
    "if not errorlevel 1 (",
    "  node \"%SCRIPT%\" %*",
    "  exit /b %errorlevel%",
    ")",
    "echo Unable to run agent harness: CLASH_NODE_EXEC_PATH is not set and node is not on PATH 1>&2",
    "exit /b 127",
    "",
  ].join("\r\n");
}

export async function prepareAcpHarnesses({
  outputDir = join(desktopRoot, "build", "acp-bin"),
  platform = process.platform,
  logger = console.log,
} = {}) {
  const log = (message: string) => logger(`[prepare-acp-harnesses] ${message}`);
  const codexAgentScript = packageBinPath("@agentclientprotocol/codex-acp", "codex-acp");
  const codexAgentNodeModules = packageNodeModulesDir("@agentclientprotocol/codex-acp");
  const claudeAgentScript = packageBinPath("@agentclientprotocol/claude-agent-acp", "claude-agent-acp");
  const claudeAgentNodeModules = packageNodeModulesDir("@agentclientprotocol/claude-agent-acp");
  const resourceBuildDir = dirname(outputDir);
  const codexAgentBundleDir = join(resourceBuildDir, "acp-node", "codex-acp");
  const claudeAgentBundleDir = join(resourceBuildDir, "acp-node", "claude-agent-acp");

  log("resetting output directories");
  await rm(outputDir, { recursive: true, force: true });
  await rm(codexAgentBundleDir, { recursive: true, force: true });
  await rm(claudeAgentBundleDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(codexAgentBundleDir, { recursive: true });
  await mkdir(claudeAgentBundleDir, { recursive: true });
  log("copying codex-acp runtime");
  await cp(codexAgentNodeModules, join(codexAgentBundleDir, "node_modules"), {
    recursive: true,
    dereference: true,
    force: true,
  });
  log("copying claude-agent-acp runtime");
  await cp(claudeAgentNodeModules, join(claudeAgentBundleDir, "node_modules"), {
    recursive: true,
    dereference: true,
    force: true,
  });

  const isWindows = platform === "win32";
  const renderWrapper = isWindows ? renderNodeAcpWindowsWrapper : renderNodeAcpWrapper;
  const resourcesPrefix = isWindows ? "%RESOURCES_DIR%\\" : "$RESOURCES_DIR/";
  const separator = isWindows ? "\\" : "/";
  const codexWrapper = renderWrapper({
    packagedScriptPath: `${resourcesPrefix}acp-node${separator}codex-acp${separator}node_modules${separator}@agentclientprotocol${separator}codex-acp${separator}dist${separator}index.js`,
    devScriptPath: codexAgentScript,
  });
  const claudeAgentWrapper = renderWrapper({
    packagedScriptPath: `${resourcesPrefix}acp-node${separator}claude-agent-acp${separator}node_modules${separator}@agentclientprotocol${separator}claude-agent-acp${separator}dist${separator}index.js`,
    devScriptPath: claudeAgentScript,
  });

  const wrappers = [
    ["codex-acp", codexWrapper],
    ["claude-agent-acp", claudeAgentWrapper],
  ];
  log(`writing ${isWindows ? "Windows" : "POSIX"} launchers`);
  for (const [name, contents] of wrappers) {
    const file = join(outputDir, isWindows ? `${name}.cmd` : name);
    await writeFile(file, contents, "utf8");
    if (!isWindows) await chmod(file, 0o755);
  }
  log("done");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await prepareAcpHarnesses();
  } catch (error) {
    console.error(
      "[prepare-acp-harnesses] failed",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  }
}
