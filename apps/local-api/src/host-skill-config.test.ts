import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createClashUserConfigStore } from "./user-config";
import { ensureAgentCwd } from "./runtime/host/lib/session-cwd";

it("mounts global and matching-project skills from Host config without a project-side configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "clash-host-skills-"));
  const previousHome = process.env.HOME;
  const previousClashHome = process.env.CLASH_HOME;
  process.env.HOME = home;
  process.env.CLASH_HOME = join(home, ".clash");
  try {
    for (const name of ["global-skill", "project-skill", "unselected-skill"]) {
      await mkdir(join(home, ".agents/skills", name), { recursive: true });
      await writeFile(join(home, ".agents/skills", name, "SKILL.md"), name);
    }
    const store = createClashUserConfigStore(join(home, ".clash/local-api"));
    await store.setSection("skills", {
      "global-skill": { scope: "global" },
      "project-skill": { scope: "projects", projectIds: ["project-a"] },
    });
    const before = await readFile(store.configPath, "utf8");
    const a = await ensureAgentCwd("clash", "project-a", {
      harnessId: "codex-acp",
    });
    const b = await ensureAgentCwd("clash", "project-b", {
      harnessId: "claude-acp",
    });
    expect(await readlink(join(a, ".agents/skills/project-skill"))).toBe(
      join(home, ".agents/skills/project-skill"),
    );
    expect(await readlink(join(b, ".claude/skills/global-skill"))).toBe(
      join(home, ".agents/skills/global-skill"),
    );
    await expect(
      readFile(join(b, ".agents/skills/project-skill/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(a, ".agents/skills/unselected-skill/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(store.configPath, "utf8")).toBe(before);
    await store.setSection("skills", {});
    await ensureAgentCwd("clash", "project-a", { harnessId: "codex-acp" });
    // Host configuration owns scope; removing stale links is an explicit agent action.
    expect(await readlink(join(a, ".agents/skills/project-skill"))).toBe(
      join(home, ".agents/skills/project-skill"),
    );
    await expect(readFile(join(a, ".clash/agent.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = previousClashHome;
    await rm(home, { recursive: true, force: true });
  }
});
