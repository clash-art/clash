import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ACP_WRAPPERS,
  renderNodeAcpWindowsWrapper,
  renderNodeAcpWrapper,
} from "./prepare-acp-harnesses.ts";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(desktopRoot));

describe("prepare ACP harness wrappers", () => {
  it("prepares only the built-in harness wrapper names", () => {
    expect(BUILTIN_ACP_WRAPPERS).toEqual(["codex-acp", "claude-agent-acp"]);
  });

  it("runs Codex ACP from a Resources-owned Node bundle", () => {
    const script = renderNodeAcpWrapper({
      packagedScriptPath: "$RESOURCES_DIR/acp-node/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
      devScriptPath: "/repo/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    });

    expect(script).toContain("acp-node/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
    expect(script).not.toContain("app.asar");
    expect(script).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain("exec \"$CLASH_NODE_EXEC_PATH\" \"$SCRIPT\" \"$@\"");
  });

  it("keeps harness preparation out of the self-hosted desktop package build", async () => {
    const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
    const cliPackageJson = JSON.parse(
      await readFile(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    );

    expect(packageJson.scripts["prepare:pack"]).not.toContain("pnpm prepare:harnesses");
    expect(packageJson.devDependencies["@agentclientprotocol/codex-acp"]).toBe("^1.1.7");
    expect(packageJson.devDependencies["@zed-industries/codex-acp"]).toBeUndefined();
    expect(packageJson.devDependencies["@agentclientprotocol/claude-agent-acp"]).toBeTruthy();
    expect(cliPackageJson.dependencies["@zed-industries/codex-acp"]).toBeUndefined();
  });

  it("runs node-based ACP packages from a Resources-owned bundle in packaged apps", () => {
    const script = renderNodeAcpWrapper({
      packagedScriptPath: "$RESOURCES_DIR/acp-node/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      devScriptPath: "/repo/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    });

    expect(script).toContain("acp-node/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    expect(script).not.toContain("app.asar/node_modules/@agentclientprotocol/claude-agent-acp");
    expect(script).toContain("PACKAGED_SCRIPT=");
    expect(script).toContain("if [ -f \"$PACKAGED_SCRIPT\" ]; then");
    expect(script).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain("exec \"$CLASH_NODE_EXEC_PATH\" \"$SCRIPT\" \"$@\"");
  });

  it("renders Windows command wrappers for packaged ACP agents", () => {
    const script = renderNodeAcpWindowsWrapper({
      packagedScriptPath: String.raw`%RESOURCES_DIR%\acp-node\codex-acp\node_modules\@agentclientprotocol\codex-acp\dist\index.js`,
      devScriptPath: String.raw`D:\repo\node_modules\@agentclientprotocol\codex-acp\dist\index.js`,
    });

    expect(script).toContain("set \"RESOURCES_DIR=%~dp0..\"");
    expect(script).toContain("set \"ELECTRON_RUN_AS_NODE=1\"");
    expect(script).toContain("\"%CLASH_NODE_EXEC_PATH%\" \"%SCRIPT%\" %*");
    expect(script).toContain("node \"%SCRIPT%\" %*");
    expect(script).toContain("acp-node\\codex-acp\\node_modules");
  });
});
