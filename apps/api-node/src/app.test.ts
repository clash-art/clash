import { createHash } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { VOICE_INPUT_NOT_CONFIGURED_MESSAGE } from "@clash/shared-runtime/cloud-project-host/voice-input";
import { describeVoiceInputContract } from "@clash/shared-runtime/cloud-project-host/voice-input-contract";
import { encryptProviderCredentials } from "@clash/shared-runtime/provider-credentials";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import { appendNodeProviderUsageEvent } from "./provider-settings.ts";
import { createNodeVoiceInputRoutes } from "./voice-input.ts";

it("admits through real HTTP using database tokens and rejects forged identity/revocation", async () => {
  const db = new PGlite();
  let server: ReturnType<typeof serve> | undefined;
  try {
    await migrateDatabase(db);
    await migrateDatabase(db);
    const token = "clsh_" + "a".repeat(40);
    await db.query(
      "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
      [
        "token",
        "owner",
        "test",
        createHash("sha256").update(token).digest("hex"),
        "clsh_aaaa",
      ],
    );
    const app = createNodeCloudApp({
      db,
      syncBaseUrl: "https://node.example.com",
    });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    const url = `http://127.0.0.1:${address.port}/api/v1/projects/project/cloud-admission`;
    const request = {
      schemaVersion: 1,
      projectId: "project",
      localReplicaId: "replica",
      resourceIds: [],
      metadata: {
        projectId: "project",
        name: "Project",
        description: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        deletedAt: null,
      },
    };
    const post = (headers: Record<string, string>, body: unknown = request) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ "x-user-id": "owner", "x-internal-agent": "true" })).status,
    ).toBe(401);
    const admitted = await post({ authorization: `Bearer ${token}` });
    expect(admitted.status).toBe(201);
    expect(await admitted.json()).toMatchObject({
      admission: { userId: "owner", projectId: "project", status: "pending" },
      syncBaseUrl: "https://node.example.com",
    });
    expect(
      (
        await post(
          { authorization: `Bearer ${token}` },
          { ...request, projectId: "other" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url + "?localReplicaId=replica", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    await db.query("UPDATE api_token SET user_id='other'");
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(404);
    await db.query("DELETE FROM api_token");
    expect(
      (
        await fetch(url + "?localReplicaId=replica", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
    await db.close();
  }
});

it("serves provider-route voice input with shared readiness instead of 501", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const token = "clsh_" + "b".repeat(40);
    await db.query(
      "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
      [
        "voice-token",
        "owner",
        "voice",
        createHash("sha256").update(token).digest("hex"),
        "clsh_bbbb",
      ],
    );
    const app = createNodeCloudApp({
      db,
      syncBaseUrl: "https://node.example.com",
    });
    const headers = { authorization: `Bearer ${token}` };

    const health = await app.request("/health");
    expect(await health.json()).toMatchObject({
      runtime: {
        mode: "hosted",
        capabilities: {
          host: { voiceInput: "available", localAudio: "unavailable" },
        },
      },
    });

    const readiness = await app.request("/api/v1/audio/voice-input", {
      headers,
    });
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toMatchObject({
      asr: {
        enabled: true,
        ready: false,
        setup: { runtime: "provider-route", status: "needs-config" },
      },
    });

    const warmup = await app.request("/api/v1/audio/voice-input/warmup", {
      method: "POST",
      headers,
    });
    expect(warmup.status).toBe(409);
    expect(await warmup.json()).toEqual({
      status: "needs-config",
      runtime: "provider-route",
    });

    const missing = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Missing file" });

    const form = new FormData();
    form.append(
      "file",
      new File(["voice-bytes"], "voice.webm", { type: "audio/webm" }),
    );
    const unconfigured = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form,
    });
    expect(unconfigured.status).toBe(409);
    expect(await unconfigured.json()).toEqual({
      error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
    });
  } finally {
    await db.close();
  }
});

it("transcribes through PostgreSQL provider settings with one usage event", async () => {
  const db = new PGlite();
  const secret = "node-voice-secret";
  try {
    await migrateDatabase(db);
    const token = "clsh_" + "d".repeat(40);
    await db.query(
      "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
      [
        "voice-configured-token",
        "owner",
        "voice-configured",
        createHash("sha256").update(token).digest("hex"),
        "clsh_dddd",
      ],
    );
    const encrypted = await encryptProviderCredentials(
      { apiKey: "node-gemini-key" },
      secret,
    );
    await db.query(
      `INSERT INTO provider_account
         (id,user_id,provider_id,upstream_id,api_shape,enabled,priority,
          configured_credentials,encrypted_credentials,created_at,updated_at)
       VALUES ('provider','owner','official','google-ai-studio','google-ai-studio',1,10,$1,$2,1,1)`,
      [JSON.stringify(["apiKey"]), encrypted],
    );
    const app = createNodeCloudApp({
      db,
      syncBaseUrl: "https://node.example.com",
      providerSecretKey: secret,
    });
    const headers = { authorization: `Bearer ${token}` };

    const readiness = await app.request("/api/v1/audio/voice-input", {
      headers,
    });
    expect(readiness.status).toBe(200);
    const readinessBody = (await readiness.json()) as {
      asr: { model: string; provider: string; ready: boolean };
    };
    expect(readinessBody.asr).toMatchObject({
      provider: "google-ai-studio",
      ready: true,
    });
    const model = readinessBody.asr.model;

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "  node transcript  " }] } },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const form = new FormData();
    form.append(
      "file",
      new File(["voice-bytes"], "voice.webm", {
        type: "audio/webm;codecs=opus",
      }),
    );
    form.append("language", "English");
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "clash.asr.timed-transcript",
      text: "node transcript",
      backendId: "official",
      modelId: model,
      language: "English",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(":generateContent");
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
    expect(body.contents[0]?.parts[1]?.inlineData?.mimeType).toBe("audio/webm");

    const usageCount = async () => {
      const result = await db.query(
        "SELECT count(*)::int AS count FROM provider_usage_audit WHERE user_id='owner'",
      );
      return Number((result.rows[0] as { count: number | string }).count);
    };
    expect(await usageCount()).toBe(1);

    // Retrying the same audit event id must not append a second charge row.
    const event = {
      id: "voice-input:retry",
      userId: "owner",
      providerId: "official",
      modelId: "gemini-3-flash",
      operation: "gemini-3-flash-preview",
      taskId: "retry",
      actorType: "user" as const,
      actorUserId: "owner",
      idempotencyKey: "voice-input:retry",
      status: "completed" as const,
      estimateComplete: false,
      currency: "USD" as const,
      pricingSource: "unavailable" as const,
      billingBasis: {},
      occurredAt: new Date().toISOString(),
    };
    await appendNodeProviderUsageEvent(db, event);
    await appendNodeProviderUsageEvent(db, event);
    expect(await usageCount()).toBe(2);
  } finally {
    vi.unstubAllGlobals();
    await db.close();
  }
});

describeVoiceInputContract("api-node (shared HTTP contract)", () => {
  return {
    mount: (ports) => {
      const app = new Hono<{ Variables: { userId: string } }>();
      app.use("*", async (c, next) => {
        c.set("userId", c.req.header("x-user-id") ?? "");
        await next();
      });
      app.route(
        "/api/v1",
        createNodeVoiceInputRoutes({ createPorts: () => ports }),
      );
      return { fetch: async (request) => app.request(request) };
    },
  };
});
