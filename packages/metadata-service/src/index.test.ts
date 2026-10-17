import { describe, expect, it } from "vitest";
import {
  DEFERRED_HEADER,
  createMetadataService,
  isMetadataServiceRequest,
  type MetadataServicePorts,
} from "./index.js";
import { createMemoryMetadataPorts, createMemoryMetadataState } from "./memory.js";

const at = (s: string) => new Date(s);
function setup(overrides: Partial<MetadataServicePorts> = {}) {
  const state = createMemoryMetadataState();
  state.sessions.set("s1", "u1");
  state.apiTokens.set("clsh_t1", "u1");
  state.projects.set("p1", {
    id: "p1", ownerId: "u1", tenantId: null, name: "One", description: null,
    createdAt: at("2026-10-01T00:00:00Z"), updatedAt: at("2026-10-02T00:00:00Z"), deletedAt: null,
  });
  state.projects.set("p2", {
    id: "p2", ownerId: "u2", tenantId: null, name: "Other", description: null,
    createdAt: at("2026-10-01T00:00:00Z"), updatedAt: at("2026-10-02T00:00:00Z"), deletedAt: null,
  });
  const service = createMetadataService({ ...createMemoryMetadataPorts(state), ...overrides });
  const call = (path: string, init: RequestInit = {}) =>
    service.handle(new Request(`https://svc.test${path}`, init)) as Promise<Response>;
  return { state, service, call };
}
const cookie = { cookie: "session=s1" };

describe("metadata service routes", () => {
  it("matches only its routes", () => {
    expect(isMetadataServiceRequest("GET", "/api/projects")).toBe(true);
    expect(isMetadataServiceRequest("POST", "/api/projects")).toBe(false);
    expect(isMetadataServiceRequest("GET", "/api/projects/p1/assets")).toBe(false);
    expect(isMetadataServiceRequest("PUT", "/loro/p1/metadata")).toBe(true);
    expect(isMetadataServiceRequest("POST", "/loro/p1/updates")).toBe(false);
    expect(isMetadataServiceRequest("DELETE", "/api/settings/tokens/x")).toBe(false);
  });

  it("lists and gets only the caller's projects", async () => {
    const { call } = setup();
    const list = await call("/api/projects", { headers: cookie });
    expect(list.status).toBe(200);
    expect((await list.json()).map((p: { id: string }) => p.id)).toEqual(["p1"]);
    expect((await call("/api/projects/p2", { headers: cookie })).status).toBe(404);
    const one = await (await call("/api/projects/p1", { headers: cookie })).json();
    expect(one).toMatchObject({ id: "p1", assets: [], assetCount: 0 });
  });

  it("keeps api-cf's 401 shapes and session-only semantics", async () => {
    const { call } = setup();
    expect(await (await call("/api/projects")).json()).toEqual({ error: "Unauthorized" });
    expect(await (await call("/api/projects/p1")).text()).toBe("Unauthorized");
    expect((await call("/api/projects", { headers: { authorization: "Bearer clsh_t1" } })).status).toBe(401);
    expect((await call("/api/v1/projects/p1", { headers: { authorization: "Bearer clsh_t1" } })).status).toBe(200);
    expect(await (await call("/api/v1/projects/p1")).json()).toEqual({ error: "unauthorized" });
    expect(
      await (await call("/api/v1/projects/p1", { headers: { "x-clash-require-identity": "1" } })).json(),
    ).toEqual({ error: "Unauthorized" });
  });

  it("replicates metadata with LWW, 409 stale, 413 oversize, owner only", async () => {
    const { call } = setup();
    const get = await call("/loro/p1/metadata", { headers: cookie });
    const { metadata } = await get.json();
    const put = (m: unknown, headers: Record<string, string> = cookie) =>
      call("/loro/p1/metadata", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, metadata: m }) });
    expect((await put({ ...metadata, name: "Renamed", updatedAt: "2026-10-03T00:00:00.000Z" })).status).toBe(204);
    const stale = await put({ ...metadata, name: "Old", updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).metadata.name).toBe("Renamed");
    expect((await put({ ...metadata, name: "x".repeat(513), updatedAt: "2026-10-04T00:00:00.000Z" })).status).toBe(413);
    expect((await put({ ...metadata, projectId: "p2" })).status).toBe(400);
    expect((await call("/loro/p2/metadata", { headers: cookie })).status).toBe(401);
  });

  it("hands deferred requests to the host unchanged (body intact, marked)", async () => {
    let seen: Request | undefined;
    const { call } = setup({
      identity: { verify: async () => "defer" },
      authorizer: { authorize: async () => "defer" },
      defer: async (request) => {
        seen = request;
        return new Response(await request.text(), { status: 299 });
      },
    });
    const res = await call("/loro/p1/metadata", { method: "PUT", body: "{\"x\":1}", headers: cookie });
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("{\"x\":1}");
    expect(seen?.headers.get(DEFERRED_HEADER)).toBe("1");
    expect((await call("/api/projects", { headers: cookie })).status).toBe(299);
  });

  it("answers 503 for a defer verdict without a host fallback", async () => {
    const { call } = setup({ identity: { verify: async () => "defer" } });
    expect((await call("/api/projects", { headers: cookie })).status).toBe(503);
  });
});
