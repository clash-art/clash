/**
 * Remote plugin media outputs over the real shared import-session module: a
 * fake third-party plugin uploads through the run's capability, and the remote
 * port accepts its Asset answer only after that exact session completed.
 */
import { describe, expect, it } from "vitest";
import { uploadCloudContent } from "@clash/asset-sdk";
import { createInMemoryAssetDeliveryStore } from "@clash/asset-sdk/upload-service";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import { durableRunIdempotencyKey } from "../durable-run-engine.js";
import {
  createRemotePluginExecution,
  type RemotePluginOutputCapability,
} from "../executable-plugin-remote.js";
import {
  beginPluginOutputSession,
  createPluginOutputGrants,
  handlePluginOutputSessionContent,
  issuePluginOutputCapabilities,
  pluginOutputAssetId,
  pluginOutputStagingLocator,
  readPluginOutputUpload,
  type PluginOutputSessionPorts,
} from "./plugin-output-sessions.js";
import {
  createHmacProjectAssetImportSessionTokens,
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
} from "./project-asset-import-sessions.js";

const ENDPOINT = "https://plugins.example.com/invoke";
const HOST = "https://host.test/out";
const BYTES = new TextEncoder().encode("rendered plugin video bytes");

function host(run = { actionRunId: "project:p:node:n:rev:1", outputSlot: "media" }) {
  let now = Date.parse("2026-10-01T00:00:00.000Z");
  const clock = { now: () => now };
  const store = createInMemoryAssetDeliveryStore();
  const ports: PluginOutputSessionPorts = {
    grants: createPluginOutputGrants({ secret: "host-secret", now: clock.now }),
    sessions: {
      clock,
      tokens: createHmacProjectAssetImportSessionTokens({
        secret: "host-secret",
        now: clock.now,
      }),
      access: {
        canAccessProject: async ({ projectId, ownerId }) =>
          projectId === "p" && ownerId === "owner",
      },
      staging: {
        store,
        delete: async (locator) => void store.objects.delete(locator),
      },
    },
    beginUrl: (grant) => `${HOST}/${grant}`,
    contentUrl: (grant, sessionId) => `${HOST}/${grant}/${sessionId}`,
  };
  /** The Host's two transport routes, as an adapter would mount them. */
  const serve: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const [grant, sessionId] = new URL(request.url).pathname
      .replace(/^\/out\//u, "")
      .split("/");
    if (request.method === "POST" && grant && !sessionId) {
      const result = await beginPluginOutputSession(
        { grant, body: await request.json() },
        ports,
      );
      return Response.json(result.body, { status: result.status });
    }
    if (request.method === "PUT" && grant && sessionId)
      return handlePluginOutputSessionContent(request, { grant, sessionId }, ports);
    return new Response(null, { status: 404 });
  };
  const invocation: ExecutablePluginInvocation = {
    protocol: "clash.plugin.invoke/v1",
    invocationId: durableRunIdempotencyKey(run),
    taskId: run.actionRunId,
    projectId: "p",
    nodeId: "n",
    target: {
      pluginId: "third.party",
      version: "1.0.0",
      exportId: "run",
      schemaHash: `sha256:${"a".repeat(64)}`,
      kind: "action",
    },
    input: { values: { prompt: "a clip" }, references: [] },
    expectedOutputSlots: ["video", "media"],
    actor: { kind: "user", id: "owner" },
    operation: "submit",
  };
  const capabilitiesFor = (target: typeof run) =>
    issuePluginOutputCapabilities(
      { run: target, ownerId: "owner", projectId: "p", kind: "video", slots: ["video", "media"] },
      ports,
    );
  const capabilities = () => capabilitiesFor(run);
  const port = (plugin: typeof fetch) =>
    createRemotePluginExecution({
      fetch: plugin,
      now: clock.now,
      target: async () => ({
        endpoint: ENDPOINT,
        secret: "plugin-secret",
        references: [],
        outputs: await capabilities(),
      }),
      outputUploaded: async () => !!(await readPluginOutputUpload(run, { store })),
    });
  const invoke = (plugin: typeof fetch) =>
    port(plugin).invoke({ run, invocation, timeoutMs: 5_000 });
  return {
    run,
    store,
    serve,
    invoke,
    capabilities,
    capabilitiesFor,
    advance: (ms: number) => void (now += ms),
  };
}

type Host = ReturnType<typeof host>;

const answer = (
  invocationId: string,
  outputs: Extract<ExecutablePluginResult, { status: "completed" }>["outputs"],
) =>
  Response.json({
    protocol: "clash.plugin.result/v1",
    invocationId,
    status: "completed",
    outputs,
  });

/** An echo-style third-party plugin: uploads `BYTES` through its capability, then answers with it. */
function echoPlugin(h: Host, options: { upload?: boolean; answerAssetId?: string } = {}) {
  const seen: Array<{ outputs?: RemotePluginOutputCapability[] }> = [];
  const plugin: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      invocation: ExecutablePluginInvocation;
      outputs?: RemotePluginOutputCapability[];
    };
    seen.push({ ...(body.outputs ? { outputs: body.outputs } : {}) });
    const capability = body.outputs!.find((output) => output.slot === "video")!;
    if (options.upload !== false) {
      const begun = await h.serve(capability.upload.beginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ byteLength: BYTES.byteLength, contentType: "video/mp4" }),
      });
      expect(begun.status).toBe(201);
      const { upload } = (await begun.json()) as { upload: { url: string } };
      await uploadCloudContent({
        url: upload.url,
        fetch: h.serve,
        source: {
          byteLength: BYTES.byteLength,
          readPart: async (offset, length) => BYTES.slice(offset, offset + length),
        },
      });
    }
    return answer(body.invocation.invocationId, [
      {
        slot: "video",
        kind: "asset",
        asset: {
          ...capability.asset,
          ...(options.answerAssetId ? { assetId: options.answerAssetId } : {}),
        },
      },
    ]);
  };
  return { plugin, seen };
}

describe("remote plugin output sessions", () => {
  it("accepts a media output uploaded through this run's session, under the pre-assigned id", async () => {
    const h = host();
    const { plugin, seen } = echoPlugin(h);
    const result = await h.invoke(plugin);
    expect(result).toMatchObject({
      status: "completed",
      outputs: [
        { slot: "video", kind: "asset", asset: { assetId: pluginOutputAssetId(h.run), kind: "video" } },
      ],
    });
    // One capability per accepted slot name, all for the same durable output.
    expect(seen[0]!.outputs!.map((output) => output.slot)).toEqual(["video", "media"]);
    expect(new Set(seen[0]!.outputs!.map((output) => output.asset.assetId)).size).toBe(1);
    const upload = await readPluginOutputUpload(h.run, { store: h.store });
    expect(upload).toMatchObject({ size: BYTES.byteLength });
    // The sweep of abandoned import staging covers plugin uploads too.
    expect(upload!.locator.startsWith(PROJECT_ASSET_IMPORT_STAGING_PREFIX)).toBe(true);
    expect(h.store.objects.get(pluginOutputStagingLocator(h.run))?.bytes).toEqual(BYTES);
  });

  it("rejects an asset answer whose bytes never went through the session", async () => {
    const h = host();
    const { plugin } = echoPlugin(h, { upload: false });
    await expect(h.invoke(plugin)).rejects.toMatchObject({
      failure: { code: "contract_violation", retryable: false },
    });
  });

  it("rejects a foreign Asset id even when this run's upload completed", async () => {
    const h = host();
    const { plugin } = echoPlugin(h, { answerAssetId: "someone-elses-asset" });
    const failure = await h.invoke(plugin).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      failure: { code: "contract_violation", retryable: false },
    });
    expect((failure as Error).message).toContain("someone-elses-asset");
  });

  it("gives a retried invocation the same Asset id and staging object, so there is no second Asset", async () => {
    const h = host();
    const { plugin, seen } = echoPlugin(h);
    await h.invoke(plugin);
    h.advance(60_000);
    await h.invoke(plugin);
    const [first, second] = seen.map((call) => call.outputs![0]!);
    expect(second!.asset).toEqual(first!.asset);
    const staged = [...h.store.objects.keys()].filter((locator) =>
      locator.startsWith(PROJECT_ASSET_IMPORT_STAGING_PREFIX),
    );
    expect(staged).toEqual([pluginOutputStagingLocator(h.run)]);
  });

  it("does not let one run's grant carry another run's session, and refuses a tampered grant", async () => {
    const h = host();
    const [mine] = await h.capabilities();
    const [theirs] = await h.capabilitiesFor({
      actionRunId: "project:p:node:n:rev:2",
      outputSlot: "media",
    });
    const begun = await h.serve(theirs!.upload.beginUrl, {
      method: "POST",
      body: JSON.stringify({ byteLength: 4 }),
    });
    expect(begun.status).toBe(201);
    const { sessionId } = (await begun.json()) as { sessionId: string };
    const crossed = await h.serve(
      `${mine!.upload.beginUrl}/${sessionId}?upload=begin&uploadId=${"u".repeat(32)}`,
      { method: "PUT" },
    );
    expect(crossed.status).toBe(403);
    const tampered = await h.serve(`${mine!.upload.beginUrl}0`, {
      method: "POST",
      body: JSON.stringify({ byteLength: 4 }),
    });
    expect(tampered.status).toBe(403);
  });
});
