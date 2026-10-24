/**
 * Gateway data plane (#347) in workerd with the migrated D1 schema: the shared
 * gateway-core contract (including the non-stream chat cases) over the D1
 * ports, and /gateway/v1/chat/completions through the Worker app. Upstreams
 * are fetch stubs; any other outbound request fails the test.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeGatewayContract } from "@clash/gateway-core/contract";
import { gatewayRetentionKeys } from "@clash/gateway-core";

import { createApp } from "../app";
import type { Env } from "../config";
import { signedInAdmin } from "../services/admin-session.test-support";
import { d1ContractHarness, seedGateway, type SeededGateway } from "../gateway/test-support";

const ORIGIN = "https://clash.test";
// Seeded on first use: the setup file applies the migrations before any hook runs.
let seeding: Promise<SeededGateway> | undefined;
// The real workerd R2 binding backs `blobs`, so the contract runs retention end to end.
const seeded = () => (seeding ??= seedGateway(env.DB, { bucket: env.R2_BUCKET }));

describeGatewayContract("Workers/D1 gateway ports (miniflare)", async () => d1ContractHarness(await seeded()));

describe("/gateway/v1/chat/completions in workerd", () => {
  const app = createApp();
  let gateway: SeededGateway;
  let bindings: Env;
  let upstream: Request[];
  let answer: (body: Record<string, unknown>) => Response;

  beforeAll(async () => {
    gateway = await seeded();
    bindings = { ...env, GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as unknown as Env;
  });
  beforeEach(() => {
    upstream = [];
    answer = (body) =>
      Response.json({
        id: "chatcmpl-workerd",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions"))
        throw new Error(`Unexpected external request: ${request.url}`);
      upstream.push(request);
      return answer((await request.clone().json()) as Record<string, unknown>);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const send = (token: string | undefined, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      bindings,
    );
  const chat = (extra: Record<string, unknown> = {}) => ({
    model: gateway.textModel,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    ...extra,
  });
  const code = (res: Response) => res.headers.get("x-clash-error-code");

  it("routes to the official account and bills the token's user, not a spoofed x-user-id", async () => {
    const alice = await gateway.tenantToken();
    const bob = await gateway.tenantToken();
    const res = await send(alice.token, chat(), { "x-user-id": bob.userId });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${gateway.upstreamApiKey}`);
    expect(upstream[0]!.headers.get("x-user-id")).toBeNull();
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT user_id, tenant_id FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`,
    )
      .bind(res.headers.get("x-clash-request-id"))
      .all<{ user_id: string; tenant_id: string }>();
    expect(results).toEqual([{ user_id: alice.userId, tenant_id: alice.tenantId }]);
  });

  it("answers coded 401, 403, 402 and 502 without leaking upstream text", async () => {
    const caller = await gateway.tenantToken();
    const restricted = await gateway.tenantToken({ modelAllowlist: ["some-other-model"] });
    const unbudgeted = await gateway.tenantToken({ budgets: false });
    const anonymous = await send(undefined, chat(), { "x-user-id": caller.userId });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
    const denied = await send(restricted.token, chat());
    expect([denied.status, code(denied)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
    // A stream refused at admission is a plain coded JSON answer: nothing was streamed.
    const refused = await send(unbudgeted.token, chat({ stream: true }));
    expect([refused.status, code(refused), refused.headers.get("content-type")]).toEqual([
      402,
      "GATEWAY_BUDGET_EXCEEDED",
      "application/json",
    ]);
    expect(((await refused.json()) as { error: Record<string, unknown> }).error).toMatchObject({ budget_id: null, reset_at: null });
    expect(upstream).toHaveLength(0);

    answer = () => Response.json({ error: { message: `key ${gateway.upstreamApiKey}` } }, { status: 503 });
    const failed = await send(caller.token, chat());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(gateway.upstreamApiKey);
  });

  describe("streaming (#348)", () => {
    const encoder = new TextEncoder();
    const events = (model: unknown) =>
      [
        { object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] },
        { object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
        { object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
        "[DONE]",
      ].map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
    /** The events in 5-byte chunks; with `gate`, everything after the first event waits for it. */
    const sse = (parts: string[], gate?: Promise<unknown>) =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const [index, part] of parts.entries()) {
              if (index === 1 && gate) await gate;
              const bytes = encoder.encode(part);
              for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const settleRows = async (requestId: string) =>
      (
        await env.DB.prepare(
          `SELECT status, input_tokens, output_tokens, usage_source FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`,
        )
          .bind(requestId)
          .all<{ status: string; input_tokens: number; output_tokens: number; usage_source: string }>()
      ).results;

    it("relays the stream byte for byte through the Worker, settles reported usage and retains it in R2", async () => {
      const retaining = { ...bindings, GATEWAY_STAFF_PROMPT_ACCESS: "enabled" } as Env;
      const caller = await gateway.tenantToken();
      // The upstream names its own model; the caller must only ever see the public code.
      const vendorModel = "vendor-internal-model-name";
      answer = () => sse(events(vendorModel));
      const res = await app.request(
        "/gateway/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
          body: JSON.stringify(chat({ stream: true, stream_options: { include_usage: true } })),
        },
        retaining,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const delivered = await res.text();
      expect(delivered).toBe(events(gateway.textModel).join(""));
      expect(delivered).not.toContain(vendorModel);
      expect(upstream).toHaveLength(1);
      expect(((await upstream[0]!.json()) as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
      const requestId = res.headers.get("x-clash-request-id")!;
      const rows = await settleRows(requestId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toEqual({ status: "settled", input_tokens: 4, output_tokens: 2, usage_source: "reported" });
      const object = await env.R2_BUCKET.get(gatewayRetentionKeys(requestId).response);
      expect(await object?.text()).toBe(delivered);
    });

    it("aborts the upstream when the caller disconnects and settles client_aborted", async () => {
      const caller = await gateway.tenantToken();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let upstreamSignal: AbortSignal | undefined;
      answer = (body) => sse(events(body.model), gate);
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = new Request(input as RequestInfo, init);
        upstream.push(request);
        upstreamSignal = init?.signal ?? request.signal;
        return answer((await request.clone().json()) as Record<string, unknown>);
      });
      const res = await send(caller.token, chat({ stream: true }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      const requestId = res.headers.get("x-clash-request-id")!;
      let rows = await settleRows(requestId);
      for (let wait = 0; wait < 200 && (rows.length === 0 || !upstreamSignal?.aborted); wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        rows = await settleRows(requestId);
      }
      open();
      expect(upstreamSignal?.aborted).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject({ status: "client_aborted", usage_source: "estimated" });
    });

    it("streams Anthropic Messages through /gateway/anthropic/v1 with the public model and settles message_delta usage (#349)", async () => {
      const caller = await gateway.tenantToken();
      const vendorModel = "vendor-internal-model-name";
      const anthropicEvents = (model: string) =>
        [
          ["message_start", { message: { id: "msg_workerd", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 4, output_tokens: 1 } } }],
          ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
          ["message_stop", {}],
        ].map(([type, data]) => `event: ${type as string}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = new Request(input as RequestInfo, init);
        if (!request.url.endsWith("/messages")) throw new Error(`Unexpected external request: ${request.url}`);
        upstream.push(request);
        return sse(anthropicEvents(vendorModel));
      });
      const res = await app.request(
        "/gateway/anthropic/v1/messages?beta=true",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            authorization: `Bearer ${caller.token}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
          },
          body: JSON.stringify({
            model: gateway.messagesModel,
            max_tokens: 16,
            stream: true,
            messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
          }),
        },
        bindings,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const delivered = await res.text();
      expect(delivered).toBe(anthropicEvents(gateway.messagesModel).join(""));
      expect(upstream).toHaveLength(1);
      expect(upstream[0]!.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
      expect(upstream[0]!.headers.get("authorization")).toBeNull();
      const rows = await settleRows(res.headers.get("x-clash-request-id")!);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toEqual({ status: "settled", input_tokens: 4, output_tokens: 2, usage_source: "reported" });
    });
  });

  it("retains bodies in R2 with the hosted flag, and an admin account views the stored bytes, audited", async () => {
    const retaining = { ...bindings, GATEWAY_STAFF_PROMPT_ACCESS: "enabled" } as Env;
    const caller = await gateway.tenantToken();
    const prompt = `workerd prompt ${crypto.randomUUID()}`;
    const res = await app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
        body: JSON.stringify(chat({ messages: [{ role: "user", content: prompt }] })),
      },
      retaining,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("x-gateway-retention")).toBeNull();
    const answered = await res.text();
    const requestId = res.headers.get("x-clash-request-id")!;
    const object = await env.R2_BUCKET.get(gatewayRetentionKeys(requestId).response);
    expect(await object?.text()).toBe(answered);

    // An admin account's session (#394), resolved by the /api/* middleware as in production.
    const adminEnv = { ...retaining, BETTER_AUTH_URL: ORIGIN } as Env;
    const staff = await signedInAdmin(app, adminEnv as never, ORIGIN);
    const staffId = staff.id;
    const viewed = await app.request(
      `/api/v1/admin/gateway/prompts/${requestId}/access`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...staff.auth },
        body: JSON.stringify({ reason: "workerd incident" }),
      },
      adminEnv,
    );
    expect(viewed.status, await viewed.clone().text()).toBe(200);
    const view = (await viewed.json()) as { prompt: { request: { body: string }; response: { body: string } } };
    expect(view.prompt.response.body).toBe(answered);
    expect(view.prompt.request.body).toContain(prompt);
    const audit = await env.DB.prepare(
      `SELECT actor_kind, actor_id, reason, after_json FROM gateway_admin_audit WHERE action = 'prompt.view' AND target_id = ?`,
    )
      .bind(requestId)
      .all<{ actor_kind: string; actor_id: string; reason: string; after_json: string }>();
    expect(audit.results).toEqual([expect.objectContaining({ actor_kind: "admin", actor_id: staffId, reason: "workerd incident" })]);
    expect(audit.results[0]!.after_json).not.toContain(prompt);
  });
});
