import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ensureAgentCwd } from "./session-cwd";

const roots: string[] = [];
const previousHome = process.env.HOME;
const previousClashHome = process.env.CLASH_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousClashHome === undefined) delete process.env.CLASH_HOME;
  else process.env.CLASH_HOME = previousClashHome;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "clash-project-links-"));
  roots.push(home);
  process.env.HOME = home;
  process.env.CLASH_HOME = join(home, ".clash");
  const globalSkills = join(home, ".agents", "skills");
  for (const name of ["storyboard", "sound-design"]) {
    await mkdir(join(globalSkills, name), { recursive: true });
    await writeFile(join(globalSkills, name, "SKILL.md"), `# ${name}\n`);
  }
  const start = (harnessId = "codex-acp") =>
    ensureAgentCwd("clash", "selected-skills", { harnessId });
  return { globalSkills, start };
}

it("shares project skill links immediately across native harness directories", async () => {
  const { globalSkills, start } = await fixture();
  const cwd = await start();
  await start("claude-acp");
  expect(await readlink(join(cwd, ".claude/skills"))).toBe("../.agents/skills");
  await expect(
    readFile(join(cwd, ".agents/skills/storyboard/SKILL.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  // The agent enables a globally installed skill with a normal filesystem link.
  await symlink(
    join(globalSkills, "storyboard"),
    join(cwd, ".agents/skills/storyboard"),
    "dir",
  );
  expect(
    await readFile(join(cwd, ".claude/skills/storyboard/SKILL.md"), "utf8"),
  ).toBe("# storyboard\n");
  await expect(
    readFile(join(cwd, ".claude/skills/sound-design/SKILL.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await unlink(join(cwd, ".claude/skills/storyboard"));
  await unlink(join(cwd, ".agents/skills/clash"));
  await start();
  await expect(
    readlink(join(cwd, ".agents/skills/storyboard")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readlink(join(cwd, ".agents/skills/clash")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(join(globalSkills, "storyboard", "SKILL.md"), "utf8"),
  ).toBe("# storyboard\n");
  for (const name of ["agent.json", "agent.toml"]) {
    await expect(readFile(join(cwd, ".clash", name))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("preserves a project's existing skill selection on start", async () => {
  await fixture();
  const cwd = join(process.env.CLASH_HOME!, "projects", "selected-skills");
  const custom = join(cwd, ".agents/skills/my-skill");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "SKILL.md"), "user owned\n");
  await ensureAgentCwd("clash", "selected-skills", { harnessId: "claude-acp" });
  expect(
    await readFile(join(cwd, ".claude/skills/my-skill/SKILL.md"), "utf8"),
  ).toBe("user owned\n");
  await expect(
    readlink(join(cwd, ".agents/skills/clash")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("consolidates legacy native skill directories without copying skill bodies", async () => {
  const { globalSkills, start } = await fixture();
  const cwd = join(process.env.CLASH_HOME!, "projects", "selected-skills");
  for (const directory of [".agents/skills", ".claude/skills"]) {
    await mkdir(join(cwd, directory), { recursive: true });
    await symlink(
      join(globalSkills, "storyboard"),
      join(cwd, directory, "storyboard"),
      "dir",
    );
  }
  const custom = join(cwd, ".claude/skills/custom");
  await mkdir(custom);
  await writeFile(join(custom, "SKILL.md"), "custom\n");
  await start("claude-acp");
  expect(await readlink(join(cwd, ".claude/skills"))).toBe("../.agents/skills");
  expect(await readlink(join(cwd, ".agents/skills/storyboard"))).toBe(
    join(globalSkills, "storyboard"),
  );
  expect(
    await readFile(join(cwd, ".agents/skills/custom/SKILL.md"), "utf8"),
  ).toBe("custom\n");
});

it("uses an existing native skill set without adding defaults and preserves conflicts for manual merging", async () => {
  const { start } = await fixture();
  const cwd = join(process.env.CLASH_HOME!, "projects", "selected-skills");
  const legacy = join(cwd, ".claude/skills/clash");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "SKILL.md"), "custom clash\n");
  await start("claude-acp");
  expect(
    await readFile(join(cwd, ".agents/skills/clash/SKILL.md"), "utf8"),
  ).toBe("custom clash\n");
  await unlink(join(cwd, ".claude/skills"));
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "SKILL.md"), "different custom clash\n");
  await expect(start()).rejects.toThrow(/conflicting project skill/i);
  expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toBe(
    "different custom clash\n",
  );
  expect(
    await readFile(join(cwd, ".agents/skills/clash/SKILL.md"), "utf8"),
  ).toBe("custom clash\n");
});
