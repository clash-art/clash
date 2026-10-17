import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
}));

vi.mock("../../services/provider-accounts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/provider-accounts")>();
  return {
    ...actual,
    getProviderCredentials: mocks.getProviderCredentials,
  };
});

import type { ModelUpstreamRoute } from "@clash/shared-types";
import type { Env } from "../../config";
import { transcribeWithTextGeneration } from "../../generation/adapters/text-gen";
import {
  VOICE_INPUT_MAX_AUDIO_BYTES,
  type VoiceInputModelEntry,
} from "@clash/shared-runtime/cloud-project-host/voice-input";
import { createVoiceInputRoutes } from "./voice-input";

const route: ModelUpstreamRoute = {
  modelCode: "gemini-3-flash",
  kind: "text",
  providerId: "official",
  upstreamId: "google-ai-studio",
  upstreamModel: "gemini-3-flash-preview",
  apiShape: "google-ai-studio",
  priority: 10,
  requiredCredentials: ["apiKey"],
};

const entry: VoiceInputModelEntry = {
  model: {
    id: "gemini-3-flash",
    kind: "text",
    input: {
      promptModalities: ["text", "image", "video", "audio"],
      inputMode: { audios: { max: 1 } },
    },
  },
  selectedRoute: route,
  missingCredentials: [],
  tier: "available",
  routes: [route],
};

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    "/api/v1",
    createVoiceInputRoutes({
      createPorts: () => ({
        resolveVoiceInputSelection: async () => ({
          enabled: true,
          model: "gemini-3-flash",
        }),
        resolveModelEntry: async () => entry,
        transcribeWithModel: async ({ modelId, audio, prompt, language }) => {
          if (modelId !== entry.model.id) throw new Error("unexpected model");
          return transcribeWithTextGeneration({
            env: {} as Env,
            userId: "user-1",
            route,
            audio,
            prompt,
            ...(language ? { language } : {}),
          });
        },
      }),
    }),
  );
  return app;
}

function env(): Env {
  return {} as Env;
}

describe("Cloudflare adapter voice input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.getProviderCredentials.mockReset();
  });

  it("returns a timed transcript and sends audio as a Gemini inlineData part", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "gemini-key",
      baseUrl: "https://gemini.example/v1beta",
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "  cloud transcript  " }] } },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = makeApp();
    const form = new FormData();
    form.append(
      "file",
      new File(["voice-bytes"], "voice.webm", { type: "audio/webm;codecs=opus" }),
    );
    form.append("language", "English");

    const response = await app.request(
      "/api/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { "x-user-id": "user-1" },
        body: form,
      },
      env(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      kind: "clash.asr.timed-transcript",
      timebase: "milliseconds",
      alignment: "word",
      text: "cloud transcript",
      backendId: "official",
      modelId: "gemini-3-flash",
      language: "English",
      durationMs: 1,
      words: [
        { id: "word-000001", text: "cloud transcript", startMs: 0, endMs: 1 },
      ],
      segments: [
        {
          id: "segment-000001",
          text: "cloud transcript",
          startMs: 0,
          endMs: 1,
          wordIds: ["word-000001"],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      "/models/gemini-3-flash-preview:generateContent",
    );
    const body = JSON.parse(String(init?.body)) as {
      contents: Array<{
        parts: Array<{
          text?: string;
          inlineData?: { mimeType?: string; data?: string };
        }>;
      }>;
    };
    expect(body.contents[0]?.parts[0]?.text).toContain(
      "Transcribe the attached audio verbatim in English.",
    );
    expect(body.contents[0]?.parts[1]?.inlineData).toEqual({
      mimeType: "audio/webm",
      data: Buffer.from("voice-bytes").toString("base64"),
    });
  });

  it("rejects an upload above 20 MB before reading it", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append(
      "file",
      new File(
        [new Uint8Array(VOICE_INPUT_MAX_AUDIO_BYTES + 1)],
        "large.webm",
        { type: "audio/webm" },
      ),
    );

    const response = await app.request(
      "/api/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { "x-user-id": "user-1" },
        body: form,
      },
      env(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Audio upload exceeds the 20 MB limit.",
    });
  });

  it("rejects a declared body above the limit without parsing the form", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("file", new File([new Uint8Array(8)], "small.webm", { type: "audio/webm" }));
    const request = new Request("http://local/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { "x-user-id": "user-1" },
      body: form,
    });
    const headers = new Headers(request.headers);
    headers.set("content-length", String(VOICE_INPUT_MAX_AUDIO_BYTES * 2));
    const formData = vi.spyOn(Request.prototype, "formData");

    const response = await app.request(
      "/api/v1/audio/transcriptions",
      { method: "POST", headers, body: await request.arrayBuffer() },
      env(),
    );

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
    formData.mockRestore();
  });

  it("requires the v1 identity header", async () => {
    const app = makeApp();
    const response = await app.request("/api/v1/audio/voice-input", {}, env());

    expect(response.status).toBe(401);
  });
});
