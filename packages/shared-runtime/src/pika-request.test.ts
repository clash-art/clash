import { describe, expect, it } from "vitest";

import { buildPikaMediaRequest } from "./pika-request.js";

describe("Pika media request projection", () => {
  // dev.pika.art/llms/openai/gpt-image-2.5-flare/image-to-image
  it.each(["flare", "sunburst"])(
    "passes GPT Image 2.5 %s controls through the edit route",
    (variant) => {
      expect(
        buildPikaMediaRequest({
          modelId: `gpt-image-2.5-${variant}`,
          upstreamModel: `openai/gpt-image-2.5-${variant}/text-to-image`,
          kind: "image",
          prompt: "edit",
          aspectRatio: "16:9",
          modelParams: {
            resolution: "4K",
            quality: "xhigh",
            background: "transparent",
            count: 2,
          },
          referenceImageUrls: ["https://example.test/ref.png"],
        }),
      ).toEqual({
        operation: `openai/gpt-image-2.5-${variant}/image-to-image`,
        body: {
          prompt: "edit",
          aspect_ratio: "16:9",
          resolution: "4K",
          quality: "xhigh",
          background: "transparent",
          num_images: 2,
          output_format: "png",
          image_urls: ["https://example.test/ref.png"],
        },
      });
    },
  );

  it("projects Nano Banana 2 text generation onto the live catalog schema", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "nano-banana-2",
        kind: "image",
        upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
        prompt: "a quiet paper garden",
        aspectRatio: "3:4",
        modelParams: { count: 1, resolution: "2K" },
      }),
    ).toEqual({
      operation: "google/gemini-3.1-flash-image/text-to-image",
      body: {
        prompt: "a quiet paper garden",
        num_images: 1,
        aspect_ratio: "3:4",
        output_format: "png",
        resolution: "2K",
      },
    });
  });

  it("selects Nano Banana 2 image editing and preserves all reference URLs", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "nano-banana-2",
        kind: "image",
        upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
        prompt: "combine the references",
        referenceImageUrls: [
          "https://pika.test/a.png",
          "https://pika.test/b.png",
        ],
        modelParams: { count: 1, resolution: "1K" },
      }),
    ).toMatchObject({
      operation: "google/gemini-3.1-flash-image/image-to-image",
      body: {
        image_urls: ["https://pika.test/a.png", "https://pika.test/b.png"],
      },
    });
  });

  it("uses the catalog keyframes field for FLUX 3 image-to-video", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "flux-3-video",
        kind: "video",
        upstreamModel: "black-forest-labs/flux-3-video/text-to-video",
        prompt: "camera pushes through the doorway",
        startFrameUrl: "https://pika.test/start.png",
        duration: "auto",
        modelParams: { resolution: "720p", generate_audio: true },
      }),
    ).toEqual({
      operation: "black-forest-labs/flux-3-video/image-to-video",
      body: {
        prompt: "camera pushes through the doorway",
        duration: "auto",
        resolution: "720p",
        aspect_ratio: "auto",
        draft: false,
        generate_audio: true,
        keyframes: [{ image_url: "https://pika.test/start.png" }],
      },
    });
  });

  it("uses image_urls for Grok Imagine image editing", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "grok-imagine-quality",
        kind: "image",
        upstreamModel: "x-ai/grok-imagine-image-quality/text-to-image",
        prompt: "turn the sketch into a product photo",
        referenceImageUrls: ["https://pika.test/sketch.png"],
        modelParams: { count: 1 },
      }),
    ).toMatchObject({
      operation: "x-ai/grok-imagine-image-quality/image-to-image",
      body: { image_urls: ["https://pika.test/sketch.png"] },
    });
  });

  it("rejects Pika 2.5's 10-second duration without the required source image", () => {
    expect(() =>
      buildPikaMediaRequest({
        modelId: "pika-2.5",
        kind: "video",
        upstreamModel: "pika/pika-2.5/image-to-video",
        prompt: "a paper kite rises",
        duration: 10,
        modelParams: { resolution: "720p" },
      }),
    ).toThrow(/10-second Pika 2.5 generation requires a source image/);
  });

  it("uses Pika 2.5's catalog resolution default when no override is supplied", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "pika-2.5",
        kind: "video",
        upstreamModel: "pika/pika-2.5/image-to-video",
        prompt: "a paper kite rises",
      }).body,
    ).toMatchObject({ resolution: "1080p", duration_s: 5 });
  });

  it("does not let GPT Image 2's auto size override ratio and resolution", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "gpt-image-2",
        kind: "image",
        upstreamModel: "openai/gpt-image-2/text-to-image",
        prompt: "an editorial still life",
        aspectRatio: "3:2",
        modelParams: { size: "auto", resolution: "2K", count: 1 },
      }).body,
    ).toMatchObject({
      aspect_ratio: "3:2",
      resolution: "2K",
    });
    expect(
      buildPikaMediaRequest({
        modelId: "gpt-image-2",
        kind: "image",
        upstreamModel: "openai/gpt-image-2/text-to-image",
        prompt: "an editorial still life",
        modelParams: { size: "auto" },
      }).body,
    ).not.toHaveProperty("size");
  });

  it("maps Recraft's selected ratio onto its documented size field", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "recraft-v4",
        kind: "image",
        upstreamModel: "recraft/recraft-4.1/text-to-image",
        prompt: "a typographic travel poster",
        aspectRatio: "16:9",
      }).body,
    ).toMatchObject({ size: "16:9" });
  });

  it("uses Grok Imagine's catalog default resolution", () => {
    expect(
      buildPikaMediaRequest({
        modelId: "grok-imagine-quality",
        kind: "image",
        upstreamModel: "x-ai/grok-imagine-image-quality/text-to-image",
        prompt: "a product photograph",
      }).body,
    ).toMatchObject({ resolution: "1K" });
  });

  it("rejects MiniMax Speech without the catalog-required voice id", () => {
    expect(() =>
      buildPikaMediaRequest({
        modelId: "minimax-speech-2.8-hd",
        kind: "audio",
        upstreamModel: "minimax/minimax-speech-2.8-hd/text-to-speech",
        prompt: "Read this aloud.",
      }),
    ).toThrow(/voice_id is required/);
  });
});
