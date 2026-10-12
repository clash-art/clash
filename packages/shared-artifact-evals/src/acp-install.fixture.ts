import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  acpHarnessPinnedPackages,
  pinnedAcpHarnessPaths,
} from "@openma/common/acp-harnesses/installer";
import { resolveKnownAgent } from "@openma/common/acp-harnesses/registry";

/**
 * Lays out a benchmark ACP bin directory the way the OpenMA pinned installer
 * does: the pinned launcher, an npm prefix whose packages report the versions
 * the registry pins, and the install record. `launcher` is the script the
 * launcher ends up running. `versions` overrides what individual packages
 * report on disk; `recorded` overrides what the install record says.
 */
export async function writeManagedAcpInstall(input: {
  binDir: string;
  harnessId: string;
  launcher: string;
  versions?: Record<string, string>;
  recorded?: { version?: string; dependencies?: Record<string, string> } | null;
}): Promise<{ shim: string; pinned: Record<string, string> }> {
  const entry = resolveKnownAgent(input.harnessId)!;
  const pins = acpHarnessPinnedPackages(entry);
  const paths = pinnedAcpHarnessPaths(entry, input.binDir);
  const dependencies = Object.fromEntries(pins.dependencies);
  const pinned = { [pins.package.name]: pins.package.version, ...dependencies };
  const state = join(input.binDir, "registry", paths.stateId);
  const prefix = join(state, "install");
  for (const [name, version] of Object.entries(pinned)) {
    const directory = join(prefix, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, version: input.versions?.[name] ?? version }),
    );
  }
  const bin = join(prefix, "node_modules", ".bin", basename(pins.package.name));
  await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
  await writeFile(bin, input.launcher, "utf8");
  await chmod(bin, 0o755);
  await writeFile(
    paths.launcherPath,
    `#!/bin/sh\nset -eu\nexec '${bin}' "$@"\n`,
    "utf8",
  );
  await chmod(paths.launcherPath, 0o755);
  if (input.recorded !== null) {
    await writeFile(
      join(state, "install.json"),
      JSON.stringify({
        source: "registry",
        registryId: paths.stateId,
        shimName: paths.launcherName,
        version: pins.package.version,
        dependencies,
        installedAt: "2026-10-12T00:00:00.000Z",
        ...input.recorded,
      }),
    );
  }
  return { shim: paths.launcherPath, pinned };
}
