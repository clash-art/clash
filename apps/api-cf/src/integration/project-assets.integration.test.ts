/**
 * api-cf Project Asset adapter in workerd: single-shot and chunked imports
 * publish a Resource in R2 and an Asset in the ProjectRoom, and the upload
 * Worker's capability URL serves the bytes with Range/CORS.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectAssetHttpError,
  createProjectAssetHttpClient,
  type ProjectAssetHttpClient,
} from "@clash/asset-sdk";
import { CONTRACT_SAMPLE_VIDEO_FILE } from "@clash/shared-runtime/project-host-contract";
import { createApp } from "../app";
import { contentHash } from "../services/project-content";
import { createUploadWorkerApp } from "../upload-worker";
import type { Env } from "../config";

beforeEach(() => {
  // Nothing in this flow may reach the network; every URL is served locally.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    throw new Error(`Unexpected external request: ${String(request)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("api-cf Project Asset adapter", () => {
  it("imports, projects, and serves Range bytes through the upload Worker", async () => {
    const bindings = { ...env } as unknown as Env;
    const projectId = crypto.randomUUID(),
      userId = crypto.randomUUID(),
      token = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(projectId, "Assets", userId, null, Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        userId,
        "contract",
        await contentHash(token),
        token.slice(0, 10),
        Date.now(),
      )
      .run();
    const sample = env.CONTRACT_SAMPLE_VIDEO_BASE64;
    if (!sample) throw new Error("CONTRACT_SAMPLE_VIDEO_BASE64 binding is missing");
    const bytes = Uint8Array.from(atob(sample), (char) => char.charCodeAt(0));
    const app = createApp();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return app.request(
        String(input instanceof Request ? input.url : input),
        { ...init, headers },
        bindings,
      );
    };
    const client: ProjectAssetHttpClient = createProjectAssetHttpClient({
      endpoint: "https://clash.test",
      fetch,
    });

    const imported = await client.importFile({
      projectId,
      projectAssetId: "asset:single",
      kind: "video",
      file: new File([bytes as Uint8Array<ArrayBuffer>], CONTRACT_SAMPLE_VIDEO_FILE, {
        type: "video/mp4",
      }),
      metadataHints: { durationMs: 1_000, width: 64, height: 64, hasAudio: false },
    });
    expect(imported).toMatchObject({
      id: "asset:single",
      kind: "video",
      status: "ready",
    });
    expect(imported.url).toEqual(expect.any(String));

    const listed = await client.list({ projectId });
    expect(listed.find((asset) => asset.id === "asset:single")).toMatchObject({
      status: "ready",
      metadata: { durationMs: 1_000, width: 64, height: 64, hasAudio: false },
    });
    const observed = await client.get({
      projectId,
      assetId: "asset:single",
    });
    expect(observed.receipt).toMatch(/\S/);
    expect(await client.references({ projectId, assetId: "asset:single" })).toMatchObject({
      value: [],
    });

    const duplicate = await client
      .importFile({
        projectId,
        projectAssetId: "asset:duplicate",
        kind: "video",
        file: new File([bytes as Uint8Array<ArrayBuffer>], CONTRACT_SAMPLE_VIDEO_FILE, {
          type: "video/mp4",
        }),
        duplicateContent: "reject",
      })
      .catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(ProjectAssetHttpError);
    expect((duplicate as ProjectAssetHttpError).status).toBe(409);
    expect((duplicate as ProjectAssetHttpError).body).toMatchObject({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
    });

    const uploadApp = createUploadWorkerApp();
    const ranged = await uploadApp.request(
      imported.url!,
      { headers: { Range: "bytes=0-15", Origin: "https://web.test" } },
      bindings,
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("access-control-allow-origin")).toBe("*");
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-15\//);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      bytes.subarray(0, 16),
    );

    // The chunked path is chosen by the client's cap, not by a UI mode branch.
    const chunked = createProjectAssetHttpClient({
      endpoint: "https://clash.test",
      fetch,
      singleShotMaxBytes: 1024,
    });
    expect(bytes.byteLength).toBeGreaterThan(1024);
    const sessionAsset = await chunked.importFile({
      projectId,
      projectAssetId: "asset:chunked",
      kind: "video",
      file: new File([bytes as Uint8Array<ArrayBuffer>], CONTRACT_SAMPLE_VIDEO_FILE, {
        type: "video/mp4",
      }),
    });
    expect(sessionAsset).toMatchObject({ id: "asset:chunked", status: "ready" });
    const sessionRange = await uploadApp.request(
      sessionAsset.url!,
      { headers: { Range: "bytes=0-31" } },
      bindings,
    );
    expect(sessionRange.status).toBe(206);
    expect(new Uint8Array(await sessionRange.arrayBuffer())).toEqual(
      bytes.subarray(0, 32),
    );

    const tenant = await env.DB.prepare(
      "SELECT tenant_id FROM project WHERE id = ?",
    )
      .bind(projectId)
      .first<{ tenant_id: string | null }>();
    expect(tenant?.tenant_id).toBe(`personal:${userId}`);

    // Trash is a durable soft delete: it survives a fresh room instance, the
    // bytes stay in R2, and restore brings the same Asset back playable.
    const read = await client.get({ projectId, assetId: "asset:single" });
    const trashed = await client.trash({
      projectId,
      assetId: "asset:single",
      deleteOperationId: "delete-1",
      actorClientType: "browser",
      receipt: read.receipt,
    });
    expect(trashed.value.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: "delete-1",
    });
    const room = env.ROOM.get(env.ROOM.idFromName(projectId));
    await evictDurableObject(room);
    const afterEviction = await client.list({ projectId });
    expect(
      afterEviction.find((asset) => asset.id === "asset:single")?.lifecycle,
    ).toMatchObject({ state: "trashed", deleteOperationId: "delete-1" });
    const restored = await client.restore({
      projectId,
      assetId: "asset:single",
      actorClientType: "browser",
      receipt: trashed.receipt,
    });
    expect(restored.value).toMatchObject({
      id: "asset:single",
      status: "ready",
      lifecycle: { state: "active" },
    });
    await evictDurableObject(room);
    expect(
      (await client.list({ projectId })).find(
        (asset) => asset.id === "asset:single",
      )?.lifecycle,
    ).toEqual({ state: "active" });
    const replay = await uploadApp.request(restored.value.url!, {
      headers: { Range: "bytes=0-15" },
    }, bindings);
    expect(replay.status).toBe(206);

    await env.DB.prepare("DELETE FROM api_token WHERE user_id = ?")
      .bind(userId)
      .run();
    await env.DB.prepare("DELETE FROM project WHERE id = ?")
      .bind(projectId)
      .run();
  });
});
