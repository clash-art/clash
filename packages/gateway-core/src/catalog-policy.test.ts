import { describe, expect, it } from "vitest";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";

import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import { planGatewayRoutes } from "./routing.js";

const account = {
  id: "official-compatible",
  providerId: "official",
  upstreamId: "openai",
  apiShape: "openai-compatible",
  configuredCredentials: ["apiKey"],
};

function card(modelId: string, upstreamModels: string[]) {
  return buildEffectiveModelCards({
    baseModels: [],
    providers: [account],
    configs: [
      {
        modelId,
        custom: true,
        name: modelId,
        kind: "text",
        providerBindings: upstreamModels.map((upstreamModel) => ({
          providerAccountId: account.id,
          upstreamModel,
        })),
      },
    ],
  });
}

const plan = (models: ReturnType<typeof card>, modelCode: string) =>
  planGatewayRoutes({
    modelCode,
    catalog: applyGatewayCatalogPolicy({ version: "policy", models }).catalog,
    scope: "official",
    providers: [account],
  });

describe("applyGatewayCatalogPolicy (DeepSeek Flash only)", () => {
  it("drops a DeepSeek card that is not a Flash card", () => {
    const models = card("deepseek-house-pro", ["deepseek-house-pro"]);
    expect(models).toHaveLength(1);
    const { excluded } = applyGatewayCatalogPolicy({ version: "policy", models });
    expect(excluded).toEqual([{ modelCode: "deepseek-house-pro", reason: "deepseek-not-flash" }]);
    expect(() => plan(models, "deepseek-house-pro")).toThrowError(
      expect.objectContaining({ code: "GATEWAY_MODEL_NOT_FOUND" }),
    );
  });

  it("keeps a Flash card but removes its non-Flash upstream implementations", () => {
    const models = card("deepseek-flash", ["deepseek-reasoner", "deepseek-flash-upstream"]);
    const routes = plan(models, "deepseek-flash").attempts.map((attempt) => attempt.route.upstreamModel);
    expect(routes).toEqual(["deepseek-flash-upstream"]);
  });

  it("drops a card that reaches DeepSeek only through a non-Flash upstream model", () => {
    const models = card("house-chat", ["deepseek-chat"]);
    expect(applyGatewayCatalogPolicy({ version: "policy", models }).catalog.models).toEqual([]);
  });

  it("leaves non-DeepSeek cards untouched", () => {
    const models = card("house-chat", ["some-model"]);
    expect(applyGatewayCatalogPolicy({ version: "policy", models }).catalog.models).toEqual(models);
  });
});
