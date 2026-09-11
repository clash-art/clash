import { describe, expect, it } from "vitest";

import { submitPikaMedia, pollPikaMediaOnce, type PikaMediaGenerationInput, type PikaUsageLifecycleEvent } from "./pika-media";

async function runFixture(apiKey: string, input: PikaMediaGenerationInput) {
  const token = await submitPikaMedia(apiKey, input);
  return pollPikaMediaOnce(apiKey, input, token);
}

describe("generatePikaMedia", () => {
  it("executes a Pika-routed image generation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const usageEvents: PikaUsageLifecycleEvent[] = [];
    const result = await runFixture("pk_live_hosted", {
      taskId: "hosted-pika-1",
      kind: "image",
      route: {
        modelCode: "nano-banana-2",
        kind: "image",
        providerId: "pika",
        upstreamId: "pika",
        upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
        apiShape: "pika",
        priority: 18,
        requiredCredentials: ["apiKey"],
      },
      prompt: "quiet paper garden",
      aspectRatio: "3:4",
      modelParams: { resolution: "2K", count: 1 },
      onUsageEvent: async (event) => { usageEvents.push(event); },
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, init });
        if (url.endsWith("/v1/media/google/gemini-3.1-flash-image/text-to-image")) {
          return Response.json({ id: "hosted-pika-job", status: "queued" });
        }
        if (url.endsWith("/v1/media/jobs/hosted-pika-job")) {
          return Response.json({ id: "hosted-pika-job", status: "completed" });
        }
        if (url.endsWith("/v1/media/jobs/hosted-pika-job/content")) {
          return Response.json({ url: "https://pika.test/hosted.png" });
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(result).toEqual({
      url: "https://pika.test/hosted.png",
      requestId: "hosted-pika-job",
      operation: "google/gemini-3.1-flash-image/text-to-image",
    });
    const submitCall = calls.find((call) => call.url.includes("/v1/media/google/"));
    expect(JSON.parse(String(submitCall?.init?.body))).toEqual({
      prompt: "quiet paper garden",
      num_images: 1,
      aspect_ratio: "3:4",
      output_format: "png",
      resolution: "2K",
    });
    expect(usageEvents).toEqual([
      expect.objectContaining({
        status: "submitted",
        providerRequestId: "hosted-pika-job",
        idempotencyKey: "hosted-pika-1",
        operation: "google/gemini-3.1-flash-image/text-to-image",
        billingBasis: { num_images: 1, aspect_ratio: "3:4", output_format: "png", resolution: "2K" },
      }),
      expect.objectContaining({
        status: "completed",
        providerRequestId: "hosted-pika-job",
      }),
    ]);
    expect(JSON.stringify(usageEvents)).not.toContain("quiet paper garden");
  });
});
