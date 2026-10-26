/**
 * #360 local-api + mock upstream (REPORT “Reuse (no new harness)”).
 * Host-side handoff: drive createGatewayApp on loopback with vi.stubGlobal("fetch")
 * so the Host never needs a real cloud gateway for multi-tenant auth/key checks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayApp,
  GATEWAY_REQUEST_ID_HEADER,
} from "@clash/gateway-core";
import { createMemoryGatewayPorts } from "@clash/gateway-core/testing";
import { catalogFixture } from "../../../packages/gateway-core/src/testing/fixtures.js";

const fixture = catalogFixture();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#360 local-api host handoff against mock upstream", () => {
  it("authenticates a tenant token, sends the official key upstream, and never echoes secrets", async () => {
    const seen: string[] = [];
    const memory = createMemoryGatewayPorts({
      identities: {
        "tenant-a": {
          tenantId: "tenant-a",
          userId: "user-a",
          keyId: "key-a",
          budgetIds: ["budget-a"],
          credentialScope: "official",
        },
      },
      catalog: fixture.catalog,
      providers: fixture.providers,
      keys: fixture.keys,
      prices: [
        {
          modelCode: fixture.textModel,
          version: "local-api-mt",
          maxOutputTokens: 64,
          rates: [
            { unit: "input_token", microCredits: 1_000_000, per: 1_000_000 },
            { unit: "output_token", microCredits: 2_000_000, per: 1_000_000 },
          ],
        },
      ],
      budgets: [
        {
          id: "budget-a",
          tenantId: "tenant-a",
          scope: "tenant",
          scopeId: "tenant-a",
          limitMicroCredits: 50_000_000,
          spentMicroCredits: 0,
          reservedMicroCredits: 0,
          version: 0,
        },
      ],
      upstream: {
        async fetch(request) {
          seen.push(request.headers.get("authorization") ?? "");
          return Response.json({
            model: "x",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
        },
      },
    });
    const app = createGatewayApp(memory.ports, { basePath: "/gateway" });
    // Host would normally call fetch(cloudGatewayUrl); stub proves the same contract locally.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)));

    const res = await fetch("https://gateway.local/gateway/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tenant-a" },
      body: JSON.stringify({
        model: fixture.textModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get(GATEWAY_REQUEST_ID_HEADER)).toMatch(/\S/);
    expect(seen).toEqual([`Bearer ${fixture.keys["official-openai"]}`]);
    expect(JSON.stringify(seen)).not.toContain("tenant-a");
  });

  it("rejects an anonymous Host call with GATEWAY_AUTH_REQUIRED before any upstream contact", async () => {
    let contacted = false;
    const memory = createMemoryGatewayPorts({
      identities: {},
      catalog: fixture.catalog,
      providers: fixture.providers,
      keys: fixture.keys,
      prices: [
        {
          modelCode: fixture.textModel,
          version: "local-api-mt",
          rates: [{ unit: "input_token", microCredits: 1, per: 1 }],
        },
      ],
      budgets: [],
      upstream: {
        async fetch() {
          contacted = true;
          return new Response("no", { status: 500 });
        },
      },
    });
    const app = createGatewayApp(memory.ports, { basePath: "/gateway" });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)));
    const res = await fetch("https://gateway.local/gateway/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: fixture.textModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      }),
    });
    expect([res.status, res.headers.get("x-clash-error-code")]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
    expect(contacted).toBe(false);
  });
});
