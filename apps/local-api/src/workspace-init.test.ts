import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { managedLocalApiApps } from "./local-api-app.test-fixtures";
import { createLocalMetadataStore } from "./local-metadata-store";

const apps = managedLocalApiApps();
const dirs: string[] = [];
afterEach(async () => {
  await apps.close();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it.each(["local_existing-marker", "project/chaos"])("registers marker %s once without replacing existing project metadata", async (projectId) => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-workspace-registration-"));
  dirs.push(dataDir);
  const app = apps.createApp({ dataDir, userId: "local-user" });
  const initialize = (name: string) => app.request(`/api/v1/projects/${encodeURIComponent(projectId)}/initialize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  expect((await initialize("Election")).status).toBe(201);
  const initial = await createLocalMetadataStore(dataDir).load();
  expect(initial.projects.map(project => project.id)).toEqual([projectId]);
  expect((await initialize("Different directory name")).status).toBe(200);
  expect((await createLocalMetadataStore(dataDir).load()).projects).toEqual(initial.projects);
  const reopened = apps.createApp({ dataDir, userId: "local-user" });
  expect(await (await reopened.request("/api/v1/projects")).json()).toMatchObject({
    projects: [{ id: projectId, name: "Election" }],
  });
});

it("does not restore an archived marker project or adopt another owner's project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-workspace-registration-conflict-"));
  dirs.push(dataDir);
  const app = apps.createApp({ dataDir, userId: "local-user" });
  const created = await (await app.request("/api/v1/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Original" }),
  })).json() as { id: string };
  const store = createLocalMetadataStore(dataDir);
  const before = await store.load();
  before.projects[0]!.deletedAt = "2026-09-01T00:00:00.000Z";
  await store.save(before);
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Replacement" }) };
  expect((await app.request(`/api/v1/projects/${created.id}/initialize`, init)).status).toBe(409);
  expect((await store.load()).projects).toEqual(before.projects);
  before.projects[0]!.deletedAt = null;
  await store.save(before);
  const other = apps.createApp({ dataDir, userId: "another-user" });
  expect((await other.request(`/api/v1/projects/${created.id}/initialize`, init)).status).toBe(409);
  expect((await store.load()).projects).toEqual(before.projects);
});
