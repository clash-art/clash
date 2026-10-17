/**
 * Shared voice-input contract: one Vitest suite both hosted adapters mount
 * through their own route modules. Readiness, the Provider transcription and
 * the size limit must answer the same way on Cloudflare and Node.
 *
 * Test-only entry; it imports Vitest and is not exported from the package root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ModelUpstreamRoute,
  ProviderUsageAuditEvent,
} from "@clash/shared-types";
import {
  VOICE_INPUT_MAX_AUDIO_BYTES,
  createHostedVoiceInputPorts,
  type VoiceInputHostedPorts,
  type VoiceInputModelEntry,
  type VoiceInputPorts,
} from "./voice-input.js";

export interface VoiceInputContractApp {
  fetch(request: Request): Promise<Response>;
}
export interface VoiceInputContractHarness {
  /** Mount the adapter's voice routes with the supplied user-scoped ports. */
  mount(ports: VoiceInputPorts): VoiceInputContractApp;
  close?: () => Promise<void>;
}

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

export function voiceInputContractEntry(
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
    selectedRoute: route,
    missingCredentials: [],
    tier: "available",
    routes: [route],
    ...overrides,
  };
}

function hostedPorts(input: {
  entries: readonly VoiceInputModelEntry[];
  fetch: typeof fetch;
  events: ProviderUsageAuditEvent[];
}): VoiceInputHostedPorts {
  return {
    catalog: { list: async () => input.entries },
    credentials: {
      resolve: async () => ({ apiKey: "voice-contract-key" }),
    },
    usage: {
      append: async (event) => {
        input.events.push(event);
      },
    },
    fetch: input.fetch,
  };
}

export function describeVoiceInputContract(
  name: string,
  setup: () => VoiceInputContractHarness | Promise<VoiceInputContractHarness>,
): void {
  describe(`Voice input contract: ${name}`, () => {
    let harness: VoiceInputContractHarness;

    beforeAll(async () => {
      harness = await setup();
    });

    afterAll(async () => {
      await harness.close?.();
    });

    const call = (
      app: VoiceInputContractApp,
      path: string,
      init: RequestInit = {},
    ) => {
      const headers = new Headers(init.headers);
      if (!headers.has("x-user-id")) headers.set("x-user-id", "user-1");
      return app.fetch(
        new Request(`http://voice.contract.test/api/v1${path}`, {
          ...init,
          headers,
        }),
      );
    };

    it("reports disabled when the catalog has no Provider-route audio model", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({ entries: [], fetch, events }),
        ),
      );

      const response = await call(app, "/audio/voice-input");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        asr: {
          enabled: false,
          ready: false,
          setup: { runtime: "provider-route", status: "disabled" },
        },
      });
    });

    it("reports not-configured for an audio model with no ready Provider route", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [
              voiceInputContractEntry({
                selectedRoute: null,
                missingCredentials: ["apiKey"],
                tier: "all",
              }),
            ],
            fetch,
            events,
          }),
        ),
      );

      const response = await call(app, "/audio/voice-input");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        asr: {
          enabled: true,
          model: "gemini-3-flash",
          ready: false,
          setup: { runtime: "provider-route", status: "needs-config" },
        },
      });
    });

    it("reports a ready Provider-route selection", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch,
            events,
          }),
        ),
      );

      const response = await call(app, "/audio/voice-input");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
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
          },
        },
      });
    });

    it("transcribes through the fake Provider fetch and appends one audit event", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const fetchMock = async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ) =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "  contract transcript  " }] } },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch: fetchMock,
            events,
          }),
        ),
      );
      const form = new FormData();
      form.append(
        "file",
        new File(["voice-bytes"], "voice.webm", {
          type: "audio/webm;codecs=opus",
        }),
      );
      form.append("language", "English");

      const response = await call(app, "/audio/transcriptions", {
        method: "POST",
        body: form,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        schemaVersion: 1,
        kind: "clash.asr.timed-transcript",
        timebase: "milliseconds",
        alignment: "word",
        text: "contract transcript",
        backendId: "official",
        modelId: "gemini-3-flash",
        language: "English",
        durationMs: 1,
        words: [
          {
            id: "word-000001",
            text: "contract transcript",
            startMs: 0,
            endMs: 1,
          },
        ],
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: expect.stringMatching(/^voice-input:/),
        userId: "user-1",
        providerId: "official",
        modelId: "gemini-3-flash",
        operation: "gemini-3-flash-preview",
        status: "completed",
        idempotencyKey: expect.stringMatching(/^voice-input:/),
      });
    });

    it("rejects an upload above the shared 20 MB limit with 413", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch,
            events,
          }),
        ),
      );
      const response = await call(app, "/audio/transcriptions", {
        method: "POST",
        headers: {
          "content-length": String(VOICE_INPUT_MAX_AUDIO_BYTES * 2),
        },
        body: new Uint8Array(8),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Audio upload exceeds the 20 MB limit.",
      });
    });

    it("answers hosted warmup without a local runtime", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch,
            events,
          }),
        ),
      );

      const response = await call(app, "/audio/voice-input/warmup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "not-needed",
        runtime: "provider-route",
      });
    });

    it("requires an authenticated user", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch,
            events,
          }),
        ),
      );

      const response = await app.fetch(
        new Request("http://voice.contract.test/api/v1/audio/voice-input"),
      );

      expect(response.status).toBe(401);
    });
  });
}
