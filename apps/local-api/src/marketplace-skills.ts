import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveBuiltinClashPluginRoot } from "./runtime/host/lib/session-cwd.js";
import { HostInstallScopeSchema, HostSkillInstallationsSchema, type HostInstallScope } from "@clash/shared-types";
import type { ClashUserConfigStore } from "./user-config.js";

interface NpxSkillsInstall {
  kind: "npx-skills";
  source: string;
  skill: string;
  scope: "global";
}

interface BundledSkillInstall {
  kind: "bundled-skill";
  skill: string;
  scope: "global";
}

export interface NpxSkillsMarketplaceItem extends Record<string, unknown> {
  id: string;
  name: string;
  type: "skill";
  source: "first-party" | "provider-official" | "community";
  install: NpxSkillsInstall | BundledSkillInstall;
}

interface InstalledSkillLockEntry {
  source?: unknown;
  sourceUrl?: unknown;
}

type CommandRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(
  executable: string,
  args: string[],
): Promise<{ stdout: string }> {
  const result = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout };
}

function asLazyMarketplaceSkill(
  value: unknown,
): NpxSkillsMarketplaceItem | null {
  if (!value || typeof value !== "object") return null;
  const skill = value as Record<string, unknown>;
  const rawInstall = skill.install;
  if (!rawInstall || typeof rawInstall !== "object") return null;
  const descriptor = rawInstall as Record<string, unknown>;
  if (
    typeof skill.id !== "string" ||
    typeof skill.name !== "string" ||
    (skill.source !== "provider-official" &&
      skill.source !== "community" &&
      skill.source !== "first-party") ||
    typeof descriptor.skill !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(descriptor.skill) ||
    descriptor.scope !== "global"
  ) {
    return null;
  }
  let install: NpxSkillsInstall | BundledSkillInstall;
  if (descriptor.kind === "bundled-skill") {
    install = {
      kind: "bundled-skill",
      skill: descriptor.skill,
      scope: "global",
    };
  } else if (
    descriptor.kind === "npx-skills" &&
    typeof descriptor.source === "string" &&
    descriptor.source.startsWith("https://")
  ) {
    install = {
      kind: "npx-skills",
      source: descriptor.source,
      skill: descriptor.skill,
      scope: "global",
    };
  } else {
    return null;
  }
  return {
    ...skill,
    id: skill.id,
    name: skill.name,
    type: "skill",
    source: skill.source,
    install,
  };
}

async function readInstalledSkillLock(
  agentsDir: string,
): Promise<Record<string, InstalledSkillLockEntry>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(agentsDir, ".skill-lock.json"), "utf8"),
    ) as { skills?: unknown };
    if (!parsed.skills || typeof parsed.skills !== "object") return {};
    return parsed.skills as Record<string, InstalledSkillLockEntry>;
  } catch {
    return {};
  }
}

export function createNpxSkillsMarketplace({
  registry,
  run = defaultCommandRunner,
  agentsDir = join(homedir(), ".agents"),
  builtinPluginRoot = resolveBuiltinClashPluginRoot,
  configStore,
}: {
  registry: { skills?: unknown };
  run?: CommandRunner;
  agentsDir?: string;
  builtinPluginRoot?: () => string;
  configStore?: ClashUserConfigStore;
}) {
  const rawSkills = Array.isArray(registry.skills) ? registry.skills : [];
  const skills = rawSkills
    .map(asLazyMarketplaceSkill)
    .filter((skill): skill is NpxSkillsMarketplaceItem => skill !== null);
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";

  function requireSkill(id: string): NpxSkillsMarketplaceItem {
    const skill = byId.get(id);
    if (!skill) throw new Error(`Unknown marketplace skill: ${id}`);
    return skill;
  }

  return {
    skills,
    async listInstalled(): Promise<Array<Record<string, unknown>>> {
      const scopes = HostSkillInstallationsSchema.parse(await configStore?.getSection("skills") ?? {});
      const installedByName = await readInstalledSkillLock(agentsDir);
      const installed = await Promise.all(
        skills.map(async (skill) => {
          const lockEntry = installedByName[skill.install.skill];
          if (!lockEntry) return null;
          const path = join(agentsDir, "skills", skill.install.skill);
          try {
            await access(join(path, "SKILL.md"));
          } catch {
            return null;
          }
          return {
            skillId: skill.id,
            name: skill.name,
            description: skill.description ?? null,
            version: skill.sourceVersion ?? null,
            path,
            scope: scopes[skill.install.skill]?.scope ?? "global",
            installation: scopes[skill.install.skill] ?? { scope: "global" },
            source:
              typeof lockEntry.source === "string" ? lockEntry.source : null,
            sourceUrl:
              typeof lockEntry.sourceUrl === "string"
                ? lockEntry.sourceUrl
                : skill.install.kind === "npx-skills"
                  ? skill.install.source
                  : (skill.repository ?? null),
          };
        }),
      );
      return installed.filter(
        (skill): skill is NonNullable<typeof skill> => skill !== null,
      );
    },
    async install(id: string, target: HostInstallScope = { scope: "global" }): Promise<Record<string, unknown>> {
      const installation = HostInstallScopeSchema.parse(target);
      if (installation.scope === "projects" && !configStore) throw new Error("Host configuration is required for project-scoped skill installation");
      const skill = requireSkill(id);
      const source =
        skill.install.kind === "bundled-skill"
          ? join(builtinPluginRoot(), "skills", skill.install.skill)
          : skill.install.source;
      if (skill.install.kind === "bundled-skill") {
        await access(join(source, "SKILL.md"));
      }
      await run(executable, [
        "--yes",
        "skills@latest",
        "add",
        source,
        "--skill",
        skill.install.skill,
        "--global",
        "--yes",
      ]);
      await configStore?.updateSection("skills", (current) => ({
        ...HostSkillInstallationsSchema.parse(current ?? {}),
        [skill.install.skill]: installation,
      }));
      return {
        skillId: skill.id,
        name: skill.name,
        installed: true,
        scope: installation.scope,
        installation,
      };
    },
    async uninstall(id: string): Promise<void> {
      const skill = requireSkill(id);
      await run(executable, [
        "--yes",
        "skills@latest",
        "remove",
        skill.install.skill,
        "--global",
        "--yes",
      ]);
      await configStore?.updateSection("skills", (current) => {
        const scopes = HostSkillInstallationsSchema.parse(current ?? {});
        delete scopes[skill.install.skill];
        return scopes;
      });
    },
  };
}
