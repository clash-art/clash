import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyClashAcpShims } from "./acp-legacy-shim-migration.js";

describe("migrateLegacyClashAcpShims", () => {
  it("renames a legacy clash shim to the current catalog command basename", async () => {
    const binDir = join("/tmp", `acp-migrate-${Date.now()}`);
    await mkdir(binDir, { recursive: true });
    const registryId = "codex-acp";
    const legacyName = `clash-acp-${registryId}`;
    const legacyPath = join(binDir, legacyName);
    const commandPath = join(binDir, "registry", registryId, "npx", "bin.js");
    await mkdir(join(binDir, "registry", registryId, "npx"), {
      recursive: true,
    });
    await writeFile(commandPath, "#!/usr/bin/env node\n", "utf8");
    await chmod(commandPath, 0o755);
    await writeFile(
      legacyPath,
      `#!/bin/sh\nexec '${commandPath.replace(/'/g, "'\\''")}' "$@"\n`,
      "utf8",
    );
    await chmod(legacyPath, 0o755);
    await writeFile(
      join(binDir, "registry", registryId, "install.json"),
      JSON.stringify({
        source: "registry",
        registryId,
        shimName: legacyName,
        version: "1.0.0",
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const result = await migrateLegacyClashAcpShims({
      binDir,
      reinstallHarness: async () => {
        throw new Error("should not reinstall");
      },
    });

    expect(result.adopted).toContain("codex-acp");
    expect(result.needsAttention).toEqual([]);
  });
});
