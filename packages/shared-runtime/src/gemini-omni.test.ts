import { describe, expect, it, vi } from "vitest";

import {
  createGeminiOmniInteraction,
  downloadGeminiOmniVideo,
  extractGeminiOmniVideo,
  getGeminiOmniInteraction,
} from "./gemini-omni.js";

describe("Gemini Omni Interactions transport", () => {
  it("takes the credential its surface accepts and nothing else", async () => {
    // Routing Gemini through Cloudflare's AI Gateway was removed. It was the only credential in the
    // product whose validity was decided by inspecting another credential's value -- a gateway
    // token was accepted only when the base url's hostname was literally gateway.ai.cloudflare.com,
    // which also meant a self-hosted gateway could not be configured at all.
    //
    // A proxy in front of Google is still expressible: set a base url. What is gone is a second
    // party's credential wearing Google's account.
    await expect(createGeminiOmniInteraction({
      apiKey: "",
      model: "gemini-omni-flash-preview",
      input: [],
      aspectRatio: "16:9",
      duration: 8,
      fetch: (async () => new Response("{}", { status: 200 })) as never,
    })).rejects.toThrow(/requires a Google API key/);
  });

  
  
  it("preserves authored text/image order in a background video interaction", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "interactions/omni-1",
      status: "in_progress",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(createGeminiOmniInteraction({
      accessToken: "gemini-key", project: "p-1",
      baseUrl: "https://aiplatform.googleapis.com/v1beta1/",
      model: "gemini-omni-flash-preview",
      input: [
        { type: "text", text: "Use " },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: " as the jacket reference" },
      ],
      background: true,
      aspectRatio: "9:16",
      duration: 7,
      fetch: fetchImpl,
    })).resolves.toEqual(expect.objectContaining({ id: "interactions/omni-1" }));

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1beta1/projects/p-1/locations/global/interactions",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer gemini-key",
          "content-type": "application/json",
        },
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      model: "gemini-omni-flash-preview",
      input: [
        { type: "text", text: "Use " },
        { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
        { type: "text", text: " as the jacket reference" },
      ],
      response_format: {
        type: "video",
        aspect_ratio: "9:16",
        duration: "7s",
      },
      background: true,
      store: true,
      stream: false,
    });
  });

  it("gets a stored interaction from the developer api and extracts URI or inline video output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "interactions/omni-1",
      status: "completed",
      steps: [{
        content: [
          { type: "text", text: "done" },
          { type: "video", uri: "https://files.example/video-1", mime_type: "video/mp4" },
        ],
      }],
    }), { status: 200 }));

    const interaction = await getGeminiOmniInteraction({
      apiKey: "gemini-key",
      interactionId: "interactions/omni-1",
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/interactions/omni-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(extractGeminiOmniVideo(interaction)).toEqual({
      uri: "https://files.example/video-1",
      mimeType: "video/mp4",
    });
    expect(extractGeminiOmniVideo({
      status: "completed",
      steps: [{ content: [{ type: "video", data: "dmlkZW8=", mime_type: "video/mp4" }] }],
    })).toEqual({ data: "dmlkZW8=", mimeType: "video/mp4" });
  });

  it("surfaces structured API errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "model unavailable" },
    }), { status: 400 }));

    await expect(createGeminiOmniInteraction({
      apiKey: "bad-key",
      model: "gemini-omni-flash-preview",
      input: [{ type: "text", text: "hello" }],
      aspectRatio: "16:9",
      duration: 5,
      fetch: fetchImpl,
    })).rejects.toThrow("model unavailable");
  });

  it("checks Google Files once and leaves PROCESSING scheduling to the caller", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ name: "files/video-1", state: "PROCESSING" }))
      .mockResolvedValueOnce(Response.json({ name: "files/video-1", state: "ACTIVE" }))
      .mockResolvedValueOnce(new Response("video-bytes", { headers: { "content-type": "video/mp4" } }));

    const options = {
      apiKey: "gemini-key",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/video-1:download?alt=media",
      fetch: fetchImpl,
    };
    expect(await downloadGeminiOmniVideo(options)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const result = await downloadGeminiOmniVideo(options);

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/files/video-1",
      "https://generativelanguage.googleapis.com/v1beta/files/video-1",
      "https://generativelanguage.googleapis.com/v1beta/files/video-1:download?alt=media",
    ]);
    expect(new TextDecoder().decode(result!.bytes)).toBe("video-bytes");
  });

  });
