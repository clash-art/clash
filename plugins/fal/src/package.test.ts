import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_CARDS,
  composeExecutablePluginModelCards,
  resolveModelBindingFromProvider,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (relativePath: string) =>
  JSON.parse(await readFile(join(root, relativePath), "utf8"));

const FAL_BINDINGS = [
  ["flux-schnell", "fal-ai/flux/schnell"],
  ["flux-dev", "fal-ai/flux/dev"],
  ["gpt-image-2", "openai/gpt-image-2"],
  ["nano-banana-2", "fal-ai/nano-banana-2"],
  ["seedream-4.5", "fal-ai/bytedance/seedream/v4.5/text-to-image"],
  ["recraft-v4", "fal-ai/recraft/v4/pro/text-to-image"],
  ["flux-2-pro", "fal-ai/flux-2-pro"],
  ["sora-2", "fal-ai/sora-2/text-to-video"],
  ["kling-3", "fal-ai/kling-video/v3/pro/image-to-video"],
  ["flux-3-video", "blackforestlabs/flux-3/text-to-video"],
  ["flux-3-video-keyframes", "blackforestlabs/flux-3/keyframes-to-video"],
  ["flux-3-video-continue", "blackforestlabs/flux-3/extend-video"],
  ["seedance-2-startend", "bytedance/seedance-2.0/image-to-video"],
  ["seedance-2-ref", "bytedance/seedance-2.0/reference-to-video"],
  ["minimax-tts", "fal-ai/minimax/speech-02-hd"],
  ["minimax-music-3", "fal-ai/minimax-music/v3"],
  ["minimax-h3", "minimax/h3/reference-to-video"],
  ["minimax-h3-startend", "minimax/h3/image-to-video"],
  ["gpt-image-2.5-flare", "openai/gpt-image-2.5/flare/text-to-image"],
  ["gpt-image-2.5-sunburst", "openai/gpt-image-2.5/sunburst/text-to-image"],
] as const;

describe("fal Provider package", () => {
  it("declares every shipped fal model route as a plugin binding", async () => {
    const manifest = await json("manifest.json");
    const declared = manifest.contributes.modelBindings.map(
      ({ id }: { id: string }) => id,
    );
    expect(declared).toEqual(FAL_BINDINGS.map(([modelId]) => modelId));
  });

  it("validates the provider, model bindings, and contract tests", async () => {
    const manifest = await json("manifest.json");
    const provider = await json("providers/fal.json");
    const bindings = Object.fromEntries(
      await Promise.all(
        manifest.contributes.modelBindings.map(
          async ({ path }: { path: string }) => [path, await json(path)],
        ),
      ),
    );
    const contractTests = Object.fromEntries(
      await Promise.all(
        manifest.contractTests.map(async (path: string) => [
          path,
          await json(path),
        ]),
      ),
    );

    expect(
      validateExecutablePluginPackage(manifest, {}, contractTests, {
        providers: { "providers/fal.json": provider },
        modelBindings: bindings,
      }),
    ).toMatchObject({ cards: {} });
  });

  it("composes all fal routes with immutable plugin executor provenance", async () => {
    const manifest = await json("manifest.json");
    const provider = await json("providers/fal.json");
    const registrations = await Promise.all(
      manifest.contributes.modelBindings.map(
        async ({ path }: { path: string }) => {
          const binding = await json(path);
          return {
            pluginId: manifest.id,
            version: manifest.version,
            schemaHash: `sha256:${"a".repeat(64)}`,
            runtime: manifest.runtime,
            document: {
              ...binding,
              spec: {
                ...binding.spec,
                ...resolveModelBindingFromProvider(binding.spec, provider.spec),
              },
            },
          };
        },
      ),
    );
    const composed = composeExecutablePluginModelCards(
      MODEL_CARDS,
      [],
      registrations as never,
    );

    for (const [modelId, upstreamModel] of FAL_BINDINGS) {
      expect(
        composed
          .find((card) => card.id === modelId)
          ?.providerImplementations?.find(
            (implementation) => implementation.providerId === "fal",
          ),
      ).toMatchObject({
        upstreamId: "fal",
        upstreamModel,
        apiShape: "fal-queue",
        executorPluginId: "clash.fal",
        executorExportId: "fal-execute",
      });
    }
  });

  it("keeps provider-specific parameters and reference dialects in bindings", async () => {
    const seedance = await json("bindings/seedance-2-ref.json");
    const h3 = await json("bindings/minimax-h3.json");
    const music = await json("bindings/minimax-music-3.json");

    expect(seedance.spec).toMatchObject({
      excludedParameterIds: ["edit_mode"],
      defaultParamOverrides: { duration: "auto" },
      referenceBinding: {
        type: "positional-tokens",
        modalityScopedIndexes: true,
        tokens: {
          image: "@Image{n}",
          video: "@Video{n}",
          audio: "@Audio{n}",
        },
      },
    });
    expect(
      h3.spec.parameterOverrides.find(
        (parameter: { id: string }) => parameter.id === "aspect_ratio",
      ),
    ).toMatchObject({
      defaultValue: "16:9",
      description: expect.stringMatching(/reference/i),
    });
    expect(music.spec.excludedParameterIds).toEqual(["aigc_watermark"]);
  });
});
