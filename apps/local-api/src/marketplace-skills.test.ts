import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNpxSkillsMarketplace } from "./marketplace-skills.js";
import { createClashUserConfigStore } from "./user-config.js";

const registry = {
  skills: [
    {
      id: "clash.video.sd25-pe",
      name: "sd25-pe",
      title: "Seedance 2.5 Prompt Engineering",
      description: "Official Seedance 2.5 prompt-engineering guidance.",
      source: "provider-official",
      sourceVersion: "0.1.1",
      install: {
        kind: "npx-skills",
        source: "https://arkdocs.tos-cn-beijing.volces.com/skills/",
        skill: "sd25-pe",
        scope: "global",
      },
    },
    {
      id: "clash.video.bundled",
      name: "bundled",
      source: "first-party",
      path: "skills/bundled",
    },
  ],
};

describe("npx skills marketplace", () => {
  it("persists the selected install scope in Host config and exposes it when listing", async () => {
    const home = await mkdtemp(join(tmpdir(), "clash-scoped-install-"));
    try {
      const configStore = createClashUserConfigStore(join(home, "local-api"));
      const agentsDir = join(home, "agents");
      await mkdir(join(agentsDir, "skills/sd25-pe"), { recursive: true });
      await writeFile(join(agentsDir, "skills/sd25-pe/SKILL.md"), "test\n");
      await writeFile(
        join(agentsDir, ".skill-lock.json"),
        JSON.stringify({ skills: { "sd25-pe": { source: "test" } } }),
      );
      const run = vi.fn().mockResolvedValue({ stdout: "" });
      const marketplace = createNpxSkillsMarketplace({
        registry,
        agentsDir,
        run,
        configStore,
      });
      const installation = {
        scope: "projects" as const,
        projectIds: ["project-a", "project-b"],
      };
      await marketplace.install("clash.video.sd25-pe", installation);
      expect(await configStore.getSection("skills")).toEqual({
        "sd25-pe": installation,
      });
      expect(await marketplace.listInstalled()).toEqual([
        expect.objectContaining({ installation }),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps community authorship and provenance when exposing an official pick", async () => {
    const picked = {
      ...registry.skills[0],
      id: "clash.community.example",
      name: "example-skill",
      source: "community",
      author: "Example author",
      curation: { collection: "official-picks", curator: "Clash" },
      attribution: {
        sourceUrl:
          "https://github.com/example/skills/blob/revision/example/SKILL.md",
        license: "MIT",
        licenseUrl: "https://github.com/example/skills/blob/revision/LICENSE",
      },
      install: {
        kind: "npx-skills",
        source: "https://github.com/example/skills/tree/revision",
        skill: "example-skill",
        scope: "global",
      },
    };
    const run = vi.fn().mockResolvedValue({ stdout: "" });
    const marketplace = createNpxSkillsMarketplace({
      registry: { skills: [picked] },
      run,
    });
    expect(marketplace.skills).toEqual([expect.objectContaining(picked)]);
    await marketplace.install(picked.id);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        picked.install.source,
        "--skill",
        picked.install.skill,
      ]),
    );
  });

  it.each(["first-party", "community"])(
    "installs a bundled %s pick without changing its authorship or fetching upstream",
    async (source) => {
      const pluginRoot = await mkdtemp(join(tmpdir(), "clash-bundled-skill-"));
      const skillName = "example-multiview";
      const skillPath = join(pluginRoot, "skills", skillName);
      try {
        await mkdir(skillPath, { recursive: true });
        await writeFile(
          join(skillPath, "SKILL.md"),
          `---\nname: ${skillName}\ndescription: Test subject views\n---\n`,
        );
        const picked = {
          id: "clash.creative.example",
          name: skillName,
          source,
          author: "Example author",
          attribution: {
            sourceUrl:
              "https://github.com/example/skills/blob/revision/SKILL.md",
            notes: "Clash adaptation of the credited upstream skill.",
          },
          install: { kind: "bundled-skill", skill: skillName, scope: "global" },
        };
        const run = vi.fn().mockResolvedValue({ stdout: "" });
        const marketplace = createNpxSkillsMarketplace({
          registry: { skills: [picked] },
          run,
          builtinPluginRoot: () => pluginRoot,
        });
        expect(marketplace.skills).toEqual([expect.objectContaining(picked)]);
        await marketplace.install(picked.id);
        expect(run).toHaveBeenCalledWith(
          expect.any(String),
          expect.arrayContaining(["add", skillPath, "--skill", skillName]),
        );
        await rm(join(skillPath, "SKILL.md"));
        await expect(marketplace.install(picked.id)).rejects.toThrow();
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        await rm(pluginRoot, { recursive: true, force: true });
      }
    },
  );

  it("lists only registry skills backed by the supported lazy installer", () => {
    const marketplace = createNpxSkillsMarketplace({ registry, run: vi.fn() });

    expect(marketplace.skills).toEqual([
      expect.objectContaining({
        id: "clash.video.sd25-pe",
        name: "sd25-pe",
        type: "skill",
        install: registry.skills[0]?.install,
      }),
    ]);
  });

  it("reads installed registry skills from local global state without invoking npx", async () => {
    const agentsDir = await mkdtemp(
      join(tmpdir(), "clash-marketplace-skills-"),
    );
    const skillPath = join(agentsDir, "skills", "sd25-pe");
    try {
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, "SKILL.md"), "# Seedance 2.5\n");
      await writeFile(
        join(agentsDir, ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            "sd25-pe": {
              source: "openclaw/skills",
              sourceUrl: "https://arkdocs.tos-cn-beijing.volces.com/skills/",
            },
          },
        }),
      );
      const marketplace = createNpxSkillsMarketplace({
        registry,
        agentsDir,
        run: async () => {
          throw new Error("npx must not run while listing installed skills");
        },
      });

      await expect(marketplace.listInstalled()).resolves.toEqual([
        expect.objectContaining({
          skillId: "clash.video.sd25-pe",
          name: "sd25-pe",
          path: skillPath,
        }),
      ]);
    } finally {
      await rm(agentsDir, { force: true, recursive: true });
    }
  });

  it("installs a selected registry skill from its fixed official source", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "" });
    const marketplace = createNpxSkillsMarketplace({ registry, run });

    await expect(
      marketplace.install("clash.video.sd25-pe"),
    ).resolves.toMatchObject({
      skillId: "clash.video.sd25-pe",
      installed: true,
    });
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^npx(?:\.cmd)?$/), [
      "--yes",
      "skills@latest",
      "add",
      "https://arkdocs.tos-cn-beijing.volces.com/skills/",
      "--skill",
      "sd25-pe",
      "--global",
      "--yes",
    ]);
  });

  it("uninstalls only the fixed skill name belonging to the selected registry id", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "" });
    const marketplace = createNpxSkillsMarketplace({ registry, run });

    await marketplace.uninstall("clash.video.sd25-pe");

    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^npx(?:\.cmd)?$/), [
      "--yes",
      "skills@latest",
      "remove",
      "sd25-pe",
      "--global",
      "--yes",
    ]);
  });

  it("rejects ids that are not in the trusted registry", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "" });
    const marketplace = createNpxSkillsMarketplace({ registry, run });

    await expect(
      marketplace.install("https://evil.example/skill"),
    ).rejects.toThrow(/unknown marketplace skill/i);
    expect(run).not.toHaveBeenCalled();
  });
});
