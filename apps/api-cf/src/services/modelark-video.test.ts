import { afterEach, describe, expect, it, vi } from "vitest";

import { submitModelArkVideo, pollModelArkVideoOnce, type ModelArkVideoParams } from "./modelark-video";

function successfulFetchMock() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "cgt-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "cgt-test",
          status: "succeeded",
          output: { video_url: "https://cdn.example/video.mp4" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
}

async function runFixture(key: string, params: ModelArkVideoParams) {
  const token = await submitModelArkVideo(key, params);
  return pollModelArkVideoOnce(key, params, token);
}

describe("ModelArk video service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates and polls a ModelArk video generation task", async () => {
    const fetchMock = successfulFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runFixture("ark-key", {
      baseUrl: "https://ark.example.com/api/v3",
      prompt: "cinematic product launch",
      modelName: "seedance-2-ref",
      upstreamModel: "doubao-seedance-2-0-260128",
      referenceImageUrls: ["https://cdn.example/ref.png"],
      referenceVideoUrls: ["https://cdn.example/ref.mp4"],
      referenceAudioUrls: ["https://cdn.example/ref.mp3"],
      duration: 8,
      aspectRatio: "16:9",
      modelParams: { resolution: "720p", generate_audio: true, output_format: "mov" },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://ark.example.com/api/v3/contents/generations/tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ark-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      model: "doubao-seedance-2-0-260128",
      content: [
        { type: "text", text: "cinematic product launch" },
        { type: "image_url", image_url: { url: "https://cdn.example/ref.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "https://cdn.example/ref.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "https://cdn.example/ref.mp3" }, role: "reference_audio" },
      ],
      duration: 8,
      ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
      output_format: "mov",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://ark.example.com/api/v3/contents/generations/tasks/cgt-test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ark-key" }),
      }),
    );
    expect(result).toMatchObject({
      url: "https://cdn.example/video.mp4",
      model: "doubao-seedance-2-0-260128",
      taskId: "cgt-test",
    });
  });

  it("uses the documented Beijing Ark endpoint unless an account overrides it", async () => {
    const fetchMock = successfulFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runFixture("ark-key", {
      prompt: "A quiet establishing shot",
      modelName: "seedance-2.5-ref",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    );
  });

  it("marks first and last frame content with their ModelArk roles", async () => {
    const fetchMock = successfulFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runFixture("ark-key", {
      prompt: "Move from dawn to night",
      modelName: "seedance-2.5-startend",
      upstreamModel: "doubao-seedance-2-5-260628",
      startFrameUrl: "https://cdn.example/first.png",
      endFrameUrl: "https://cdn.example/last.png",
      aspectRatio: "16:9",
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.content).toEqual([
      { type: "text", text: "Move from dawn to night" },
      { type: "image_url", image_url: { url: "https://cdn.example/first.png" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://cdn.example/last.png" }, role: "last_frame" },
    ]);
    expect(body.ratio).toBe("adaptive");
  });

  it("turns the all-purpose edit control into an explicit Seedance 2.5 edit request", async () => {
    const fetchMock = successfulFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runFixture("ark-key", {
      prompt: "Replace the subject in @视频1",
      modelName: "seedance-2.5-ref",
      upstreamModel: "doubao-seedance-2-5-260628",
      referenceVideoUrls: ["https://cdn.example/source.mp4"],
      duration: 12,
      aspectRatio: "16:9",
      modelParams: { edit_mode: true },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      omni_reference_task_type: "edit",
      ratio: "adaptive",
      duration: -1,
    });
  });

  it("rejects edit mode before submission when no source video is attached", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runFixture("ark-key", {
      prompt: "Replace the subject",
      modelName: "seedance-2.5-ref",
      modelParams: { edit_mode: true },
    })).rejects.toThrow(/edit.*reference video/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a continuation card into an explicit Seedance 2.5 extension request", async () => {
    const fetchMock = successfulFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await runFixture("ark-key", {
      prompt: "Continue @视频1 into @视频2",
      modelName: "seedance-2.5-extend",
      upstreamModel: "doubao-seedance-2-5-260628",
      referenceVideoUrls: ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"],
      duration: "auto",
      aspectRatio: "16:9",
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      omni_reference_task_type: "extend",
      ratio: "adaptive",
      duration: -1,
    });
    expect(body.content.filter((part: { role?: string }) => part.role === "reference_video"))
      .toHaveLength(2);
  });

  it("rejects a continuation request before submission when it has no source video", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runFixture("ark-key", {
      prompt: "Continue forward",
      modelName: "seedance-2.5-extend",
    })).rejects.toThrow(/extension.*reference video/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
