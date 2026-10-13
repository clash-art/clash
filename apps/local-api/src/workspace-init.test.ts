import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectMetadata } from "@clash/shared-types";
import { managedLocalApiApps } from "./local-api-app.test-fixtures";
import { createLocalMetadataStore } from "./local-metadata-store";
import { createLocalSyncConfigStore } from "./sync-config";

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

it("joins an existing cloud project without overwriting its name and description with the marker placeholder", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-workspace-registration-join-"));
  dirs.push(dataDir);
  const projectId = "project-shared";
  // The cloud copy predates this Host's registration, so the placeholder's
  // updatedAt is always the newer of the two.
  let cloud: ProjectMetadata = {
    projectId, name: "Election film", description: "Authored on Host A",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null,
  };
  const saveProjectMetadata = vi.fn(async (_projectId: string, metadata: ProjectMetadata) => { cloud = metadata; });
  const app = apps.createApp({
    dataDir, userId: "local-user",
    syncConfig: {
      ...createLocalSyncConfigStore({ dataDir, env: {} }),
      resolveRemotePersistence: async () => ({
        appendUpdate: async () => undefined,
        loadProjectMetadata: async () => cloud,
        saveProjectMetadata,
      }),
    },
    cloudAdmission: {
      admit: async request => ({
        schemaVersion: 1, syncBaseUrl: "https://cloud.example.com",
        admission: {
          schemaVersion: 1, projectId: request.projectId, localReplicaId: request.localReplicaId,
          tenantId: "tenant-1", userId: "local-user", syncBaseUrl: "https://cloud.example.com", status: "pending",
          capabilities: { canvas: true, projectMetadata: true, resources: true },
          admittedAt: null, updatedAt: "2026-09-04T00:00:00Z", lastError: null,
        },
      }),
    },
  });
  const json = { "content-type": "application/json" };
  expect((await app.request(`/api/v1/projects/${projectId}/initialize`, {
    method: "POST", headers: json, body: JSON.stringify({ name: "wsB2" }),
  })).status).toBe(201);
  expect((await app.request(`/api/v1/projects/${projectId}/cloud-admission`, {
    method: "POST", headers: json, body: "{}",
  })).status).toBe(201);

  const localProject = async () => (await createLocalMetadataStore(dataDir).load()).projects.find(project => project.id === projectId);
  await vi.waitFor(async () => expect(await localProject()).toMatchObject({
    name: "Election film", description: "Authored on Host A",
  }));
  expect(saveProjectMetadata).not.toHaveBeenCalled();

  // Once adopted, the metadata is ordinary again: a real local rename wins.
  expect((await app.request(`/api/v1/projects/${projectId}`, {
    method: "PATCH", headers: json, body: JSON.stringify({ name: "Renamed on Host B" }),
  })).status).toBe(200);
  await vi.waitFor(() => expect(cloud.name).toBe("Renamed on Host B"));
});

function cloudJoinedApp(dataDir: string, initial: ProjectMetadata | null) {
  const cloud = { metadata: initial };
  const saveProjectMetadata = vi.fn(async (_projectId: string, metadata: ProjectMetadata) => { cloud.metadata = metadata; });
  const app = apps.createApp({
    dataDir, userId: "local-user",
    syncConfig: {
      ...createLocalSyncConfigStore({ dataDir, env: {} }),
      resolveRemotePersistence: async () => ({
        appendUpdate: async () => undefined,
        loadProjectMetadata: async () => cloud.metadata,
        saveProjectMetadata,
      }),
    },
    cloudAdmission: {
      admit: async request => ({
        schemaVersion: 1, syncBaseUrl: "https://cloud.example.com",
        admission: {
          schemaVersion: 1, projectId: request.projectId, localReplicaId: request.localReplicaId,
          tenantId: "tenant-1", userId: "local-user", syncBaseUrl: "https://cloud.example.com", status: "pending",
          capabilities: { canvas: true, projectMetadata: true, resources: true },
          admittedAt: null, updatedAt: "2026-09-04T00:00:00Z", lastError: null,
        },
      }),
    },
  });
  const json = { "content-type": "application/json" };
  const join = async (projectId: string) => {
    expect((await app.request(`/api/v1/projects/${projectId}/initialize`, {
      method: "POST", headers: json, body: JSON.stringify({ name: "wsB2" }),
    })).status).toBe(201);
    expect((await app.request(`/api/v1/projects/${projectId}/cloud-admission`, {
      method: "POST", headers: json, body: "{}",
    })).status).toBe(201);
  };
  const localProject = async (projectId: string) => (await createLocalMetadataStore(dataDir).load()).projects.find(project => project.id === projectId);
  return { app, cloud, saveProjectMetadata, join, localProject, json };
}

it("adopts the archived state of an existing cloud project instead of resurrecting it with the marker placeholder", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-workspace-registration-archived-"));
  dirs.push(dataDir);
  const projectId = "project-archived";
  const archived: ProjectMetadata = {
    projectId, name: "Election film", description: "Authored on Host A",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", deletedAt: "2026-09-02T00:00:00.000Z",
  };
  const host = cloudJoinedApp(dataDir, archived);
  await host.join(projectId);

  await vi.waitFor(async () => expect(await host.localProject(projectId)).toMatchObject({
    name: archived.name, description: archived.description,
    updatedAt: archived.updatedAt, deletedAt: archived.deletedAt,
  }));
  expect(host.saveProjectMetadata).not.toHaveBeenCalled();
  expect(host.cloud.metadata).toEqual(archived);
  // The adopted Project is archived for local readers too.
  expect((await host.app.request(`/api/v1/projects/${projectId}`)).status).toBe(404);
});

// A placeholder that seeded an empty cloud Project is still provisional. Every
// local metadata edit must end that, or the next mirror would adopt the stale
// cloud copy and silently undo the edit.
it.each([
  {
    edit: "rename",
    request: (projectId: string) => [`/api/v1/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed on Host B" }) }] as const,
    expected: { name: "Renamed on Host B", deletedAt: null },
  },
  {
    edit: "archive",
    request: (projectId: string) => [`/api/v1/projects/${projectId}`, { method: "DELETE", body: "{}" }] as const,
    expected: { name: "wsB2", deletedAt: expect.any(String) },
  },
])("keeps a local $edit of a placeholder that seeded the cloud project", async ({ request, expected }) => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-workspace-registration-seeded-"));
  dirs.push(dataDir);
  const projectId = "project-seeded";
  const host = cloudJoinedApp(dataDir, null);
  await host.join(projectId);
  await vi.waitFor(() => expect(host.cloud.metadata).toMatchObject({ name: "wsB2", deletedAt: null }));
  // Synced timestamps have second resolution; age the seeded copy so the edit
  // below cannot tie with it and fall through to the canonical tie-breaker.
  host.cloud.metadata = { ...host.cloud.metadata!, updatedAt: "2026-09-01T00:00:00.000Z" };

  const [path, init] = request(projectId);
  expect((await host.app.request(path, { ...init, headers: host.json })).status).toBe(200);
  await vi.waitFor(() => expect(host.cloud.metadata).toMatchObject(expected));
  expect(await host.localProject(projectId)).toMatchObject(expected);
  expect(await host.localProject(projectId)).not.toHaveProperty("metadataProvisional");
});
