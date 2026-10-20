/**
 * Test catalog built through shared-types itself: a custom text card from
 * `buildEffectiveModelCards` (the configurable-catalog path) bound to official
 * and tenant accounts, plus, when the built-in catalog has one, an image card
 * with an official route. No value here is asserted by tests; they compare
 * gateway results against the shared resolver's own answers.
 */
import {
  buildEffectiveModelCards,
  listDeclaredModelUpstreamRoutes,
  type ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import type { GatewayModelKind } from "../request.js";
import type { GatewayCatalog, GatewayCredentialScope, GatewayModelCard } from "../routing.js";

export const TEXT_MODEL = "gateway-fixture-chat";

export interface CatalogFixture {
  catalog: GatewayCatalog;
  providers: Record<GatewayCredentialScope, ProviderAccountAvailability[]>;
  keys: Record<string, string>;
  textModel: string;
  mediaModel?: { code: string; kind: GatewayModelKind };
}

export function catalogFixture(): CatalogFixture {
  const official: ProviderAccountAvailability[] = [
    {
      id: "official-openai",
      providerId: "official",
      upstreamId: "openai",
      apiShape: "openai-compatible",
      configuredCredentials: ["apiKey"],
    },
    {
      id: "official-anthropic",
      providerId: "official",
      upstreamId: "anthropic",
      apiShape: "anthropic-compatible",
      configuredCredentials: ["apiKey"],
    },
  ];
  const tenant: ProviderAccountAvailability[] = [
    {
      id: "tenant-compatible",
      providerId: "custom",
      upstreamId: "openai",
      apiShape: "openai-compatible",
      configuredCredentials: ["apiKey", "baseUrl"],
    },
  ];
  const text = buildEffectiveModelCards({
    baseModels: [],
    providers: [...official, ...tenant],
    configs: [
      {
        modelId: TEXT_MODEL,
        custom: true,
        name: "Gateway fixture chat",
        kind: "text",
        providerBindings: [
          { providerAccountId: "official-openai", upstreamModel: "fixture-openai-model" },
          { providerAccountId: "official-anthropic", upstreamModel: "fixture-anthropic-model" },
          { providerAccountId: "tenant-compatible", upstreamModel: "fixture-tenant-model" },
        ],
      },
    ],
  });

  const models: GatewayModelCard[] = [...text];
  let mediaModel: CatalogFixture["mediaModel"];
  const image = buildEffectiveModelCards().find(
    (card) =>
      card.kind === "image" &&
      listDeclaredModelUpstreamRoutes([card]).some((route) => route.providerId === "official"),
  );
  if (image) {
    const route = listDeclaredModelUpstreamRoutes([image]).find(
      (candidate) => candidate.providerId === "official",
    )!;
    official.push({
      id: "official-media",
      providerId: "official",
      upstreamId: route.upstreamId,
      ...(route.region ? { region: route.region } : {}),
      supportedModelIds: [image.id],
      configuredCredentials: [
        ...(route.requiredCredentials ?? []),
        ...(route.credentialRequirements?.anyOf?.[0] ?? []),
      ],
    });
    models.push(image);
    mediaModel = { code: image.id, kind: image.kind };
  }

  return {
    catalog: { version: "fixture-catalog-1", models },
    providers: { official, tenant },
    keys: {
      "official-openai": "sk-fixture-official-openai",
      "official-anthropic": "sk-fixture-official-anthropic",
      "official-media": "sk-fixture-official-media",
      "tenant-compatible": "sk-fixture-tenant",
    },
    textModel: TEXT_MODEL,
    ...(mediaModel ? { mediaModel } : {}),
  };
}
