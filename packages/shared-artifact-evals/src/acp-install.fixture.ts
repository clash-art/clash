import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { npmPackageNameFromSpec } from "@openma/common/acp-harnesses/installer";
import { resolveKnownAgent } from "@openma/common/acp-harnesses/registry";

/**
 * Lays out a managed ACP bin directory the way the OpenMA installer does: a
 * shell shim that execs the package bin inside an npm prefix whose packages
 * report the versions the registry pins. `launcher` is the script the shim
 * ends up running; `versions` overrides what individual packages report.
 */
export async function writeManagedAcpInstall(input: {
  binDir: string;
  harnessId: string;
  launcher: string;
  versions?: Record<string, string>;
}): Promise<{ shim: string; pinned: Record<string, string> }> {
  const entry = resolveKnownAgent(input.harnessId);
  if (!entry?.pinned) throw new Error(`${input.harnessId} pins nothing`);
  const packageName = npmPackageNameFromSpec(entry.pinned.package);
  const pinned = {
    [packageName]: entry.pinned.package.slice(packageName.length + 1),
    ...entry.pinned.dependencies,
  };
  const prefix = join(input.binDir, "registry", input.harnessId, "install");
  for (const [name, version] of Object.entries(pinned)) {
    const directory = join(prefix, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, version: input.versions?.[name] ?? version }),
    );
  }
  const bin = join(prefix, "node_modules", ".bin", basename(packageName));
  await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
  await writeFile(bin, input.launcher, "utf8");
  await chmod(bin, 0o755);
  const shim = join(input.binDir, basename(entry.spec.command));
  await writeFile(shim, `#!/bin/sh\nset -eu\nexec '${bin}' "$@"\n`, "utf8");
  await chmod(shim, 0o755);
  return { shim, pinned };
}
