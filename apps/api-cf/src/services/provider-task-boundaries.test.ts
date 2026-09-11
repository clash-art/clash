import { describe, expect, it, vi } from "vitest";
import { submitMiniMaxVideo, pollMiniMaxVideoOnce } from "./minimax-video";
import { submitSunoAudio, pollSunoAudioOnce } from "./suno-audio";

describe("hosted provider task boundaries", () => {
  it("checkpoints MiniMax acceptance before any status request and polls exactly once", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "accepted-task" }))
      .mockResolvedValueOnce(Response.json({ task: { status: "processing" } }))
      .mockResolvedValueOnce(Response.json({ task: { status: "succeeded", content: { url: "https://media.example/video" } } }));
    const params = { apiKey: "key", model: "h3", prompt: "test", duration: 5, resolution: "768P" as const, ratio: "16:9" as const, fetch: transport };
    const token = await submitMiniMaxVideo(params);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await pollMiniMaxVideoOnce(params, token)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await pollMiniMaxVideoOnce(params, token)).toMatchObject({ taskId: token.taskId, url: "https://media.example/video" });
    expect(transport.mock.calls.slice(1).every(([url]) => String(url).endsWith(encodeURIComponent(token.taskId)))).toBe(true);
  });

  it("returns Suno acceptance independently and resumes the same task", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 200, data: { taskId: "song-task" } }))
      .mockResolvedValueOnce(Response.json({ code: 200, data: { status: "PENDING" } }))
      .mockResolvedValueOnce(Response.json({ code: 200, data: { status: "SUCCESS", response: { sunoData: [{ audioUrl: "https://media.example/song" }] } } }));
    const params = { apiKey: "key", prompt: "test", model: "V5", callbackUrl: "https://host.example/callback", fetch: transport };
    const token = await submitSunoAudio(params);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await pollSunoAudioOnce(params, token)).toBeNull();
    expect(await pollSunoAudioOnce(params, token)).toMatchObject({ taskId: token.taskId, url: "https://media.example/song" });
    expect(transport.mock.calls.slice(1).every(([url]) => String(url).includes(encodeURIComponent(token.taskId)))).toBe(true);
  });
});

it("BFL checkpoints its opaque polling URL and performs one request per poll", async () => {
  const { submitBflFlux3Video, pollBflFlux3VideoOnce } = await import("@clash/shared-runtime");
  const transport = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "job", polling_url: "https://status.example/opaque" }))
    .mockResolvedValueOnce(Response.json({ status: "Pending" }))
    .mockResolvedValueOnce(Response.json({ status: "Ready", result: { sample: "https://media.example/result" } }));
  const options = { apiKey: "key", input: { prompt: "test" }, fetch: transport };
  const token = await submitBflFlux3Video(options);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await pollBflFlux3VideoOnce(options, token)).toBeNull();
  expect(await pollBflFlux3VideoOnce(options, token)).toMatchObject({ url: "https://media.example/result" });
  expect(transport.mock.calls.slice(1).map(([url]) => url)).toEqual([token.pollingUrl, token.pollingUrl]);
});

it("preserves retryable HTTP facts for rejected submits and accepted polls", async () => {
  const { executableFailureFromThrown } = await import("@clash/action-sdk/executable-failure");
  const params = { apiKey: "key", prompt: "test", model: "V5", callbackUrl: "https://host.example/callback", fetch: vi.fn().mockResolvedValue(Response.json({ msg: "busy" }, { status: 429 })) };
  const submitError = await submitSunoAudio(params).catch((error: unknown) => error);
  expect(executableFailureFromThrown(submitError, "submit")).toMatchObject({ retryable: true, requestState: "rejected", code: "rate_limited" });
  params.fetch.mockResolvedValue(Response.json({ msg: "unavailable" }, { status: 503 }));
  const pollError = await pollSunoAudioOnce(params, { taskId: "accepted", model: "V5" }).catch((error: unknown) => error);
  expect(executableFailureFromThrown(pollError, "poll")).toMatchObject({ retryable: true, requestState: "accepted", code: "provider_unavailable" });
});
