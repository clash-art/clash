import { describe, expect, it, vi } from "vitest";

import {
  minimaxSubmit,
  minimaxPoll,
  type MinimaxPollState,
} from "@clash/shared-runtime/minimax-executor";

/**
 * MiniMax, translated rather than waited on.
 *
 * The host used to do this inline, with a loop of 180 attempts five seconds apart. Fifteen minutes
 * was the most generous of the seven hand-written ceilings in that file and none of them came from
 * anywhere; the job id lived in a local variable, so a host that stopped mid-loop lost a generation
 * that had already been billed.
 *
 * Split in two, neither half waits. How often to ask, and for how long, stops being MiniMax's
 * opinion.
 *
 * MiniMax is the first ported provider that does not queue everything. Its audio endpoints answer
 * in the same call with the bytes inline, so there is nothing to poll and no id to poll it with.
 * That path returns `completed` from submit, which is what the protocol says a synchronous provider
 * does — inventing a poll cycle for it would mean inventing an identifier MiniMax never issued.
 */
describe("minimax executor", () => {
  const apiKey = "test-key";
  const model = "MiniMax-Hailuo-H3";

  function textResponse(
    raw: string,
    init: { ok?: boolean; statusText?: string } = {},
  ) {
    return {
      ok: init.ok ?? true,
      status: init.ok === false ? 500 : 200,
      statusText: init.statusText ?? "OK",
      text: async () => raw,
    };
  }

  function jsonResponse(
    body: unknown,
    init: { ok?: boolean; statusText?: string } = {},
  ) {
    return textResponse(JSON.stringify(body), init);
  }

  describe("video, which MiniMax queues", () => {
    const submitVideo = (fetch: unknown) =>
      minimaxSubmit({
        kind: "video" as const,
        apiKey,
        body: { model, content: [], resolution: "2K" },
        fetch: fetch as never,
      });

    it("returns MiniMax's task id as poll state instead of waiting for it", async () => {
      const fetch = async () => jsonResponse({ task_id: "task-9" });
      const result = await submitVideo(fetch);
      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") throw new Error("expected accepted");
      // The id alone. MiniMax queries by it and nothing else, and copying the model in here because
      // it happens to be at hand would duplicate what the node already records.
      expect(result.pollState).toStrictEqual({ taskId: "task-9" });
    });

    it("normalizes MiniMax's numeric live task id into string poll state", async () => {
      // Captured from the real H3 API on 2026-08-12. MiniMax emits this field as a JSON number,
      // while Clash keeps provider task identifiers opaque and string-valued across persistence.
      const fetch = async () => jsonResponse({ task_id: 429977861058784 });
      const result = await submitVideo(fetch);

      expect(result).toEqual({
        status: "accepted",
        pollState: { taskId: "429977861058784" },
      });
    });

    it("refuses a submission MiniMax did not acknowledge", async () => {
      // Without a task id there is nothing to poll. Reporting success would leave the host waiting
      // on work it can never ask about, while the job may well be running and billable upstream.
      const fetch = async () =>
        jsonResponse({ base_resp: { status_msg: "ok" } });
      await expect(submitVideo(fetch)).rejects.toMatchObject({
        failure: {
          code: "invalid_response",
          message: expect.stringMatching(/task_id/),
          retryable: false,
          requestState: "unknown",
        },
      });
    });

    it("reports still-running work as unfinished, with the same state", async () => {
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () =>
        jsonResponse({ task: { status: "Processing" } });
      const result = await minimaxPoll({
        state,
        apiKey,
        fetch: fetch as never,
      });
      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") throw new Error("expected accepted");
      expect(result.pollState).toEqual(state);
    });

    it("treats a task with no status yet as queued rather than as an error", async () => {
      // MiniMax omits the field entirely in the moments after submission. The original defaulted to
      // `queued` there, and treating a missing field as terminal would abandon work that is fine.
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () => jsonResponse({ task: {} });
      const result = await minimaxPoll({
        state,
        apiKey,
        fetch: fetch as never,
      });
      expect(result.status).toBe("accepted");
    });

    it("surfaces a failed job as an error rather than an endless wait", async () => {
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () =>
        jsonResponse({
          task: { status: "failed", error: { message: "content policy" } },
        });
      await expect(
        minimaxPoll({ state, apiKey, fetch: fetch as never }),
      ).rejects.toMatchObject({
        failure: {
          code: "provider_failed",
          message: expect.stringMatching(/content policy/),
          retryable: false,
          requestState: "accepted",
          providerCode: "failed",
        },
      });
    });

    it("treats a cancelled job as terminal, spelled the way MiniMax spells it", async () => {
      // Two Ls. Replicate's equivalent state has one, and a shared spelling would silently poll a
      // dead job until the host's own budget ran out.
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () => jsonResponse({ task: { status: "cancelled" } });
      await expect(
        minimaxPoll({ state, apiKey, fetch: fetch as never }),
      ).rejects.toThrow(/cancelled/);
    });

    it("ends the wait on a status it cannot place, quoting what MiniMax sent", async () => {
      // The mistake this guards against has no symptom. `status !== "succeeded"` reads as careful
      // and hands every unfamiliar word to another poll: a state MiniMax adds later, or spells
      // differently for a new model family, would be asked about until the host's budget ran out
      // while the node sat at generating and nothing was ever raised.
      //
      // Quoting the spelling MiniMax actually used is the point of the message — it is what lets
      // whoever reads it decide whether to add the state here or find out why it appeared.
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () => jsonResponse({ task: { status: "Preparing" } });
      await expect(
        minimaxPoll({ state, apiKey, fetch: fetch as never }),
      ).rejects.toThrow(/"Preparing".*does not recognise/s);
    });

    it("returns the media url once MiniMax reports success", async () => {
      const state: MinimaxPollState = { taskId: "task-9" };
      const calls: string[] = [];
      const fetch = async (url: string) => {
        calls.push(String(url));
        return jsonResponse({
          task: {
            status: "Succeeded",
            content: { url: "https://minimax.test/out.mp4" },
            duration: 6,
          },
        });
      };
      const result = await minimaxPoll({
        state,
        apiKey,
        fetch: fetch as never,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.media.url).toBe("https://minimax.test/out.mp4");
      // MiniMax reports whole seconds; the host stores milliseconds.
      expect(result.media.durationMs).toBe(6000);
      // One status check per poll. Looping here would put the wait back where it was.
      expect(calls).toHaveLength(1);
    });

    it("refuses a success that carries no video url", async () => {
      // A succeeded task with no url is not something to hand on as a result; the host would store
      // an asset pointing nowhere.
      const state: MinimaxPollState = { taskId: "task-9" };
      const fetch = async () =>
        jsonResponse({ task: { status: "succeeded", content: {} } });
      await expect(
        minimaxPoll({ state, apiKey, fetch: fetch as never }),
      ).rejects.toThrow(/url/i);
    });
  });

  describe("audio, which MiniMax answers in the same call", () => {
    const submitAudio = (
      fetch: unknown,
      body: Record<string, unknown> = {
        model: "speech-2.8-hd",
        text: "hello",
        audio_setting: { format: "wav" },
      },
    ) =>
      minimaxSubmit({
        kind: "audio" as const,
        apiKey,
        body,
        fetch: fetch as never,
      });

    it("returns the decoded audio without a poll cycle", async () => {
      const fetch = async () =>
        jsonResponse({
          base_resp: { status_code: 0 },
          data: { audio: "48656c6c6f" },
        });
      vi.stubGlobal("Buffer", undefined);
      let result;
      try { result = await submitAudio(fetch); } finally { vi.unstubAllGlobals(); }
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(Buffer.from(result.media.bytes).toString()).toBe("Hello");
      expect(result.media.contentType).toBe("audio/wav");
    });

    it("rejects an error MiniMax reports inside a successful HTTP response", async () => {
      // MiniMax answers 200 and puts the verdict in `base_resp.status_code`. Trusting the HTTP
      // status alone would hand the host an empty result as though it had worked.
      const fetch = async () =>
        jsonResponse({
          base_resp: { status_code: 1004, status_msg: "invalid api key" },
          data: {},
        });
      await expect(submitAudio(fetch)).rejects.toMatchObject({
        failure: {
          code: "authentication_failed",
          message: expect.stringMatching(/invalid api key/),
          retryable: false,
          requestState: "rejected",
          providerCode: "1004",
        },
      });
    });

    it("refuses a response with no audio payload", async () => {
      const fetch = async () =>
        jsonResponse({ base_resp: { status_code: 0 }, data: {} });
      await expect(submitAudio(fetch)).rejects.toThrow(/no audio/i);
    });

    it("names the media type after the format that was actually requested", async () => {
      // Read back from the body rather than passed alongside it, so the declared type cannot drift
      // from what MiniMax was told to produce. `pcm` is the odd one: its registered type is
      // `audio/L16`, not anything with `pcm` in it.
      const cases: Array<[string, string]> = [
        ["wav", "audio/wav"],
        ["pcm", "audio/L16"],
        ["mp3", "audio/mpeg"],
      ];
      for (const [format, contentType] of cases) {
        const fetch = async () =>
          jsonResponse({
            base_resp: { status_code: 0 },
            data: { audio: "00" },
          });
        const result = await submitAudio(fetch, {
          model: "speech-2.8-hd",
          text: "hi",
          audio_setting: { format },
        });
        if (result.status !== "completed")
          throw new Error("expected completed");
        expect(result.media.contentType, format).toBe(contentType);
      }
    });

    it("carries a music duration through as MiniMax reports it", async () => {
      // `extra_info.music_duration` is already milliseconds, unlike the video task's whole seconds.
      // Scaling this one too would report tracks a thousand times too long.
      const fetch = async () =>
        jsonResponse({
          base_resp: { status_code: 0 },
          data: { audio: "00" },
          extra_info: { music_duration: 187000 },
        });
      const result = await submitAudio(fetch, {
        model: "music-1.5",
        prompt: "a waltz",
        audio_setting: { format: "mp3" },
      });
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.media.durationMs).toBe(187000);
    });

    it("rejects hex that cannot be a payload", async () => {
      // An odd number of characters means the response was truncated, and decoding it leniently
      // would store a corrupt asset that only fails when someone plays it.
      const fetch = async () =>
        jsonResponse({
          base_resp: { status_code: 0 },
          data: { audio: "abc" },
        });
      await expect(submitAudio(fetch)).rejects.toThrow(/hex/i);
    });
  });

  it("surfaces a non-JSON error body instead of hiding it behind the status line", async () => {
    // A gateway between here and MiniMax answers with HTML. The original passed that text through,
    // which is the difference between diagnosing a proxy and staring at "Bad Gateway".
    const fetch = async () =>
      textResponse("<html>upstream down</html>", {
        ok: false,
        statusText: "Bad Gateway",
      });
    await expect(
      minimaxSubmit({
        kind: "video",
        apiKey,
        body: {},
        fetch: fetch as never,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "provider_unavailable",
        message: expect.stringMatching(/upstream down/),
        retryable: true,
        requestState: "unknown",
        providerCode: "HTTP_500",
      },
    });
  });

  it("never sleeps", async () => {
    // The point of the split is that neither half decides how long to wait. A timer in here would
    // reintroduce a ceiling that no Model Card asked for.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../packages/shared-runtime/src/minimax-executor.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/setTimeout|setInterval|sleep\(/);
    expect(source).not.toMatch(/for \(let attempt/);
  });
});
