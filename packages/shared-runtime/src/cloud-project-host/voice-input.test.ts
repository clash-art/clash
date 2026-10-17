import { describe, expect, it, vi } from "vitest";
import {
  VOICE_INPUT_EMPTY_TRANSCRIPT_MESSAGE,
  isVoiceInputProviderReady,
  resolveVoiceInputReadiness,
  transcribeVoiceInputWithProvider,
  voiceInputTranscriptPrompt,
  type VoiceInputModelEntry,
  type VoiceInputPorts,
  type VoiceInputSelection,
} from "./voice-input";

function entry(
  overrides: Partial<VoiceInputModelEntry> = {},
): VoiceInputModelEntry {
  return {
    model: {
      id: "gemini-3-flash",
      kind: "text",
      input: {
        promptModalities: ["text", "image", "video", "audio"],
        inputMode: { audios: { max: 1 } },
      },
    },
    selectedRoute: {
      upstreamId: "google-ai-studio",
      apiShape: "google-ai-studio",
    },
    missingCredentials: [],
    tier: "available",
    ...overrides,
  };
}

function ports(input: {
  selection?: VoiceInputSelection;
  entry?: VoiceInputModelEntry | null;
  result?: { text: string; provider?: string; model?: string };
}): VoiceInputPorts {
  return {
    resolveVoiceInputSelection: vi.fn(
      async () => input.selection ?? { enabled: true, model: "gemini-3-flash" },
    ),
    resolveModelEntry: vi.fn(async () => input.entry ?? entry()),
    transcribeWithModel: vi.fn(
      async () => input.result ?? { text: "hello world" },
    ),
  };
}

describe("shared voice input", () => {
  it("reports a ready Provider-route selection", () => {
    const selection = { enabled: true, model: "gemini-3-flash" };
    const readiness = resolveVoiceInputReadiness(selection, entry());

    expect(readiness.status).toBe("ready");
    expect(readiness.response).toMatchObject({
      asr: {
        enabled: true,
        provider: "google-ai-studio",
        model: "gemini-3-flash",
        ready: true,
        setup: {
          provider: "google-ai-studio",
          runtime: "provider-route",
          status: "ready",
          available: true,
          default_base_url: null,
          commands: [],
        },
      },
    });
    expect(isVoiceInputProviderReady(entry())).toBe(true);
  });

  it("reports not-configured when the selected model has no ready route", () => {
    const selection = { enabled: true, model: "gemini-3-flash" };
    const readiness = resolveVoiceInputReadiness(
      selection,
      entry({
        selectedRoute: null,
        missingCredentials: ["apiKey"],
        tier: "all",
      }),
    );

    expect(readiness.status).toBe("not-configured");
    expect(readiness.response).toMatchObject({
      asr: {
        enabled: true,
        model: "gemini-3-flash",
        ready: false,
        setup: {
          runtime: "provider-route",
          status: "needs-config",
          available: false,
        },
      },
    });
  });

  it("reports disabled when voice input is off", () => {
    const readiness = resolveVoiceInputReadiness(
      { enabled: false, model: "gemini-3-flash" },
      entry(),
    );

    expect(readiness.status).toBe("disabled");
    expect(readiness.response.asr).toMatchObject({
      enabled: false,
      ready: false,
      setup: { status: "disabled", available: false },
    });
  });

  it("fails a transcription whose Provider result is empty", async () => {
    const voicePorts = ports({ result: { text: "   " } });

    await expect(
      transcribeVoiceInputWithProvider({
        userId: "user-1",
        ports: voicePorts,
        audio: { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/webm" },
      }),
    ).rejects.toMatchObject({
      name: "VoiceInputError",
      status: 502,
      message: VOICE_INPUT_EMPTY_TRANSCRIPT_MESSAGE,
    });
  });

  it("includes the requested language in the prompt and transcript", async () => {
    const voicePorts = ports({
      result: { text: " bonjour ", provider: "google" },
    });

    const transcript = await transcribeVoiceInputWithProvider({
      userId: "user-1",
      ports: voicePorts,
      audio: { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/webm" },
      language: "French",
    });

    expect(voiceInputTranscriptPrompt("French")).toBe(
      "Transcribe the attached audio verbatim in French. Return only the transcript.",
    );
    expect(voicePorts.transcribeWithModel).toHaveBeenCalledWith({
      modelId: "gemini-3-flash",
      audio: { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/webm" },
      prompt:
        "Transcribe the attached audio verbatim in French. Return only the transcript.",
      language: "French",
    });
    expect(transcript).toMatchObject({
      schemaVersion: 1,
      kind: "clash.asr.timed-transcript",
      timebase: "milliseconds",
      alignment: "word",
      text: "bonjour",
      backendId: "google",
      modelId: "gemini-3-flash",
      language: "French",
      durationMs: 1,
      words: [{ id: "word-000001", text: "bonjour", startMs: 0, endMs: 1 }],
      segments: [
        {
          id: "segment-000001",
          text: "bonjour",
          startMs: 0,
          endMs: 1,
          wordIds: ["word-000001"],
        },
      ],
    });
  });
});
