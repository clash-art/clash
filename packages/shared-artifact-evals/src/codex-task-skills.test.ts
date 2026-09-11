import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderCodexTaskSkillContext } from "./codex-task-skills";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex Task skill context", () => {
  it("uses only the task's installed metadata and keeps skill bodies lazy", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-codex-task-skills-"));
    roots.push(root);
    const descriptions = new Map([
      ["dialogue", "Edit actual speech."],
      ["rhythm", "Edit against actual music."],
    ]);
    for (const [name, description] of descriptions) {
      const folder = join(root, name, ".agents", "skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nprivate-body-${name}`,
      );
    }
    for (const [name, description] of descriptions) {
      const context = await renderCodexTaskSkillContext(join(root, name));
      expect(context).toContain(description);
      expect(context).toContain(
        join(root, name, ".agents", "skills", name, "SKILL.md"),
      );
      expect(context).not.toContain("private-body-");
      for (const [other, otherDescription] of descriptions)
        if (other !== name) expect(context).not.toContain(otherDescription);
      expect(
        await readFile(
          join(root, name, ".agents", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`private-body-${name}`);
    }
  });

  it("handles a task without installed skills without discovering global directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-codex-no-task-skills-"));
    roots.push(root);
    expect(await renderCodexTaskSkillContext(root)).not.toContain("SKILL.md");
  });
});
