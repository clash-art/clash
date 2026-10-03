import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  OVERLAY_AGENTS,
  _resetRegistryCache,
  detect,
  resolveAcpDetectOptions,
} from "./registry.js";

describe("ACP registry (OpenMA harness catalog)", () => {
  afterEach(() => {
    _resetRegistryCache();
  });

  it("uses OpenMA overlay for featured Codex and Claude entries", () => {
    expect(
      OVERLAY_AGENTS.some(
        (agent) => agent.id === "codex-acp" && agent.spec.command === "codex-acp",
      ),
    ).toBe(true);
    expect(
      OVERLAY_AGENTS.some(
        (agent) =>
          agent.id === "claude-acp" &&
          agent.spec.command === "claude-agent-acp",
      ),
    ).toBe(true);
    expect(OVERLAY_AGENTS.some((agent) => agent.id === "dsh-acp")).toBe(true);
  });

  it("maps Clash managed bin env into OpenMA detection options", () => {
    const options = resolveAcpDetectOptions({
      env: { CLASH_ACP_BIN_DIR: "/tmp/clash-acp-bin" },
    });
    expect(options.managedBinDirs).toEqual(["/tmp/clash-acp-bin"]);
    expect(options.env?.OPENMA_ACP_BIN_DIR).toBe("/tmp/clash-acp-bin");
  });

  it("detects a managed registry shim from the configured bin directory", async () => {
    const binDir = join(
      tmpdir(),
      `clash-acp-managed-${process.pid}-${Date.now()}`,
    );
    await mkdir(binDir, { recursive: true });
    const shim = join(binDir, "codex-acp");
    await writeFile(shim, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(shim, 0o755);

    const detected = await detect("codex-acp", {
      harnessBinDir: binDir,
      env: { PATH: "" },
    });
    expect(detected?.spec.command).toBe(shim);
    await access(shim, constants.X_OK);
  });
});
