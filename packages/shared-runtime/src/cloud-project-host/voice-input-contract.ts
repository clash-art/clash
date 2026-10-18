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
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
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
      expect(events.map((event) => event.status)).toEqual([
        "submitted",
        "completed",
      ]);
      expect(events[1]).toMatchObject({
        id: expect.stringMatching(/^voice-input:.+:completed$/),
        userId: "user-1",
        providerId: "official",
        modelId: "gemini-3-flash",
        operation: "gemini-3-flash-preview",
        status: "completed",
        idempotencyKey: expect.stringMatching(/^voice-input:/),
      });
    });

    const transcriptForm = () => {
      const form = new FormData();
      form.append(
        "file",
        new File(["voice-bytes"], "voice.webm", { type: "audio/webm" }),
      );
      return form;
    };
    const okProvider = (calls: { count: number }) => async () => {
      calls.count += 1;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "kept transcript" }] } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    it("fails before calling the Provider when usage cannot be recorded", async () => {
      const calls = { count: 0 };
      const ports = hostedPorts({
        entries: [voiceInputContractEntry()],
        fetch: okProvider(calls),
        events: [],
      });
      const app = harness.mount(
        createHostedVoiceInputPorts("user-1", {
          ...ports,
          usage: {
            append: async () => {
              throw new Error("audit store unavailable");
            },
          },
        }),
      );

      const response = await call(app, "/audio/transcriptions", {
        method: "POST",
        body: transcriptForm(),
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        code: "VOICE_INPUT_USAGE_AUDIT_FAILED",
        error:
          "Voice input did not run: its Provider usage could not be recorded: audit store unavailable",
      });
      expect(calls.count).toBe(0);
    });

    it("fails explicitly when the completed usage cannot be recorded", async () => {
      const calls = { count: 0 };
      const events: ProviderUsageAuditEvent[] = [];
      const ports = hostedPorts({
        entries: [voiceInputContractEntry()],
        fetch: okProvider(calls),
        events,
      });
      const app = harness.mount(
        createHostedVoiceInputPorts("user-1", {
          ...ports,
          usage: {
            append: async (event) => {
              if (event.status === "completed") throw new Error("disk full");
              events.push(event);
            },
          },
        }),
      );

      const response = await call(app, "/audio/transcriptions", {
        method: "POST",
        body: transcriptForm(),
      });

      expect(response.status).toBe(502);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe("VOICE_INPUT_USAGE_AUDIT_FAILED");
      expect(body.error).toContain("disk full");
      expect(calls.count).toBe(1);
      expect(events.map((event) => event.status)).toEqual(["submitted"]);
    });

    it("surfaces the Provider's own failure and records it", async () => {
      const events: ProviderUsageAuditEvent[] = [];
      const app = harness.mount(
        createHostedVoiceInputPorts(
          "user-1",
          hostedPorts({
            entries: [voiceInputContractEntry()],
            fetch: async () =>
              new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
                status: 429,
                headers: { "content-type": "application/json" },
              }),
            events,
          }),
        ),
      );

      const response = await call(app, "/audio/transcriptions", {
        method: "POST",
        body: transcriptForm(),
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        code: "VOICE_INPUT_PROVIDER_FAILED",
        error: "Gemini text request failed: quota exceeded",
      });
      expect(events.map((event) => event.status)).toEqual(["submitted", "failed"]);
      expect(events[1]?.errorMessage).toBe("Gemini text request failed: quota exceeded");
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
        code: "VOICE_INPUT_AUDIO_TOO_LARGE",
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

    it("fails an unconfigured warmup with a coded, user-visible error", async () => {
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

      const response = await call(app, "/audio/voice-input/warmup", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        status: "needs-config",
        runtime: "provider-route",
        error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
        code: "VOICE_INPUT_NOT_CONFIGURED",
      });
      expect(events).toEqual([]);
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
