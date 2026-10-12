import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildAcpHeadlessLaunch } from "@openma/common/acp-harnesses/headless-launch";
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
  acpManagedBinDirs,
  installAcpHarness,
  isAcpAgent,
  resolveAcpHarness,
} from "./acp-harness";
import { writeManagedAcpInstall } from "./acp-install.fixture";

const entry = resolveKnownAgent("pi-acp")!;
const roots: string[] = [];

async function managedBinDir(
  versions?: Record<string, string>,
): Promise<{ binDir: string; pinned: Record<string, string> }> {
  const binDir = await mkdtemp(join(tmpdir(), "clash-acp-harness-"));
  roots.push(binDir);
  const { pinned } = await writeManagedAcpInstall({
    binDir,
    harnessId: entry.id,
    launcher: "#!/bin/sh\nexit 0\n",
    ...(versions ? { versions } : {}),
  });
  return { binDir, pinned };
}

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

  it("reads managed bin directories from the Local Host's variables", () => {
    expect(
      acpManagedBinDirs({
        CLASH_ACP_BIN_DIR: "/a:/b",
        OPENMA_ACP_BIN_DIR: "/b:/c",
      }),
    ).toEqual(["/a", "/b", "/c"]);
    expect(acpManagedBinDirs({})).toEqual([]);
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

  it("resolves a managed install and reports the pinned versions it verified", async () => {
    const { binDir, pinned } = await managedBinDir();

    const harness = await resolveAcpHarness(
      { adapter: "pi" },
      { CLASH_ACP_BIN_DIR: binDir },
    );

    expect(harness.command).toBe(join(binDir, basename(entry.spec.command)));
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

  it("refuses a managed install whose Pi SDK differs from the pinned version", async () => {
    const [dependency, version] = Object.entries(
      entry.pinned!.dependencies,
    )[0]!;
    const { binDir } = await managedBinDir({ [dependency]: "0.0.1" });

    await expect(
      resolveAcpHarness({ adapter: "pi" }, { CLASH_ACP_BIN_DIR: binDir }),
    ).rejects.toThrow(
      `does not match the pinned versions: ${dependency} is 0.0.1, pinned ${version}. Reinstall it with: clash-artifact-bench acp-install --agent pi`,
    );
  });

  it("names the searched directories when the harness is not installed", async () => {
    await expect(
      resolveAcpHarness({ adapter: "pi" }, { CLASH_ACP_BIN_DIR: "/missing" }),
    ).rejects.toThrow(/is not installed \(looked in \/missing\)/u);
    await expect(resolveAcpHarness({ adapter: "pi" }, {})).rejects.toThrow(
      /CLASH_ACP_BIN_DIR is not set/u,
    );
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

  it("installs the registry entry at its pinned versions", async () => {
    installer.installPinnedAcpHarness.mockResolvedValue({
      commandPath: "/opt/acp/shim",
      version: "9.9.9",
      dependencies: { sdk: "1.0.0" },
    });

    await expect(
      installAcpHarness({ adapter: "pi", binDir: "/opt/acp", env: { A: "1" } }),
    ).resolves.toEqual({
      id: entry.id,
      commandPath: "/opt/acp/shim",
      version: "9.9.9",
      dependencies: { sdk: "1.0.0" },
    });
    expect(installer.installPinnedAcpHarness).toHaveBeenCalledWith({
      entry,
      binDir: "/opt/acp",
      installRoot: "/opt/acp",
      env: { A: "1" },
    });
    await installAcpHarness({ adapter: "pi", binDir: "/opt/acp" });
    expect(installer.installPinnedAcpHarness).toHaveBeenLastCalledWith({
      entry,
      binDir: "/opt/acp",
      installRoot: "/opt/acp",
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
      detectEntry: async () => ({ spec: { command: "/bin/sh" } }),
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
      unpinned.resolveAcpHarness({ adapter: "pi" }, {}),
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
