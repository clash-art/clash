import { getLocalReplicaId } from "./local-replica-identity.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudReplicaLinkState } from "./loro/cloud-replica-link";
import { createLocalSyncConfigStore } from "./sync-config";
import { createLocalMetadataStore } from "./local-metadata-store";
import { createClashUserConfigStore } from "./user-config";

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-sync-config-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("local sync config", () => {
  it("stores sync intent in config.yaml and the token in owner-only credentials", async () => {
    const removedSyncSidecar = String.fromCharCode(
      115,
      121,
      110,
      99,
      46,
      106,
      115,
      111,
      110,
    );
    const store = createLocalSyncConfigStore({ dataDir, env: {} });

    await store.updateFromRequest({
      mode: "cloud-sync",
      remote_loro_url: "https://sync.example",
      remote_loro_token: "secret-token",
    });

    await expect(stat(join(dataDir, removedSyncSidecar))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    const configInfo = await stat(join(dataDir, "config.yaml"));
    const credentialsInfo = await stat(join(dataDir, "credentials.json"));
    expect(configInfo.mode & 0o777).toBe(0o600);
    expect(credentialsInfo.mode & 0o777).toBe(0o600);
    const configText = await readFile(join(dataDir, "config.yaml"), "utf8");
    expect(configText).toContain("https://sync.example");
    expect(configText).not.toContain("secret-token");
    await expect(
      readFile(join(dataDir, "credentials.json"), "utf8"),
    ).resolves.toContain("secret-token");
    await expect(stat(join(dataDir, "local.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.getPublicConfig()).resolves.toMatchObject({
      remote_loro: {
        has_token: true,
        source: "config",
      },
    });
    await expect(
      createLocalSyncConfigStore({ dataDir, env: {} }).getPublicConfig(),
    ).resolves.toMatchObject({
      remote_loro: {
        has_token: true,
        source: "config",
      },
    });
  });

  it("stores explicit sync capability readiness separately from remote credentials", async () => {
    const store = createLocalSyncConfigStore({ dataDir, env: {} });

    await store.updateFromRequest({
      mode: "cloud-sync",
      remote_loro_url: "https://sync.example",
      capabilities: {
        canvas: true,
        asset_metadata: true,
        revision_content: true,
        project_metadata: true,
      },
    });

    await expect(store.getPublicConfig()).resolves.toMatchObject({
      mode: "cloud-sync",
      capabilities: {
        canvas: true,
        asset_metadata: true,
        revision_content: true,
        project_metadata: true,
      },
    });
  });

  it("keeps project metadata sync disabled by default", async () => {
    const store = createLocalSyncConfigStore({ dataDir, env: {} });

    await expect(store.getPublicConfig()).resolves.toMatchObject({
      mode: "local-only",
      capabilities: {
        project_metadata: false,
      },
    });
  });

  it("resolves an admitted project without enabling the global cloud switch", async () => {
    const metadataStore = createLocalMetadataStore(dataDir);
    await metadataStore.upsertProjectCloudAdmission({
      schemaVersion: 1,
      projectId: "project-1",
      tenantId: "personal:user-1",
      userId: "user-1",
      localReplicaId: await getLocalReplicaId(dataDir),
      syncBaseUrl: "https://cloud.example",
      status: "pending",
      capabilities: { canvas: true, projectMetadata: true, resources: true },
      admittedAt: null,
      updatedAt: "2026-09-04T00:00:00.000Z",
      lastError: null,
    });
    await createClashUserConfigStore(dataDir).setSection("server",{url:"https://cloud.example"});
    await createClashUserConfigStore(dataDir).updateCredentials((current) => ({
      ...current,
      cliApiKey: "clsh_test",
    }));
    const fetch = async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://cloud.example/loro/project-1/snapshot");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer clsh_test",
      );
      return new Response(null, { status: 204 });
    };
    const store = createLocalSyncConfigStore({ dataDir, env: {}, fetch });
    await expect(store.getPublicConfig()).resolves.toMatchObject({
      mode: "local-only",
    });
    const remote = await store.resolveRemotePersistence("project-1");
    await expect(remote?.loadSnapshot?.("project-1")).resolves.toBeNull();
  });
});

it("never resolves a global transport for an unadmitted Project or another replica", async () => {
  const store = createLocalSyncConfigStore({ dataDir, env: { CLASH_REMOTE_LORO_URL: "https://cloud.example" } });
  expect(await store.resolveRemotePersistence("private-project")).toBeUndefined();
  expect(await store.resolveRemotePersistence()).toBeUndefined();
  await createLocalMetadataStore(dataDir).upsertProjectCloudAdmission({
    schemaVersion: 1, projectId: "private-project", tenantId: "t", userId: "u", localReplicaId: "old-process",
    syncBaseUrl: "https://cloud.example", status: "ready", capabilities: { canvas: true, projectMetadata: true, resources: true },
    admittedAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", lastError: null,
  });
  expect(await store.resolveRemotePersistence("private-project")).toBeUndefined();
});

describe("cloud link admission", () => {
  let server: Server;
  let requests = 0;
  let baseUrl = "";

  beforeEach(async () => {
    requests = 0;
    // Answers every discovery with 503, so the link is always in its retry loop.
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function admittedLink() {
    const { createCloudAccounts } = await import("./cloud-accounts.js");
    const accounts = createCloudAccounts(dataDir);
    await accounts.save(baseUrl, {
      token: "test-token",
      user: { id: "u", name: "User", email: "u@example.test" },
    });
    const metadataStore = createLocalMetadataStore(dataDir);
    const admission = {
      schemaVersion: 1 as const,
      projectId: "p",
      tenantId: "t",
      userId: "u",
      localReplicaId: await getLocalReplicaId(dataDir),
      syncBaseUrl: baseUrl,
      status: "ready" as const,
      capabilities: { canvas: true, projectMetadata: true, resources: true },
      admittedAt: null,
      updatedAt: new Date().toISOString(),
      lastError: null,
    };
    await metadataStore.upsertProjectCloudAdmission(admission);
    const remote = await createLocalSyncConfigStore({
      dataDir,
      env: {},
    }).resolveRemotePersistence("p");
    const states: CloudReplicaLinkState[] = [];
    const commit = vi.fn(async () => {});
    const link = remote!.createLink!({
      projectId: "p",
      doc: () => new LoroDoc(),
      commit,
      onState: (state) => states.push(state),
    });
    const revoke = () =>
      metadataStore.upsertProjectCloudAdmission({
        ...admission,
        status: "local-only",
      });
    return { accounts, link, states, revoke };
  }

  const settled = () => new Promise((resolve) => setTimeout(resolve, 700));

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops retrying with a coded state when admission is revoked offline", async () => {
    const { link, states, revoke } = await admittedLink();
    await link.start();
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        state: "retrying",
        code: "CLOUD_LINK_UNREACHABLE",
        retryAt: expect.any(String),
      }),
    );
    await revoke();
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        state: "stopped",
        code: "CLOUD_LINK_NOT_ADMITTED",
        message: "Project cloud admission was revoked or changed",
      }),
    );
    const attempts = requests;
    await settled();
    expect(requests).toBe(attempts);
    expect(states.at(-1)?.code).toBe("CLOUD_LINK_NOT_ADMITTED");
  });

  it("stops retrying when the account signs out", async () => {
    const { accounts, link, states } = await admittedLink();
    await link.start();
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ state: "retrying" }),
    );
    await accounts.logout(baseUrl);
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        state: "stopped",
        code: "CLOUD_LINK_NOT_ADMITTED",
      }),
    );
    const attempts = requests;
    await settled();
    expect(requests).toBe(attempts);
  });

  it("stops with a coded state when a publish finds admission revoked", async () => {
    const { link, states, revoke } = await admittedLink();
    await link.start();
    await revoke();
    await expect(link.publish(new Uint8Array([1]))).rejects.toThrow(
      "Project cloud admission was revoked or changed",
    );
    expect(states.at(-1)).toMatchObject({
      state: "stopped",
      code: "CLOUD_LINK_NOT_ADMITTED",
    });
    const attempts = requests;
    await settled();
    expect(requests).toBe(attempts);
    // A later publish still rejects but does not report a second stop.
    const reported = states.length;
    await expect(link.publish(new Uint8Array([2]))).rejects.toThrow();
    expect(states).toHaveLength(reported);
  });

  it("does not start a link that was closed during its admission check", async () => {
    const { link, states } = await admittedLink();
    const starting = link.start();
    await link.close();
    await starting;
    await settled();
    expect(requests).toBe(0);
    expect(states.map((state) => state.state)).not.toContain("connecting");
  });

  it("fails start with a coded rejection when admission is already gone", async () => {
    const { link, revoke } = await admittedLink();
    await revoke();
    await expect(link.start()).rejects.toMatchObject({
      code: "CLOUD_LINK_NOT_ADMITTED",
    });
    expect(requests).toBe(0);
  });
});

it('does not create a project transport after its cloud account signs out',async()=>{
 const {createCloudAccounts}=await import('./cloud-accounts.js');
 const accounts=createCloudAccounts(dataDir);
 await accounts.save('https://cloud.example',{token:'test-token',user:{id:'u',name:'User',email:'u@example.test'}});
 await createLocalMetadataStore(dataDir).upsertProjectCloudAdmission({schemaVersion:1,projectId:'p',tenantId:'t',userId:'u',localReplicaId:await getLocalReplicaId(dataDir),syncBaseUrl:'https://cloud.example',status:'ready',capabilities:{canvas:true,projectMetadata:true,resources:true},admittedAt:null,updatedAt:new Date().toISOString(),lastError:null});
 const sync=createLocalSyncConfigStore({dataDir,env:{}});
 expect(await sync.resolveRemotePersistence('p')).toBeDefined();
 await accounts.logout('https://cloud.example');
 expect(await sync.resolveRemotePersistence('p')).toBeUndefined();
});
