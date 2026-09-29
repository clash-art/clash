import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNpxSkillsMarketplace } from "./marketplace-skills";
import { createClashUserConfigStore } from "./user-config";
import { ensureProjectSkillLinks } from "./runtime/host/lib/project-skill-links";

it("keeps a scoped skill out of global discovery and revokes only its managed project links", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-skill-plugin-"));
  try {
    const store = createClashUserConfigStore(join(root, "host/local-api"));
    const builtin = join(root, "builtin");
    await mkdir(join(builtin, "skills/example"), { recursive: true });
    await writeFile(join(builtin, "skills/example/SKILL.md"), "Example instructions");
    const marketplace = createNpxSkillsMarketplace({ configStore: store, agentsDir: join(root, "global/.agents"), builtinPluginRoot: () => builtin, registry: { skills: [{id: "example", name: "Example", source: "first-party", install: { kind: "bundled-skill", skill: "example", scope: "global" }}] } });
    await marketplace.install("example", {scope: "projects", projectIds: ["a"]});
    const managedSkillsRoot = join(store.clashHome, "plugin-skills");
    const source = join(managedSkillsRoot, "example");
    const cwd = join(root, "project-a");
    const base = { cwd, nativeDirectories: [".claude/skills"], initialSkills: new Map<string,string>(), managedSkillsRoot };
    await ensureProjectSkillLinks({...base, installedSkills: new Map([["example", source]])});
    expect(await readFile(join(cwd, ".claude/skills/example/SKILL.md"), "utf8")).toBe("Example instructions");
    await expect(readFile(join(root, "global/.agents/skills/example/SKILL.md"))).rejects.toMatchObject({code: "ENOENT"});
    await mkdir(join(cwd, ".agents/skills/custom"));
    await writeFile(join(cwd, ".agents/skills/custom/SKILL.md"), "User instructions");
    await symlink(builtin, join(cwd, ".agents/skills/external"));
    await ensureProjectSkillLinks({...base, installedSkills: new Map()});
    await expect(readFile(join(cwd, ".claude/skills/example/SKILL.md"))).rejects.toMatchObject({code: "ENOENT"});
    expect(await readFile(join(cwd, ".agents/skills/custom/SKILL.md"), "utf8")).toBe("User instructions");
    expect(await readFile(join(cwd, ".agents/skills/external/skills/example/SKILL.md"), "utf8")).toBe("Example instructions");
  } finally { await rm(root, {recursive: true, force: true}); }
});

it("migrates only a legacy Host-owned global install before narrowing its scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-skill-migration-"));
  try {
    const store = createClashUserConfigStore(join(root, "host/local-api"));
    const agentsDir = join(root, "global/.agents");
    const legacy = join(agentsDir, "skills/example");
    await mkdir(legacy, {recursive: true});
    await writeFile(join(legacy, "SKILL.md"), "Existing content");
    const marketplace = createNpxSkillsMarketplace({configStore: store, agentsDir, registry: {skills: [{id: "example", name: "Example", source: "first-party", install: {kind: "bundled-skill", skill: "example", scope: "global"}}]}});
    await expect(marketplace.install("example", {scope: "projects", projectIds: ["a"]})).rejects.toThrow("outside Clash");
    expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toBe("Existing content");
    await store.setSection("skills", {example: {scope: "global"}});
    await marketplace.install("example", {scope: "projects", projectIds: ["a"]});
    await expect(readFile(join(legacy, "SKILL.md"))).rejects.toMatchObject({code: "ENOENT"});
    expect(await readFile(join(store.clashHome, "plugin-skills/example/SKILL.md"), "utf8")).toBe("Existing content");
  } finally { await rm(root, {recursive: true, force: true}); }
});
