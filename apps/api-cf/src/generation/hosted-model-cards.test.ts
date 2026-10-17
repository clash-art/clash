import { describe, expect, it } from "vitest";
import { listModelCatalogEntries, buildEffectiveModelCards } from "@clash/shared-types";

import { hostedBaseModelCards } from "./hosted-model-cards";
import { isExecutablePluginProviderRoute } from "./plugin-provider-adapter";

describe("hosted model cards", () => {
  it("compose clash.fal bindings so a fal account routes through the plugin executor", async () => {
    const baseModels = await hostedBaseModelCards();
    const flux = baseModels.find((model) => model.id === "flux-schnell");
    const falImplementation = flux?.providerImplementations?.find(
      (implementation) => implementation.executorPluginId === "clash.fal",
    );
    expect(falImplementation).toMatchObject({
      executorPluginId: "clash.fal",
      executorExportId: expect.any(String),
      upstreamModel: "fal-ai/flux/schnell",
    });

    const configuredProviders = [
      {
        id: "acct-fal",
        providerId: falImplementation!.providerId,
        ...(falImplementation!.upstreamId ? { upstreamId: falImplementation!.upstreamId } : {}),
        enabled: true,
        configuredCredentials: ["apiKey"],
      },
    ];
    const entry = listModelCatalogEntries({
      models: buildEffectiveModelCards({ providers: configuredProviders as never, baseModels }),
      configuredProviders: configuredProviders as never,
    }).find((candidate) => candidate.model.id === "flux-schnell");
    expect(isExecutablePluginProviderRoute(entry?.selectedRoute ?? undefined)).toBe(true);
  });

  it("is memoised: plugin documents are composed once per isolate", async () => {
    expect(await hostedBaseModelCards()).toBe(await hostedBaseModelCards());
  });
});
