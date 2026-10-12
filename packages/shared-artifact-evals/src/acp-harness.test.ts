import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildAcpHeadlessLaunch } from "@openma/common/acp-harnesses/headless-launch";
import { pinnedAcpHarnessPaths } from "@openma/common/acp-harnesses/installer";
import { resolveKnownAgent } from "@openma/common/acp-harnesses/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installer = vi.hoisted(() => ({
  installPinnedAcpHarness: vi.fn(),
}));

vi.mock("@openma/common/acp-harnesses/installer", async (original) => ({
  ...(await original<object>()),
  installPinnedAcpHarness: installer.installPinnedAcpHarness,
}));
// Installation refreshes the public registry first; tests stay offline.
vi.mock("@openma/common/acp-harnesses/registry", async (original) => ({
  ...(await original<object>()),
  loadRegistry: vi.fn(async () => []),
}));

import {
  acpAgentDirectoryVariables,
  acpHeadlessLaunch,
  BENCHMARK_ACP_BIN_DIR_VARIABLE,
  installAcpHarness,
  isAcpAgent,
  resolveAcpHarness,
} from "./acp-harness";
import { writeManagedAcpInstall } from "./acp-install.fixture";

const entry = resolveKnownAgent("pi-acp")!;
const [firstDependency, firstDependencyPin] = Object.entries(
  entry.pinned!.dependencies,
)[0]!;
const roots: string[] = [];

async function emptyBinDir(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "clash-acp-harness-"));
  roots.push(binDir);
  return binDir;
}

async function managedBinDir(
  layout: Partial<
    Pick<Parameters<typeof writeManagedAcpInstall>[0], "versions" | "recorded">
  > = {},
): Promise<{ binDir: string; pinned: Record<string, string> }> {
  const binDir = await emptyBinDir();
  const { pinned } = await writeManagedAcpInstall({
    binDir,
    harnessId: entry.id,
    launcher: "#!/bin/sh\nexit 0\n",
    ...layout,
  });
  return { binDir, pinned };
}

const inBinDir = (binDir: string) => ({
  [BENCHMARK_ACP_BIN_DIR_VARIABLE]: binDir,
});

const resolveIn = (binDir: string) =>
  resolveAcpHarness({ adapter: "pi" }, inBinDir(binDir));

describe("ACP harness resolution", () => {
  beforeEach(() => installer.installPinnedAcpHarness.mockReset());
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("treats Pi as the ACP-driven adapter", () => {
    expect(isAcpAgent({ adapter: "pi" })).toBe(true);
    expect(isAcpAgent({ adapter: "codex" })).toBe(false);
    expect(isAcpAgent({ command: "/bin/true" })).toBe(false);
  });

  it("reads only the benchmark's own bin directory variable, never a product's", async () => {
    const { binDir } = await managedBinDir();

    expect(BENCHMARK_ACP_BIN_DIR_VARIABLE).not.toMatch(
      /^(?:CLASH|OPENMA)_ACP_BIN_DIR$/u,
    );
    // The variables the Local Host exports for its managed harnesses are ignored.
    await expect(
      resolveAcpHarness(
        { adapter: "pi" },
        { CLASH_ACP_BIN_DIR: binDir, OPENMA_ACP_BIN_DIR: binDir },
      ),
    ).rejects.toThrow(
      `is not installed: ${BENCHMARK_ACP_BIN_DIR_VARIABLE} must name the benchmark's own harness directory`,
    );
    await expect(resolveIn("relative/dir")).rejects.toThrow(
      /an absolute path/u,
    );
  });

  it("refuses a directory that holds a product harness install", async () => {
    const { binDir } = await managedBinDir();
    // A product install keeps its launcher under the registry's own shim name.
    await writeFile(join(binDir, basename(entry.spec.command)), "#!/bin/sh\n");

    const refusal = `holds a product ${entry.label} harness install`;
    await expect(resolveIn(binDir)).rejects.toThrow(refusal);
    await expect(installAcpHarness({ adapter: "pi", binDir })).rejects.toThrow(
      refusal,
    );
    expect(installer.installPinnedAcpHarness).not.toHaveBeenCalled();
  });

  it("takes an absolute explicit launcher as given, without verified versions", async () => {
    await expect(
      resolveAcpHarness({ adapter: "pi", command: "pi-acp" }, {}),
    ).rejects.toThrow(/must be an absolute path/u);
    await expect(
      resolveAcpHarness({ adapter: "pi", command: "/opt/pi-acp" }, {}),
    ).resolves.toEqual({
      id: entry.id,
      label: entry.label,
      command: "/opt/pi-acp",
    });
  });

  it("resolves the pinned launcher and reports the versions the installer recorded", async () => {
    const { binDir, pinned } = await managedBinDir();

    const harness = await resolveIn(binDir);

    // The pinned launcher, not the product's shim name.
    expect(harness.command).toBe(
      pinnedAcpHarnessPaths(entry, binDir).launcherPath,
    );
    expect(basename(harness.command)).not.toBe(basename(entry.spec.command));
    const { package: adapter, dependencies } = harness.versions!;
    expect(
      Object.fromEntries(
        [adapter, ...dependencies].map(({ name, version }) => [name, version]),
      ),
    ).toEqual(pinned);
    expect(dependencies.map(({ name }) => name)).toEqual(
      Object.keys(entry.pinned!.dependencies).sort(),
    );
  });

  it("refuses an install whose Pi SDK on disk differs from the pinned version", async () => {
    const { binDir } = await managedBinDir({
      versions: { [firstDependency]: "0.0.1" },
    });

    await expect(resolveIn(binDir)).rejects.toThrow(
      `does not match the pinned versions: ${firstDependency} is 0.0.1, pinned ${firstDependencyPin}. Reinstall it with: clash-artifact-bench acp-install --agent pi`,
    );
  });

  it("refuses an install whose record of what was installed differs from the pins", async () => {
    const adapterSpec = entry.pinned!.package;
    const adapterName = adapterSpec.slice(0, adapterSpec.lastIndexOf("@"));
    const adapterPin = adapterSpec.slice(adapterSpec.lastIndexOf("@") + 1);

    const drifted = await managedBinDir({
      recorded: { dependencies: { [firstDependency]: "0.0.2" } },
    });
    const error = await resolveIn(drifted.binDir).catch(
      (caught: Error) => caught.message,
    );
    expect(error).toContain(
      `install record says ${firstDependency} 0.0.2, pinned ${firstDependencyPin}`,
    );
    // That record names one dependency only, so every other one is missing.
    expect(error).toContain("not installed, pinned");

    const wrongAdapter = await managedBinDir({
      recorded: { version: "0.0.3" },
    });
    await expect(resolveIn(wrongAdapter.binDir)).rejects.toThrow(
      `install record says ${adapterName} 0.0.3, pinned ${adapterPin}`,
    );

    const unversioned = await managedBinDir({
      recorded: { version: undefined, dependencies: undefined },
    });
    await expect(resolveIn(unversioned.binDir)).rejects.toThrow(
      `install record says ${adapterName} unknown, pinned ${adapterPin}`,
    );
  });

  it("treats a directory without the pinned launcher or its install record as not installed", async () => {
    const empty = await emptyBinDir();
    const unrecorded = await managedBinDir({ recorded: null });

    for (const binDir of [empty, unrecorded.binDir]) {
      await expect(resolveIn(binDir)).rejects.toThrow(
        `is not installed in ${binDir}. Install it with: clash-artifact-bench acp-install --agent pi`,
      );
    }
  });

  it("builds the launch from the registry recipe and generic options only", () => {
    const directories = { agentDir: "/trial/agent", sessionDir: "/trial/s" };

    // Pass-through: whatever the registry recipe yields for these options.
    expect(
      acpHeadlessLaunch(
        { adapter: "pi", provider: "deepseek", model: "v4", args: ["--x"] },
        directories,
      ),
    ).toEqual(
      (({ args, env }) => ({ args: [...args, "--x"], env }))(
        buildAcpHeadlessLaunch(entry, {
          ...directories,
          trustProject: true,
          provider: "deepseek",
          model: "v4",
          thinkingLevel: "medium",
        }),
      ),
    );
    expect(acpHeadlessLaunch({ adapter: "pi" }, directories)).toEqual(
      (({ args, env }) => ({ args, env }))(
        buildAcpHeadlessLaunch(entry, { ...directories, trustProject: true }),
      ),
    );
    expect(acpAgentDirectoryVariables({ adapter: "pi" })).toEqual(
      Object.keys(buildAcpHeadlessLaunch(entry, { agentDir: "" }).env).sort(),
    );
  });

  it("refuses a provider that has no model to travel with", () => {
    // The recipe reports it as unsupported; launching would silently lose it.
    expect(() =>
      acpHeadlessLaunch(
        { adapter: "pi", provider: "deepseek" },
        { agentDir: "/a", sessionDir: "/s" },
      ),
    ).toThrow(`${entry.label} headless launch recipe cannot express: provider`);
  });

  it("installs the registry entry at its pinned versions into the benchmark directory", async () => {
    const binDir = await emptyBinDir();
    installer.installPinnedAcpHarness.mockResolvedValue({
      commandPath: join(binDir, "launcher"),
      version: "9.9.9",
      dependencies: { sdk: "1.0.0" },
    });

    await expect(
      installAcpHarness({ adapter: "pi", binDir, env: { A: "1" } }),
    ).resolves.toEqual({
      id: entry.id,
      commandPath: join(binDir, "launcher"),
      version: "9.9.9",
      dependencies: { sdk: "1.0.0" },
    });
    expect(installer.installPinnedAcpHarness).toHaveBeenCalledWith({
      entry,
      binDir,
      installRoot: binDir,
      env: { A: "1" },
    });
    await installAcpHarness({ adapter: "pi", binDir });
    expect(installer.installPinnedAcpHarness).toHaveBeenLastCalledWith({
      entry,
      binDir,
      installRoot: binDir,
    });
    await expect(
      installAcpHarness({ adapter: "pi", binDir: "relative" }),
    ).rejects.toThrow(/must be an absolute path/u);
  });
});

describe("ACP harness registry gaps", () => {
  afterEach(() => {
    vi.doUnmock("@openma/common/acp-harnesses/registry");
    vi.doUnmock("@openma/common/acp-harnesses/headless-launch");
    vi.resetModules();
  });

  async function withRegistry(
    resolved: unknown,
    unsupported: string[] = [],
  ): Promise<typeof import("./acp-harness")> {
    vi.resetModules();
    vi.doMock("@openma/common/acp-harnesses/registry", () => ({
      resolveKnownAgent: () => resolved,
      loadRegistry: async () => [],
    }));
    vi.doMock("@openma/common/acp-harnesses/headless-launch", () => ({
      buildAcpHeadlessLaunch: () => ({ args: [], env: {}, unsupported }),
    }));
    return import("./acp-harness");
  }

  it("fails when the registry has no entry, pins nothing, or cannot express an option", async () => {
    const missing = await withRegistry(null);
    await expect(
      missing.resolveAcpHarness({ adapter: "pi" }, {}),
    ).rejects.toThrow("The ACP harness registry has no 'pi-acp' entry");

    const unpinned = await withRegistry({
      id: "pi-acp",
      label: "Pi",
      spec: { command: "x" },
    });
    await expect(
      unpinned.resolveAcpHarness(
        { adapter: "pi" },
        { CLASH_BENCH_ACP_BIN_DIR: "/nonexistent/bench-acp" },
      ),
    ).rejects.toThrow("pins no versions for 'pi-acp'");

    const partial = await withRegistry(
      { id: "pi-acp", label: "Pi", spec: { command: "x" } },
      ["agentDir"],
    );
    // An ignored agent directory would load the operator's own configuration.
    expect(() =>
      partial.acpHeadlessLaunch(
        { adapter: "pi" },
        { agentDir: "/a", sessionDir: "/s" },
      ),
    ).toThrow("Pi headless launch recipe cannot express: agentDir");
  });
});
