import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalApiApp } from "./app.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-activation-scope-"));
  dirs.push(dataDir);
  const activate = vi.fn(async () => ({
    id: "project.photo-prep",
    version: "1.0.0",
  }));
  const host = createLocalApiApp({
    dataDir,
    pluginPackages: {
      activate,
      list: async () => [],
      validate: async () => ({}),
      read: async () => ({}),
      rollback: async () => ({}),
      remove: async () => ({}),
    },
  });
  const created = await host.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Photo prep" }),
  });
  expect(created.status).toBe(201);
  const project = (await created.json()) as { id: string };
  const request = (body: unknown) =>
    host.request("/api/v1/local/plugins/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { activate, request, projectId: project.id };
}

it("forwards validated project scope separately from executable package bytes and preserves omitted scope", async () => {
  const { activate, request, projectId } = await fixture();
  const pkg = { id: "project.photo-prep", manifest: {}, files: {} };
  const installation = { scope: "projects", projectIds: [projectId] };
  expect((await request({ ...pkg, installation })).status).toBe(200);
  expect(activate).toHaveBeenLastCalledWith(pkg, installation);
  expect((await request(pkg)).status).toBe(200);
  expect(activate).toHaveBeenLastCalledWith(pkg);
});

it("rejects unknown projects or malformed scopes before activating any executable code", async () => {
  const { activate, request } = await fixture();
  for (const installation of [
    { scope: "projects", projectIds: ["missing-project"] },
    { scope: "projects", projectIds: [] },
    { scope: "global", projectIds: ["anything"] },
  ]) {
    expect(
      (
        await request({
          id: "project.photo-prep",
          manifest: {},
          files: {},
          installation,
        })
      ).status,
    ).toBe(400);
  }
  expect(activate).not.toHaveBeenCalled();
});
