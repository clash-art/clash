import { createHash } from "node:crypto";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockUpstreamApp,
  MOCK_KEY_ID,
  MOCK_PROCESSING_MS,
} from "./app.ts";
import { deriveUsage, keyIdFor, MODEL_CATALOG } from "./protocol.ts";
import { createMockState } from "./state.ts";

const KEY_A = "sk_test_alpha_aaaaaaaa";
const KEY_B = "sk_test_beta_bbbbbbbb";

function expectedKeyId(key: string) {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

async function listen(fetchHandler: Parameters<typeof serve>[0]["fetch"]) {
  const server = serve({ fetch: fetchHandler, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("deriveUsage (deterministic)", () => {
  it("uses ceil(bodyBytes/3) for input and max_tokens for output", () => {
    expect(deriveUsage(9, 4)).toEqual({ input: 3, output: 4, cached: 0 });
    expect(deriveUsage(10, undefined).input).toBe(Math.ceil(10 / 3));
    expect(deriveUsage(0, 0)).toEqual({ input: 0, output: 0, cached: 0 });
    expect(deriveUsage(100, 7, { input: 1, output: 2, cached: 3 })).toEqual({
      input: 1,
      output: 2,
      cached: 3,
    });
  });

  it("keyIdFor is sha256 hex prefix 12 and never the raw key", () => {
    expect(keyIdFor(KEY_A)).toBe(expectedKeyId(KEY_A));
    expect(keyIdFor(KEY_A)).not.toContain("sk_test");
    expect(keyIdFor(KEY_A)).toHaveLength(12);
  });
});

describe("mock upstream HTTP", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function boot() {
    const { app, state } = createMockUpstreamApp(createMockState());
    const listening = await listen(app.fetch);
    closers.push(() => listening.close());
    return { ...listening, state, app };
  }

  it("serves a deterministic model catalog", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MODEL_CATALOG);
  });

  it("rejects non sk_test_* keys with 401 and never echoes the secret", async () => {
    const { base } = await boot();
    const secret = "sk-live-should-never-appear";
    const res = await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk-live");
    expect(res.headers.get(MOCK_KEY_ID)).toBe("anonymous");
  });

  it("OpenAI non-stream: usage from body length + max_tokens, mock headers", async () => {
    const { base } = await boot();
    const body = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello mock" }],
      max_tokens: 5,
    };
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(MOCK_KEY_ID)).toBe(expectedKeyId(KEY_A));
    expect(Number(res.headers.get(MOCK_PROCESSING_MS))).toBeGreaterThanOrEqual(0);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    const expected = deriveUsage(Buffer.byteLength(raw), 5);
    expect(json.usage.prompt_tokens).toBe(expected.input);
    expect(json.usage.completion_tokens).toBe(5);
    expect(json.usage.total_tokens).toBe(expected.input + 5);
    expect(json.choices[0]?.message.content.length).toBeGreaterThan(0);
  });

  it("OpenAI SSE with include_usage ends in [DONE] and a usage chunk", async () => {
    const { base } = await boot();
    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ok", chunks: 2, chunk_ms: 0 }),
    });
    const body = {
      model: "gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "sse" }],
      max_tokens: 4,
    };
    const res = await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as {
        usage?: { completion_tokens: number };
        choices?: unknown[];
      });
    const usageChunk = dataLines.find(
      (chunk) => chunk.usage && Array.isArray(chunk.choices) && chunk.choices.length === 0,
    );
    expect(usageChunk?.usage?.completion_tokens).toBe(4);
  });

  it("Anthropic non-stream and SSE carry input on message_start and output on message_delta", async () => {
    const { base } = await boot();
    const body = {
      model: "claude-3-5-haiku-latest",
      max_tokens: 6,
      messages: [{ role: "user", content: "hi" }],
    };
    const raw = JSON.stringify(body);
    const non = await fetch(`${base}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": KEY_B,
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(non.status).toBe(200);
    expect(non.headers.get(MOCK_KEY_ID)).toBe(expectedKeyId(KEY_B));
    const nonJson = (await non.json()) as {
      usage: { input_tokens: number; output_tokens: number };
    };
    const expected = deriveUsage(Buffer.byteLength(raw), 6);
    expect(nonJson.usage).toMatchObject({
      input_tokens: expected.input,
      output_tokens: 6,
    });

    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ok", chunks: 2 }),
    });
    const streamed = await fetch(`${base}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_B}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
    const start = [...text.matchAll(/event: message_start\ndata: (\{.*?\})\n\n/gs)];
    expect(start.length).toBe(1);
    const startPayload = JSON.parse(start[0]![1]!) as {
      message: { usage: { input_tokens: number } };
    };
    expect(startPayload.message.usage.input_tokens).toBe(
      deriveUsage(Buffer.byteLength(JSON.stringify({ ...body, stream: true })), 6)
        .input,
    );
    expect(text).toMatch(/"output_tokens":\s*6/);
  });

  it("control modes 500/429 and usage override; stats + reset per key hash", async () => {
    const { base, state } = await boot();
    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "ok",
        usage: { input: 11, output: 22, cached: 3 },
      }),
    });
    const ok = await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "x" }],
      }),
    });
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    // OpenAI prompt_tokens includes cached.
    expect(okJson.usage.prompt_tokens).toBe(14);
    expect(okJson.usage.completion_tokens).toBe(22);

    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "500" }),
    });
    expect(
      (
        await fetch(`${base}/openai/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${KEY_A}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "m", messages: [] }),
        })
      ).status,
    ).toBe(500);

    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "429" }),
    });
    const limited = await fetch(`${base}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": KEY_B,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }),
    });
    expect(limited.status).toBe(429);

    const stats = (await (await fetch(`${base}/__stats`)).json()) as {
      keys: Record<
        string,
        {
          requests: number;
          streams: number;
          tokensEmitted: number;
          lastStatus: number;
        }
      >;
    };
    expect(stats.keys[expectedKeyId(KEY_A)]?.requests).toBeGreaterThanOrEqual(2);
    expect(stats.keys[expectedKeyId(KEY_A)]?.lastStatus).toBe(500);
    expect(stats.keys[expectedKeyId(KEY_B)]?.lastStatus).toBe(429);
    // Stats keys are hashes, never raw secrets.
    expect(JSON.stringify(stats)).not.toContain(KEY_A);
    expect(JSON.stringify(stats)).not.toContain("sk_test");

    await fetch(`${base}/__reset`, { method: "POST" });
    expect(state.snapshot()).toEqual({});
    expect(((await (await fetch(`${base}/__stats`)).json()) as { keys: object }).keys).toEqual(
      {},
    );
  });

  it("ttfb_ms delays headers; timeout mode returns headers then hangs the body", async () => {
    const { base } = await boot();
    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ok", ttfb_ms: 50, chunks: 1 }),
    });
    const t0 = performance.now();
    const delayed = await fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "d" }],
        max_tokens: 1,
      }),
    });
    expect(delayed.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(40);
    await delayed.arrayBuffer();

    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "timeout", ttfb_ms: 0 }),
    });
    const ac = new AbortController();
    const timed = fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: "hang-body" }],
      }),
      signal: ac.signal,
    });
    const res = await timed;
    expect(res.status).toBe(200);
    expect(res.headers.get(MOCK_KEY_ID)).toBe(expectedKeyId(KEY_A));
    const reader = res.body!.getReader();
    const wait = reader.read();
    const raced = await Promise.race([
      wait.then(() => "chunk" as const),
      new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 80)),
    ]);
    expect(raced).toBe("idle");
    ac.abort();
    await wait.catch(() => undefined);
  });

  it("hang mode does not produce a response before abort", async () => {
    const { base } = await boot();
    await fetch(`${base}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "hang" }),
    });
    const ac = new AbortController();
    const pending = fetch(`${base}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
      signal: ac.signal,
    });
    const raced = await Promise.race([
      pending.then(() => "responded" as const),
      new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 80)),
    ]);
    expect(raced).toBe("idle");
    ac.abort();
    await pending.catch(() => undefined);
  });
});
