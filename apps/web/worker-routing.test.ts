import { describe, expect, it } from "vitest";
import worker, { type Env } from "./workers/app";

function gatewayEnv(): Env {
  return {
    ASSETS: {
      fetch: async () => new Response("static boundary", { status: 404 }),
    },
    API_CF: {
      fetch: async () => new Response("api boundary", { status: 418 }),
    },
  } as unknown as Env;
}

describe("web worker Asset routing boundary", () => {
  it.each(["snapshot", "updates", "metadata"])(
    "routes Project Loro %s to the authenticated API boundary",
    async (suffix) => {
      const response = await worker.fetch(
        new Request(`https://clash.test/loro/project/${suffix}`),
        gatewayEnv(),
      );
      expect(response.status).toBe(418);
    },
  );
  it("does not carve anonymous upload out to api-cf", async () => {
    const response = await worker.fetch(
      new Request("https://clash.test/upload", { method: "POST" }),
      gatewayEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("static boundary");
  });

  it("keeps signed Asset delivery isolated as a transport route", async () => {
    const response = await worker.fetch(
      new Request("https://clash.test/assets/capability?exp=1&sig=opaque"),
      gatewayEnv(),
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("api boundary");
  });
});

describe("cloud browser login gateway", () => {
  it.each([
    ["/api/v1/cloud", "GET"],
    ["/api/v1/cli-auth/token", "POST"],
  ])(
    "forwards public protocol endpoint %s without accepting caller identity",
    async (path, method) => {
      const env = gatewayEnv();
      let received: Request | undefined;
      env.API_CF = {
        fetch: async (request) => {
          received = request;
          return new Response("backend validated", { status: 200 });
        },
      };
      const response = await worker.fetch(
        new Request("https://clash.test" + path, {
          method,
          headers: { "x-user-id": "forged" },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(received?.headers.has("x-user-id")).toBe(false);
    },
  );
  it.each([
    "/api/v1/cloud/account",
    "/api/v1/cli-auth/authorize",
    "/api/v1/projects",
  ])("still requires authentication for %s", async (path) => {
    const response = await worker.fetch(
      new Request("https://clash.test" + path, {
        headers: { "x-user-id": "forged" },
      }),
      gatewayEnv(),
    );
    expect(response.status).toBe(401);
  });
});
