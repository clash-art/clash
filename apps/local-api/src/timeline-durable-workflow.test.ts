import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  createProjectTimeline,
  listActionAssetBindingsForOwner,
  listProjectAssets,
  markActionAssetBindingAuthority,
  markProjectAssetAuthority,
  readProjectTimeline,
  requestTimelineRender,
  type ExecutablePluginResult,
} from "@clash/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import { createLocalDurableOutputStagingStore } from "./local-durable-output-staging.js";
import { createMockExternalAigcService } from "./local-aigc.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";

let dataDir = "";
const nodeRequire = createRequire(import.meta.url);

const inspectTestMedia: LocalAssetInspector = async ({ resource }) => {
  const contentType = resource.contentType
    ? { contentType: resource.contentType }
    : {};
  if (resource.kind === "video") {
    return {
      ...contentType,
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      durationMs: 1_000,
      frameRate: 30,
      videoCodec: "h264",
      hasAudio: false,
    };
  }
  if (resource.kind === "audio") {
    return {
      ...contentType,
      durationMs: 500,
      hasAudio: true,
      audioCodec: resource.contentType === "audio/wav" ? "pcm_s16le" : "mp3",
      sampleRate: 48_000,
      channelCount: 2,
      channelLayout: "stereo",
    };
  }
  if (resource.kind === "image") {
    return {
      ...contentType,
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
    };
  }
  return contentType;
};

function testAssetInspection() {
  return createLocalAssetInspectionService({
    dataDir,
    inspectResource: inspectTestMedia,
  });
}

async function recoverableIdentityForNode(
  nodeId: string,
): Promise<{ actionRunId: string; outputSlot: string }> {
  const runs = await createSqliteDurableRunJournal(dataDir).listRecoverable(
    "local-api",
    Number.MAX_SAFE_INTEGER,
  );
  const matches = runs.filter(
    (run) =>
      !!run.executorInput &&
      typeof run.executorInput === "object" &&
      !Array.isArray(run.executorInput) &&
      (run.executorInput as Record<string, unknown>).nodeId === nodeId,
  );
  expect(matches).toHaveLength(1);
  return {
    actionRunId: matches[0]!.actionRunId,
    outputSlot: matches[0]!.outputSlot,
  };
}

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = "";
});

function submittedTimelineRender(): {
  doc: LoroDoc;
  owner: {
    kind: "run";
    actionId: string;
    actionRevisionId: string;
    actionRunId: string;
  };
} {
  const doc = new LoroDoc();
  expect(
    createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Cut",
      state: {
        fps: 30,
        durationInFrames: 30,
        tracks: [
          {
            id: "titles",
            items: [
              {
                id: "title-1",
                type: "text",
                text: "Opening",
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
        ],
      },
    }),
  ).toMatchObject({ ok: true });
  const revisionId = readProjectTimeline(doc, "timeline-1")!.revisionId;
  expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
  const requested = requestTimelineRender(doc, {
    timelineId: "timeline-1",
    actorUserId: "user-1",
    generateId: () => "render-1",
  });
  if (!requested.ok) throw new Error(requested.error);
  expect(requested).toMatchObject({ ok: true, renderNodeId: "render-1" });
  return {
    doc,
    owner: {
      kind: "run",
      actionId: "timeline:timeline-1",
      actionRevisionId: revisionId,
      actionRunId: "timeline-render:render-1",
    },
  };
}

function remotionActionHarness() {
  const binding = {
    pluginId: "clash.remotion",
    version: "0.1.0",
    exportId: "render-timeline",
    schemaHash: `sha256:${"f".repeat(64)}` as const,
  };
  const staging = createLocalPluginAssetStagingStore({ dataDir });
  const complete = async (
    request: Record<string, any>,
  ): Promise<ExecutablePluginResult> => {
    const outputSlot = String(request.input.values.outputSlot);
    const invocationId = `${request.taskId}:remotion-test`;
    const staged = await staging.stage({
      projectId: request.projectId,
      taskId: request.taskId,
      slot: outputSlot,
      pluginId: binding.pluginId,
      pluginVersion: binding.version,
      invocationId,
      kind: "video",
      mediaType: "video/mp4",
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    });
    return {
      protocol: "clash.plugin.result/v1" as const,
      invocationId,
      status: "completed" as const,
      outputs: [
        {
          slot: outputSlot,
          kind: "asset" as const,
          asset: {
            assetId: staged.projectAssetId,
            uri: `clash-asset://${staged.projectAssetId}`,
            kind: "video" as const,
            mediaType: "video/mp4",
          },
        },
      ],
    };
  };
  const executablePluginAction = vi.fn(complete);
  return {
    binding,
    complete,
    executablePluginAction,
    resolvePluginBinding: vi.fn(async () => binding),
  };
}

function retryableRemotionFailure(message: string): ExecutablePluginResult {
  return {
    protocol: "clash.plugin.result/v1" as const,
    invocationId: "remotion-test-failure",
    status: "failed" as const,
    error: {
      code: "provider_unavailable" as const,
      message,
      retryable: true,
      requestState: "rejected" as const,
    },
  };
}

describe("Local durable Timeline render workflow", () => {
  it("refuses a legacy renderer when the bundled Remotion Action binding is unavailable", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-binding-required-"));
    const { doc } = submittedTimelineRender();
    let legacyRenderCalls = 0;

    const legacyOptions = {
      dataDir,
      assetInspection: testAssetInspection(),
      timelineRenderer: {
        async render() {
          legacyRenderCalls += 1;
          return {
            bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
            contentType: "video/mp4",
          };
        },
      },
    } as unknown as Parameters<typeof createLocalWorkflowProcessor>[0];

    await createLocalWorkflowProcessor(legacyOptions).process({
      doc,
      projectId: "project-1",
    });

    expect(legacyRenderCalls).toBe(0);
    expect(doc.getMap("nodes").get("render-1")).toMatchObject({
      data: {
        status: "failed",
        error:
          "Timeline rendering requires the clash.remotion bundled Action binding.",
      },
    });
  });

  it("runs a frozen Timeline render through the bundled Remotion Action contract", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-remotion-action-"));
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "asset:hero",
        kind: "image",
        source: {
          kind: "owned",
          resourceId: `sha256:${"b".repeat(64)}`,
        },
        lifecycle: { state: "active" },
        metadata: { contentType: "image/png" },
      }),
    ).toMatchObject({ ok: true });
    expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
    expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
    expect(
      createProjectTimeline(doc, {
        id: "timeline-media",
        name: "Media cut",
        state: {
          fps: 30,
          durationInFrames: 30,
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "hero",
                  type: "image",
                  assetId: "asset:hero",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    const requested = requestTimelineRender(doc, {
      timelineId: "timeline-media",
      actorUserId: "user-1",
      generateId: () => "render-plugin",
    });
    if (!requested.ok) throw new Error(requested.error);

    const binding = {
      pluginId: "clash.remotion",
      version: "0.1.0",
      exportId: "render-timeline",
      schemaHash: `sha256:${"a".repeat(64)}` as const,
    };
    const resolvePluginBinding = vi.fn(async () => binding);
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    const requests: Array<Record<string, any>> = [];
    const executablePluginAction = vi.fn(async (request) => {
      requests.push(structuredClone(request));
      expect(request.input.values.outputSlot).toBe("render:output");
      const staged = await staging.stage({
        projectId: request.projectId,
        taskId: request.taskId,
        slot: "render:output",
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
        invocationId: "remotion-invocation",
        kind: "video",
        mediaType: "video/mp4",
        bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      });
      return {
        protocol: "clash.plugin.result/v1" as const,
        invocationId: "remotion-invocation",
        status: "completed" as const,
        outputs: [
          {
            slot: "render:output",
            kind: "asset" as const,
            asset: {
              assetId: staged.projectAssetId,
              uri: `clash-asset://${staged.projectAssetId}`,
              kind: "video" as const,
              mediaType: "video/mp4",
            },
          },
        ],
      };
    });

    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction,
      resolvePluginBinding,
    } as Parameters<typeof createLocalWorkflowProcessor>[0] & {
      resolvePluginBinding: typeof resolvePluginBinding;
    }).process({ doc, projectId: "project-1", checkpoint: async () => {} });

    expect(resolvePluginBinding).toHaveBeenCalledWith(
      "clash.remotion",
      "render-timeline",
      "action",
    );
    expect(executablePluginAction).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      expect.objectContaining({
        binding,
        taskId: "timeline-render:render-plugin",
        projectId: "project-1",
        nodeId: "render-plugin",
        input: {
          values: expect.objectContaining({
            timeline: {
              name: "Media cut",
              owner: { kind: "project" },
              state: expect.objectContaining({
                tracks: expect.any(Array),
              }),
            },
          }),
          references: [
            {
              slot: "timeline:item:hero",
              index: 0,
              asset: {
                assetId: "asset:hero",
                uri: "clash-asset://asset:hero",
                kind: "image",
                mediaType: "image/png",
              },
            },
          ],
        },
      }),
    ]);
    expect(JSON.stringify(requests)).not.toMatch(
      /(?:executorUrl|providerUrl|storageKey|\/Users\/|\/tmp\/)/,
    );
    const completedRun = await createSqliteDurableRunJournal(dataDir).load({
      actionRunId: "timeline-render:render-plugin",
      outputSlot: "render:output",
    });
    expect(completedRun).toMatchObject({ phase: "succeeded" });
    expect(completedRun?.failure).toBeUndefined();
    expect(doc.getMap("nodes").get("render-plugin")).toMatchObject({
      data: { status: "completed", assetId: expect.any(String) },
    });
    expect(listProjectAssets(doc)).toContainEqual(
      expect.objectContaining({
        kind: "video",
        provenance: expect.objectContaining({
          kind: "render",
          actionRunId: "timeline-render:render-plugin",
        }),
      }),
    );
  });

  it("reuses the Timeline run's frozen Asset binding during durable plugin recovery", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-plugin-recovery-"));
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "asset:recovery-hero",
        kind: "image",
        source: {
          kind: "owned",
          resourceId: `sha256:${"c".repeat(64)}`,
        },
        lifecycle: { state: "active" },
        metadata: { contentType: "image/png" },
      }),
    ).toMatchObject({ ok: true });
    expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
    expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
    expect(
      createProjectTimeline(doc, {
        id: "timeline-recovery",
        name: "Recovery cut",
        state: {
          fps: 30,
          durationInFrames: 30,
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "hero",
                  type: "image",
                  assetId: "asset:recovery-hero",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    const requested = requestTimelineRender(doc, {
      timelineId: "timeline-recovery",
      actorUserId: "user-1",
      generateId: () => "render-recovery",
    });
    if (!requested.ok) throw new Error(requested.error);
    const owner = {
      kind: "run" as const,
      actionId: "timeline:timeline-recovery",
      actionRevisionId: readProjectTimeline(doc, "timeline-recovery")!
        .revisionId,
      actionRunId: "timeline-render:render-recovery",
    };
    let now = 100;
    const executablePluginAction = vi.fn(async () => ({
      protocol: "clash.plugin.result/v1" as const,
      invocationId: "remotion-recovery-invocation",
      status: "failed" as const,
      error: {
        code: "provider_unavailable" as const,
        message: "transient bundled renderer restart",
        retryable: true,
        requestState: "rejected" as const,
      },
    }));
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction,
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now,
        async providerPluginExecutor() {
          throw new Error(
            "Provider execution is not used by the Remotion Action",
          );
        },
      },
      resolvePluginBinding: async () => ({
        pluginId: "clash.remotion",
        version: "0.1.0",
        exportId: "render-timeline",
        schemaHash: `sha256:${"d".repeat(64)}`,
      }),
    });

    await processor.process({
      doc,
      projectId: "project-1",
      checkpoint: async () => {},
    });
    now = 1_101;
    await processor.process({
      doc,
      projectId: "project-1",
      checkpoint: async () => {},
    });

    expect(executablePluginAction).toHaveBeenCalledTimes(2);
    expect(
      listActionAssetBindingsForOwner(doc, owner)
        .filter((binding) => binding.direction === "input")
        .map((binding) => ({
          slot: binding.slot,
          projectAssetId: binding.projectAssetId,
        })),
    ).toEqual([
      {
        slot: "timeline:item:hero",
        projectAssetId: "asset:recovery-hero",
      },
    ]);
  });

  it("publishes the render output through the shared durable journal identity", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-durable-"));
    const { doc, owner } = submittedTimelineRender();
    const remotion = remotionActionHarness();
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
    });

    await processor.process({ doc, projectId: "project-1" });

    const run = await createSqliteDurableRunJournal(dataDir).load({
      actionRunId: owner.actionRunId,
      outputSlot: "render:output",
    });
    expect(run?.failure).toBeUndefined();
    expect(run).toMatchObject({
      actionRunId: owner.actionRunId,
      outputSlot: "render:output",
      phase: "succeeded",
      projectedAt: expect.any(Number),
    });
    const outputBindings = listActionAssetBindingsForOwner(doc, owner).filter(
      (binding) => binding.direction === "output",
    );
    expect(outputBindings).toEqual([
      expect.objectContaining({
        slot: "render:output",
        projectAssetId: expect.any(String),
      }),
    ]);
    expect(listProjectAssets(doc)).toEqual([
      expect.objectContaining({
        id: outputBindings[0]!.projectAssetId,
        source: {
          kind: "owned",
          resourceId: expect.stringMatching(/^sha256:/),
        },
        provenance: {
          kind: "render",
          actionRunId: owner.actionRunId,
          model: "remotion-render",
          prompt: "Render Timeline timeline-1",
        },
      }),
    ]);
    expect(doc.getMap("nodes").get("render-1")).toMatchObject({
      data: {
        status: "completed",
        assetId: outputBindings[0]!.projectAssetId,
      },
    });
  });

  it("recovers publication after restart without invoking the renderer again", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-restart-"));
    const { doc, owner } = submittedTimelineRender();
    let now = 100;
    const remotion = remotionActionHarness();
    const durableProviderRuns = {
      ownerId: "local-api",
      now: () => now,
      providerPluginExecutor: vi.fn(async () => {
        throw new Error("Provider adapter must not run for Timeline render");
      }),
    };
    let checkpoints = 0;
    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns,
    }).process({
      doc,
      projectId: "project-1",
      async checkpoint() {
        checkpoints += 1;
        if (checkpoints === 2) throw new Error("snapshot acknowledgement lost");
      },
    });

    const journal = createSqliteDurableRunJournal(dataDir);
    await expect(
      journal.load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({ phase: "finalizing", nextAttemptAt: 1_100 });
    expect(remotion.executablePluginAction).toHaveBeenCalledOnce();

    now = 1_100;
    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns,
    }).process({ doc, projectId: "project-1", checkpoint: async () => {} });

    await expect(
      journal.load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({ phase: "succeeded", projectedAt: 1_100 });
    expect(remotion.executablePluginAction).toHaveBeenCalledOnce();
  });

  it("does not publish a recovered staged entry after its versioned inspection receipt is lost", async () => {
    dataDir = await mkdtemp(
      join(tmpdir(), "clash-timeline-inspection-recovery-"),
    );
    const { doc, owner } = submittedTimelineRender();
    let now = 100;
    const remotion = remotionActionHarness();
    const durableProviderRuns = {
      ownerId: "local-api",
      now: () => now,
      providerPluginExecutor: vi.fn(async () => {
        throw new Error("Provider adapter must not run for Timeline render");
      }),
    };
    let checkpoints = 0;
    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns,
    }).process({
      doc,
      projectId: "project-1",
      async checkpoint() {
        checkpoints += 1;
        if (checkpoints === 2) throw new Error("snapshot acknowledgement lost");
      },
    });

    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const database = new DatabaseSync(join(dataDir, "local.sqlite"));
    database.exec("DELETE FROM local_asset_inspections");
    database.close();

    const recovered = submittedTimelineRender().doc;
    now = 1_100;
    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: createLocalAssetInspectionService({ dataDir }),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns,
    }).process({ doc: recovered, projectId: "project-1" });

    expect(listProjectAssets(recovered)).toEqual([]);
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({
      phase: "finalizing",
      failure: { retryable: true },
    });
    expect(remotion.executablePluginAction).toHaveBeenCalledOnce();
  });

  it("retries a transient Host-local renderer failure through the shared policy", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-retry-"));
    const { doc, owner } = submittedTimelineRender();
    let now = 100;
    const remotion = remotionActionHarness();
    remotion.executablePluginAction
      .mockResolvedValueOnce(retryableRemotionFailure("renderer worker exited"))
      .mockImplementation(remotion.complete);
    const durableProviderRuns = {
      ownerId: "local-api",
      now: () => now,
      providerPluginExecutor: vi.fn(async () => {
        throw new Error("Provider adapter must not run for Timeline render");
      }),
    };
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns,
      providerPollDelayCapMs: 0,
    });

    await processor.process({ doc, projectId: "project-1" });
    now = 1_100;
    await processor.process({ doc, projectId: "project-1" });

    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({ phase: "succeeded" });
    expect(remotion.executablePluginAction).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight Timeline render out of generic video generation while its durable retry waits", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-retry-owner-"));
    const { doc, owner } = submittedTimelineRender();
    let now = 100;
    const remotion = remotionActionHarness();
    remotion.executablePluginAction.mockResolvedValue(
      retryableRemotionFailure("Remotion media fetch timed out"),
    );
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now,
        async providerPluginExecutor() {
          throw new Error("mock-video reached no provider");
        },
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    await processor.process({ doc, projectId: "project-1" });

    expect(doc.getMap("nodes").get("render-1")).toMatchObject({
      data: { status: "generating" },
    });
    expect(
      (doc.getMap("nodes").get("render-1") as any).data.error,
    ).toBeUndefined();
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({
      phase: "submitting",
      failure: { message: "Remotion media fetch timed out" },
    });
  });

  it("fails malformed Timeline render ownership without handing the node to generic video generation", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-invalid-owner-"));
    const doc = new LoroDoc();
    doc.getMap("nodes").set("render-invalid-owner", {
      type: "video",
      data: {
        status: "generating",
        timelineDsl: {
          fps: 30,
          durationInFrames: 30,
          tracks: [],
        },
        sourceTimelineActionId: "timeline:missing",
        sourceTimelineRevisionId: "timeline-revision-v1:missing",
        actionType: "video-gen",
        modelId: "test-video",
        prompt: "This generic request must never be planned",
      },
    });
    const providerPluginExecutor = vi.fn(async () => {
      throw new Error("generic video provider must not own Timeline renders");
    });

    await createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      aigc: {
        async planProviderPlugin() {
          return {
            binding: {
              pluginId: "test.provider",
              version: "1.0.0",
              exportId: "execute",
              schemaHash: `sha256:${"e".repeat(64)}`,
            },
            accountId: "private-account",
            assetInputs: [],
            kind: "video",
            projectId: "project-1",
            nodeId: "render-invalid-owner",
            provider: "test-provider",
            modelEndpoint: "video-v1",
            input: {
              values: {
                modelId: "test-video",
                upstreamModel: "video-v1",
                prompt: "This generic request must never be planned",
                modelParams: {},
              },
              references: [],
            },
          };
        },
        generateImage: vi.fn(),
        generateVideo: vi.fn(),
        generateAudio: vi.fn(),
        generateText: vi.fn(),
      },
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor,
      },
    }).process({ doc, projectId: "project-1" });

    expect(providerPluginExecutor).not.toHaveBeenCalled();
    expect(doc.getMap("nodes").get("render-invalid-owner")).toMatchObject({
      data: {
        status: "failed",
        errorCode: "TIMELINE_RENDER_INPUT_INVALID",
      },
    });
  });

  it("keeps the real Remotion terminal failure owner-private without creating a generic video run", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-real-failure-"));
    const { doc, owner } = submittedTimelineRender();
    let now = 100;
    const remotion = remotionActionHarness();
    remotion.executablePluginAction.mockResolvedValue(
      retryableRemotionFailure("Remotion media fetch timed out"),
    );
    const processor = createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      executablePluginAction: remotion.executablePluginAction,
      resolvePluginBinding: remotion.resolvePluginBinding,
      durableProviderRuns: {
        ownerId: "local-api",
        now: () => now,
        async providerPluginExecutor() {
          throw new Error("mock-video reached no provider");
        },
      },
    });

    await processor.process({ doc, projectId: "project-1" });
    for (const retryAt of [1_100, 3_100, 7_100]) {
      now = retryAt;
      await processor.process({ doc, projectId: "project-1" });
    }

    expect(doc.getMap("nodes").get("render-1")).toMatchObject({
      data: {
        status: "failed",
        errorCode: "provider_unavailable",
        error:
          "Generation failed. See the owning Host for private diagnostics.",
      },
    });
    await expect(
      createSqliteDurableRunJournal(dataDir).load({
        actionRunId: owner.actionRunId,
        outputSlot: "render:output",
      }),
    ).resolves.toMatchObject({
      phase: "failed",
      projectedAt: 7_100,
      failure: { message: "Remotion media fetch timed out" },
    });
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): {
          get(...params: unknown[]): Record<string, unknown> | undefined;
        };
        close(): void;
      };
    };
    const database = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM durable_run_journal WHERE owner_id = ?",
          )
          .get("local-api"),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("keeps the first CAS output when an at-least-once renderer returns different bytes", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-timeline-output-cas-"));
    const staging = createLocalDurableOutputStagingStore({ dataDir });
    const firstBytes = new TextEncoder().encode("first complete render");
    const secondBytes = new TextEncoder().encode("different retry render");
    const identity = {
      projectId: "project-1",
      actionRunId: "timeline-render:render-1",
      outputSlot: "render:output",
      kind: "video" as const,
      contentType: "video/mp4",
    };

    const first = await staging.stage({ ...identity, bytes: firstBytes });
    const sameReplay = await staging.stage({ ...identity, bytes: firstBytes });
    const replay = await staging.stage({ ...identity, bytes: secondBytes });

    const expectedDigest = createHash("sha256")
      .update(firstBytes)
      .digest("hex");
    expect(sameReplay.projectAssetId).toBe(first.projectAssetId);
    expect(first.projectAssetId).toBe(replay.projectAssetId);
    expect(replay.projection.digest).toBe(expectedDigest);
  });
});

describe("Local executor generation uses the shared durable graph", () => {
  it("journals local-acp text before publishing the completed node", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-local-acp-durable-"));
    const doc = new LoroDoc();
    doc.getMap("nodes").set("text-1", {
      type: "text",
      data: {
        status: "pending",
        actionType: "text-gen",
        modelId: "local-acp",
        prompt: "Write a title",
      },
    });
    const generate = vi.fn(async () => ({
      text: "A durable title",
      provider: "local-acp",
      modelEndpoint: "codex-acp",
    }));

    const processor = createLocalWorkflowProcessor({
      dataDir,
      textAgent: { generate },
    });
    await processor.process({
      doc,
      projectId: "project-1",
      checkpoint: async () => {
        throw new Error("pause after the frozen journal commit");
      },
    });
    const identity = await recoverableIdentityForNode("text-1");
    await processor.process({ doc, projectId: "project-1" });

    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "succeeded",
      projectedAt: expect.any(Number),
    });
    expect(doc.getMap("nodes").get("text-1")).toMatchObject({
      data: {
        status: "completed",
        content: "A durable title",
        provider: "local-acp",
        modelEndpoint: "codex-acp",
      },
    });
  });

  it("retries the frozen local text executor without invoking a fallback executor", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-local-acp-retry-"));
    const doc = new LoroDoc();
    doc.getMap("nodes").set("text-1", {
      type: "text",
      data: {
        status: "pending",
        actionType: "text-gen",
        modelId: "local-acp",
        prompt: "Write a title",
      },
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("local ACP result is unknown"))
      .mockResolvedValueOnce({
        text: "Recovered durable title",
        provider: "local-acp",
        modelEndpoint: "codex-acp",
      });
    const generateText = vi.fn(async () => ({
      text: "Wrong fallback title",
      provider: "fallback-provider",
      modelEndpoint: "fallback-model",
    }));
    const aigc = { ...createMockExternalAigcService(), generateText };
    let now = 100;
    const durableProviderRuns = {
      ownerId: "local-api",
      now: () => now,
      providerPluginExecutor: vi.fn(async () => {
        throw new Error("Provider adapter must not run for local-acp text");
      }),
    };
    const journal = createSqliteDurableRunJournal(dataDir);

    await createLocalWorkflowProcessor({
      dataDir,
      aigc,
      textAgent: { generate },
      durableProviderRuns,
    }).process({ doc, projectId: "project-1" });

    expect(generate).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
    const identity = await recoverableIdentityForNode("text-1");
    const firstFailure = await journal.load(identity);
    expect(firstFailure).toMatchObject({
      phase: "submitting",
      failure: {
        retryable: true,
        requestState: "unknown",
      },
      nextAttemptAt: expect.any(Number),
    });

    now = firstFailure!.nextAttemptAt!;
    await createLocalWorkflowProcessor({
      dataDir,
      aigc,
      durableProviderRuns,
    }).process({ doc, projectId: "project-1" });

    expect(generateText).not.toHaveBeenCalled();
    const unavailableFailure = await journal.load(identity);
    expect(unavailableFailure).toMatchObject({
      phase: "submitting",
      failure: {
        code: "plugin_unavailable",
        retryable: true,
        requestState: "unknown",
      },
      nextAttemptAt: expect.any(Number),
    });

    now = unavailableFailure!.nextAttemptAt!;
    await createLocalWorkflowProcessor({
      dataDir,
      aigc,
      textAgent: { generate },
      durableProviderRuns,
    }).process({ doc, projectId: "project-1" });

    await expect(journal.load(identity)).resolves.toMatchObject({
      phase: "succeeded",
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generateText).not.toHaveBeenCalled();
    expect(doc.getMap("nodes").get("text-1")).toMatchObject({
      data: {
        status: "completed",
        content: "Recovered durable title",
        provider: "local-acp",
        modelEndpoint: "codex-acp",
      },
    });
  });

  it("journals the built-in local-tts adapter before publishing audio", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-local-tts-durable-"));
    const doc = new LoroDoc();
    doc.getMap("nodes").set("audio-1", {
      type: "audio",
      data: {
        status: "pending",
        actionType: "audio-gen",
        modelId: "kokoro-82m-tts",
        prompt: "Hello",
      },
    });
    const localTts = vi.fn(async () => ({
      bytes: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]),
      contentType: "audio/wav",
      durationMs: 500,
      provider: "local",
      modelEndpoint: "mlx-community/Kokoro-82M-4bit",
    }));
    const aigc = createMockExternalAigcService({ localTts });

    const processor = createLocalWorkflowProcessor({
      dataDir,
      aigc,
      assetInspection: testAssetInspection(),
    });
    await processor.process({
      doc,
      projectId: "project-1",
      checkpoint: async () => {
        throw new Error("pause after the frozen journal commit");
      },
    });
    const identity = await recoverableIdentityForNode("audio-1");
    await processor.process({ doc, projectId: "project-1" });

    await expect(
      createSqliteDurableRunJournal(dataDir).load(identity),
    ).resolves.toMatchObject({
      phase: "succeeded",
      projectedAt: expect.any(Number),
    });
    expect(localTts).toHaveBeenCalledWith(
      expect.objectContaining({ model: "mlx-community/Kokoro-82M-4bit" }),
    );
    expect(doc.getMap("nodes").get("audio-1")).toMatchObject({
      data: { status: "completed", assetId: expect.any(String) },
    });
  });
});
