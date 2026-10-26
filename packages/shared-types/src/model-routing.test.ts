import { describe, expect, it } from "vitest";
import * as modelRouting from "./model-routing.js";

import {
  MODEL_UPSTREAM_ROUTES,
  MODEL_PROVIDER_DEFINITIONS,
  listCompatibleModelCatalogEntries,
  listModelCatalogEntries,
  listProviderModelSupport,
  listModelUpstreamRoutes,
  resolveModelUpstreamRoute,
  type ProviderAccountAvailability,
  type UpstreamAvailability,
} from "./model-routing.js";
import { MOCK_MODEL_CARDS, MODEL_CARDS, ModelCardSchema, normalizeModelId, type ModelCard } from "./models.js";
import { validateModelCardConfiguration } from "./model-constraints.js";

describe("model upstream routing", () => {
  it("accepts plugin-defined Provider, upstream, API shape, and OAuth ids", () => {
    expect(modelRouting.ProviderAccountIdSchema.parse("hilo-hub")).toBe("hilo-hub");
    expect(modelRouting.ModelUpstreamIdSchema.parse("hilo-hub")).toBe("hilo-hub");
    expect(modelRouting.ModelUpstreamApiShapeSchema.parse("hilo-hub")).toBe("hilo-hub");
    expect(modelRouting.ProviderOAuthIdSchema.parse("hilo-hub")).toBe("hilo-hub");
  });

  it("does not advertise retired direct KIE or Dreamina providers", () => {
    const retired = new Set(["kie", "jimeng"]);

    expect(MODEL_PROVIDER_DEFINITIONS.some((provider) =>
      retired.has(provider.providerId) || retired.has(provider.upstreamId)
    )).toBe(false);
    expect(MODEL_UPSTREAM_ROUTES.some((route) =>
      retired.has(route.providerId ?? "") ||
      retired.has(route.upstreamId) ||
      route.apiShape === "kie" ||
      route.apiShape === "dreamina-cli"
    )).toBe(false);
    expect(MODEL_CARDS.some((model) =>
      model.availableProviders?.some((provider) => retired.has(provider))
    )).toBe(false);
  });

  it("exposes Pika API Club as a configured media provider", () => {
    const configuredProviders: ProviderAccountAvailability[] = [{
      id: "pika-primary",
      providerId: "pika",
      upstreamId: "pika",
      enabled: true,
      configuredCredentials: ["apiKey"],
    }];

    expect(resolveModelUpstreamRoute({
      modelCode: "pika-2.5",
      kind: "video",
      configuredProviders,
    })).toMatchObject({
      accountId: "pika-primary",
      providerId: "pika",
      upstreamId: "pika",
      apiShape: "pika",
      upstreamModel: "pika/pika-2.5/image-to-video",
      requiredCredentials: ["apiKey"],
    });

    const support = listProviderModelSupport().find((candidate) => candidate.providerId === "pika");
    expect(support).toMatchObject({
      upstreamId: "pika",
      requiredCredentials: ["apiKey"],
    });
    expect(support?.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "pika-2.5",
      "nano-banana-2",
      "gpt-image-2",
      "seedance-2-startend",
      "seedance-2-ref",
      "minimax-h3",
      "minimax-h3-startend",
      "minimax-music-3",
      "gpt-5.6-sol",
      "claude-sonnet-5",
      "gemini-3.6-flash",
      "kimi-k3",
      "glm-5.2",
      "seedream-5-pro",
      "grok-imagine-quality",
      "flux-3-video",
      "kling-3",
      "grok-imagine-video-1.5",
      "recraft-v4",
      "lyria-3-pro",
      "minimax-speech-2.8-hd",
    ]));
  });

  it("declares an explicit reference binding for every card with inline media", () => {
    const inlineMediaCards = MODEL_CARDS.filter((model) =>
      model.input.promptModalities.includes("text")
      && model.input.promptModalities.some((modality) => modality !== "text"),
    );

    expect(inlineMediaCards).not.toHaveLength(0);
    expect(inlineMediaCards.filter((model) => !model.input.referenceBinding).map((model) => model.id)).toEqual([]);
    expect(MODEL_CARDS.find((model) => model.id === "nano-banana-2")?.input.referenceBinding).toEqual({
      type: "grouped-references",
    });
    expect(MODEL_CARDS.find((model) => model.id === "gpt-5.4")?.input.referenceBinding).toEqual({
      type: "ordered-content-parts",
      usesRoles: false,
      modalityScopedIndexes: false,
    });
    expect(MODEL_CARDS.find((model) => model.id === "seedance-2-ref")?.input.referenceBinding).toMatchObject({
      type: "positional-tokens",
      modalityScopedIndexes: true,
    });
  });

  it("lets a built-in provider implementation override the model reference binding dialect", () => {
    const volcengineRoute = listModelUpstreamRoutes({
      modelCode: "seedance-2-ref",
      kind: "video",
      configuredProviders: [{
        id: "volcengine-primary",
        providerId: "volcengine-modelark",
        upstreamId: "volcengine-modelark",
        enabled: true,
        configuredCredentials: ["apiKey"],
      }],
    })[0];

    expect(volcengineRoute?.referenceBinding).toEqual({
      type: "positional-tokens",
      modalityScopedIndexes: true,
      tokens: { image: "@图像{n}", video: "@视频{n}", audio: "@音频{n}" },
    });
  });

  it("does not rewrite H3 MIME types now that references use file upload", () => {
    const routeFor = (providerId: "minimax" | "fal" | "pika") =>
      resolveModelUpstreamRoute({
        modelCode: "minimax-h3",
        kind: "video",
        configuredProviders: [{
          id: `${providerId}-primary`,
          providerId,
          upstreamId: providerId,
          enabled: true,
          configuredCredentials: ["apiKey"],
        }],
      });

    expect(routeFor("minimax")?.inputAdaptation).toBeUndefined();
    expect(routeFor("fal")?.inputAdaptation).toBeUndefined();
    expect(routeFor("pika")?.inputAdaptation).toBeUndefined();
  });

  it("composes built-in provider-specific parameter candidates into the effective catalog card", () => {
    const volcengine = listModelCatalogEntries({
      configuredProviders: [
        {
          providerId: "volcengine-modelark",
          upstreamId: "volcengine-modelark",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    }).find((entry) => entry.model.id === "seedance-2-ref");
    const options = (entry: typeof volcengine, id: string) =>
      entry?.model.parameters
        .find((parameter) => parameter.id === id)
        ?.options?.map((option) => option.value);

    expect(options(volcengine, "duration")).toEqual([
      "auto",
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
    ]);
    expect(options(volcengine, "resolution")).toEqual([
      "480p",
      "720p",
      "1080p",
      "4k",
    ]);
    expect(volcengine?.model.defaultParams).toMatchObject({
      duration: "auto",
      aspect_ratio: "auto",
      resolution: "720p",
    });
    expect(validateModelCardConfiguration(volcengine!.model, {
      prompt: "product reveal",
      modelParams: { duration: "auto", resolution: "720p" },
    })).toBeNull();
  });

  it("keeps plugin-owned providers out of the uncomposed Music 3 card", () => {
    const entry = listModelCatalogEntries().find(
      (candidate) => candidate.model.id === "minimax-music-3",
    );

    expect(entry?.model.availableProviders).toEqual(["minimax", "pika"]);
    expect(entry?.model.parameters.map((parameter) => parameter.id)).toContain(
      "aigc_watermark",
    );
    expect(
      entry?.model.parameters
        .find((parameter) => parameter.id === "sample_rate")
        ?.options?.map((option) => option.value),
    ).toEqual([16000, 24000, 32000, 44100]);
    expect(entry?.model.musicInput).toMatchObject({
      lyricsParam: "lyrics",
      maxPromptCharacters: 2000,
      maxLyricsCharacters: 3500,
    });
  });

  it("does not expose the local ACP agent as a model card", () => {
    expect(MODEL_CARDS.some((model) => model.id === "local-acp")).toBe(false);
  });

  it("builds a custom text model card that is mounted to compatible provider accounts", () => {
    const buildEffectiveModelCards = (modelRouting as Record<string, unknown>).buildEffectiveModelCards;
    expect(buildEffectiveModelCards).toBeTypeOf("function");
    if (typeof buildEffectiveModelCards !== "function") return;

    const providers = [
      {
        id: "custom-openai-primary",
        providerId: "custom",
        upstreamId: "openai",
        apiShape: "openai-compatible",
        label: "Studio proxy",
        enabled: true,
        configuredCredentials: ["apiKey", "baseUrl"],
      },
      {
        id: "custom-anthropic-primary",
        providerId: "custom",
        upstreamId: "anthropic",
        apiShape: "anthropic-compatible",
        label: "Claude proxy",
        enabled: true,
        configuredCredentials: ["apiKey", "baseUrl"],
      },
    ];
    const models = (buildEffectiveModelCards as (input: unknown) => ModelCard[])({
      providers,
      configs: [
        {
          modelId: "editorial-reasoner",
          custom: true,
          name: "Editorial Reasoner",
          kind: "text",
          description: "A house model for structured edit decisions.",
          promptGuidance: "State the audience, desired cut, and non-negotiable constraints.",
          providerBindings: [
            {
              providerAccountId: "custom-openai-primary",
              upstreamModel: "editorial/reasoner-v2",
            },
            {
              providerAccountId: "custom-anthropic-primary",
              upstreamModel: "editorial-reasoner-2026-07",
            },
          ],
        },
      ],
    });

    const model = models.find((candidate) => candidate.id === "editorial-reasoner");
    expect(model).toMatchObject({
      id: "editorial-reasoner",
      name: "Editorial Reasoner",
      kind: "text",
      custom: true,
      description: "A house model for structured edit decisions.",
      promptGuidance: "State the audience, desired cut, and non-negotiable constraints.",
    });

    const entry = listModelCatalogEntries({
      models,
      configuredProviders: providers as ProviderAccountAvailability[],
    }).find((candidate) => candidate.model.id === "editorial-reasoner");
    expect(entry).toMatchObject({
      tier: "available",
      selectedRoute: {
        accountId: "custom-openai-primary",
        providerId: "custom",
        upstreamId: "openai",
        apiShape: "openai-compatible",
        upstreamModel: "editorial/reasoner-v2",
      },
    });
    expect(entry?.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: "custom-anthropic-primary",
        apiShape: "anthropic-compatible",
        upstreamModel: "editorial-reasoner-2026-07",
      }),
    ]));
  });

  it("applies user description and prompt guidance to a built-in model card without replacing its routes", () => {
    const buildEffectiveModelCards = (modelRouting as Record<string, unknown>).buildEffectiveModelCards;
    expect(buildEffectiveModelCards).toBeTypeOf("function");
    if (typeof buildEffectiveModelCards !== "function") return;

    const models = (buildEffectiveModelCards as (input: unknown) => ModelCard[])({
      providers: [],
      configs: [
        {
          modelId: "gpt-5.4",
          custom: false,
          description: "Use for final narrative synthesis.",
          promptGuidance: "Lead with the desired deliverable, then provide source context.",
          providerBindings: [],
        },
      ],
    });
    const model = models.find((candidate) => candidate.id === "gpt-5.4");

    expect(model).toMatchObject({
      description: "Use for final narrative synthesis.",
      promptGuidance: "Lead with the desired deliverable, then provide source context.",
    });
    expect(model?.providerImplementations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "official",
          upstreamId: "openai",
          apiShape: "openai-compatible",
        }),
      ]),
    );
  });

  it("lists canvas models from the user's enabled model ids without requiring runnable credentials", () => {
    const listUserEnabledCanvasModelIds = (modelRouting as Record<string, unknown>).listUserEnabledCanvasModelIds;
    expect(listUserEnabledCanvasModelIds).toBeTypeOf("function");

    const template = MODEL_CARDS.find((model) => model.kind === "video")!;
    const canvasModel = (id: string): ModelCard => ({
      ...template,
      id,
      name: id,
      providerImplementations: [{
        providerId: "fal",
        upstreamId: "fal",
        upstreamModel: `test/${id}`,
        apiShape: "fal",
      }],
    });

    const enabledIds = (listUserEnabledCanvasModelIds as (options: unknown) => string[])({
      models: [canvasModel("enabled-canvas-model"), canvasModel("disabled-canvas-model")],
      configuredProviders: [{
        providerId: "fal",
        upstreamId: "fal",
        enabled: true,
        supportedModelIds: ["enabled-canvas-model"],
      }],
    });

    expect(enabledIds).toEqual(["enabled-canvas-model"]);
  });

  it("keeps the default canvas model set when the user has no explicit model filter", () => {
    const models = MODEL_CARDS.slice(0, 3);

    const enabledIds = (modelRouting as unknown as {
      listUserEnabledCanvasModelIds: (options: unknown) => string[];
    }).listUserEnabledCanvasModelIds({
      models,
      configuredProviders: [],
    });

    expect(enabledIds).toEqual(models.map((model) => model.id));
  });

  it("filters injected future models by declared input and output modalities", () => {
    const template = MODEL_CARDS.find((model) => model.kind === "video")!;
    const audioVideo = (id: string): ModelCard => ({
      ...template,
      id,
      name: id,
      input: {
        requiresPrompt: true,
        inputMode: { audios: { max: 1 } },
        promptModalities: ["text", "audio"],
      },
    });
    const imageVideo: ModelCard = {
      ...audioVideo("future-image-video"),
      input: {
        requiresPrompt: true,
        inputMode: { images: { max: 1 } },
        promptModalities: ["text", "image"],
      },
    };

    const entries = listCompatibleModelCatalogEntries({
      outputKind: "video",
      sourceKind: "audio",
      models: [audioVideo("future-audio-video-a"), imageVideo, audioVideo("future-audio-video-b")],
    });

    expect(entries.map((entry) => entry.model.id)).toEqual([
      "future-audio-video-a",
      "future-audio-video-b",
    ]);
  });

  it("allows model cards to declare current provider account implementations", () => {
    const parsed = ModelCardSchema.parse({
      id: "seedance-2-text",
      name: "Seedance 2.0",
      provider: "ByteDance",
      kind: "video",
      parameters: [],
      defaultParams: {},
      availableProviders: ["volcengine-modelark", "replicate", "fal", "mock"],
      defaultProvider: "volcengine-modelark",
    });

    expect(parsed.availableProviders).toEqual(["volcengine-modelark", "replicate", "fal", "mock"]);
    expect(parsed.defaultProvider).toBe("volcengine-modelark");
  });

  it("allows model cards to own provider route implementations", () => {
    const parsed = ModelCardSchema.parse({
      id: "gpt-image-2",
      name: "GPT Image 2",
      provider: "OpenAI",
      kind: "image",
      parameters: [],
      defaultParams: {},
      availableProviders: ["official"],
      defaultProvider: "official",
      providerImplementations: [
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          upstreamModel: "gpt-image-2",
          apiShape: "openai-images",
          priority: 10,
          requiredCredentials: ["apiKey"],
        },
      ],
    });

    expect((parsed as any).providerImplementations).toEqual([
      {
        providerId: "official",
        upstreamId: "openai",
        region: "global",
        upstreamModel: "gpt-image-2",
        apiShape: "openai-images",
        priority: 10,
        requiredCredentials: ["apiKey"],
      },
    ]);
  });

  it("rejects model cards whose default provider is not one of their implementations", () => {
    expect(() => ModelCardSchema.parse({
      id: "broken-model",
      name: "Broken",
      provider: "Broken Provider",
      kind: "image",
      parameters: [],
      defaultParams: {},
      availableProviders: ["fal"],
    })).toThrow(/defaultProvider/);

    expect(() => ModelCardSchema.parse({
      id: "broken-model",
      name: "Broken",
      provider: "Broken Provider",
      kind: "image",
      parameters: [],
      defaultParams: {},
      availableProviders: ["fal"],
      defaultProvider: "replicate",
    })).toThrow(/defaultProvider/);
  });

  it("keeps every routed model backed by a first-class model card", () => {
    const modelCardIds = new Set([...MODEL_CARDS, ...MOCK_MODEL_CARDS].map((model) => model.id));
    const routedModelIds = [...new Set(MODEL_UPSTREAM_ROUTES.map((route) => route.modelCode))].sort();

    expect(routedModelIds.filter((modelId) => !modelCardIds.has(modelId))).toEqual([]);
  });

  it("exposes first-class mock model cards only when mock routing is enabled", () => {
    const mockModel = MOCK_MODEL_CARDS.find((model) => model.id === "mock-image-model");
    const mockTextModel = MOCK_MODEL_CARDS.find((model) => model.id === "mock-text-model");

    expect(mockModel).toMatchObject({
      id: "mock-image-model",
      name: "Mock Image Model",
      availableProviders: ["mock"],
      defaultProvider: "mock",
      providerImplementations: [
        expect.objectContaining({
          providerId: "mock",
          upstreamId: "mock",
          upstreamModel: "fal-ai/mock-image",
          apiShape: "fal",
        }),
      ],
    });
    expect(mockTextModel).toMatchObject({
      id: "mock-text-model",
      name: "Mock Text Model",
      kind: "text",
      availableProviders: ["mock"],
      defaultProvider: "mock",
      providerImplementations: [
        expect.objectContaining({
          providerId: "mock",
          upstreamId: "mock",
          upstreamModel: "mock/text-completion",
          apiShape: "openai-compatible",
        }),
      ],
    });
    expect(listModelCatalogEntries().some((entry) => entry.model.id === "mock-image-model")).toBe(false);
    expect(listModelCatalogEntries().some((entry) => entry.model.id === "mock-text-model")).toBe(false);

    const mockEntries = listModelCatalogEntries({
      configuredProviders: [{ providerId: "mock", upstreamId: "mock", enabled: true }],
    });
    const entry = mockEntries.find((candidate) => candidate.model.id === "mock-image-model");
    const textEntry = mockEntries.find((candidate) => candidate.model.id === "mock-text-model");

    expect(entry).toMatchObject({
      tier: "available",
      selectedRoute: {
        modelCode: "mock-image-model",
        providerId: "mock",
        upstreamId: "mock",
        upstreamModel: "fal-ai/mock-image",
      },
      candidateProviders: ["mock"],
    });
    expect(textEntry).toMatchObject({
      tier: "available",
      selectedRoute: {
        modelCode: "mock-text-model",
        providerId: "mock",
        upstreamId: "mock",
        upstreamModel: "mock/text-completion",
      },
      candidateProviders: ["mock"],
    });
    const supportedMockModelIds = listProviderModelSupport({ includeMock: true })
      .find((support) => support.providerId === "mock")?.models
      .map((model) => model.id);
    expect(supportedMockModelIds).toContain("mock-image-model");
    expect(supportedMockModelIds).toContain("mock-text-model");
  });

  it("exports model cards after applying schema validation and defaults", () => {
    const cardsMissingPromptDefaults = MODEL_CARDS
      .filter((model) => !model.input.promptModalities?.length)
      .map((model) => model.id);

    expect(cardsMissingPromptDefaults).toEqual([]);
    expect(MODEL_CARDS.map((model) => ModelCardSchema.parse(model).id)).toEqual(MODEL_CARDS.map((model) => model.id));
  });

  it("requires routed model cards to explicitly declare their provider implementations", () => {
    const modelCards = new Map(MODEL_CARDS.map((model) => [model.id, model]));
    const providersByModel = new Map<string, Set<string>>();

    for (const route of MODEL_UPSTREAM_ROUTES) {
      const providerId = route.providerId ?? route.upstreamId;
      if (providerId === "local" || providerId === "mock") continue;
      const providers = providersByModel.get(route.modelCode) ?? new Set<string>();
      providers.add(providerId);
      providersByModel.set(route.modelCode, providers);
    }

    const failures = [...providersByModel.entries()].flatMap(([modelId, providerIds]) => {
      const model = modelCards.get(modelId);
      const declaredProviders = (model?.availableProviders ?? []).map(String);
      const missingProviders = [...providerIds].filter((providerId) => !declaredProviders.includes(providerId));
      const extraProviders = declaredProviders.filter((providerId) => !providerIds.has(providerId));
      const defaultProvider = model?.defaultProvider ? String(model.defaultProvider) : "";
      const routedDefaultProvider = MODEL_UPSTREAM_ROUTES
        .filter((route) => route.modelCode === modelId)
        .map((route) => ({
          providerId: route.providerId ?? route.upstreamId,
          priority: route.priority ?? 1000,
        }))
        .filter((route) => route.providerId !== "local" && route.providerId !== "mock")
        .sort((a, b) => a.priority - b.priority || a.providerId.localeCompare(b.providerId))[0]?.providerId;
      const problems: string[] = [];
      if (!model) problems.push("missing model card");
      if (missingProviders.length > 0) problems.push(`missing providers: ${missingProviders.join(", ")}`);
      if (extraProviders.length > 0) problems.push(`providers without routes: ${extraProviders.join(", ")}`);
      if (!defaultProvider) problems.push("missing defaultProvider");
      else if (!declaredProviders.includes(defaultProvider)) problems.push(`defaultProvider not declared: ${defaultProvider}`);
      else if (routedDefaultProvider && defaultProvider !== routedDefaultProvider) {
        problems.push(`defaultProvider ${defaultProvider} does not match routed default ${routedDefaultProvider}`);
      }
      return problems.length > 0 ? [`${modelId}: ${problems.join("; ")}`] : [];
    }).sort();

    expect(failures).toEqual([]);
  });

  it("builds hosted route table from model card implementations", () => {
    const compactRoute = (route: {
      modelCode: string;
      providerId?: string;
      upstreamId: string;
      region?: string;
      upstreamModel: string;
      apiShape: string;
      priority: number;
      requiredCredentials?: readonly string[];
      requiredOAuth?: readonly string[];
    }) => Object.fromEntries(Object.entries({
      modelCode: route.modelCode,
      providerId: route.providerId,
      upstreamId: route.upstreamId,
      region: route.region,
      upstreamModel: route.upstreamModel,
      apiShape: route.apiShape,
      priority: route.priority,
      requiredCredentials: route.requiredCredentials,
      requiredOAuth: route.requiredOAuth,
    }).filter(([, value]) => value !== undefined));

    const declared = MODEL_CARDS.flatMap((model) =>
      (model.providerImplementations ?? []).map((implementation) => compactRoute({
        modelCode: model.id,
        providerId: implementation.providerId,
        upstreamId: implementation.upstreamId,
        region: implementation.region,
        upstreamModel: implementation.upstreamModel,
        apiShape: implementation.apiShape,
        priority: implementation.priority ?? 100,
        requiredCredentials: implementation.requiredCredentials,
        requiredOAuth: implementation.requiredOAuth,
      })),
    ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    const hostedRoutes = MODEL_UPSTREAM_ROUTES
      .filter((route) => route.upstreamId !== "mock")
      .map(compactRoute)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(hostedRoutes).toEqual(declared);
  });

  it("routes canonical Seedance model codes to fal-shaped mock endpoints", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "seedance-2-ref",
      kind: "video",
      allowMock: true,
      configuredUpstreams: [{ upstreamId: "mock", enabled: true }],
    });

    expect(route).toMatchObject({
      modelCode: "seedance-2-ref",
      upstreamId: "mock",
      upstreamModel: "bytedance/seedance-2.0/reference-to-video",
      apiShape: "fal",
    });
  });

  it("skips configured upstreams without required variables and falls back", () => {
    const upstreams: UpstreamAvailability[] = [
      { upstreamId: "fal", enabled: true, configuredCredentials: [] },
      { upstreamId: "google-ai-studio", enabled: true, configuredCredentials: ["apiKey"] },
    ];

    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredUpstreams: upstreams,
    });

    expect(route).toMatchObject({
      upstreamId: "google-ai-studio",
      upstreamModel: "gemini-3.1-flash-image",
    });
  });

  it("orders fallback candidates by user upstream order before route defaults", () => {
    const routes = listModelUpstreamRoutes({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredUpstreams: [
        { upstreamId: "fal", enabled: true, configuredCredentials: ["apiKey"] },
        { upstreamId: "google-ai-studio", enabled: true, configuredCredentials: ["apiKey"] },
      ],
    });

    expect(routes.map((route) => route.upstreamId)).toEqual([
      "google-ai-studio",
    ]);
  });

  it("keeps mock routes out of hosted resolution unless explicitly allowed", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "seedance-2-text",
      kind: "video",
      configuredUpstreams: [{ upstreamId: "mock", enabled: true }],
    });

    expect(route).toBeNull();
  });

  it("marks mock-backed catalog entries available only when mock routing is explicitly configured", () => {
    const mockEntries = listModelCatalogEntries({
      configuredProviders: [{ providerId: "mock", upstreamId: "mock", enabled: true }],
    });
    const mockNanoBanana = mockEntries.find((entry) => entry.model.id === "nano-banana-2");

    expect(mockNanoBanana).toMatchObject({
      tier: "available",
      selectedRoute: {
        providerId: "mock",
        upstreamId: "mock",
        upstreamModel: "fal-ai/nano-banana-2",
      },
      missingCredentials: [],
    });

    const unavailableEntries = listModelCatalogEntries({ configuredProviders: [] });
    const unavailableNanoBanana = unavailableEntries.find((entry) => entry.model.id === "nano-banana-2");
    expect(unavailableNanoBanana?.selectedRoute?.upstreamId).not.toBe("mock");
  });

  it("routes GPT Image 2 to the OpenAI image upstream with variables", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredUpstreams: [
        { upstreamId: "openai", enabled: true, configuredCredentials: ["apiKey"] },
      ],
    });

    expect(route).toMatchObject({
      modelCode: "gpt-image-2",
      upstreamId: "openai",
      upstreamModel: "gpt-image-2",
      apiShape: "openai-images",
      requiredCredentials: ["apiKey"],
    });
    expect(route).not.toHaveProperty("requiredSecretIds");
  });

  it("does not invent a Fal route before plugin bindings are composed", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "fal",
          upstreamId: "fal",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toBeNull();
  });

  it("routes official Google AI Studio image models when a Gemini API key is configured", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "official",
      upstreamId: "google-ai-studio",
      upstreamModel: "gemini-3.1-flash-image",
      apiShape: "google-ai-studio",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    });
  });

  it("does not route MiniMax TTS to Fal before plugin bindings are composed", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "minimax-tts",
      kind: "audio",
      configuredUpstreams: [
        { upstreamId: "fal", enabled: true, configuredCredentials: ["apiKey"] },
      ],
    });

    expect(route).toBeNull();
  });

  it("keeps local ASR model cards available without hosted provider setup", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "sensevoice-small-asr",
      kind: "text",
      configuredProviders: [],
    });

    expect(route).toMatchObject({
      modelCode: "sensevoice-small-asr",
      providerId: "local",
      upstreamId: "local",
      upstreamModel: "iic/SenseVoiceSmall",
      apiShape: "local-asr",
    });

    const entries = listModelCatalogEntries({ configuredProviders: [] });
    expect(entries.find((entry) => entry.model.id === "sensevoice-small-asr")).toMatchObject({
      tier: "available",
      selectedRoute: {
        providerId: "local",
        upstreamId: "local",
        upstreamModel: "iic/SenseVoiceSmall",
      },
      missingCredentials: [],
    });
  });

  it("keeps selectable local Piper TTS voices available without hosted credentials", () => {
    const entries = listModelCatalogEntries({ configuredProviders: [] });
    const localTtsEntries = entries.filter((entry) =>
      entry.selectedRoute?.apiShape === "local-tts"
    );

    expect(localTtsEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: expect.objectContaining({
          id: "piper-huayan-tts",
          kind: "audio",
          defaultParams: expect.objectContaining({
            tts_model: "zh_CN-huayan-medium",
          }),
        }),
        tier: "available",
        selectedRoute: expect.objectContaining({
          providerId: "local",
          upstreamId: "local",
          upstreamModel: "zh_CN-huayan-medium",
          apiShape: "local-tts",
        }),
        missingCredentials: [],
      }),
      expect.objectContaining({
        model: expect.objectContaining({
          id: "piper-lessac-tts",
          kind: "audio",
          defaultParams: expect.objectContaining({
            tts_model: "en_US-lessac-medium",
          }),
        }),
      }),
    ]));
  });

  it("exposes a real local speech quality ladder with Whisper, VibeVoice, and Kokoro", () => {
    const entries = listModelCatalogEntries({ configuredProviders: [] });
    const expected = [
      ["whisper-large-v3-turbo-asr", "text", "local-asr", "mlx-community/whisper-large-v3-turbo"],
      ["whisper-small-asr", "text", "local-asr", "mlx-community/whisper-small-mlx"],
      ["vibevoice-asr", "text", "local-asr", "mlx-community/VibeVoice-ASR-4bit"],
      ["kokoro-82m-tts", "audio", "local-tts", "mlx-community/Kokoro-82M-4bit"],
    ] as const;

    for (const [id, kind, apiShape, upstreamModel] of expected) {
      expect(entries.find((entry) => entry.model.id === id)).toMatchObject({
        model: { id, kind },
        tier: "available",
        selectedRoute: {
          providerId: "local",
          upstreamId: "local",
          upstreamModel,
          apiShape,
        },
        missingCredentials: [],
      });
    }

    expect(MODEL_CARDS.find((model) => model.id === "vibevoice-asr")?.description).toMatch(/speaker/i);
    expect(MODEL_CARDS.find((model) => model.id === "kokoro-82m-tts")?.defaultParams).toMatchObject({
      voice_name: "af_heart",
      tts_model: "mlx-community/Kokoro-82M-4bit",
    });
  });

  it("publishes Parakeet v3 as a local European-language ASR model with an honest download warning", () => {
    const entry = listModelCatalogEntries({ configuredProviders: [] })
      .find((candidate) => candidate.model.id === "parakeet-tdt-0.6b-v3-asr");

    expect(entry).toMatchObject({
      model: {
        id: "parakeet-tdt-0.6b-v3-asr",
        name: "Parakeet TDT 0.6B v3",
        provider: "NVIDIA",
        kind: "text",
        defaultParams: {
          asr_model: "mlx-community/parakeet-tdt-0.6b-v3",
        },
      },
      tier: "available",
      selectedRoute: {
        providerId: "local",
        upstreamId: "local",
        upstreamModel: "mlx-community/parakeet-tdt-0.6b-v3",
        apiShape: "local-asr",
      },
      missingCredentials: [],
    });
    expect(entry?.model.description).toMatch(/25 European languages/i);
    expect(entry?.model.description).toMatch(/2\.5 GB/i);
    expect(`${entry?.model.description} ${entry?.model.promptGuidance}`).toMatch(/does not support Chinese/i);
  });

  it("routes hosted official media providers from configured provider accounts", () => {
    const cases = [
      {
        modelCode: "kling-3",
        kind: "video" as const,
        providerId: "kling",
        upstreamId: "kling",
        upstreamModel: "kling-v3",
        apiShape: "kling",
        credentials: ["accessKey", "secretKey"],
      },
      {
        modelCode: "minimax-tts",
        kind: "audio" as const,
        providerId: "minimax",
        upstreamId: "minimax",
        upstreamModel: "speech-02-hd",
        apiShape: "minimax",
        credentials: ["apiKey"],
      },
      {
        modelCode: "elevenlabs-tts",
        kind: "audio" as const,
        providerId: "elevenlabs",
        upstreamId: "elevenlabs",
        upstreamModel: "eleven_v3",
        apiShape: "elevenlabs",
        credentials: ["apiKey"],
      },
      {
        modelCode: "seedance-2-ref",
        kind: "video" as const,
        providerId: "volcengine-modelark",
        upstreamId: "volcengine-modelark",
        upstreamModel: "doubao-seedance-2-0-260128",
        apiShape: "modelark",
        credentials: ["apiKey"],
      },
    ] as const;

    for (const item of cases) {
      const route = resolveModelUpstreamRoute({
        modelCode: item.modelCode,
        kind: item.kind,
        configuredProviders: [
          {
            providerId: item.providerId,
            upstreamId: item.upstreamId,
            enabled: true,
            configuredCredentials: [...item.credentials],
          },
        ],
      });

      expect(route, item.providerId).toMatchObject({
        modelCode: item.modelCode,
        providerId: item.providerId,
        upstreamId: item.upstreamId,
        upstreamModel: item.upstreamModel,
        apiShape: item.apiShape,
      });
      if (item.credentials.length) expect(route).toMatchObject({ requiredCredentials: [...item.credentials] });
      else expect(route?.requiredCredentials).toBeUndefined();
    }
  });

  it("indexes provider-declared model support by provider", () => {
    const supports = listProviderModelSupport();
    const byProvider = new Map<string, (typeof supports)[number]>(
      supports.map((support) => [support.providerId, support]),
    );

    expect(byProvider.get("kling")).toMatchObject({
      providerId: "kling",
      upstreamId: "kling",
      models: [expect.objectContaining({ id: "kling-3", apiShape: "kling" })],
      requiredCredentials: ["accessKey", "secretKey"],
    });
    expect(byProvider.get("minimax")).toMatchObject({
      providerId: "minimax",
      models: expect.arrayContaining([
        expect.objectContaining({ id: "minimax-tts", apiShape: "minimax" }),
        expect.objectContaining({ id: "minimax-music-3", upstreamModel: "music-3.0" }),
        expect.objectContaining({ id: "minimax-h3", upstreamModel: "MiniMax-H3" }),
        expect.objectContaining({ id: "minimax-h3-startend", upstreamModel: "MiniMax-H3" }),
      ]),
      requiredCredentials: ["apiKey"],
    });
    expect(byProvider.get("elevenlabs")).toMatchObject({
      providerId: "elevenlabs",
      models: [expect.objectContaining({ id: "elevenlabs-tts", apiShape: "elevenlabs" })],
      requiredCredentials: ["apiKey"],
    });
    expect(byProvider.get("volcengine-modelark")?.models.map((model) => model.id)).toContain("seedance-2-ref");
    expect(byProvider.has("midjourney")).toBe(false);
  });

  it("indexes provider support from model card implementations", () => {
    const model = ModelCardSchema.parse({
      id: "custom-model",
      name: "Custom Model",
      provider: "Custom",
      kind: "image",
      parameters: [],
      defaultParams: {},
      availableProviders: ["custom"],
      defaultProvider: "custom",
      providerImplementations: [
        {
          providerId: "custom",
          upstreamId: "openai",
          region: "team-a",
          upstreamModel: "team/custom-model",
          apiShape: "openai-compatible",
          priority: 42,
          requiredCredentials: ["apiKey"],
        },
      ],
    });

    expect(listProviderModelSupport({ models: [model] })).toEqual([
      {
        providerId: "custom",
        upstreamId: "openai",
        region: "team-a",
        models: [
          {
            id: "custom-model",
            aliases: [],
            name: "Custom Model",
            kind: "image",
            upstreamModel: "team/custom-model",
            apiShape: "openai-compatible",
            requiredCredentials: ["apiKey"],
            requiredOAuth: [],
          },
        ],
        requiredCredentials: ["apiKey"],
        requiredOAuth: [],
      },
    ]);
  });

  it("does not separate Google AI Studio from Agent Platform", () => {
    // They were separate while Agent Platform required a service-account JSON exchanged for a
    // scoped token. Asked directly with a real key, both surfaces answer :generateContent with
    // x-goog-api-key and differ only by host -- so under the rule that the same authentication
    // method means the same provider, they are one.
    //
    // The split was not free. A Google account was configured, nano-banana-2 was requested, our own
    // gate demanded a service account, found none, and hilo-hub answered instead. The asset looked
    // exactly like a successful Google generation.
    const upstreams = new Set(
      listProviderModelSupport()
        .filter((support) => support.providerId === "official")
        .map((support) => support.upstreamId),
    );
    expect(upstreams.has("google-agent-platform")).toBe(false);
    expect(upstreams.has("google-ai-studio")).toBe(true);
  });

  it("keeps provider definitions free of per-model support declarations", () => {
    const providersWithModelLists = MODEL_PROVIDER_DEFINITIONS
      .filter((provider) => "supportedModels" in provider)
      .map((provider) => [provider.providerId, provider.upstreamId, provider.region ?? ""].join(":"));

    expect(providersWithModelLists).toEqual([]);
  });

  it("does not substitute MiniMax audio for Gemini TTS when only fal is configured", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-tts",
      kind: "audio",
      configuredUpstreams: [
        { upstreamId: "fal", enabled: true, configuredCredentials: ["apiKey"] },
      ],
    });

    expect(route).toBeNull();
  });

  it("resolves weighted provider accounts before static route priority", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
          weight: 10,
        },
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          configuredCredentials: ["apiKey"],
          weight: 90,
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "replicate",
      upstreamId: "replicate",
      upstreamModel: "google/nano-banana-2",
      apiShape: "replicate",
    });
  });

  it("uses configured provider order before static route priority when provider weights tie", () => {
    const routes = listModelUpstreamRoutes({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(routes.map((route) => `${route.providerId}/${route.upstreamId}`)).toEqual([
      "replicate/replicate",
      "official/openai",
    ]);
  });

  it("uses explicit provider priority before incidental account array order", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "fal",
          upstreamId: "fal",
          enabled: true,
          priority: 30,
          configuredCredentials: ["apiKey"],
        },
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 10,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "official",
      upstreamId: "openai",
      upstreamModel: "gpt-image-2",
    });
  });

  it("honors per-account supported model filters before provider priority", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          configuredCredentials: ["apiKey"],
          supportedModelIds: ["nano-banana-2"],
        },
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 20,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "official",
      upstreamId: "openai",
      upstreamModel: "gpt-image-2",
    });

    const allowedRoute = resolveModelUpstreamRoute({
      modelCode: "nano-banana-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          configuredCredentials: ["apiKey"],
          supportedModelIds: ["nano-banana-2"],
        },
      ],
    });

    expect(allowedRoute).toMatchObject({
      providerId: "replicate",
      upstreamId: "replicate",
      upstreamModel: "google/nano-banana-2",
    });
  });

  it("applies provider ordering only to the model it was configured for", () => {
    const configuredProviders = [
      {
        providerId: "official",
        upstreamId: "google-ai-studio",
        enabled: true,
        configuredCredentials: ["apiKey"],
        modelPriorities: { "nano-banana-2": 20 },
      },
      {
        providerId: "replicate",
        upstreamId: "replicate",
        enabled: true,
        configuredCredentials: ["apiKey"],
        modelPriorities: { "nano-banana-2": 10 },
      },
    ] satisfies ProviderAccountAvailability[];

    const nanoRoute = resolveModelUpstreamRoute({
      modelCode: "nano-banana-2",
      kind: "image",
      configuredProviders,
    });
    const fluxRoute = resolveModelUpstreamRoute({
      modelCode: "flux-schnell",
      kind: "image",
      configuredProviders,
    });

    expect(nanoRoute?.providerId).toBe("replicate");
    expect(fluxRoute?.providerId).toBe("replicate");
  });

  it("normalizes model aliases before applying configured provider scopes and priorities", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "fal",
          upstreamId: "fal",
          enabled: true,
          configuredCredentials: ["apiKey"],
          supportedModelIds: ["gemini-3.1-flash-image"],
          modelPriorities: { "gemini-3.1-flash-image": 20 },
        },
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          configuredCredentials: ["apiKey"],
          supportedModelIds: ["nano-banana-2"],
          modelPriorities: { "nano-banana-2": 10 },
        },
      ],
    });

    expect(route).toMatchObject({
      modelCode: "nano-banana-2",
      providerId: "replicate",
      upstreamId: "replicate",
      upstreamModel: "google/nano-banana-2",
    });
  });

  it("uses a provider model priority even when another key in that provider has higher key priority", () => {
    const routes = listModelUpstreamRoutes({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          configuredCredentials: ["apiKey"],
        },
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 20,
          configuredCredentials: ["apiKey"],
          modelPriorities: { "gpt-image-2": 10 },
        },
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 5,
          configuredCredentials: ["apiKey"],
          modelPriorities: { "gpt-image-2": 20 },
        },
      ],
    });

    expect(routes.map((route) => `${route.providerId}/${route.upstreamId}`)).toEqual([
      "replicate/replicate",
      "official/openai",
    ]);
  });

  it("uses provider weight before array order for the same model", () => {
    const routes = listModelUpstreamRoutes({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          weight: 10,
          configuredCredentials: ["apiKey"],
        },
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          weight: 90,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(routes.map((route) => `${route.providerId}/${route.upstreamId}`)).toEqual([
      "replicate/replicate",
      "official/openai",
    ]);
  });

  it("does not let an incomplete higher-priority key block a complete key for the same provider", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      allowMock: true,
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          configuredCredentials: [],
        },
        {
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 20,
          configuredCredentials: ["apiKey"],
        },
        { providerId: "mock", enabled: true },
      ],
    });

    expect(route).toMatchObject({
      providerId: "replicate",
      upstreamId: "replicate",
      apiShape: "replicate",
      upstreamModel: "openai/gpt-image-2",
    });
  });

  it("does not let a disabled key block an enabled key for the same provider", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-tts",
      kind: "audio",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: false,
          priority: 1,
          configuredCredentials: ["apiKey"],
        },
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          priority: 20,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "official",
      upstreamId: "google-ai-studio",
      apiShape: "google-ai-studio",
      upstreamModel: "gemini-3.1-flash-tts-preview",
    });
  });

  it("uses one Google credential for every Google route", () => {
    // This used to assert the opposite: that an Agent Platform service account must not satisfy an
    // AI Studio route. Both surfaces now take the same api key, so keeping them apart would mean
    // asking for two credentials where the vendor asks for one.
    const route = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-tts",
      kind: "audio",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });
    expect(route?.upstreamId).toBe("google-ai-studio");
  });

  it("marks a model available when any configured key for its provider satisfies required credentials", () => {
    const entries = listModelCatalogEntries({
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 1,
          configuredCredentials: [],
        },
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          priority: 20,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    const gptImage = entries.find((entry) => entry.model.id === "gpt-image-2");
    expect(gptImage).toMatchObject({
      tier: "available",
      selectedRoute: {
        providerId: "official",
        upstreamId: "openai",
      },
      missingCredentials: [],
    });
  });

  it("routes Replicate provider accounts through prediction models", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "replicate",
          upstreamId: "replicate",
          configuredCredentials: ["apiKey"],
          weight: 100,
        },
        {
          providerId: "official",
          upstreamId: "openai",
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "replicate",
      upstreamId: "replicate",
      upstreamModel: "openai/gpt-image-2",
      apiShape: "replicate",
      requiredCredentials: ["apiKey"],
    });
  });

  it("treats Google image model names as aliases for Clash canonical model ids", () => {
    const proRoute = resolveModelUpstreamRoute({
      modelCode: "gemini-3-pro-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });
    const fakeProRoute = resolveModelUpstreamRoute({
      modelCode: "not-a-real-google-image-model",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });
    const flashRoute = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });
    const flashLiteRoute = resolveModelUpstreamRoute({
      modelCode: "gemini-3.1-flash-lite-image",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "google-ai-studio",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(proRoute).toMatchObject({
      modelCode: "nano-banana-pro",
      upstreamModel: "gemini-3-pro-image",
    });
    expect(fakeProRoute).toBeNull();
    expect(flashRoute).toMatchObject({
      modelCode: "nano-banana-2",
      upstreamModel: "gemini-3.1-flash-image",
    });
    expect(flashLiteRoute).toMatchObject({
      modelCode: "nano-banana-2-lite",
      upstreamModel: "gemini-3.1-flash-lite-image",
    });
  });

  it("routes current Google SOTA text models through the official Google account", () => {
    const configuredProviders: ProviderAccountAvailability[] = [
      {
        providerId: "official",
        upstreamId: "google-ai-studio",
        region: "global",
        enabled: true,
        configuredCredentials: ["apiKey"],
      },
    ];

    expect(
      ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash", "gemini-3.1-flash-lite"].map((modelCode) =>
        resolveModelUpstreamRoute({
          modelCode,
          kind: "text",
          configuredProviders,
        })
      )
    ).toEqual([
      expect.objectContaining({
        modelCode: "gemini-3.5-flash",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-3.5-flash",
        apiShape: "google-ai-studio",
        credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
      }),
      expect.objectContaining({
        modelCode: "gemini-3.1-pro",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-3.1-pro-preview",
        apiShape: "google-ai-studio",
        credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
      }),
      expect.objectContaining({
        modelCode: "gemini-3-flash",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-3-flash-preview",
        apiShape: "google-ai-studio",
        credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
      }),
      expect.objectContaining({
        modelCode: "gemini-3.1-flash-lite",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-3.1-flash-lite",
        apiShape: "google-ai-studio",
        credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
      }),
    ]);
  });

  it("lists Clash canonical image models instead of provider model aliases", () => {
    const entries = listModelCatalogEntries();
    const ids = entries.map((entry) => entry.model.id);

    expect(ids).toContain("nano-banana-2");
    expect(ids).toContain("nano-banana-2-lite");
    expect(ids).toContain("nano-banana-pro");
    expect(ids).not.toContain("gemini-3.1-flash-image");
    expect(ids).not.toContain("gemini-3.1-flash-lite-image");
    expect(ids).not.toContain("gemini-3-pro-image");
  });

  it("keeps official provider accounts separate from internal upstream adapters and regions", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
          configuredCredentials: ["apiKey"],
        },
      ],
    });

    expect(route).toMatchObject({
      providerId: "official",
      upstreamId: "openai",
      region: "global",
      upstreamModel: "gpt-image-2",
    });
  });

  it("classifies model catalog entries by runnable and configured-provider tiers", () => {
    const configuredProviders: ProviderAccountAvailability[] = [
      {
        providerId: "pika",
        upstreamId: "pika",
        enabled: true,
        configuredCredentials: ["apiKey"],
      },
      {
        providerId: "official",
        upstreamId: "openai",
        enabled: true,
        configuredCredentials: [],
      },
    ];

    const entries = listModelCatalogEntries({ configuredProviders });
    const nanoBanana = entries.find((entry) => entry.model.id === "nano-banana-2");
    const gptImage = entries.find((entry) => entry.model.id === "gpt-image-2");

    expect(nanoBanana).toMatchObject({
      tier: "available",
      selectedRoute: {
        providerId: "pika",
        upstreamId: "pika",
      },
    });
    expect(gptImage).toMatchObject({
      tier: "available",
      selectedRoute: {
        providerId: "pika",
        upstreamId: "pika",
        upstreamModel: "openai/gpt-image-2/text-to-image",
      },
      candidateProviders: ["pika", "official"],
    });
  });

  it("does not treat an enabled provider account with omitted credential metadata as ready", () => {
    const entries = listModelCatalogEntries({
      configuredProviders: [
        {
          providerId: "official",
          upstreamId: "openai",
          region: "global",
          enabled: true,
        },
      ],
    });

    expect(entries.find((entry) => entry.model.id === "gpt-image-2")).toMatchObject({
      tier: "configured-provider",
      selectedRoute: null,
      missingCredentials: ["apiKey"],
      candidateProviders: ["official"],
    });
  });

  it("keeps one provider-neutral Seedream card ready for plugin bindings", () => {
    const seedreamCards = MODEL_CARDS.filter((model) =>
      model.id.startsWith("seedream-4.5"),
    );
    expect(seedreamCards).toHaveLength(1);
    expect(seedreamCards[0]).toMatchObject({
      id: "seedream-4.5",
      kind: "image",
      input: {
        inputMode: { images: { max: 10 } },
        promptModalities: ["text", "image"],
      },
    });
    expect(normalizeModelId("seedream-4.5-edit")).toBeNull();
    expect(
      resolveModelUpstreamRoute({
        modelCode: "seedream-4.5",
        kind: "image",
        configuredProviders: [
          {
            id: "fal-primary",
            providerId: "fal",
            upstreamId: "fal",
            enabled: true,
            configuredCredentials: ["apiKey"],
          },
        ],
      }),
    ).toBeNull();
  });

  it("does not expose legacy fal edit IDs as cards or aliases", () => {
    expect(MODEL_CARDS.some((model) => model.id === "nano-banana-2-edit")).toBe(false);
    expect(MODEL_CARDS.some((model) => model.id === "flux-2-pro-edit")).toBe(false);
    expect(MODEL_CARDS.some((model) => model.id === "seedream-4.5-edit")).toBe(false);
    expect(normalizeModelId("nano-banana-2-edit")).toBeNull();
    expect(normalizeModelId("flux-2-pro-edit")).toBeNull();
    expect(normalizeModelId("seedream-4.5-edit")).toBeNull();
  });

  it("declares Suno API as a first-class ordered provider route", () => {
    const suno = MODEL_CARDS.find((model) => model.id === "suno-v5.5");
    expect(suno).toMatchObject({
      kind: "audio",
      availableProviders: ["suno"],
      defaultProvider: "suno",
    });
    expect(resolveModelUpstreamRoute({
      modelCode: "suno-v5.5",
      kind: "audio",
      configuredProviders: [{
        id: "suno-secondary",
        providerId: "suno",
        upstreamId: "suno",
        enabled: true,
        priority: 40,
        configuredCredentials: ["apiKey", "callbackUrl"],
      }],
    })).toMatchObject({
      accountId: "suno-secondary",
      providerId: "suno",
      upstreamId: "suno",
      upstreamModel: "V5_5",
      apiShape: "suno",
    });
  });

  it("declares MiniMax Music 3 and both user-facing H3 modes as first-class MiniMax routes", () => {
    expect(MODEL_CARDS.find((model) => model.id === "minimax-music-3")).toMatchObject({
      name: "MiniMax Music 3.0",
      kind: "audio",
      availableProviders: ["minimax", "pika"],
      defaultProvider: "minimax",
      musicInput: {
        lyricsTarget: "modelParam",
        lyricsParam: "lyrics",
        maxLyricsCharacters: 3500,
        maxPromptCharacters: 2000,
      },
      parameters: [
        expect.objectContaining({ id: "lyrics_optimizer", type: "boolean" }),
        expect.objectContaining({ id: "is_instrumental", type: "boolean" }),
        expect.objectContaining({ id: "sample_rate", type: "select" }),
        expect.objectContaining({ id: "bitrate", type: "select" }),
        expect.objectContaining({ id: "format", type: "select" }),
        expect.objectContaining({ id: "aigc_watermark", type: "boolean" }),
      ],
    });
    expect(MODEL_CARDS.find((model) => model.id === "suno-v5.5")).toMatchObject({
      musicInput: {
        lyricsTarget: "prompt",
        descriptionParam: "style",
        titleParam: "title",
      },
    });
    expect(resolveModelUpstreamRoute({
      modelCode: "minimax-music-3",
      kind: "audio",
      configuredProviders: [{
        id: "minimax-primary",
        providerId: "minimax",
        upstreamId: "minimax",
        enabled: true,
        configuredCredentials: ["apiKey"],
      }],
    })).toMatchObject({
      accountId: "minimax-primary",
      upstreamModel: "music-3.0",
      apiShape: "minimax",
    });

    expect(MODEL_CARDS.find((model) => model.id === "minimax-h3")).toMatchObject({
      name: "MiniMax H3 (全能参考)",
      kind: "video",
      availableProviders: ["minimax", "pika"],
      defaultProvider: "minimax",
      input: {
        referenceBinding: { type: "ordered-content-parts" },
        inputMode: {
          images: { max: 9 },
          videos: { max: 3 },
          audios: { max: 3, requiresAnyOf: ["image", "video"] },
        },
      },
    });
    expect(MODEL_CARDS.find((model) => model.id === "minimax-h3")?.parameters).toEqual([
      expect.objectContaining({ id: "duration" }),
      expect.objectContaining({
        id: "aspect_ratio",
        options: expect.arrayContaining([expect.objectContaining({ value: "adaptive" })]),
      }),
      expect.objectContaining({ id: "resolution" }),
    ]);
    expect(resolveModelUpstreamRoute({
      modelCode: "minimax-h3",
      kind: "video",
      configuredProviders: [{
        id: "minimax-primary",
        providerId: "minimax",
        upstreamId: "minimax",
        enabled: true,
        configuredCredentials: ["apiKey"],
      }],
    })).toMatchObject({
      accountId: "minimax-primary",
      upstreamModel: "MiniMax-H3",
      apiShape: "minimax",
    });

    expect(MODEL_CARDS.find((model) => model.id === "minimax-h3-startend")).toMatchObject({
      name: "MiniMax H3 (Start / End Frame)",
      kind: "video",
      availableProviders: ["minimax", "pika"],
      defaultProvider: "minimax",
      parameters: [
        expect.objectContaining({ id: "duration" }),
        expect.objectContaining({ id: "resolution" }),
      ],
      defaultParams: {
        duration: 5,
        resolution: "2K",
      },
      input: {
        inputMode: { startEnd: {} },
      },
    });
    expect(resolveModelUpstreamRoute({
      modelCode: "minimax-h3-startend",
      kind: "video",
      configuredProviders: [{
        id: "minimax-primary",
        providerId: "minimax",
        upstreamId: "minimax",
        enabled: true,
        configuredCredentials: ["apiKey"],
      }],
    })).toMatchObject({
      accountId: "minimax-primary",
      upstreamModel: "MiniMax-H3",
      apiShape: "minimax",
    });
  });

  it("names a card by what it produces, with no second axis", () => {
    // This asserted the opposite: that `task` separated the job from the media kind, so
    // transcription was `kind: "asr", task: "speech-to-text"`. Producing one class of output is one
    // action and the rest is parameters, so transcription is text and speech is audio, said once.
    // The old `asr` kind named a technique rather than an output, which is why it could not survive
    // the rule while image, video, audio and text could.
    expect(MODEL_CARDS.find((model) => model.id === "sensevoice-small-asr")?.kind).toBe("text");
    expect(MODEL_CARDS.find((model) => model.id === "piper-huayan-tts")?.kind).toBe("audio");
    expect(MODEL_CARDS.every((model) => !("task" in model))).toBe(true);
  });

  it("accepts whichever credential the chosen Omni surface takes", () => {
    // Not an api key. The Interactions API answers one with 401 "API keys are not supported by this
    // API", measured with a key that generateContent accepts -- so a token is the only way in, and a
    // service account is the only unattended way to hold one. The name said "Gateway", which was
    // removed some time ago.
    const direct = resolveModelUpstreamRoute({
      modelCode: "gemini-omni-flash",
      kind: "video",
      configuredProviders: [{
        id: "google-direct",
        providerId: "official",
        upstreamId: "google-ai-studio",
        region: "global",
        configuredCredentials: ["serviceAccountKey"],
      }],
    });
    const gateway = resolveModelUpstreamRoute({
      modelCode: "gemini-omni-flash",
      kind: "video",
      configuredProviders: [{
        id: "google-proxy",
        providerId: "official",
        upstreamId: "google-ai-studio",
        region: "global",
        configuredCredentials: ["baseUrl"],
      }],
    });
    const incompleteGateway = resolveModelUpstreamRoute({
      modelCode: "gemini-omni-flash",
      kind: "video",
      configuredProviders: [{
        id: "google-gateway-incomplete",
        providerId: "official",
        upstreamId: "google-ai-studio",
        region: "global",
        configuredCredentials: [],
      }],
    });

    expect(direct).toMatchObject({ accountId: "google-direct" });
    expect(gateway).toMatchObject({
      accountId: "google-proxy",
      credentialRequirements: {
        anyOf: [["serviceAccountKey"], ["apiKey"], ["baseUrl"]],
        exclusive: true,
      },
    });
    expect(incompleteGateway).toBeNull();
  });

  it("binds the selected provider account after applying per-model order", () => {
    const route = resolveModelUpstreamRoute({
      modelCode: "gpt-image-2",
      kind: "image",
      configuredProviders: [
        {
          id: "replicate-general",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 1,
          modelPriorities: { "gpt-image-2": 50 },
          configuredCredentials: ["apiKey"],
        },
        {
          id: "replicate-images",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 20,
          modelPriorities: { "gpt-image-2": 5 },
          configuredCredentials: ["apiKey"],
        },
      ],
    });
    expect(route).toMatchObject({
      accountId: "replicate-images",
      providerId: "replicate",
      upstreamModel: "openai/gpt-image-2",
    });
  });
});
