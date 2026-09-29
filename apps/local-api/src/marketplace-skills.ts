import { execFile } from "node:child_process";
import { access, cp, mkdir, rm, readFile, rename, stat } from "node:fs/promises";
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
  options?: { cwd?: string },
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(
  executable: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string }> {
  const result = await execFileAsync(executable, args, {
    ...options,
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
  const managedRoot = configStore ? join(configStore.clashHome, "plugin-skills") : join(agentsDir, "skills");
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
          const managedPath = join(managedRoot, skill.install.skill);
          const path = (await stat(join(managedPath, "SKILL.md")).catch(() => null))?.isFile() ? managedPath : join(agentsDir, "skills", skill.install.skill);
          if (!lockEntry && skill.install.kind !== "bundled-skill" && !scopes[skill.install.skill]) return null;
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
              typeof lockEntry?.source === "string" ? lockEntry.source : null,
            sourceUrl:
              typeof lockEntry?.sourceUrl === "string"
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
      const targetPath = join(managedRoot, skill.install.skill);
      const legacyPath = join(agentsDir, "skills", skill.install.skill);
      if (configStore && await stat(legacyPath).catch(() => null)) {
        const previous = HostSkillInstallationsSchema.parse(await configStore.getSection("skills") ?? {});
        if (previous[skill.install.skill] && !await stat(targetPath).catch(() => null)) {
          await mkdir(managedRoot, { recursive: true });
          await rename(legacyPath, targetPath);
        } else if (installation.scope === "projects") {
          throw new Error("This skill is also installed globally outside Clash. Remove that global installation before limiting it to selected projects.");
        }
      }
      if (!configStore || !(await stat(join(targetPath, "SKILL.md")).catch(() => null))?.isFile()) {
      const source =
        skill.install.kind === "bundled-skill"
          ? join(builtinPluginRoot(), "skills", skill.install.skill)
          : skill.install.source;
      if (skill.install.kind === "bundled-skill") {
        await access(join(source, "SKILL.md"));
        await mkdir(managedRoot, { recursive: true });
        await cp(source, targetPath, { recursive: true, dereference: true });
      } else {
      const installerHome = configStore ? join(configStore.clashHome, "skill-installer") : undefined;
      if (installerHome) await mkdir(installerHome, { recursive: true });
      const args = [
        "--yes",
        "skills@latest",
        "add",
        source,
        "--skill",
        skill.install.skill,
        ...(installerHome ? [] : ["--global"]),
        "--yes",
      ];
      if (installerHome) await run(executable, args, { cwd: installerHome });
      else await run(executable, args);
      if (installerHome) {
        await mkdir(managedRoot, { recursive: true });
        await cp(join(installerHome, ".agents", "skills", skill.install.skill), targetPath, { recursive: true, dereference: true });
      }
      }
      }
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
      if (configStore || skill.install.kind === "bundled-skill") {
        await rm(join(managedRoot, skill.install.skill), { recursive: true, force: true });
      } else {
      await run(executable, [
        "--yes",
        "skills@latest",
        "remove",
        skill.install.skill,
        "--global",
        "--yes",
      ]);
      }
      await configStore?.updateSection("skills", (current) => {
        const scopes = HostSkillInstallationsSchema.parse(current ?? {});
        delete scopes[skill.install.skill];
        return scopes;
      });
    },
  };
}
