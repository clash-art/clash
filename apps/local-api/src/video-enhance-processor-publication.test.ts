import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import {
  createProjectGenerator,
  ensureActionRunRequest,
  readOutputCommit,
  readProjectActionRun,
  readProjectAsset,
  type ActionRunModelRoute,
  type ActionRunRequest,
} from "@clash/shared-types";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDurableRun,
  type LocalDurableRunCreateCommand,
} from "./durable-run-coordinator.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalAssetInspectionService } from "./local-asset-inspections.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";

/**
 * The real processor-side publication boundary for the generic `clash.video-enhance` Generator
 * Action: a completed Action output names only a Host-issued Asset handle, and the processor's
 * own `expectedProviderReceiptOwner` check (exercised here through `createLocalWorkflowProcessor`,
 * never recomputed by this test) decides whether the staging receipt behind that handle is allowed
 * to publish.
 *
 * `frozen.input.values.modelRoute` is what makes this a *generic model-consumer* Action rather
 * than a plain custom Action: because `targetKind: "generator-action"` and `modelRoute` carries an
 * `executorBinding`, the processor requires the receipt to be owned by that frozen Provider
 * executor plugin/version/account -- never by `clash.video-enhance` itself, and never by a Provider
 * plugin/version/account/slot the Run did not freeze.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clash-video-enhance-processor-"));
  temporaryDirectories.push(path);
  return path;
}

const videoEnhanceBinding = {
  pluginId: "clash.video-enhance",
  version: "0.1.0",
  exportId: "enhance",
  schemaHash: `sha256:${"b".repeat(64)}`,
} as const;

const providerBinding = {
  pluginId: "clash.fake-provider",
  version: "1.0.0",
  exportId: "fake-provider-execute",
  schemaHash: `sha256:${"a".repeat(64)}` as const,
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

function request(actionRunId: string): ActionRunRequest {
  return {
    actionRunId,
    generatorRevision: {
      generatorId: "video-enhance-1",
      generatorRevisionId: "video-enhance-rev-1",
    },
    actionId: "enhance",
    executor: videoEnhanceBinding,
    invocationFingerprint: `sha256:${"d".repeat(64)}`,
    parameters: { modelId: "video-enhance-card", modelRoute: frozenRoute },
    invocationInputRefs: [],
    outputContract: [
      {
        slot: "media",
        assetType: { kind: "media", mediaKind: "video" },
        cardinality: { minItems: 1, maxItems: 1 },
      },
    ],
  };
}

function command(actionRunId: string, now: number, providerExecution = false): LocalDurableRunCreateCommand {
  const run = request(actionRunId);
  return {
    type: "create",
    actionRunId,
    outputSlot: "media",
    deadlineAt: now + 60_000,
    executor: {
      targetKind: "generator-action",
      binding: videoEnhanceBinding,
      ...(providerExecution ? { providerExecution: {
        binding: providerBinding,
        accountId: "account-1",
        assetInputs: [],
        input: { values: {}, references: [] },
      } } : {}),
      actionId: "enhance",
      actor: { kind: "system", id: "local-api" },
      publicOwner: {
        actionId: "video-enhance-1",
        actionRevisionId: "video-enhance-rev-1",
      },
      generatorOutputContract: run.outputContract,
      kind: "video",
      projectId: "project-1",
      delivery: {
        kind: "project-asset",
        actionId: "video-enhance-1",
        name: "enhanced.mp4",
      },
      input: {
        values: {
          modelId: "video-enhance-card",
          ...(providerExecution ? {} : { modelRoute: frozenRoute }),
          modelParams: {},
        },
        references: [],
      },
    },
  };
}

function projectDoc(actionRunId: string): LoroDoc {
  const doc = new LoroDoc();
  const generator = createProjectGenerator(doc, {
    head: { id: "video-enhance-1", headRevisionId: "video-enhance-rev-1" },
    revision: {
      id: "video-enhance-rev-1",
      generatorId: "video-enhance-1",
      definitionRef: {
        pluginId: videoEnhanceBinding.pluginId,
        definitionId: "video-enhance",
        version: videoEnhanceBinding.version,
        schemaHash: videoEnhanceBinding.schemaHash,
      },
      state: {},
      persistentInputRefs: [],
    },
  });
  if (!generator.ok) throw new Error(generator.error.message);
  const run = ensureActionRunRequest(doc, request(actionRunId));
  if (!run.ok) throw new Error(run.error.message);
  return doc;
}

function videoInspection(directory: string) {
  return createLocalAssetInspectionService({
    dataDir: directory,
    inspectResource: async ({ resource }) => ({
      contentType: resource.contentType ?? "video/mp4",
      width: 1,
      height: 1,
      rotationDegrees: 0,
      durationMs: 1_000,
      frameRate: 24,
      videoCodec: "test-video",
      hasAudio: false,
    }),
  });
}

async function buildProcessor(
  directory: string,
  assetHandle: {
    assetId: string;
    uri: string;
    kind: "video";
    mediaType: string;
  },
  now: () => number,
  providerExecution = false,
) {
  return createLocalWorkflowProcessor({
    dataDir: directory,
    assetInspection: videoInspection(directory),
    executablePluginAction: async () => ({
      protocol: "clash.plugin.result/v1",
      invocationId: "video-enhance-result",
      status: "completed",
      outputs: [
        {
          slot: "media",
          kind: "asset",
          asset: assetHandle,
        },
      ],
    }),
    durableProviderRuns: {
      ownerId: "host-1",
      providerPluginExecutor: async () => {
        if (providerExecution) return { status: "completed", binding: providerBinding, media: assetHandle };
        throw new Error(
          "Generator Actions must dispatch through executablePluginAction, not Provider execution.",
        );
      },
      now,
    },
    providerPollDelayCapMs: 0,
  });
}

describe("clash.video-enhance real processor publication boundary", () => {
  it.each([false, true])("publishes an immutable Project Asset and OutputCommit from its frozen Provider receipt (direct execution: %s)", async (providerExecution) => {
    const actionRunId = "run-video-enhance-publish-1";
    const directory = await dataDir();
    const doc = projectDoc(actionRunId);
    const journal = createSqliteDurableRunJournal(directory);
    const now = { value: 1_000 };
    const creation = command(actionRunId, now.value, providerExecution);
    await createLocalDurableRun({
      ownerId: "host-1",
      journal,
      clock: { now: () => now.value },
      command: creation,
    });
    // The exact frozen Provider executor plugin/version/account, under this Run's own task and
    // canonical output slot -- the only receipt shape `expectedProviderReceiptOwner` accepts for a
    // generic model-consumer Generator Action whose route carries an `executorBinding`.
    const staged = await createLocalPluginAssetStagingStore({
      dataDir: directory,
    }).stage({
      projectId: "project-1",
      taskId: providerExecution ? `${actionRunId}:media` : actionRunId,
      slot: "media",
      pluginId: providerBinding.pluginId,
      pluginVersion: providerBinding.version,
      accountId: "account-1",
      invocationId: "fake-provider-result",
      kind: "video",
      mediaType: "video/mp4",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    const processor = await buildProcessor(
      directory,
      {
        assetId: staged.projectAssetId,
        uri: `clash-asset://${staged.projectAssetId}`,
        kind: "video",
        mediaType: "video/mp4",
      },
      () => now.value,
      providerExecution,
    );

    await processor.process({
      doc,
      projectId: "project-1",
      checkpoint: async () => undefined,
    });

    expect(readProjectActionRun(doc, actionRunId)?.status).toBe("succeeded");
    expect(
      readOutputCommit(doc, { actionRunId, outputSlot: "media" }),
    ).toEqual({
      actionRunId,
      outputSlot: "media",
      asset: { kind: "media", projectAssetId: staged.projectAssetId },
    });
    expect(readProjectAsset(doc, staged.projectAssetId)).toMatchObject({
      id: staged.projectAssetId,
      kind: "video",
      lifecycle: { state: "active" },
      source: { kind: "owned", resourceId: staged.resourceId },
    });
    expect(
      await journal.load({ actionRunId, outputSlot: "media" }),
    ).toMatchObject({ phase: "succeeded", projectedAt: expect.any(Number) });
  });

  it.each(([
    [
      "a wrong Provider plugin",
      {
        pluginId: "clash.impostor-provider",
        pluginVersion: providerBinding.version,
        accountId: "account-1",
        slot: "media",
      },
    ],
    [
      "a wrong Provider version",
      {
        pluginId: providerBinding.pluginId,
        pluginVersion: "9.9.9",
        accountId: "account-1",
        slot: "media",
      },
    ],
    [
      "a wrong Provider account",
      {
        pluginId: providerBinding.pluginId,
        pluginVersion: providerBinding.version,
        accountId: "someone-elses-account",
        slot: "media",
      },
    ],
    [
      "a wrong output slot",
      {
        pluginId: providerBinding.pluginId,
        pluginVersion: providerBinding.version,
        accountId: "account-1",
        slot: "video",
      },
    ],
  ] as const).flatMap(([label, drift]) => [false, true].map((direct) => ({ label, drift, direct }))))(
    "rejects a receipt staged under $label through the real processor (direct: $direct)",
    async ({ drift, direct }) => {
      const actionRunId = `run-video-enhance-reject-${drift.pluginId}-${drift.pluginVersion}-${drift.accountId}-${drift.slot}`;
      const directory = await dataDir();
      const doc = projectDoc(actionRunId);
      const journal = createSqliteDurableRunJournal(directory);
      const now = { value: 1_000 };
      await createLocalDurableRun({
        ownerId: "host-1",
        journal,
        clock: { now: () => now.value },
        command: command(actionRunId, now.value, direct),
      });
      const staged = await createLocalPluginAssetStagingStore({
        dataDir: directory,
      }).stage({
        projectId: "project-1",
        taskId: direct ? `${actionRunId}:media` : actionRunId,
        slot: drift.slot,
        pluginId: drift.pluginId,
        pluginVersion: drift.pluginVersion,
        accountId: drift.accountId,
        invocationId: "drifted-provider-result",
        kind: "video",
        mediaType: "video/mp4",
        bytes: new Uint8Array([9, 9, 9, 9]),
      });

      const processor = await buildProcessor(
        directory,
        {
          assetId: staged.projectAssetId,
          uri: `clash-asset://${staged.projectAssetId}`,
          kind: "video",
          mediaType: "video/mp4",
        },
        () => now.value,
        direct,
      );

      await processor.process({
        doc,
        projectId: "project-1",
        checkpoint: async () => undefined,
      });
      expect(readProjectActionRun(doc, actionRunId)?.status).toBe("running");
      expect(
        readOutputCommit(doc, { actionRunId, outputSlot: "media" }),
      ).toBeNull();
      expect(readProjectAsset(doc, staged.projectAssetId)).toBeNull();
      // The real processor's own receipt-ownership check rejected this exact attempt -- nothing
      // here recomputes plugin/version/account/slot equality by hand. Checked right after the
      // first process() call, before the run is later abandoned on its own deadline, so this
      // assertion is about the ownership rejection itself, not about deadline handling.
      await expect(
        journal.load({ actionRunId, outputSlot: "media" }),
      ).resolves.toMatchObject({
        phase: "finalizing",
        failure: {
          code: "output_persistence_failed",
          message:
            "Durable Provider media output staging receipt is not owned by the frozen run and binding.",
          retryable: true,
          requestState: "accepted",
        },
      });

      // Separately: since this receipt can never become valid, the real engine's own
      // deadline-exceeded policy is what eventually gives up and marks the run terminally failed --
      // no different from how any other permanently-failing publish reaches "failed" in production.
      now.value += 61_000;
      await processor.process({
        doc,
        projectId: "project-1",
        checkpoint: async () => undefined,
      });

      expect(readProjectActionRun(doc, actionRunId)?.status).toBe("failed");
      expect(
        readOutputCommit(doc, { actionRunId, outputSlot: "media" }),
      ).toBeNull();
      expect(readProjectAsset(doc, staged.projectAssetId)).toBeNull();
      await expect(
        journal.load({ actionRunId, outputSlot: "media" }),
      ).resolves.toMatchObject({
        phase: "failed",
        failure: {
          code: "deadline_exceeded",
          message:
            "The generation lifetime expired before the durable run reached a terminal state.",
          retryable: false,
          requestState: "accepted",
        },
      });
    },
  );
});
