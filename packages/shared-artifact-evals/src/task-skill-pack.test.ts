import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkSuite } from "./suite";
import { installCaseSkills } from "./runner";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clash-task-skill-pack-"));
  roots.push(root);
  const template = JSON.parse(
    await readFile(
      new URL(
        "../../../benchmarks/agent-product/v1/suite.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const name of ["base", "dialogue", "rhythm", "extra"]) {
    await mkdir(join(root, "source", name), { recursive: true });
    await writeFile(
      join(root, "source", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} example\n---\n${name}\n`,
    );
  }
  await writeFile(
    join(root, "packs.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: {
        dialogue: {
          description: "Dialogue editing",
          skills: ["./source/base", "./source/dialogue"],
        },
        rhythm: {
          description: "Beat editing",
          skills: ["./source/base", "./source/rhythm"],
        },
      },
    }),
  );
  const cases = ["dialogue", "rhythm"].map((id) => ({
    ...template.cases[0],
    id,
    skills: id === "dialogue" ? ["./source/base", "./source/extra"] : [],
    skillPack: { path: "./packs.json", id },
  }));
  const suite = {
    schemaVersion: 1,
    id: "task-packs",
    title: "Task packs",
    cases,
  };
  const path = join(root, "suite.json");
  await writeFile(path, JSON.stringify(suite));
  return { root, path, suite };
}

describe("per-task skill packs", () => {
  it("resolves only the selected pack, deduplicates additions, and mounts independent payloads", async () => {
    const { root, path } = await fixture();
    const suite = await loadBenchmarkSuite(path);
    const installed: string[][] = [];
    for (const task of suite.cases) {
      const workspace = join(root, task.id);
      installed.push(await installCaseSkills(task.skills, root, workspace));
      expect(task.skillPack?.id).toBe(task.id);
      for (const agent of [".agents", ".claude"]) {
        expect(
          (await readdir(join(workspace, agent, "skills"))).sort(),
        ).toEqual([...installed.at(-1)!].sort());
        for (const name of installed.at(-1)!)
          expect(
            await readFile(
              join(workspace, agent, "skills", name, "SKILL.md"),
              "utf8",
            ),
          ).toBe(
            await readFile(join(root, "source", name, "SKILL.md"), "utf8"),
          );
      }
    }
    expect(installed[0]).toEqual(["base", "dialogue", "extra"]);
    expect(installed[1]).toEqual(["base", "rhythm"]);
    await writeFile(
      join(root, "dialogue", ".agents", "skills", "base", "SKILL.md"),
      "task edit",
    );
    expect(
      await readFile(
        join(root, "rhythm", ".agents", "skills", "base", "SKILL.md"),
        "utf8",
      ),
    ).not.toBe("task edit");
    expect(
      await readFile(join(root, "source", "base", "SKILL.md"), "utf8"),
    ).not.toBe("task edit");
    expect(suite.cases[0]!.skills.map((p) => resolve(root, p))).toContain(
      join(root, "source", "dialogue"),
    );
  });

  it("fails before mounting when a task names an unknown pack", async () => {
    const { path, suite } = await fixture();
    suite.cases[0]!.skillPack.id = "missing";
    await writeFile(path, JSON.stringify(suite));
    await expect(loadBenchmarkSuite(path)).rejects.toThrow(
      /unknown.*skill pack.*missing/i,
    );
  });
});
