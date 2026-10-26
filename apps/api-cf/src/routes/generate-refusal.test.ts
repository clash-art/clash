/** A generation the gateway refuses at enqueue answers with its gateway code (#359), never a bare 500. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@clash/gateway-core";

const startGeneration = vi.fn();
vi.mock("../generation/start", () => ({ startGeneration: (...args: unknown[]) => startGeneration(...args) }));

import { api } from "./index";

const submit = () =>
  api.request(
    "/api/generate/image",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "user-1" },
      body: JSON.stringify({ prompt: "a lighthouse", project_id: "project-1", asset_id: "node-1", asset_name: "node" }),
    },
    {} as never,
  );

describe("POST /api/generate/image refusals", () => {
  afterEach(() => startGeneration.mockReset());

  it("answers a gateway refusal with its status and code", async () => {
    for (const code of ["GATEWAY_BUDGET_EXCEEDED", "GATEWAY_FORBIDDEN", "GATEWAY_PRICE_UNAVAILABLE"] as const) {
      const refusal = new GatewayError(code);
      startGeneration.mockRejectedValueOnce(refusal);
      const response = await submit();
      expect(response.status).toBe(refusal.status);
      expect(await response.json()).toEqual({ error: refusal.message, code });
    }
  });

  it("keeps any other failure a generic 500", async () => {
    for (const error of [new Error("workflow unavailable"), new GatewayError("GATEWAY_INTERNAL")]) {
      startGeneration.mockRejectedValueOnce(error);
      const response = await submit();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to start generation task" });
    }
  });
});
