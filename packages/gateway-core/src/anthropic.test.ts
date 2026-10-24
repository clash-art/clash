import { describe, expect, it } from "vitest";
import { buildEffectiveModelCards, type ModelUpstreamRoute, type ProviderAccountAvailability } from "@clash/shared-types/model-routing";

import {
  anthropicCredentialRequest,
  anthropicUpstreamHeaders,
  isAnthropicMessagesRoute,
  resolveAnthropicModelCode,
} from "./anthropic.js";
import { isGatewayError } from "./errors.js";
import type { GatewayCatalog } from "./routing.js";

const accounts: ProviderAccountAvailability[] = [
  { id: "anthropic", providerId: "official", upstreamId: "anthropic", apiShape: "anthropic-compatible", configuredCredentials: ["apiKey"] },
  { id: "openai", providerId: "official", upstreamId: "openai", apiShape: "openai-compatible", configuredCredentials: ["apiKey"] },
];

/** Text cards bound as `[code, account id, upstream model]`. */
function catalog(bindings: Array<[string, string, string]>, aliases: Record<string, string[]> = {}): GatewayCatalog {
  const codes = [...new Set(bindings.map(([code]) => code))];
  const models = buildEffectiveModelCards({
    baseModels: [],
    providers: accounts,
    configs: codes.map((code) => ({
      modelId: code,
      custom: true,
      name: code,
      kind: "text" as const,
      providerBindings: bindings
        .filter(([candidate]) => candidate === code)
        .map(([, providerAccountId, upstreamModel]) => ({ providerAccountId, upstreamModel })),
    })),
  }).map((card) => ({ ...card, aliases: aliases[card.id] ?? card.aliases }));
  return { version: "anthropic-test", models };
}

describe("resolveAnthropicModelCode", () => {
  const upstream = "agent-model-a";
  const served = catalog([
    ["public-a", "anthropic", upstream],
    ["public-b", "anthropic", `${upstream}-b-20250101`],
    ["public-openai", "openai", "agent-model-openai"],
  ]);

  it("keeps a public code and leaves an unknown id for planning to refuse", () => {
    expect(resolveAnthropicModelCode("public-a", served)).toBe("public-a");
    expect(resolveAnthropicModelCode("no-such-model", served)).toBe("no-such-model");
  });

  it("maps an agent's model id to the card whose anthropic-compatible route serves it, dated or not", () => {
    expect(resolveAnthropicModelCode(upstream, served)).toBe("public-a");
    expect(resolveAnthropicModelCode(` ${upstream} `, served)).toBe("public-a");
    // A snapshot of the same family, and the undated family name of a dated binding.
    expect(resolveAnthropicModelCode(`${upstream}-20991231`, served)).toBe("public-a");
    expect(resolveAnthropicModelCode(`${upstream}-b`, served)).toBe("public-b");
  });

  it("never maps through an OpenAI-compatible binding", () => {
    expect(resolveAnthropicModelCode("agent-model-openai", served)).toBe("agent-model-openai");
  });

  it("maps a catalog alias, and an alias settles an upstream model several cards share", () => {
    const shared = catalog([
      ["public-x", "anthropic", upstream],
      ["public-y", "anthropic", upstream],
    ]);
    let caught: unknown;
    try {
      resolveAnthropicModelCode(upstream, shared);
    } catch (error) {
      caught = error;
    }
    expect(isGatewayError(caught) && caught.code).toBe("GATEWAY_MODEL_NOT_FOUND");
    expect(isGatewayError(caught) && caught.details?.candidates).toEqual(["public-x", "public-y"]);

    const aliased = catalog(
      [
        ["public-x", "anthropic", upstream],
        ["public-y", "anthropic", upstream],
      ],
      { "public-y": [upstream] },
    );
    expect(resolveAnthropicModelCode(upstream, aliased)).toBe("public-y");
  });
});

describe("isAnthropicMessagesRoute", () => {
  const route = (overrides: Partial<ModelUpstreamRoute>): ModelUpstreamRoute => ({
    modelCode: "public-a",
    kind: "text",
    upstreamId: "anthropic",
    upstreamModel: "agent-model-a",
    apiShape: "anthropic-compatible",
    priority: 1,
    ...overrides,
  });

  it("executes plain anthropic-compatible text routes only, and never a DeepSeek one", () => {
    expect(isAnthropicMessagesRoute(route({}))).toBe(true);
    expect(isAnthropicMessagesRoute(route({ apiShape: "openai-compatible" }))).toBe(false);
    expect(isAnthropicMessagesRoute(route({ kind: "image" }))).toBe(false);
    expect(isAnthropicMessagesRoute(route({ executorPluginId: "plugin" }))).toBe(false);
    for (const deepseek of [{ modelCode: "deepseek-flash" }, { upstreamModel: "deepseek-v4-flash" }, { upstreamId: "deepseek" }])
      expect(isAnthropicMessagesRoute(route(deepseek)), JSON.stringify(deepseek)).toBe(false);
  });
});

describe("anthropicCredentialRequest", () => {
  const credential = (headers: Record<string, string>) =>
    anthropicCredentialRequest(new Request("https://gw.test/gateway/anthropic/v1/messages", { method: "POST", headers }));

  it("takes the Bearer token, else x-api-key, and passes on nothing else", () => {
    const both = credential({ authorization: "Bearer sk_gw_bearer", "x-api-key": "sk_gw_key", "x-user-id": "spoofed" });
    expect(both.headers.get("authorization")).toBe("Bearer sk_gw_bearer");
    const names: string[] = [];
    both.headers.forEach((_value, name) => names.push(name));
    expect(names).toEqual(["authorization"]);
    expect(credential({ "x-api-key": "sk_gw_key" }).headers.get("authorization")).toBe("Bearer sk_gw_key");
    // claude-agent-acp sets a blank ANTHROPIC_AUTH_TOKEN; a token-less Bearer header is not a credential.
    expect(credential({ authorization: "Bearer  ", "x-api-key": "sk_gw_key" }).headers.get("authorization")).toBe("Bearer sk_gw_key");
    expect(credential({}).headers.get("authorization")).toBeNull();
  });
});

describe("anthropicUpstreamHeaders", () => {
  it("sends the gateway key and forwards only the caller's protocol headers", () => {
    const caller = new Headers({
      authorization: "Bearer sk_gw_caller",
      "x-api-key": "sk_gw_caller",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "x-app": "cli",
    });
    expect(anthropicUpstreamHeaders("sk-upstream", caller, true)).toEqual({
      "x-api-key": "sk-upstream",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
      accept: "text/event-stream",
    });
  });

  it("names Anthropic's current API version when the caller names none", () => {
    // https://docs.anthropic.com/en/api/versioning: 2023-06-01 is the current version.
    expect(anthropicUpstreamHeaders("sk-upstream", new Headers(), false)["anthropic-version"]).toBe("2023-06-01");
  });
});
