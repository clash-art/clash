import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HostSkillInstallationsSchema } from "@clash/shared-types";
import { createClashUserConfigStore } from "./user-config.js";
import { defaultLocalApiDataDir } from "./local-paths.js";

export async function resolveHostProjectSkills(
  projectId: string,
  env: Record<string, string | undefined>,
): Promise<Map<string, string>> {
  const store = createClashUserConfigStore(defaultLocalApiDataDir(env));
  const installations = HostSkillInstallationsSchema.parse(
    (await store.getSection("skills")) ?? {},
  );
  const skills = new Map<string, string>();
  for (const [name, installation] of Object.entries(installations)) {
    if (
      installation.scope === "projects" &&
      !installation.projectIds.includes(projectId)
    )
      continue;
    const source = join(homedir(), ".agents", "skills", name);
    if (!(await stat(join(source, "SKILL.md")).catch(() => null))?.isFile()) {
      throw new Error(
        `Host-configured skill '${name}' is not installed at ${source}. Install it or update ${store.configPath}.`,
      );
    }
    skills.set(name, source);
  }
  return skills;
}
