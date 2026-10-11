import { basename } from "node:path";

import { resolveKnownAgent } from "@openma/common/acp-harnesses/registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const installer = vi.hoisted(() => ({
  installAcpRegistryAgent: vi.fn(),
}));

vi.mock("@openma/common/acp-harnesses/installer", async (original) => ({
  ...(await original<object>()),
  installAcpRegistryAgent: installer.installAcpRegistryAgent,
}));
// Installation refreshes the public registry first; tests stay offline.
vi.mock("@openma/common/acp-harnesses/registry", async (original) => ({
  ...(await original<object>()),
  loadRegistry: vi.fn(async () => []),
}));

import {
  acpLaunchArgs,
  acpManagedBinDirs,
  installAcpHarness,
  isAcpAgent,
  resolveAcpHarness,
} from "./acp-harness";

const entry = resolveKnownAgent("pi-acp")!;

describe("ACP harness resolution", () => {
  beforeEach(() => installer.installAcpRegistryAgent.mockReset());

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

  it("accepts only an absolute explicit launcher and keeps the registry's arguments", async () => {
    await expect(
      resolveAcpHarness({ adapter: "pi", command: "pi-acp" }, {}),
    ).rejects.toThrow(/must be an absolute path/u);
    await expect(
      resolveAcpHarness({ adapter: "pi", command: "/opt/pi-acp" }, {}),
    ).resolves.toMatchObject({
      id: entry.id,
      command: "/opt/pi-acp",
      args: entry.spec.args ?? [],
    });
  });

  it("names the searched directories when the harness is not installed", async () => {
    await expect(
      resolveAcpHarness({ adapter: "pi" }, { CLASH_ACP_BIN_DIR: "/missing" }),
    ).rejects.toThrow(
      new RegExp(`${basename(entry.spec.command)} in /missing`, "u"),
    );
    await expect(resolveAcpHarness({ adapter: "pi" }, {})).rejects.toThrow(
      /CLASH_ACP_BIN_DIR is not set/u,
    );
  });

  it("selects the provider-qualified model and never passes the model twice", () => {
    const harness = { id: "h", label: "H", command: "/h", args: [], env: {} };
    const args = (agent: Parameters<typeof acpLaunchArgs>[0]) =>
      acpLaunchArgs(agent, harness, { sessionDir: "/scratch" });
    const modelOf = (values: string[]) => values[values.indexOf("--model") + 1];

    expect(
      modelOf(args({ adapter: "pi", provider: "deepseek", model: "v4" })),
    ).toBe("deepseek/v4:medium");
    expect(
      modelOf(
        args({ adapter: "pi", provider: "deepseek", model: "deepseek/v4" }),
      ),
    ).toBe("deepseek/v4:medium");
    expect(args({ adapter: "pi" })).not.toContain("--model");
    expect(args({ adapter: "pi", args: ["--extra"] }).at(-1)).toBe("--extra");
    expect(args({ adapter: "pi" })).toEqual(
      expect.arrayContaining(["--session-dir", "/scratch"]),
    );
  });

  it("installs the registry entry's own distribution under its shim name", async () => {
    installer.installAcpRegistryAgent.mockResolvedValue({
      commandPath: "/opt/acp/shim",
      version: "9.9.9",
    });

    await expect(
      installAcpHarness({ adapter: "pi", binDir: "/opt/acp" }),
    ).resolves.toEqual({
      id: entry.id,
      commandPath: "/opt/acp/shim",
      version: "9.9.9",
    });
    expect(installer.installAcpRegistryAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        registryId: entry.registryId,
        shimName: basename(entry.spec.command),
        binDir: "/opt/acp",
        installRoot: "/opt/acp",
        registryAgent: expect.objectContaining({
          distribution: entry.registryDistribution,
        }),
      }),
    );
    await expect(
      installAcpHarness({ adapter: "pi", binDir: "relative" }),
    ).rejects.toThrow(/must be an absolute path/u);
  });
});
