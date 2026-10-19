import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocalApiApp,
  drainLocalApiAppBackgroundWork,
} from "./app.js";

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-project-list-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /api/v1/projects card summaries", () => {
  it("lists a new Project without invoking the room-backed replica", async () => {
    const seed = createLocalApiApp({ dataDir, userId: "local-user" });
    const created = await seed.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Summary card" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const project = (await created.json()) as { id: string };
    await drainLocalApiAppBackgroundWork(seed);

    const inspect = vi.fn(async () => {
      throw new Error("the list must not open a Project room");
    });
    const mutate = vi.fn(async () => {
      throw new Error("the list must not mutate a Project room");
    });
    const app = createLocalApiApp({
      dataDir,
      userId: "local-user",
      projectAssetReplica: { inspect, mutate },
    });

    for (let run = 0; run < 2; run += 1) {
      const listed = await app.request("/api/v1/projects");
      expect(listed.status, await listed.clone().text()).toBe(200);
      const body = (await listed.json()) as {
        projects: Array<{
          id: string;
          assetCount: number;
          assets: unknown[];
          error?: unknown;
        }>;
      };
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]).toMatchObject({
        id: project.id,
        assetCount: 0,
        assets: [],
      });
      expect(body.projects[0]?.error).toBeUndefined();
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    await drainLocalApiAppBackgroundWork(app);
  });

  it("keeps the list successful with a coded error on one broken card", async () => {
    const seed = createLocalApiApp({ dataDir, userId: "local-user" });
    const created = await seed.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Broken card" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const project = (await created.json()) as { id: string };
    await drainLocalApiAppBackgroundWork(seed);

    const loroDir = join(
      dataDir,
      "projects",
      encodeURIComponent(project.id),
      "loro",
    );
    await mkdir(loroDir, { recursive: true });
    await writeFile(join(loroDir, "snapshot.bin"), Buffer.from([0xff, 0xff]));

    const app = createLocalApiApp({ dataDir, userId: "local-user" });
    const listed = await app.request("/api/v1/projects");
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = (await listed.json()) as {
      projects: Array<{ id: string; error?: { code: string } }>;
    };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.id).toBe(project.id);
    expect(body.projects[0]?.error?.code).toEqual(expect.any(String));
    await drainLocalApiAppBackgroundWork(app);
  });
});
