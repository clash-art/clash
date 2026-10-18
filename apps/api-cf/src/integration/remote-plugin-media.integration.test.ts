/**
 * #214 in workerd: a remote (third-party) plugin's references resolve against
 * Project Assets (ProjectRoom + R2 Resource + signed capability), and its
 * media output is uploaded through the run's chunked import session and
 * published as the node output exactly once. Also the Cloudflare server-side
 * Timeline render binding of the same resolver.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAssetHttpClient,
  uploadCloudContent,
  type ProjectAssetHttpClient,
} from "@clash/asset-sdk";
import { Canvas } from "@clash/shared-types";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";
import { CONTRACT_SAMPLE_VIDEO_FILE } from "@clash/shared-runtime/project-host-contract";
import { pluginOutputStagingLocator } from "@clash/shared-runtime/cloud-project-host/plugin-output-sessions";
import { durablePublicFailure } from "@clash/shared-runtime/durable-run-engine";
import type {
  RemotePluginOutputCapability,
  RemotePluginReference,
} from "@clash/shared-runtime/executable-plugin-remote";

import { createApp } from "../app";
import type { Env } from "../config";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { Status } from "../domain/canvas";
import { submitExecutableAction } from "../generation/executable-admission";
import { createExecutableActionRuntime } from "../generation/executable-runtime";
import { createCloudActionInvoker } from "../generation/plugin-execution/action-invoker";
import { contentHash } from "../services/project-content";
import { createPluginEndpointSetting } from "../services/plugin-settings";
import { resolveCloudTimelineMedia } from "../services/project-asset-references";
import { createUploadWorkerApp } from "../upload-worker";

const remoteBinding = {
  pluginId: "third.echo",
  version: "1.0.0",
  exportId: "run",
  schemaHash: `sha256:${"e".repeat(64)}`,
};

beforeEach(() => {
  // Plugin, upload and delivery traffic is served in-process; nothing reaches the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    throw new Error(`Unexpected external request: ${String(request)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

function sampleVideo(): Uint8Array {
  const sample = env.CONTRACT_SAMPLE_VIDEO_BASE64;
  if (!sample) throw new Error("CONTRACT_SAMPLE_VIDEO_BASE64 binding is missing");
  return Uint8Array.from(atob(sample), (char) => char.charCodeAt(0));
}

async function project() {
  const bindings = { ...env } as unknown as Env;
  const id = crypto.randomUUID();
  const projectId = `remote-media-${id}`,
    userId = `user-${id}`,
    nodeId = `node-${id}`,
    token = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(projectId, "Remote media", userId, null, Date.now(), Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, "remote", await contentHash(token), token.slice(0, 10), Date.now())
    .run();
  const app = createApp();
  const uploadApp = createUploadWorkerApp();
  const authed: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return app.request(String(input instanceof Request ? input.url : input), { ...init, headers }, bindings);
  };
  const client: ProjectAssetHttpClient = createProjectAssetHttpClient({
    endpoint: "https://clash.test",
    fetch: authed,
  });
  const clip = sampleVideo();
  await client.importFile({
    projectId,
    projectAssetId: "asset:clip",
    kind: "video",
    file: new File([clip as Uint8Array<ArrayBuffer>], CONTRACT_SAMPLE_VIDEO_FILE, { type: "video/mp4" }),
  });
  await createPluginEndpointSetting(bindings, userId, {
    pluginId: remoteBinding.pluginId,
    endpoint: "https://plugins.example.com/invoke",
    secret: "echo-signing-secret",
    version: remoteBinding.version,
    schemaHash: remoteBinding.schemaHash,
    exportIds: [remoteBinding.exportId],
    idempotentSubmit: true,
  });
  const data = {
    status: Status.Pending,
    actionType: "custom:echo",
    customActionId: "echo",
    outputType: "video",
    prompt: "echo the clip",
    actorType: "user",
    actorUserId: userId,
    pluginBinding: remoteBinding,
    referenceVideoAssetIds: ["asset:clip"],
  };
  const seed = new LoroDoc();
  seed.getMap("nodes").set(nodeId, { type: "video", data });
  const seeded = await env.ROOM.get(env.ROOM.idFromName(projectId)).fetch(
    new Request(`http://internal/loro/${projectId}/updates`, {
      method: "POST",
      headers: { "x-internal-loro": "true", "x-loro-project-id": projectId },
      body: seed.export({ mode: "snapshot" }),
    }),
  );
  expect(seeded.status).toBe(204);
  seed.free();

  const snapshot = async () => {
    const doc = new LoroDoc();
    const response = await env.ROOM.get(env.ROOM.idFromName(projectId)).fetch(
      new Request(`http://internal/loro/${projectId}/snapshot`, {
        headers: { "x-internal-loro": "true", "x-loro-project-id": projectId },
      }),
    );
    doc.import(new Uint8Array(await response.arrayBuffer()));
    return doc;
  };
  const readNode = async () => {
    const doc = await snapshot();
    const node = new Canvas(doc, () => undefined).readNode(nodeId);
    doc.free();
    return node?.data as Record<string, unknown> | undefined;
  };

  /** Admit the node's Action and drive its Durable Run to a terminal phase. */
  const run = async (plugin: typeof fetch, afterAdmission?: () => Promise<void>) => {
    const journal = createD1CloudDurableRunJournal(bindings.DB);
    const now = { value: Date.now() };
    const runtime = createExecutableActionRuntime(bindings, {
      journal,
      clock: { now: () => now.value },
      action: createCloudActionInvoker(bindings, {
        fetch: plugin,
        userIdForProject: async () => userId,
      }),
    });
    const created = await submitExecutableAction(
      bindings,
      {
        projectId,
        nodeId,
        data,
        userId,
        custom: { actionId: "echo", outputType: "video" },
      },
      { journal, workflow: { create: async () => undefined } },
    );
    const identity = { actionRunId: created.actionRunId, outputSlot: created.outputSlot };
    await afterAdmission?.();
    let result = await runtime.coordinate({ type: "advance", identity });
    for (let step = 0; step < 20 && result.kind !== "terminal"; step += 1) {
      now.value += 2_000;
      result = await runtime.coordinate({ type: "advance", identity });
    }
    if (result.kind !== "terminal") throw new Error("run did not finish");
    return { identity, run: result.run, runtime };
  };

  return { bindings, projectId, userId, app, uploadApp, client, clip, snapshot, readNode, run };
}

type Project = Awaited<ReturnType<typeof project>>;

interface PluginCall {
  invocation: ExecutablePluginInvocation;
  references: RemotePluginReference[];
  outputs?: RemotePluginOutputCapability[];
}

/** An echo-style third-party plugin over the real begin/multipart routes. */
function echoPlugin(
  p: Project,
  respond: (call: PluginCall, attempt: number, upload: (bytes: Uint8Array) => Promise<void>) => Promise<Response>,
) {
  const calls: PluginCall[] = [];
  const plugin = (async (_input: unknown, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as PluginCall;
    calls.push(call);
    const upload = async (bytes: Uint8Array) => {
      const capability = call.outputs!.find((output) => output.slot === "video")!;
      const begun = await p.app.request(
        capability.upload.beginUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ byteLength: bytes.byteLength, contentType: "video/mp4" }),
        },
        p.bindings,
      );
      expect(begun.status).toBe(201);
      const { upload: session } = (await begun.json()) as { upload: { url: string } };
      await uploadCloudContent({
        url: session.url,
        fetch: async (input, request) => p.app.request(String(input), request, p.bindings),
        source: {
          byteLength: bytes.byteLength,
          readPart: async (offset, length) => bytes.slice(offset, offset + length),
        },
      });
    };
    return respond(call, calls.length, upload);
  }) as typeof fetch;
  return { plugin, calls };
}

const completed = (call: PluginCall, outputs: Extract<ExecutablePluginResult, { status: "completed" }>["outputs"]) =>
  Response.json({
    protocol: "clash.plugin.result/v1",
    invocationId: call.invocation.invocationId,
    status: "completed",
    outputs,
  });

const videoCapability = (call: PluginCall) =>
  call.outputs!.find((output) => output.slot === "video")!;

describe("remote plugin Project Asset references and media outputs (Cloudflare)", () => {
  it("signs a fetchable Project Asset reference and publishes the uploaded output once, across a retried invocation", async () => {
    const p = await project();
    const output = new TextEncoder().encode("echoed video bytes from the remote plugin");
    const fetched: Uint8Array[] = [];
    const { plugin, calls } = echoPlugin(p, async (call, attempt, upload) => {
      const response = await p.uploadApp.request(call.references[0]!.url, {}, p.bindings);
      expect(response.ok).toBe(true);
      fetched.push(new Uint8Array(await response.arrayBuffer()));
      if (attempt === 1) {
        // The work and upload happened, but the answer was lost in transit.
        await upload(output);
        return new Response("upstream gateway timeout", { status: 503 });
      }
      // An idempotent plugin answers its retry from its own record of the work.
      return completed(call, [{ slot: "video", kind: "asset", asset: videoCapability(call).asset }]);
    });

    const { identity, run } = await p.run(plugin);
    expect(run.phase).toBe("succeeded");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.references).toEqual([
      { slot: "video", index: 0, url: expect.any(String), expiresAt: expect.any(String) },
    ]);
    expect(fetched).toEqual([p.clip, p.clip]);
    // The retry targets the same pre-assigned Asset.
    const [first, second] = calls.map((call) => videoCapability(call).asset);
    expect(second).toEqual(first);

    const node = await p.readNode();
    expect(node).toMatchObject({ status: Status.Completed, assetId: first!.assetId });
    const assets = await p.client.list({ projectId: p.projectId });
    expect(assets.map((asset) => asset.id).sort()).toEqual(["asset:clip", first!.assetId].sort());
    const published = assets.find((asset) => asset.id === first!.assetId)!;
    expect(published).toMatchObject({ kind: "video", status: "ready" });
    const media = await p.uploadApp.request(published.url!, {}, p.bindings);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(output);
    // Private staging is released after publication.
    expect(await p.bindings.R2_BUCKET.head(pluginOutputStagingLocator(identity))).toBeNull();
  });

  it("fails reference_unavailable on the node when the Asset is trashed after admission, without calling the plugin", async () => {
    const p = await project();
    const { plugin, calls } = echoPlugin(p, async () => {
      throw new Error("the plugin must not be invoked");
    });
    const { run } = await p.run(plugin, async () => {
      const read = await p.client.get({ projectId: p.projectId, assetId: "asset:clip" });
      await p.client.trash({
        projectId: p.projectId,
        assetId: "asset:clip",
        deleteOperationId: "trash-1",
        actorClientType: "browser",
        receipt: read.receipt,
      });
    });
    expect(run.phase).toBe("failed");
    expect(run.failure).toMatchObject({ code: "reference_unavailable", retryable: false });
    // The private diagnostic names the slot, index and Asset.
    expect(run.failure!.message).toContain("video#0");
    expect(run.failure!.message).toContain("asset:clip");
    expect(calls).toHaveLength(0);
    expect(await p.readNode()).toMatchObject({
      status: Status.Failed,
      errorCode: "reference_unavailable",
      error: durablePublicFailure(run.failure!).message,
    });
  });

  it.each([
    ["was never uploaded", false, undefined],
    ["names a foreign Asset", true, "asset:clip"],
  ])("fails contract_violation on the node when the answer %s", async (_label, uploads, answerAssetId) => {
    const p = await project();
    const { plugin } = echoPlugin(p, async (call, _attempt, upload) => {
      if (uploads) await upload(new TextEncoder().encode("bytes"));
      const asset = videoCapability(call).asset;
      return completed(call, [
        { slot: "video", kind: "asset", asset: answerAssetId ? { ...asset, assetId: answerAssetId } : asset },
      ]);
    });
    const { run } = await p.run(plugin);
    expect(run.phase).toBe("failed");
    expect(run.failure).toMatchObject({ code: "contract_violation", retryable: false });
    expect(run.failure!.message).toContain("output session");
    expect(await p.readNode()).toMatchObject({
      status: Status.Failed,
      errorCode: "contract_violation",
      error: durablePublicFailure(run.failure!).message,
    });
    // Nothing was published in the plugin's name.
    const assets = await p.client.list({ projectId: p.projectId });
    expect(assets.map((asset) => asset.id)).toEqual(["asset:clip"]);
  });
});

describe("Cloudflare server-side Timeline render media", () => {
  const timeline = {
    tracks: [{ id: "media", items: [{ id: "clip", type: "video", assetId: "asset:clip" }] }],
  };
  const byAssetId = (item: Record<string, unknown>) =>
    typeof item.assetId === "string" ? item.assetId : undefined;

  it("gives an imported project video clip a signed src render-server can fetch", async () => {
    const p = await project();
    const doc = await p.snapshot();
    const resolved = await resolveCloudTimelineMedia(p.bindings, {
      doc,
      projectId: p.projectId,
      actorUserId: p.userId,
      timelineDsl: timeline,
      assetIdOf: byAssetId,
    });
    doc.free();
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const [track] = resolved.timelineDsl.tracks as Array<{ items: Array<{ src: string }> }>;
    const media = await p.uploadApp.request(track!.items[0]!.src, {}, p.bindings);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(p.clip);
  });

  it("fails with reference_unavailable when the clip's Asset is gone", async () => {
    const p = await project();
    const doc = await p.snapshot();
    const resolved = await resolveCloudTimelineMedia(p.bindings, {
      doc,
      projectId: p.projectId,
      actorUserId: p.userId,
      timelineDsl: {
        tracks: [{ id: "media", items: [{ id: "clip", type: "video", assetId: "asset:never-imported" }] }],
      },
      assetIdOf: byAssetId,
    });
    doc.free();
    expect(resolved).toMatchObject({ ok: false, failure: { code: "reference_unavailable" } });
  });
});
