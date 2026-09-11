import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createLocalApiApp } from "./app";
import { ensureAgentCwd } from "./runtime/host/lib/session-cwd";

it("prepares the hosted agent workspace during project creation before any session exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-project-workspace-"));
  const previous = process.env.CLASH_HOME;
  process.env.CLASH_HOME = root;
  try {
    const app = createLocalApiApp({
      dataDir: join(root, "local-api"),
      userId: "local-user",
      prepareProjectWorkspace: (id) =>
        ensureAgentCwd("clash", id, { harnessId: "codex-acp" }).then(
          () => undefined,
        ),
    });
    const result = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent ready project" }),
    });
    expect(result.status).toBe(201);
    const { id } = (await result.json()) as { id: string };
    const cwd = join(root, "projects", id);
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).not.toBe("");
    expect(await readlink(join(cwd, "CLAUDE.md"))).toBe("AGENTS.md");
    expect((await stat(join(cwd, "sessions"))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, ".agents/skills"))).isDirectory()).toBe(true);
    expect(await readlink(join(cwd, ".claude/skills"))).toBe(
      "../.agents/skills",
    );
  } finally {
    if (previous === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("does not publish a project when workspace preparation fails", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "clash-project-workspace-failure-"),
  );
  try {
    const app = createLocalApiApp({
      dataDir: root,
      userId: "local-user",
      prepareProjectWorkspace: async () => {
        throw new Error("Workspace is unavailable");
      },
    });
    const before = await (await app.request("/api/v1/projects")).json();
    const response = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cannot prepare" }),
    });
    expect(response.status).toBe(500);
    expect(await (await app.request("/api/v1/projects")).json()).toEqual(
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("passes an explicit skill install scope through the real marketplace route", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-skill-scope-route-"));
  try {
    const install = vi.fn(async (...args: unknown[]) => ({ args }));
    const app = createLocalApiApp({
      dataDir: root,
      userId: "local-user",
      marketplaceSkills: [{ id: "skill-test" }],
      installMarketplaceSkill: install,
    });
    const installation = { scope: "projects", projectIds: ["p"] };
    const response = await app.request(
      "/api/marketplace/skills/skill-test/install",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(installation),
      },
    );
    expect(response.status).toBe(200);
    expect(install).toHaveBeenCalledWith("skill-test", installation);
    install.mockClear();
    const invalid = await app.request(
      "/api/marketplace/skills/skill-test/install",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "projects", projectIds: [] }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(install).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
