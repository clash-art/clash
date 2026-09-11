import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiAdapter, replicateAdapter } from "./adapter.js";
import type { Executor, ExecutorContext } from "@clash/action-sdk";

afterEach(() => vi.unstubAllGlobals());
const ctx = {
  store: {
    get: async (key: string) => (key === "apiKey" ? "test-key" : undefined),
  },
  reference: async () => ({
    form: "bytes",
    bytes: new Uint8Array([1, 2]),
    kind: "image",
    mediaType: "image/png",
  }),
} as unknown as ExecutorContext;
function invocation(
  variant: string,
  references = false,
  pollState?: unknown,
): Parameters<Executor["submit"]>[0] {
  return {
    taskId: "task",
    input: {
      values: {
        modelId: `gpt-image-2.5-${variant}`,
        upstreamModel: `gpt-image-2.5-${variant}`,
        prompt: "cutout",
        aspectRatio: "16:9",
        modelParams: {
          resolution: "3840x2160",
          quality: "max",
          background: "transparent",
          output_format: "webp",
        },
      },
      references: references
        ? [
            {
              slot: "image",
              index: 0,
              asset: {
                assetId: "ref",
                uri: "clash-asset://ref",
                kind: "image",
              },
            },
          ]
        : [],
    },
    pollState,
  } as never;
}
describe("GPT Image provider execution", () => {
  it.each(["flare", "sunburst"])(
    "sends %s generation controls and publishes returned bytes",
    async (variant) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          expect(url).toBe("https://api.openai.com/v1/images/generations");
          expect(JSON.parse(String(init.body))).toMatchObject({
            model: `gpt-image-2.5-${variant}`,
            size: "3840x2160",
            quality: "max",
            background: "transparent",
            output_format: "webp",
            n: 1,
          });
          return Response.json({ data: [{ b64_json: "AQI=" }] });
        }),
      );
      expect(
        await openaiAdapter.submit(invocation(variant), ctx),
      ).toMatchObject({
        status: "completed",
        media: { media: { base64: "AQI=", mediaType: "image/webp" } },
      });
    },
  );
  it("uploads edits as multipart while retaining the selected model and reference bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.openai.com/v1/images/edits");
        const form = init.body as FormData;
        expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
        expect(form.get("quality")).toBe("max");
        expect(
          new Uint8Array(await (form.get("image[]") as Blob).arrayBuffer()),
        ).toEqual(new Uint8Array([1, 2]));
        return Response.json({ data: [{ b64_json: "AQI=" }] });
      }),
    );
    expect(
      (await openaiAdapter.submit(invocation("sunburst", true), ctx)).status,
    ).toBe("completed");
  });
  it("rejects JPEG transparency before submitting a billable request", async () => {
    const input = invocation("flare");
    (input.input.values.modelParams as Record<string, unknown>).output_format =
      "jpeg";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(openaiAdapter.submit(input, ctx)).rejects.toThrow(
      /transparent/i,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("submits a Replicate prediction with its native aspect_ratio field and resumes by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(url).toBe(
            "https://api.replicate.com/v1/models/openai/gpt-image-2.5-flare/predictions",
          );
          expect(JSON.parse(String(init.body))).toMatchObject({
            input: {
              aspect_ratio: "3840x2160",
              quality: "max",
              background: "transparent",
              input_images: ["data:image/png;base64,AQI="],
            },
          });
          return Response.json({ id: "prediction-1", status: "starting" });
        }
        expect(url).toBe(
          "https://api.replicate.com/v1/predictions/prediction-1",
        );
        return Response.json({
          id: "prediction-1",
          status: "succeeded",
          output: ["https://replicate.delivery/image.webp"],
        });
      }),
    );
    const input = invocation("flare", true);
    input.input.values.upstreamModel = "openai/gpt-image-2.5-flare";
    const pending = await replicateAdapter.submit(input, ctx);
    expect(pending).toMatchObject({
      status: "accepted",
      pollState: { id: "prediction-1" },
    });
    if (pending.status !== "accepted")
      throw new Error("Expected prediction receipt");
    expect(
      await replicateAdapter.poll!(
        { ...input, pollState: pending.pollState },
        ctx,
      ),
    ).toMatchObject({
      status: "completed",
      media: {
        media: {
          url: "https://replicate.delivery/image.webp",
          mediaType: "image/webp",
        },
      },
    });
  });
});

import { readFile } from "node:fs/promises";
import {
  MODEL_CARDS,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
it("registers executable routes for accounts created from both provider declarations", async () => {
  const json = async (path: string) =>
    JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  const manifest = await json("manifest.json");
  const providers = Object.fromEntries(
    await Promise.all(
      manifest.contributes.providers.map(async ({ path }: { path: string }) => [
        path,
        await json(path),
      ]),
    ),
  );
  const fixtures = Object.fromEntries(
    await Promise.all(
      manifest.contractTests.map(async (path: string) => [
        path,
        await json(path),
      ]),
    ),
  );
  expect(() =>
    validateExecutablePluginPackage(manifest, {}, fixtures, { providers }),
  ).not.toThrow();
  for (const document of Object.values(providers) as Array<{
    spec: { id: string; executorExportId: string };
  }>) {
    const route = MODEL_CARDS.find(
      (card) => card.id === "gpt-image-2.5-flare",
    )?.providerImplementations?.find(
      (route) => route.providerId === document.spec.id,
    );
    expect(route).toMatchObject({
      executorPluginId: manifest.id,
      executorExportId: document.spec.executorExportId,
    });
  }
});
