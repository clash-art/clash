import { submitBflFlux3Video, pollBflFlux3VideoOnce, type BflFlux3VideoRequestOptions } from "./bfl-video";
async function runFixture(options: BflFlux3VideoRequestOptions) {
  const token = await submitBflFlux3Video(options);
  const first = await pollBflFlux3VideoOnce(options, token);
  return first ?? await pollBflFlux3VideoOnce(options, token);
}
import { describe, expect, it } from "vitest";

import * as runtime from "./index";

describe("BFL FLUX 3 protocol", () => {
  it("uses explicit frame positions and rejects duplicate or out-of-range indices", () => {
    expect(runtime.resolveFlux3KeyframeIndices(
      { keyframe_frame_indices: "[0,72,240]" },
      3,
      10,
    )).toEqual([0, 72, 240]);
    expect(runtime.resolveFlux3KeyframeIndices(undefined, 3, 10)).toEqual([0, 120, 240]);
    expect(() => runtime.resolveFlux3KeyframeIndices(
      { keyframe_frame_indices: "[0,72,72]" },
      3,
      10,
    )).toThrow(/unique, increasing/);
    expect(() => runtime.resolveFlux3KeyframeIndices(
      { keyframe_frame_indices: "[0,72,241]" },
      3,
      10,
    )).toThrow(/between 0 and 240/);
  });

  it("builds official t2v, keyframe, and continuation request bodies", () => {
    const build = (runtime as Record<string, unknown>).buildBflFlux3VideoRequest;
    expect(typeof build).toBe("function");
    if (typeof build !== "function") return;

    expect(build({
      prompt: "morning mist",
      duration: "auto",
      aspectRatio: "16:9",
      modelParams: { resolution: "1080p", generate_audio: true, safety_tolerance: 2 },
    })).toEqual({
      mode: "t2v",
      prompt: "morning mist",
      duration: "auto",
      aspect_ratio: "16:9",
      resolution: "fhd",
      generate_audio: true,
      safety_tolerance: 2,
    });

    expect(build({
      prompt: "connect the beats",
      duration: 10,
      referenceImageUrls: ["https://media.example/a.png", "https://media.example/b.png"],
      modelParams: { resolution: "720p", keyframe_frame_indices: "[0,72]" },
    })).toMatchObject({
      mode: "i2v",
      keyframes: [
        { image_url: "https://media.example/a.png", frame_index: 0 },
        { image_url: "https://media.example/b.png", frame_index: 72 },
      ],
      resolution: "hd",
    });

    expect(build({
      prompt: "continue the shot",
      referenceVideoUrls: ["https://media.example/source.mp4"],
      modelParams: { resolution: "720p" },
    })).toMatchObject({
      mode: "v2v",
      start_video: "https://media.example/source.mp4",
      resolution: "hd",
    });
  });

  it("submits with x-key and follows the official polling URL", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (url === "https://api.bfl.ai/v1/flux-3-video") {
        return Response.json({ id: "flux3-task-1", polling_url: "https://api.bfl.ai/v1/get_result?id=flux3-task-1" });
      }
      if (url === "https://api.bfl.ai/v1/get_result?id=flux3-task-1") {
        return Response.json({ status: "Ready", result: { sample: "https://cdn.example/flux3.mp4" } });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await runFixture({
      apiKey: "bfl-key",
      fetch: fetchImpl as typeof fetch,
      input: { prompt: "morning mist" },
    });

    expect(result).toMatchObject({ requestId: "flux3-task-1", url: "https://cdn.example/flux3.mp4" });
    expect(calls[0]).toMatchObject({
      url: "https://api.bfl.ai/v1/flux-3-video",
      init: { method: "POST", headers: expect.objectContaining({ "x-key": "bfl-key" }) },
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.bfl.ai/v1/get_result?id=flux3-task-1",
      init: { headers: { "x-key": "bfl-key" } },
    });
  });
});
