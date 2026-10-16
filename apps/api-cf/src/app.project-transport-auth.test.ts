import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMetadata } from "@clash/shared-types";
import type { Env } from "./config";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("./containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));
vi.mock("./services/session", () => ({
  getUserIdFromApiToken: vi.fn(),
  getUserIdFromRequest: vi.fn(),
}));

import { createApp } from "./app";
import {
  getUserIdFromApiToken,
  getUserIdFromRequest,
} from "./services/session";

const tokenIdentity = vi.mocked(getUserIdFromApiToken);
const sessionIdentity = vi.mocked(getUserIdFromRequest);

import { SignJWT } from "jose";

// Exercise the real router and JWT/project authorization. Only external
// session HTTP, D1 and DO transport are replaced at their I/O boundaries.
describe("public project transport authorization", () => {
  const secret = "transport-test-signing-secret";
  let forwarded: Request[];
  let bindings: Env;

  beforeEach(() => {
    forwarded = [];
    tokenIdentity.mockReset().mockResolvedValue(null);
    sessionIdentity.mockReset().mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    const namespace = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (request: Request) => {
          forwarded.push(request);
          return new Response("room reached");
        },
      }),
    };
    bindings = {
      ENVIRONMENT: "production",
      JWT_SECRET: secret,
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [{ owner_id: "owner" }] }),
          }),
        }),
      },
      ROOM: namespace,
      SUPERVISOR: namespace,
    } as unknown as Env;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function token(userId = "owner", projectId = "project") {
    return new SignJWT({ projectId })
      .setSubject(userId)
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));
  }

  for (const path of ["/sync/project", "/agents/supervisor/project:thread"]) {
    it(`fails closed when the authority database is absent at ${path}`, async () => {
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${await token()}`,
          },
        },
        { ...bindings, DB: undefined } as unknown as Env,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });
    it(`denies a soft-deleted project at ${path}`, async () => {
      const deletedBindings = {
        ...bindings,
        DB: {
          prepare: () => ({
            bind: () => ({
              all: async () => ({
                results: [{ owner_id: "owner", deleted_at: 1 }],
              }),
            }),
          }),
        },
      } as unknown as Env;
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${await token()}`,
          },
        },
        deletedBindings,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });

    it(`rejects anonymous access to ${path} even with forged internal identity`, async () => {
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            "x-internal-agent": "true",
            "x-user-id": "owner",
          },
        },
        bindings,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });
    it(`rejects another project's user at ${path}`, async () => {
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${await token("other")}`,
          },
        },
        bindings,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });
    it(`rejects a token for another project at ${path}`, async () => {
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${await token("owner", "other")}`,
          },
        },
        bindings,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });
    it(`allows the owner at ${path} without forwarding forged privilege headers`, async () => {
      const response = await createApp().request(
        path,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${await token()}`,
            "x-internal-agent": "true",
            "x-internal-loro": "true",
            "x-loro-project-id": "victim",
            "x-partykit-props": '{"privileged":true}',
            "x-user-id": "victim",
          },
        },
        bindings,
      );
      expect(await response.text()).toBe("room reached");
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].headers.get("x-internal-agent")).toBeNull();
      expect(forwarded[0].headers.get("x-internal-loro")).toBeNull();
      expect(forwarded[0].headers.get("x-loro-project-id")).toBeNull();
      expect(forwarded[0].headers.get("x-partykit-props")).toBeNull();
      expect(forwarded[0].headers.get("x-user-id")).toBe("owner");
    });
  }

  for (const [method, suffix] of [
    ["GET", "nodes"],
    ["GET", "loro-dump"],
    ["POST", "update-node"],
    ["POST", "reset-doc"],
  ]) {
    it(`never exposes internal ${suffix} through public sync, even to an owner`, async () => {
      const response = await createApp().request(
        `/sync/project/${suffix}`,
        {
          method,
          headers: {
            authorization: `Bearer ${await token()}`,
            "x-internal-agent": "true",
            Upgrade: "websocket",
          },
        },
        bindings,
      );
      expect(response.status).toBe(404);
      expect(forwarded).toEqual([]);
    });
  }

  // Issue #83: the tombstone travels in Project metadata, so the owner of a
  // soft-deleted Project must still read and rewrite it while every content
  // transport stays closed.
  describe("soft-deleted project metadata", () => {
    function deleted(ownerId = "owner") {
      let metadata: ProjectMetadata = {
        projectId: "project",
        name: "Project",
        description: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        deletedAt: "2026-09-02T00:00:00.000Z",
      };
      const app = createApp({
        projectMetadataStore: () => ({
          read: async () => metadata,
          write: async (next) => {
            if (Date.parse(next.updatedAt) < Date.parse(metadata.updatedAt)) {
              return { status: "stale", current: metadata };
            }
            metadata = next;
            return { status: "written" };
          },
        }),
      });
      const env = {
        ...bindings,
        DB: {
          prepare: () => ({
            bind: () => ({
              all: async () => ({
                results: [{ owner_id: ownerId, deleted_at: 1 }],
              }),
            }),
          }),
        },
      } as unknown as Env;
      return { app, env, read: () => metadata };
    }

    it("lets the owner pull the tombstone and push a restore at the same timestamp", async () => {
      const { app, env, read } = deleted();
      const authorization = `Bearer ${await token()}`;
      const pulled = await app.request(
        "/loro/project/metadata",
        { headers: { authorization } },
        env,
      );
      expect(pulled.status).toBe(200);
      const envelope = (await pulled.json()) as { metadata: ProjectMetadata };
      expect(envelope.metadata).toEqual(read());

      const restored = { ...read(), deletedAt: null };
      const pushed = await app.request(
        "/loro/project/metadata",
        {
          method: "PUT",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, metadata: restored }),
        },
        env,
      );
      expect(pushed.status).toBe(204);
      expect(read()).toEqual(restored);
    });

    it("rejects a stale metadata push with the current envelope", async () => {
      const { app, env, read } = deleted();
      const current = read();
      const response = await app.request(
        "/loro/project/metadata",
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${await token()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schemaVersion: 1,
            metadata: {
              ...current,
              name: "Stale",
              updatedAt: current.createdAt,
            },
          }),
        },
        env,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Project metadata is stale",
        schemaVersion: 1,
        metadata: current,
      });
      expect(read()).toEqual(current);
    });

    it("rejects oversized metadata with 413 and leaves the row unchanged", async () => {
      const { app, env, read } = deleted();
      const before = read();
      const authorization = `Bearer ${await token()}`;
      for (const metadata of [
        { ...before, description: "a".repeat(64 * 1024 + 1) },
        { ...before, name: "n".repeat(513) },
      ]) {
        const pushed = await app.request(
          "/loro/project/metadata",
          {
            method: "PUT",
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify({ schemaVersion: 1, metadata }),
          },
          env,
        );
        expect(pushed.status).toBe(413);
      }
      expect(read()).toEqual(before);
    });

    it("still denies another user", async () => {
      const { app, env } = deleted("someone-else");
      const response = await app.request(
        "/loro/project/metadata",
        { headers: { authorization: `Bearer ${await token()}` } },
        env,
      );
      expect(response.status).toBe(401);
    });

    it("keeps the snapshot closed", async () => {
      const { app, env } = deleted();
      const response = await app.request(
        "/loro/project/snapshot",
        { headers: { authorization: `Bearer ${await token()}` } },
        env,
      );
      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    });
  });
});
