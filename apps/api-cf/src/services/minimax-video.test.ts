import { describe, expect, it, vi } from "vitest";

import { submitMiniMaxVideo, pollMiniMaxVideoOnce, type MiniMaxVideoParams } from "./minimax-video";

async function runFixture(params: MiniMaxVideoParams) {
  const token = await submitMiniMaxVideo(params);
  const first = await pollMiniMaxVideoOnce(params, token);
  return first ?? await pollMiniMaxVideoOnce(params, token);
}

describe("MiniMax H3 video service", () => {
  it("emits one complete text item and preserves omni-reference order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "h3-ordered-1" }))
      .mockResolvedValueOnce(Response.json({
        task: {
          id: "h3-ordered-1",
          status: "succeeded",
          content: { url: "https://cdn.minimax.io/h3-ordered.mp4" },
        },
      }));

    await runFixture({
      apiKey: "mini-key",
      model: "MiniMax-H3",
      prompt: "Use the subject, then follow the motion.",
      orderedContentParts: [
        { type: "text", text: "Use " },
        { type: "image", url: "https://media.clash.test/subject.png" },
        { type: "text", text: ", then follow " },
        { type: "video", url: "https://media.clash.test/motion.mp4" },
        { type: "text", text: "." },
      ],
      duration: 5,
      resolution: "2K",
      ratio: "adaptive",
      fetch: fetchMock,
    } as never);

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).content).toEqual([
      { type: "text", text: "Use the subject, then follow the motion." },
      {
        type: "image_url",
        image_url: { url: "https://media.clash.test/subject.png" },
        role: "reference_image",
      },
      {
        type: "video_url",
        video_url: { url: "https://media.clash.test/motion.mp4" },
        role: "reference_video",
      },
    ]);
  });

  it("maps the product start/end frame slots to MiniMax H3 frame roles", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "h3-startend-1" }))
      .mockResolvedValueOnce(Response.json({
        task: {
          id: "h3-startend-1",
          status: "succeeded",
          content: { url: "https://cdn.minimax.io/h3-startend.mp4" },
        },
      }));

    await runFixture({
      apiKey: "mini-key",
      model: "MiniMax-H3",
      prompt: "Move naturally between these frames",
      duration: 5,
      resolution: "2K",
      ratio: "16:9",
      startFrame: "https://media.clash.test/start.png",
      endFrame: "https://media.clash.test/end.png",
      fetch: fetchMock,
    } as never);

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      model: "MiniMax-H3",
      content: [
        { type: "text", text: "Move naturally between these frames" },
        { type: "image_url", image_url: { url: "https://media.clash.test/start.png" }, role: "first_frame" },
        { type: "image_url", image_url: { url: "https://media.clash.test/end.png" }, role: "last_frame" },
      ],
      resolution: "2K",
      duration: 5,
      ratio: "adaptive",
    });
  });

  it("submits multimodal H3 input, polls the V2 task, and returns its video URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "h3-task-1" }))
      .mockResolvedValueOnce(Response.json({
        task: { id: "h3-task-1", status: "running" },
      }))
      .mockResolvedValueOnce(Response.json({
        task: {
          id: "h3-task-1",
          status: "succeeded",
          content: { url: "https://cdn.minimax.io/h3-output.mp4" },
          duration: 8,
          resolution: "2K",
          ratio: "16:9",
        },
      }));

    const result = await runFixture({
      apiKey: "mini-key",
      model: "MiniMax-H3",
      prompt: "A cinematic train crosses a frozen lake",
      duration: 8,
      resolution: "2K",
      ratio: "16:9",
      referenceImages: ["https://media.clash.test/image.png"],
      referenceVideos: ["https://media.clash.test/video.mp4"],
      referenceAudios: ["https://media.clash.test/voice.mp3"],
      baseUrl: "https://api.minimax.io/",
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.minimax.io/v2/video_generation",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      model: "MiniMax-H3",
      content: [
        { type: "text", text: "A cinematic train crosses a frozen lake" },
        { type: "image_url", image_url: { url: "https://media.clash.test/image.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "https://media.clash.test/video.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "https://media.clash.test/voice.mp3" }, role: "reference_audio" },
      ],
      resolution: "2K",
      duration: 8,
      ratio: "16:9",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.minimax.io/v2/query/video_generation/h3-task-1",
      expect.any(Object),
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer mini-key");
    expect(result).toEqual({
      taskId: "h3-task-1",
      url: "https://cdn.minimax.io/h3-output.mp4",
      model: "MiniMax-H3",
      duration: 8,
    });
  });
});
