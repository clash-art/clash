import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assemblePluginModule,
  defineExecutor,
  type ExecutorStep,
} from "@clash/action-sdk";
import { plugin as videoEnhancePlugin } from "@clash-plugin/video-enhance/stdio";
import type { ActionRunModelRoute } from "@clash/shared-types";

import { createLocalPluginBrokerServices } from "./server.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalVideoEnhanceService } from "./local-video-enhance.js";
import { createProviderPluginExecutor } from "./provider-plugin-executor.js";
import { createModulePluginEndpoint } from "./runtime/host/lib/plugin-module-runner.js";
import videoEnhanceManifest from "../../../plugins/video-enhance/manifest.json" with { type: "json" };

/**
 * The real end-to-end shape for the `clash.video-enhance` generic Generator:
 *
 *   ModulePluginEndpoint(clash.video-enhance) --invoke--> videoEnhancePlugin's real `enhance`
 *   action --> context.hostTools.videoEnhance() --> the production outer broker's `video.enhance`
 *   operation --> createLocalVideoEnhanceService --> createProviderPluginExecutor -->
 *   ModulePluginEndpoint(clash.fake-provider) --invoke--> a fake async submit/poll Provider
 *   executor built with the real action-sdk `defineExecutor` --> its "completed" step names a
 *   `media` slot with only an external `url` --> real action-sdk `outputsFor` calls the real
 *   `context.upload` --> the real broker's `asset.upload-slot` operation --> the production
 *   `openUploadSlot` (from `createLocalPluginBrokerServices`) performs the one and only fetch of
 *   that URL and stages the bytes through the real `LocalPluginAssetStagingStore`.
 *
 * No step in this chain is hand-rolled: the fake Provider callback below builds no Asset handle,
 * calls no staging store, and never touches `fetch` itself. Only the *content* the fake Provider
 * vendor produced (an external URL) is fake; every Host mechanism that turns that URL into a
 * staged, owned Project Asset is the same production code the real Volcengine MediaKit plugin
 * runs through.
 */

const EXTERNAL_URL = "https://cdn.example/provider-output/enhanced.mp4";
const RUN_TASK_ID = "run:project-1:action-run-1";
const RUN_OUTPUT_SLOT = "media";

const providerBinding = {
  pluginId: "clash.fake-provider",
  version: "1.0.0",
  exportId: "fake-provider-execute",
  schemaHash: `sha256:${"a".repeat(64)}` as const,
};

const videoEnhanceBinding = {
  pluginId: videoEnhanceManifest.id,
  version: videoEnhanceManifest.version,
  exportId: "enhance",
  schemaHash: `sha256:${"b".repeat(64)}` as const,
};

const frozenRoute: ActionRunModelRoute = {
  upstreamId: "fake-upstream",
  upstreamModel: "fake-model",
  apiShape: "fake-shape",
  providerId: "fake-provider",
  accountId: "account-1",
  executorPluginId: providerBinding.pluginId,
  executorExportId: providerBinding.exportId,
  executorBinding: providerBinding,
  assetInputs: [
    { match: { kinds: ["video"] }, representations: ["provider-url"] },
  ],
};

const reference = {
  slot: "source",
  index: 0,
  asset: {
    assetId: "asset-source-1",
    uri: "clash-asset://asset-source-1",
    kind: "video" as const,
    mediaType: "video/mp4",
  },
};

let dataDir: string;
let providerManifestDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-video-enhance-e2e-"));
  // `assemblePluginModule` reads its manifest from disk, the same as a real installed plugin.
  providerManifestDir = join(dataDir, "fake-provider");
  await mkdir(providerManifestDir, { recursive: true });
  await writeFile(
    join(providerManifestDir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: providerBinding.pluginId,
      version: providerBinding.version,
      name: "Fake Provider",
      runtime: { kind: "local", transport: "stdio", entrypoint: "index.mjs" },
      contributes: {
        cards: [],
        providers: [],
        modelBindings: [],
        generators: [],
        functions: [
          {
            id: providerBinding.exportId,
            kind: "provider-executor",
            operations: ["submit", "poll"],
          },
        ],
        hostTools: [],
      },
      contractTests: [],
    }),
  );
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A network double: counts every fetch of the Provider's external URL. */
function countingFetch(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls += 1;
    expect(String(input)).toBe(EXTERNAL_URL);
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("generic video-enhance: real plugin Host transport -> broker -> nested Provider -> real staging", () => {
  it("fetches the fake Provider's completed URL exactly once through real asset.upload-slot and stages one owned receipt", async () => {
    const { fetchImpl, calls } = countingFetch();

    // Only the vendor content is fake here: an async submit/poll executor built with the real
    // action-sdk `defineExecutor`, whose completed step names an external `url` -- exactly the
    // shape a real Provider plugin (e.g. Volcengine MediaKit) returns.
    let submitCalls = 0;
    const fakeProviderExecutor = defineExecutor({
      async submit(): Promise<ExecutorStep> {
        submitCalls += 1;
        return {
          status: "accepted",
          pollState: { upstreamTaskId: "provider-task-1" },
          retryAfterMs: 10,
        };
      },
      async poll(): Promise<ExecutorStep> {
        return {
          status: "completed",
          media: {
            media: { url: EXTERNAL_URL, mediaType: "video/mp4", kind: "video" },
          },
        } as ExecutorStep;
      },
    });
    const fakeProviderModule = assemblePluginModule({
      manifestDir: providerManifestDir,
      contributes: { [providerBinding.exportId]: fakeProviderExecutor },
    });
    const fakeProviderManifest = {
      apiVersion: "clash.plugin/v1" as const,
      id: providerBinding.pluginId,
      version: providerBinding.version,
      name: "Fake Provider",
      runtime: { kind: "local" as const, transport: "stdio" as const, entrypoint: "index.mjs" },
      contributes: {
        cards: [],
        providers: [],
        modelBindings: [],
        generators: [],
        functions: [
          { id: providerBinding.exportId, kind: "provider-executor" as const, operations: ["submit", "poll"] as ["submit", "poll"] },
        ],
        hostTools: [],
      },
      contractTests: [],
    };

    // The outer production broker: `enhanceVideo` is the exact server.ts wiring under test,
    // `assetFetch` is the only test double, and `openUploadSlot` (inside) is the real production
    // fetch-and-stage path used for every executor plugin. Declared with `let` so the nested
    // Provider endpoint built inside `enhanceVideo` can share this exact same broker instance --
    // the same single Host broker every plugin endpoint in a real process talks to.
    let outerBroker: ReturnType<typeof createLocalPluginBrokerServices>;
    outerBroker = createLocalPluginBrokerServices({
      dataDir,
      uploadOrigin: "http://127.0.0.1:0",
      assetFetch: fetchImpl,
      enhanceVideo: async (input) => {
        // The nested Provider dispatch: real `createProviderPluginExecutor` driving the real
        // fake-provider module through a real `ModulePluginEndpoint`, exactly the production
        // bridge `ActionsHost` uses for a trusted bundled Provider executor.
        const providerEndpoint = createModulePluginEndpoint({
          manifest: fakeProviderManifest,
          schemaHash: providerBinding.schemaHash,
          module: fakeProviderModule,
          broker: outerBroker,
        });
        const providerPluginExecutor = createProviderPluginExecutor({
          client: {
            listFunctionExports: async () => [
              {
                id: providerBinding.exportId,
                kind: "provider-executor",
                operations: ["submit", "poll"],
              },
            ],
            resolveBinding: async () => providerBinding,
            invoke: (_pluginId, invocation, options) =>
              providerEndpoint.invoke(invocation, options),
          },
        });
        return createLocalVideoEnhanceService({ providerPluginExecutor }).enhance(
          input,
        );
      },
    });

    // The Host transport for the outer `clash.video-enhance` plugin itself: the exact production
    // `ModulePluginEndpoint` bridging its real, built `plugin` module to the outer broker above.
    const videoEnhanceEndpoint = createModulePluginEndpoint({
      manifest: videoEnhanceManifest,
      schemaHash: videoEnhanceBinding.schemaHash,
      module: videoEnhancePlugin,
      broker: outerBroker,
    });

    const baseInvocation = {
      protocol: "clash.plugin.invoke/v1" as const,
      invocationId: randomUUID(),
      taskId: RUN_TASK_ID,
      projectId: "project-1",
      target: {
        pluginId: videoEnhanceBinding.pluginId,
        version: videoEnhanceBinding.version,
        exportId: videoEnhanceBinding.exportId,
        schemaHash: videoEnhanceBinding.schemaHash,
        kind: "action" as const,
      },
      input: {
        values: {
          modelId: "video-enhance-card",
          modelRoute: frozenRoute,
          modelParams: { scene: "common" },
          source: {
            projectAssetId: reference.asset.assetId,
            kind: "video",
            resourceHash: `sha256:${"c".repeat(64)}`,
          },
        },
        references: [reference],
      },
      assetInputs: [],
      actor: { kind: "agent" as const, id: "agent-1" },
    };

    // 1) submit -> accepted, forwarded verbatim through the real Host transport.
    const submitResult = await videoEnhanceEndpoint.invoke({
      ...baseInvocation,
      operation: "submit" as const,
    });
    expect(submitResult.status).toBe("accepted");
    expect(submitCalls).toBe(1);
    expect(calls()).toBe(0);
    if (submitResult.status !== "accepted") throw new Error("expected accepted");

    // 2) poll -> completed, with the Host-issued Asset handle the plugin never fabricated itself.
    const pollResult = await videoEnhanceEndpoint.invoke({
      ...baseInvocation,
      invocationId: randomUUID(),
      operation: "poll" as const,
      pollState: submitResult.pollState,
    });
    expect(pollResult.status).toBe("completed");
    if (pollResult.status !== "completed") throw new Error("expected completed");
    expect(pollResult.outputs).toEqual([
      {
        slot: "media",
        kind: "asset",
        asset: expect.objectContaining({ kind: "video", mediaType: "video/mp4" }),
      },
    ]);
    // Exactly one fetch of the Provider's URL, regardless of how many times this was polled.
    expect(calls()).toBe(1);

    const asset = pollResult.outputs[0]!.kind === "asset" ? pollResult.outputs[0]!.asset : undefined;
    expect(asset).toBeDefined();

    // 3) The real staging receipt: owned by the exact frozen Provider plugin/version/account,
    //    under this Run's own task and canonical output slot -- read back from the same
    //    production `LocalPluginAssetStagingStore` `openUploadSlot` wrote to, never recomputed.
    const stagedAssets = createLocalPluginAssetStagingStore({ dataDir });
    const staged = await stagedAssets.resolve({
      projectId: "project-1",
      projectAssetId: asset!.assetId,
    });
    expect(staged).toBeDefined();
    expect(staged!.pluginId).toBe(providerBinding.pluginId);
    expect(staged!.pluginVersion).toBe(providerBinding.version);
    expect(staged!.accountId).toBe("account-1");
    expect(staged!.slot).toBe(RUN_OUTPUT_SLOT);
    expect(staged!.taskId.length).toBeGreaterThan(0);
    expect(staged!.projection.byteLength).toBe(4);
  });
});
