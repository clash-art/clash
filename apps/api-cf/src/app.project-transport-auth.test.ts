import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
