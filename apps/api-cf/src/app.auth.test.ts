import { beforeEach, describe, expect, it, vi } from "vitest";
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
const env = { DB: {} as D1Database } as Env;

describe("public API identity middleware", () => {
  beforeEach(() => {
    tokenIdentity.mockReset().mockResolvedValue(null);
    sessionIdentity.mockReset().mockResolvedValue(null);
  });

  it("strips a client-supplied x-user-id when no credential validates", async () => {
    const response = await createApp().request(
      "/api/v1/me",
      {
        headers: { "x-user-id": "attacker" },
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it("overwrites a spoofed identity with the validated clsh_ token owner", async () => {
    tokenIdentity.mockResolvedValue("token-owner");
    const response = await createApp().request(
      "/api/v1/me",
      {
        headers: {
          authorization: "Bearer clsh_valid",
          "x-user-id": "attacker",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "token-owner" });
    expect(tokenIdentity).toHaveBeenCalledTimes(1);
  });

  it("overwrites a spoofed identity with the validated Better Auth session user", async () => {
    sessionIdentity.mockResolvedValue("session-owner");
    const response = await createApp().request(
      "/api/v1/me",
      {
        headers: {
          cookie: "better-auth.session_token=signed",
          "x-user-id": "attacker",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "session-owner" });
  });

  it("does not accept API tokens from query parameters", async () => {
    tokenIdentity.mockResolvedValue("query-token-owner");
    const response = await createApp().request(
      "/api/v1/me?token=clsh_leaked",
      {},
      env,
    );

    expect(response.status).toBe(401);
    expect(tokenIdentity).not.toHaveBeenCalled();
  });

  it("fails closed without restoring a spoofed identity when validation errors", async () => {
    sessionIdentity.mockRejectedValue(
      new Error("auth configuration unavailable"),
    );
    const response = await createApp().request(
      "/api/v1/me",
      {
        headers: { "x-user-id": "attacker" },
      },
      env,
    );

    expect(response.status).toBe(401);
  });
});

it('exposes cloud compatibility without auth and rejects a forged account identity',async()=>{
 tokenIdentity.mockResolvedValue(null);sessionIdentity.mockResolvedValue(null);
 const app=createApp();
 const info=await app.request('/api/v1/cloud',{},env);
 expect(info.status).toBe(200);
 const {CloudServiceSchema}=await import('@clash/shared-types');
 expect(CloudServiceSchema.safeParse(await info.json()).success).toBe(true);
 const account=await app.request('/api/v1/cloud/account',{headers:{'x-user-id':'forged'}},env);
 expect(account.status).toBe(401);
});
