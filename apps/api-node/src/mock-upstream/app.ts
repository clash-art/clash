/**
 * Deterministic mock upstream (NODES §4.4 / #378).
 * Loopback / test-only: OpenAI + Anthropic JSON/SSE, control + stats APIs.
 */
import { Hono, type Context } from "hono";
import {
  anthropicMessageId,
  anthropicStreamFrames,
  assertFakeKey,
  buildAnthropicNonStream,
  buildOpenAINonStream,
  contentChunks,
  deriveUsage,
  extractApiKey,
  hangForever,
  keyIdFor,
  MODEL_CATALOG,
  openAIStreamFrames,
  openaiCompletionId,
  readMaxTokens,
  sleep,
} from "./protocol.ts";
import {
  createMockState,
  type MockControl,
  type MockState,
} from "./state.ts";

export const MOCK_PROCESSING_MS = "x-mock-processing-ms";
export const MOCK_KEY_ID = "x-mock-key-id";

export interface MockUpstreamApp {
  app: Hono;
  state: MockState;
}

export function createMockUpstreamApp(
  state: MockState = createMockState(),
): MockUpstreamApp {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", role: "mock-upstream" }));
  app.get("/v1/models", (c) => c.json(MODEL_CATALOG));

  app.post("/__control", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_body" }, 400);
    try {
      return c.json(state.setControl(body as Partial<MockControl>));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "invalid_control" },
        400,
      );
    }
  });

  app.get("/__control", (c) => c.json(state.getControl()));

  app.get("/__stats", (c) => c.json({ keys: state.snapshot() }));

  app.post("/__reset", (c) => {
    state.reset();
    return c.json({ ok: true });
  });

  app.post("/openai/v1/chat/completions", (c) =>
    handleCompletion(c, state, "openai"),
  );
  app.post("/anthropic/v1/messages", (c) =>
    handleCompletion(c, state, "anthropic"),
  );

  return { app, state };
}

type Protocol = "openai" | "anthropic";

async function handleCompletion(
  c: Context,
  state: MockState,
  protocol: Protocol,
): Promise<Response> {
  const started = performance.now();
  let keyId = "anonymous";
  try {
    const key = assertFakeKey(extractApiKey(c.req.raw.headers));
    keyId = keyIdFor(key);
  } catch {
    // Never echo the presented secret — only the coded error.
    return jsonError(401, protocol, "invalid_api_key", keyId, started, state, {
      stream: false,
      tokensEmitted: 0,
    });
  }

  const control = state.getControl();
  if (control.mode === "hang") {
    state.record(keyId, { stream: false, tokensEmitted: 0, status: 0 });
    await hangForever(c.req.raw.signal);
  }

  const raw = Buffer.from(await c.req.raw.arrayBuffer());
  let body: Record<string, unknown> = {};
  if (raw.byteLength) {
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      return jsonError(400, protocol, "invalid_json", keyId, started, state, {
        stream: false,
        tokensEmitted: 0,
      });
    }
  }

  const stream = body.stream === true;
  const usage = deriveUsage(raw.byteLength, readMaxTokens(body), control.usage);
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : protocol === "openai"
        ? "gpt-4o-mini"
        : "claude-3-5-haiku-latest";
  const parts = contentChunks(control.chunks, usage.output);
  const content = parts.join("");
  const includeUsage =
    protocol === "openai" &&
    !!body.stream_options &&
    typeof body.stream_options === "object" &&
    !Array.isArray(body.stream_options) &&
    (body.stream_options as { include_usage?: unknown }).include_usage === true;

  if (control.mode === "500") {
    return jsonError(500, protocol, "internal_error", keyId, started, state, {
      stream,
      tokensEmitted: 0,
    });
  }
  if (control.mode === "429") {
    return jsonError(429, protocol, "rate_limit_exceeded", keyId, started, state, {
      stream,
      tokensEmitted: 0,
    });
  }

  await sleep(control.ttfb_ms, c.req.raw.signal);

  if (control.mode === "timeout") {
    // Headers only, then hang — gateway should hit its upstream timeout.
    state.record(keyId, {
      stream,
      tokensEmitted: 0,
      status: 200,
    });
    const processing = Math.round(performance.now() - started);
    return new Response(
      new ReadableStream({
        start() {
          /* never enqueue; never close */
        },
        cancel() {},
      }),
      {
        status: 200,
        headers: {
          "content-type": stream
            ? "text/event-stream; charset=utf-8"
            : "application/json",
          "cache-control": "no-cache",
          [MOCK_PROCESSING_MS]: String(processing),
          [MOCK_KEY_ID]: keyId,
        },
      },
    );
  }

  const headers = mockHeaders(keyId, started);
  if (!stream) {
    const payload =
      protocol === "openai"
        ? buildOpenAINonStream({
            model,
            content,
            usage,
            id: openaiCompletionId(raw.byteLength),
          })
        : buildAnthropicNonStream({
            model,
            content,
            usage,
            id: anthropicMessageId(raw.byteLength),
          });
    state.record(keyId, {
      stream: false,
      tokensEmitted: usage.input + usage.output + usage.cached,
      status: 200,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    });
  }

  const frames =
    protocol === "openai"
      ? openAIStreamFrames({
          model,
          parts,
          usage,
          id: openaiCompletionId(raw.byteLength),
          includeUsage,
        })
      : anthropicStreamFrames({
          model,
          parts,
          usage,
          id: anthropicMessageId(raw.byteLength),
        });

  // Content frames sit after the role/start framing; fail_after_chunks counts
  // content pieces only (NODES chaos matrix mid-stream failure).
  const contentFrameOffset = protocol === "openai" ? 1 : 2;
  const encoder = new TextEncoder();
  const failAfter = control.fail_after_chunks;
  const chunkMs = control.chunk_ms;
  const signal = c.req.raw.signal;

  const bodyStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let contentSent = 0;
        for (let i = 0; i < frames.length; i++) {
          if (signal.aborted) throw signal.reason ?? new Error("aborted");
          const isContent =
            i >= contentFrameOffset &&
            i < contentFrameOffset + parts.length;
          if (isContent && contentSent > 0 && chunkMs > 0)
            await sleep(chunkMs, signal);
          if (
            isContent &&
            failAfter !== undefined &&
            contentSent >= failAfter
          ) {
            controller.error(new Error("mock_fail_after_chunks"));
            state.record(keyId, {
              stream: true,
              tokensEmitted: usage.input + contentSent,
              status: 500,
            });
            return;
          }
          controller.enqueue(encoder.encode(frames[i]!));
          if (isContent) contentSent += 1;
        }
        controller.close();
        state.record(keyId, {
          stream: true,
          tokensEmitted: usage.input + usage.output + usage.cached,
          status: 200,
        });
      } catch (error) {
        try {
          controller.error(error);
        } catch {
          /* already closed */
        }
      }
    },
  });

  // Record processing-ms at header time (TTFB path).
  return new Response(bodyStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers,
    },
  });
}

function mockHeaders(
  keyId: string,
  started: number,
): Record<string, string> {
  return {
    [MOCK_PROCESSING_MS]: String(Math.round(performance.now() - started)),
    [MOCK_KEY_ID]: keyId,
  };
}

function jsonError(
  status: 401 | 400 | 429 | 500,
  protocol: Protocol,
  code: string,
  keyId: string,
  started: number,
  state: MockState,
  info: { stream: boolean; tokensEmitted: number },
): Response {
  state.record(keyId, { ...info, status });
  const body =
    protocol === "openai"
      ? {
          error: {
            message: code,
            type: status === 401 ? "invalid_request_error" : "api_error",
            code,
          },
        }
      : {
          type: "error",
          error: {
            type: status === 401 ? "authentication_error" : "api_error",
            message: code,
          },
        };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...mockHeaders(keyId, started),
      ...(status === 429 ? { "retry-after": "1" } : {}),
    },
  });
}
