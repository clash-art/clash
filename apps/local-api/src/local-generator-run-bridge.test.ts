import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { createBoundedRetryPolicy } from "@clash/shared-runtime";
import {
  commitActionRunOutcome,
  createProjectAsset,
  createProjectGenerator,
  readDocumentAssetRevision,
  readDocumentAttachment,
  ensureActionRunRequest,
  markActionRunStarted,
  readActionAssetBinding,
  readOutputCommit,
  readProjectAsset,
  readProjectActionRun,
  readProjectDocumentAsset,
  type ActionAssetBinding,
  type ActionRunRequest,
  type ProjectAssetEntry,
} from "@clash/shared-types";
import type { LocalDurableRunCreateCommand } from "./durable-run-coordinator.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import {
  createLocalDurableRun,
  createLocalDurableRunCoordinator,
} from "./durable-run-coordinator.js";
import { createLocalGeneratorRunBridge } from "./local-generator-run-bridge.js";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clash-generator-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const definitionRef = {
  pluginId: "clash.stage",
  definitionId: "director-stage",
  version: "1.0.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
} as const;

function projectDoc(): LoroDoc {
  const doc = new LoroDoc();
  const created = createProjectGenerator(doc, {
    head: { id: "stage-1", headRevisionId: "stage-rev-1" },
    revision: {
      id: "stage-rev-1",
      generatorId: "stage-1",
      definitionRef,
      state: { scene: "courtyard" },
      persistentInputRefs: [],
    },
  });
  if (!created.ok) throw new Error(created.error.message);
  return doc;
}

function request(actionRunId = "run-stage-1"): ActionRunRequest {
  return {
    actionRunId,
    generatorRevision: {
      generatorId: "stage-1",
      generatorRevisionId: "stage-rev-1",
    },
    actionId: "render-still",
    executor: {
      pluginId: "clash.stage",
      version: "1.0.0",
      exportId: "render-still",
      schemaHash: `sha256:${"a".repeat(64)}`,
    },
    invocationFingerprint: `sha256:${"d".repeat(64)}`,
    parameters: { prompt: "a quiet courtyard" },
    invocationInputRefs: [],
    outputContract: [
      {
        slot: "image",
        assetType: { kind: "media", mediaKind: "image" },
        cardinality: { minItems: 1, maxItems: 1 },
      },
    ],
  };
}

function durableCommand(actionRunId = "run-stage-1") {
  return {
    type: "create" as const,
    actionRunId,
    outputSlot: "image",
    deadlineAt: Date.now() + 60_000,
    executor: {
      targetKind: "generator-action" as const,
      binding: {
        pluginId: "clash.stage",
        version: "1.0.0",
        exportId: "render-still",
        schemaHash: `sha256:${"a".repeat(64)}`,
      },
      accountId: "owner-private-account",
      actionId: "render-still",
      actor: { kind: "system" as const, id: "local-api" },
      publicOwner: {
        actionId: "stage-1",
        actionRevisionId: "stage-rev-1",
      },
      generatorOutputContract: request(actionRunId).outputContract,
      kind: "image" as const,
      projectId: "project-1",
      delivery: {
        kind: "project-asset" as const,
        actionId: "stage-1",
        name: "courtyard.png",
      },
      input: {
        values: { prompt: "a quiet courtyard" },
        references: [],
      },
    },
  };
}

function generatorActionCommand(actionRunId = "run-stage-1") {
  return durableCommand(actionRunId);
}

function generatedAsset(id = "asset-courtyard"): ProjectAssetEntry {
  return {
    id,
    kind: "image",
    source: {
      kind: "owned",
      resourceId: `sha256:${"c".repeat(64)}`,
    },
    lifecycle: { state: "active" },
    name: "courtyard.png",
    metadata: { bytes: 42, contentType: "image/png" },
    provenance: { kind: "generation", actionRunId: "run-stage-1" },
  };
}

function legacyOutputBinding(
  projectAssetId = "asset-courtyard",
): ActionAssetBinding {
  return {
    id: "action-asset:run-stage-1:image:output",
    owner: {
      kind: "run",
      actionId: "stage-1",
      actionRevisionId: "stage-rev-1",
      actionRunId: "run-stage-1",
    },
    direction: "output",
    slot: "image",
    projectAssetId,
    role: "primary",
  };
}

describe("Local Generator Run bridge", () => {
  it.each(["completed", "wrong-kind", "binding-drift"] as const)(
    "keeps a Provider-backed Generator Run authoritative across restart: %s",
    async (outcome) => {
      const doc = projectDoc();
      const dataDir = await temporaryDataDir();
      const journal = createSqliteDurableRunJournal(dataDir);
      const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal });
      const providerBinding = {
        pluginId: "vendor.media",
        version: "2.0.0",
        exportId: "execute",
        schemaHash: `sha256:${"b".repeat(64)}`,
      };
      const providerInput = {
        values: { modelId: "image-model", prompt: "a quiet courtyard", resolution: "768P" },
        references: [],
      };
      const command: LocalDurableRunCreateCommand = {
        ...durableCommand(),
        executor: {
          ...durableCommand().executor,
          providerExecution: {
            binding: providerBinding,
            accountId: "private-provider-account",
            assetInputs: [],
            input: providerInput,
          },
        },
      };
      await bridge.enqueue({ doc, request: request(), command, checkpoint: async () => undefined });
      const identity = { actionRunId: command.actionRunId, outputSlot: command.outputSlot };
      let acceptedTaskId: string | undefined;
      const coordinator = (restarted: boolean) => createLocalDurableRunCoordinator({
        ownerId: "host-1",
        journal: createSqliteDurableRunJournal(dataDir),
        retryPolicy: createBoundedRetryPolicy({
          maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
          baseDelayMs: 0,
          maxDelayMs: 0,
        }),
        providerPluginExecutor: async (invocation) => {
          expect(invocation.binding).toEqual(providerBinding);
          expect(invocation.input).toEqual(providerInput);
          expect(invocation.accountId).toBe("private-provider-account");
          if (!restarted) {
            acceptedTaskId = invocation.taskId;
            return { status: "accepted", binding: providerBinding,
              pollState: { upstreamTaskId: "accepted-once" }, retryAfterMs: 0 };
          }
          expect(invocation.taskId).toBe(acceptedTaskId);
          expect(invocation.pollState).toEqual({ upstreamTaskId: "accepted-once" });
          return {
            status: "completed",
            binding: outcome === "binding-drift" ? { ...providerBinding, version: "3.0.0" } : providerBinding,
            media: { assetId: "asset-courtyard", uri: "clash-asset://asset-courtyard",
              kind: outcome === "wrong-kind" ? "video" : "image", mediaType: "image/png" },
          };
        },
        executablePluginAction: async () => { throw new Error("The selected Provider must execute this Run."); },
        outputStore: {
          async stage() { return { kind: "asset", projectAsset: generatedAsset() }; },
        },
        publisher: {
          async publish({ run }) {
            await bridge.publishMediaSuccess({ doc, actionRunId: run.actionRunId,
              outputSlot: run.outputSlot, entry: generatedAsset(), checkpoint: async () => undefined });
          },
          async publishFailure({ run }) {
            await bridge.publishFailure({ doc, actionRunId: run.actionRunId, checkpoint: async () => undefined });
          },
        },
      });
      const first = coordinator(false);
      await first.coordinate({ type: "advance", identity });
      await first.coordinate({ type: "advance", identity });
      expect(await journal.load(identity)).toMatchObject({ phase: "polling" });
      const resumed = coordinator(true);
      for (let step = 0; step < 8; step += 1) {
        if ((await resumed.coordinate({ type: "advance", identity })).kind === "terminal") break;
      }
      expect(readProjectActionRun(doc, command.actionRunId)?.status).toBe(
        outcome === "completed" ? "succeeded" : "failed",
      );
      const commit = readOutputCommit(doc, identity);
      if (outcome === "completed") {
        expect(commit).not.toBeNull();
        expect(readProjectAsset(doc, "asset-courtyard")).not.toBeNull();
      } else {
        expect(commit).toBeNull();
        expect(readProjectAsset(doc, "asset-courtyard")).toBeNull();
      }
      expect(readProjectActionRun(doc, command.actionRunId)?.executor).toEqual(request().executor);
    },
  );

  it("checkpoints public pending before the private journal and projects only coarse running afterwards", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const persistedStatuses: Array<string | null> = [];
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });

    const publicRun = await bridge.enqueue({
      doc,
      request: request(),
      command: durableCommand(),
      checkpoint: async () => {
        persistedStatuses.push(
          readProjectActionRun(doc, "run-stage-1")?.status ?? null,
        );
      },
    });

    expect(persistedStatuses).toEqual(["pending", "running"]);
    expect(publicRun.status).toBe("running");
    expect(readProjectActionRun(doc, "run-stage-1")).toEqual(publicRun);
    expect(JSON.stringify(doc.toJSON())).not.toContain("owner-private-account");

    const privateTask = await journal.load({
      actionRunId: "run-stage-1",
      outputSlot: "image",
    });
    expect(privateTask).toMatchObject({
      phase: "queued",
      owner: { realm: "local", id: "host-1" },
      executorInput: { accountId: "owner-private-account" },
    });
  });

  it("checkpoints the media Asset, legacy binding, OutputCommit, and succeeded outcome as one public mutation", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(dataDir),
    });
    await bridge.enqueue({
      doc,
      request: request(),
      command: durableCommand(),
      checkpoint: async () => undefined,
    });
    const snapshots: Array<Record<string, boolean | string | null>> = [];
    const entry = generatedAsset();
    const binding = legacyOutputBinding();

    const published = await bridge.publishMediaSuccess({
      doc,
      actionRunId: "run-stage-1",
      outputSlot: "image",
      entry,
      checkpoint: async () => {
        snapshots.push({
          asset: readProjectAsset(doc, entry.id) !== null,
          binding: readActionAssetBinding(doc, binding.id) !== null,
          commit:
            readOutputCommit(doc, {
              actionRunId: "run-stage-1",
              outputSlot: "image",
            }) !== null,
          status: readProjectActionRun(doc, "run-stage-1")?.status ?? null,
        });
      },
    });

    expect(snapshots).toEqual([
      { asset: true, binding: false, commit: true, status: "succeeded" },
    ]);
    expect(published).toEqual({
      entry,
      commit: {
        actionRunId: "run-stage-1",
        outputSlot: "image",
        asset: { kind: "media", projectAssetId: entry.id },
      },
      run: { ...request(), status: "succeeded" },
      changed: true,
    });
  });

  it("does not let a late private failure retract an already published winner", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(dataDir),
    });
    await bridge.enqueue({
      doc,
      request: request(),
      command: durableCommand(),
      checkpoint: async () => undefined,
    });
    await bridge.publishMediaSuccess({
      doc,
      actionRunId: "run-stage-1",
      outputSlot: "image",
      entry: generatedAsset(),
      checkpoint: async () => undefined,
    });

    const failure = await bridge.publishFailure({
      doc,
      actionRunId: "run-stage-1",
      checkpoint: async () => undefined,
    });

    expect(failure).toMatchObject({
      changed: false,
      winnerPreserved: true,
      run: { actionRunId: "run-stage-1", status: "succeeded" },
    });
    expect(readProjectAsset(doc, "asset-courtyard")).toEqual(generatedAsset());
    expect(
      readOutputCommit(doc, {
        actionRunId: "run-stage-1",
        outputSlot: "image",
      }),
    ).toEqual({
      actionRunId: "run-stage-1",
      outputSlot: "image",
      asset: { kind: "media", projectAssetId: "asset-courtyard" },
    });
  });

  it("returns the existing output winner when restart recovery receives an unknown duplicate result", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const firstHost = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    await firstHost.enqueue({
      doc,
      request: request(),
      command: durableCommand(),
      checkpoint: async () => undefined,
    });
    await firstHost.publishMediaSuccess({
      doc,
      actionRunId: "run-stage-1",
      outputSlot: "image",
      entry: generatedAsset(),
      checkpoint: async () => undefined,
    });

    const recoveredHost = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(dataDir),
    });
    const duplicate = generatedAsset("asset-duplicate-result");
    const recovered = await recoveredHost.publishMediaSuccess({
      doc,
      actionRunId: "run-stage-1",
      outputSlot: "image",
      entry: duplicate,
      checkpoint: async () => undefined,
    });

    expect(recovered).toMatchObject({
      entry: { id: "asset-courtyard" },
      commit: {
        asset: { kind: "media", projectAssetId: "asset-courtyard" },
      },
      run: { status: "succeeded" },
      changed: false,
    });
    expect(readProjectAsset(doc, duplicate.id)).toBeNull();
    expect(
      readActionAssetBinding(doc, "action-asset:run-stage-1:image:output"),
    ).toBeNull();
  });

  it("runs an accepted Generator Action through the same export on poll and publishes its contracted output", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    await bridge.enqueue({
      doc,
      request: request(),
      command: generatorActionCommand(),
      checkpoint: async () => undefined,
    });
    const operations: string[] = [];
    const coordinator = createLocalDurableRunCoordinator({
      ownerId: "host-1",
      journal,
      providerPluginExecutor: async () => {
        throw new Error("Generator Actions must not use the Provider adapter.");
      },
      executablePluginAction: async (invocation) => {
        const operation = (invocation as { operation?: string }).operation;
        operations.push(operation ?? "missing");
        if (operation === "submit") {
          return {
            protocol: "clash.plugin.result/v1",
            invocationId: "submit-result",
            status: "accepted",
            pollState: { upstreamTaskId: "vendor-task-1" },
            retryAfterMs: 0,
          };
        }
        if (
          operation !== "poll" ||
          JSON.stringify((invocation as { pollState?: unknown }).pollState) !==
            JSON.stringify({ upstreamTaskId: "vendor-task-1" })
        ) {
          throw new Error("poll must carry the accepted opaque state");
        }
        return {
          protocol: "clash.plugin.result/v1",
          invocationId: "poll-result",
          status: "completed",
          outputs: [
            {
              slot: "image",
              kind: "asset",
              asset: {
                assetId: "asset-courtyard",
                uri: "clash-asset://asset-courtyard",
                kind: "image",
                mediaType: "image/png",
              },
            },
          ],
        };
      },
      outputStore: {
        async stage({ outputs }) {
          expect(outputs).toMatchObject([
            { slot: "image", kind: "asset", asset: { kind: "image" } },
          ]);
          return { kind: "asset", projectAsset: generatedAsset() };
        },
      },
      publisher: {
        async publish({ run }) {
          await bridge.publishMediaSuccess({
            doc,
            actionRunId: run.actionRunId,
            outputSlot: run.outputSlot,
            entry: generatedAsset(),
            checkpoint: async () => undefined,
          });
        },
        async publishFailure({ run }) {
          await bridge.publishFailure({
            doc,
            actionRunId: run.actionRunId,
            checkpoint: async () => undefined,
          });
        },
      },
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    });
    const identity = { actionRunId: "run-stage-1", outputSlot: "image" };

    for (let step = 0; step < 6; step += 1) {
      const advanced = await coordinator.coordinate({
        type: "advance",
        identity,
      });
      if (advanced.kind === "terminal") break;
    }

    expect(operations).toEqual(["submit", "poll"]);
    expect(await journal.load(identity)).toMatchObject({
      phase: "succeeded",
      providerOutputs: [
        { slot: "image", kind: "asset", asset: { kind: "image" } },
      ],
    });
    expect(readProjectActionRun(doc, "run-stage-1")?.status).toBe("succeeded");
  });

  it.each([
    {
      name: "wrong slot",
      output: {
        slot: "thumbnail",
        kind: "asset" as const,
        asset: {
          assetId: "asset-wrong",
          uri: "clash-asset://asset-wrong",
          kind: "image" as const,
          mediaType: "image/png",
        },
      },
    },
    {
      name: "wrong media kind",
      output: {
        slot: "image",
        kind: "asset" as const,
        asset: {
          assetId: "asset-wrong",
          uri: "clash-asset://asset-wrong",
          kind: "video" as const,
          mediaType: "video/mp4",
        },
      },
    },
  ])(
    "fails a Generator Action that completes with $name",
    async ({ output }) => {
      const doc = projectDoc();
      const dataDir = await temporaryDataDir();
      const journal = createSqliteDurableRunJournal(dataDir);
      const bridge = createLocalGeneratorRunBridge({
        ownerId: "host-1",
        journal,
      });
      await bridge.enqueue({
        doc,
        request: request(),
        command: generatorActionCommand(),
        checkpoint: async () => undefined,
      });
      let staged = 0;
      let published = 0;
      const coordinator = createLocalDurableRunCoordinator({
        ownerId: "host-1",
        journal,
        providerPluginExecutor: async () => {
          throw new Error(
            "Generator Actions must not use the Provider adapter.",
          );
        },
        executablePluginAction: async () => ({
          protocol: "clash.plugin.result/v1",
          invocationId: "wrong-result",
          status: "completed",
          outputs: [output],
        }),
        outputStore: {
          async stage() {
            staged += 1;
            return {};
          },
        },
        publisher: {
          async publish() {
            published += 1;
          },
          async publishFailure({ run }) {
            await bridge.publishFailure({
              doc,
              actionRunId: run.actionRunId,
              checkpoint: async () => undefined,
            });
          },
        },
        retryPolicy: createBoundedRetryPolicy({
          maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
          baseDelayMs: 0,
          maxDelayMs: 0,
        }),
      });
      const identity = { actionRunId: "run-stage-1", outputSlot: "image" };

      for (let step = 0; step < 4; step += 1) {
        const advanced = await coordinator.coordinate({
          type: "advance",
          identity,
        });
        if (advanced.kind === "terminal") break;
      }

      expect(staged).toBe(0);
      expect(published).toBe(0);
      expect(await journal.load(identity)).toMatchObject({
        phase: "failed",
        failure: { code: "contract_violation" },
      });
      expect(readProjectActionRun(doc, "run-stage-1")?.status).toBe("failed");
    },
  );

  it("repairs public running after restart only when the owner-private task already exists", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const pending = ensureActionRunRequest(doc, request());
    if (!pending.ok) throw new Error(pending.error.message);
    await createLocalDurableRun({
      ownerId: "host-1",
      journal,
      command: generatorActionCommand(),
    });
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const checkpoints: string[] = [];

    const running = await bridge.projectRunning({
      doc,
      identity: { actionRunId: "run-stage-1", outputSlot: "image" },
      checkpoint: async () => {
        checkpoints.push(readProjectActionRun(doc, "run-stage-1")!.status);
      },
    });

    expect(checkpoints).toEqual(["running"]);
    expect(running).toMatchObject({
      actionRunId: "run-stage-1",
      status: "running",
    });
  });

  it("rejects a private task whose frozen output contract differs from the public ActionRun", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const mismatched = generatorActionCommand();
    mismatched.executor.generatorOutputContract = [
      {
        slot: "other-image",
        assetType: { kind: "media", mediaKind: "image" },
        cardinality: { minItems: 1, maxItems: 1 },
      },
    ];

    await expect(
      bridge.enqueue({
        doc,
        request: request(),
        command: mismatched,
        checkpoint: async () => undefined,
      }),
    ).rejects.toThrow(/exact.*output contract/i);
    expect(readProjectActionRun(doc, "run-stage-1")).toBeNull();
    await expect(
      journal.load({ actionRunId: "run-stage-1", outputSlot: "image" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a private task whose executor differs from the immutable public ActionRun", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const mismatched = generatorActionCommand();
    mismatched.executor.binding = {
      ...mismatched.executor.binding,
      exportId: "other-export",
    };

    await expect(
      bridge.enqueue({
        doc,
        request: request(),
        command: mismatched,
        checkpoint: async () => undefined,
      }),
    ).rejects.toThrow(/exact.*executor/i);
    expect(readProjectActionRun(doc, "run-stage-1")).toBeNull();
    await expect(
      journal.load({ actionRunId: "run-stage-1", outputSlot: "image" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a private task whose legacy public owner differs from the Generator revision", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const mismatched = generatorActionCommand();
    mismatched.executor.publicOwner = {
      actionId: "other-generator",
      actionRevisionId: "other-revision",
    };

    await expect(
      bridge.enqueue({
        doc,
        request: request(),
        command: mismatched,
        checkpoint: async () => undefined,
      }),
    ).rejects.toThrow(/public owner.*Generator revision/i);
    expect(readProjectActionRun(doc, "run-stage-1")).toBeNull();
    await expect(
      journal.load({ actionRunId: "run-stage-1", outputSlot: "image" }),
    ).resolves.toBeUndefined();
  });

  it("replays an exact retry on the same Run id and keeps a rerun with the same fingerprint distinct", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const firstRequest = request();
    const firstCommand = generatorActionCommand();

    const first = await bridge.enqueue({
      doc,
      request: firstRequest,
      command: firstCommand,
      checkpoint: async () => undefined,
    });
    const retry = await bridge.enqueue({
      doc,
      request: structuredClone(firstRequest),
      command: structuredClone(firstCommand),
      checkpoint: async () => undefined,
    });
    const rerunRequest = request("run-stage-2");
    const rerun = await bridge.enqueue({
      doc,
      request: rerunRequest,
      command: generatorActionCommand("run-stage-2"),
      checkpoint: async () => undefined,
    });

    expect(retry).toEqual(first);
    expect(rerun).toMatchObject({
      actionRunId: "run-stage-2",
      invocationFingerprint: first.invocationFingerprint,
      status: "running",
    });
    expect(doc.getMap("generatorActionRuns").size).toBe(2);
    await expect(
      journal.load({ actionRunId: "run-stage-1", outputSlot: "image" }),
    ).resolves.toMatchObject({ actionRunId: "run-stage-1" });
    await expect(
      journal.load({ actionRunId: "run-stage-2", outputSlot: "image" }),
    ).resolves.toMatchObject({ actionRunId: "run-stage-2" });
  });

  it("does not recreate a private task when an exact retry finds a terminal public Run", async () => {
    const doc = projectDoc();
    expect(ensureActionRunRequest(doc, request())).toMatchObject({ ok: true });
    expect(
      commitActionRunOutcome(doc, {
        actionRunId: "run-stage-1",
        status: "failed",
      }),
    ).toMatchObject({ ok: true, run: { status: "failed" } });
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal,
    });
    const checkpoint = vi.fn(async () => undefined);

    await expect(
      bridge.enqueue({
        doc,
        request: request(),
        command: durableCommand(),
        checkpoint,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      journal.load({ actionRunId: "run-stage-1", outputSlot: "image" }),
    ).resolves.toBeUndefined();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("atomically publishes all required Document outputs or leaves none", async () => {
    const doc = projectDoc();
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal: createSqliteDurableRunJournal(await temporaryDataDir()) });
    const multi = {
      ...request(), actionId: "analyze",
      outputContract: ["description", "tags"].map((slot) => ({
        slot,
        assetType: { kind: "document" as const, documentKind: `media.analysis.${slot}`, schemaVersion: 1 },
        cardinality: { minItems: 1, maxItems: 1 },
      })),
    };
    expect(ensureActionRunRequest(doc, multi)).toMatchObject({ ok: true });
    expect(markActionRunStarted(doc, multi.actionRunId)).toMatchObject({ ok: true });
    const revision = (slot: string, kind = `media.analysis.${slot}`) => ({
      id: `batch:${slot}:r1`, documentAssetId: `batch:${slot}`,
      documentKind: kind, schemaVersion: 1, mutability: "versioned" as const,
      body: { digest: `sha256:${(slot === "description" ? "a" : "b").repeat(64)}` as const, byteLength: 10, contentType: "application/json" },
      producer: { kind: "action-run" as const, actionRunId: multi.actionRunId }, sourceRefs: [],
    });
    await expect(bridge.publishDocumentBatchSuccess({
      doc, actionRunId: multi.actionRunId,
      outputs: [
        { outputSlot: "description", revision: revision("description") },
        { outputSlot: "tags", revision: revision("tags", "media.transcript") },
      ],
      checkpoint: async () => undefined,
    })).rejects.toThrow(/Document.*output contract/i);
    expect(readProjectDocumentAsset(doc, "batch:description")).toBeNull();
    expect(readOutputCommit(doc, { actionRunId: multi.actionRunId, outputSlot: "description" })).toBeNull();

    await expect(bridge.publishDocumentBatchSuccess({
      doc, actionRunId: multi.actionRunId,
      outputs: [
        { outputSlot: "description", revision: revision("description") },
        { outputSlot: "tags", revision: revision("tags") },
      ],
      checkpoint: async () => undefined,
    })).resolves.toMatchObject({ run: { status: "succeeded" } });
  });

  it("attaches each typed analysis Document revision to its frozen source Asset", async () => {
    const doc = projectDoc();
    expect(createProjectAsset(doc, {
      id: "source-asset",
      kind: "image",
      source: { kind: "owned", resourceId: "resource-source" },
      lifecycle: { state: "active" },
      metadata: { contentType: "image/png" },
    })).toMatchObject({ ok: true });
    const requestWithDocument = {
      ...request(),
      actionId: "analyze",
      outputContract: [{
        slot: "description",
        assetType: { kind: "document" as const, documentKind: "media.analysis.description", schemaVersion: 1 },
        cardinality: { minItems: 1, maxItems: 1 },
      }],
    };
    expect(ensureActionRunRequest(doc, requestWithDocument)).toMatchObject({ ok: true });
    expect(markActionRunStarted(doc, requestWithDocument.actionRunId)).toMatchObject({ ok: true });
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal: createSqliteDurableRunJournal(await temporaryDataDir()) });
    await bridge.publishDocumentSuccess({
      doc,
      actionRunId: requestWithDocument.actionRunId,
      outputSlot: "description",
      revision: {
        id: "analysis:r1",
        documentAssetId: "analysis-description",
        documentKind: "media.analysis.description",
        schemaVersion: 1,
        mutability: "versioned",
        body: { digest: `sha256:${"d".repeat(64)}`, byteLength: 10, contentType: "application/json" },
        producer: { kind: "action-run", actionRunId: requestWithDocument.actionRunId },
        sourceRefs: [{ slot: "source", target: { kind: "media", projectAssetId: "source-asset" } }],
      },
      checkpoint: async () => undefined,
    });
    expect(readDocumentAttachment(doc, "attachment:analysis:r1:source-asset")).toMatchObject({
      target: { kind: "project-asset", projectAssetId: "source-asset" },
      slot: "description",
      document: { documentAssetId: "analysis-description", revisionId: "analysis:r1" },
    });
  });

  it("publishes independent optional Document slots without terminalizing before explicit finalization", async () => {
    const doc = projectDoc();
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(await temporaryDataDir()),
    });
    const multi = {
      ...request(),
      actionId: "analyze",
      outputContract: ["description", "tags"].map((slot) => ({
        slot,
        assetType: {
          kind: "document" as const,
          documentKind: `media.analysis.${slot}`,
          schemaVersion: 1,
        },
        cardinality: { minItems: 0, maxItems: 1 },
      })),
    };
    expect(ensureActionRunRequest(doc, multi)).toMatchObject({ ok: true });
    expect(markActionRunStarted(doc, multi.actionRunId)).toMatchObject({
      ok: true,
    });

    for (const slot of ["description", "tags"] as const) {
      const published = await bridge.publishDocumentSuccess({
        doc,
        actionRunId: multi.actionRunId,
        outputSlot: slot,
        revision: {
          id: `document-revision:${multi.actionRunId}:${slot}`,
          documentAssetId: `document:${multi.actionRunId}:${slot}`,
          documentKind: `media.analysis.${slot}`,
          schemaVersion: 1,
          mutability: "versioned",
          body: {
            digest: `sha256:${(slot === "description" ? "a" : "b").repeat(64)}`,
            byteLength: 10,
            contentType: "application/json",
          },
          producer: { kind: "action-run", actionRunId: multi.actionRunId },
          sourceRefs: [],
        },
        checkpoint: async () => undefined,
      });
      expect(published.run.status).toBe("running");
    }

    const finalized = await bridge.finalizeSuccess({
      doc,
      actionRunId: multi.actionRunId,
      checkpoint: async () => undefined,
    });
    expect(finalized.run.status).toBe("succeeded");
    expect(readOutputCommit(doc, {
      actionRunId: multi.actionRunId,
      outputSlot: "description",
    })).not.toBeNull();
    expect(readOutputCommit(doc, {
      actionRunId: multi.actionRunId,
      outputSlot: "tags",
    })).not.toBeNull();
  });

  it("atomically publishes a typed Document revision, OutputCommit, and succeeded outcome", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(dataDir),
    });
    const documentRequest = {
      ...request(),
      actionId: "transcribe",
      executor: { ...request().executor, exportId: "transcribe" },
      outputContract: [
        {
          slot: "transcript",
          assetType: {
            kind: "document" as const,
            documentKind: "media.transcript",
            schemaVersion: 1,
          },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    };
    const requested = ensureActionRunRequest(doc, documentRequest);
    if (!requested.ok) throw new Error(requested.error.message);
    const started = markActionRunStarted(doc, documentRequest.actionRunId);
    if (!started.ok) throw new Error(started.error.message);
    const checkpoints: string[] = [];

    const published = await bridge.publishDocumentSuccess({
      doc,
      actionRunId: documentRequest.actionRunId,
      outputSlot: "transcript",
      revision: {
        id: "document-revision:run-stage-1:transcript",
        documentAssetId: "document:run-stage-1:transcript",
        documentKind: "media.transcript",
        schemaVersion: 1,
        mutability: "versioned",
        body: {
          digest: `sha256:${"e".repeat(64)}`,
          byteLength: 512,
          contentType: "application/json",
        },
        producer: { kind: "action-run", actionRunId: "run-stage-1" },
        sourceRefs: [],
      },
      checkpoint: async () => {
        checkpoints.push(
          JSON.stringify({
            document: readProjectDocumentAsset(
              doc,
              "document:run-stage-1:transcript",
            ),
            commit: readOutputCommit(doc, {
              actionRunId: "run-stage-1",
              outputSlot: "transcript",
            }),
            status: readProjectActionRun(doc, "run-stage-1")?.status,
          }),
        );
      },
    });

    expect(checkpoints).toHaveLength(1);
    expect(published).toMatchObject({
      revision: {
        id: "document-revision:run-stage-1:transcript",
        documentKind: "media.transcript",
      },
      commit: {
        asset: {
          kind: "document",
          documentAssetId: "document:run-stage-1:transcript",
          revisionId: "document-revision:run-stage-1:transcript",
        },
      },
      run: { status: "succeeded" },
    });
    expect(
      readDocumentAssetRevision(doc, {
        documentAssetId: "document:run-stage-1:transcript",
        revisionId: "document-revision:run-stage-1:transcript",
      }),
    ).not.toBeNull();
  });

  it("rejects a Document output whose kind differs from the frozen Run contract", async () => {
    const doc = projectDoc();
    const dataDir = await temporaryDataDir();
    const bridge = createLocalGeneratorRunBridge({
      ownerId: "host-1",
      journal: createSqliteDurableRunJournal(dataDir),
    });
    const documentRequest = {
      ...request(),
      outputContract: [
        {
          slot: "document",
          assetType: {
            kind: "document" as const,
            documentKind: "media.description",
            schemaVersion: 1,
          },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    };
    const requested = ensureActionRunRequest(doc, documentRequest);
    if (!requested.ok) throw new Error(requested.error.message);

    await expect(
      bridge.publishDocumentSuccess({
        doc,
        actionRunId: "run-stage-1",
        outputSlot: "document",
        revision: {
          id: "wrong:r1",
          documentAssetId: "wrong",
          documentKind: "media.transcript",
          schemaVersion: 1,
          mutability: "versioned",
          body: {
            digest: `sha256:${"f".repeat(64)}`,
            byteLength: 10,
            contentType: "application/json",
          },
          producer: { kind: "action-run", actionRunId: "run-stage-1" },
          sourceRefs: [],
        },
        checkpoint: async () => undefined,
      }),
    ).rejects.toThrow(/Document.*output contract/i);
    expect(readProjectDocumentAsset(doc, "wrong")).toBeNull();
  });

  it("successful two-frame batch uses coherent checkpoints without prefixes", async () => {
    const doc = projectDoc();
    const journal = createSqliteDurableRunJournal(await temporaryDataDir());
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal });
    const entries = ["batch-1", "batch-2"].map((id) => ({ request: request(id), command: durableCommand(id) }));
    const snapshots: string[][] = [];
    await bridge.enqueueBatch({ doc, entries, checkpoint: async () => { snapshots.push(entries.map(({ request: item }) => readProjectActionRun(doc, item.actionRunId)?.status ?? "missing")); } });
    expect(snapshots).toEqual([["pending", "pending"], ["running", "running"]]);
  });

  it("conflict in second proposal admits zero public Runs and creates zero tasks", async () => {
    const doc = projectDoc();
    const journal = createSqliteDurableRunJournal(await temporaryDataDir());
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal });
    const bad = request("conflict-2");
    bad.actionId = "other-action";
    await expect(bridge.enqueueBatch({ doc, entries: [{ request: request("conflict-1"), command: durableCommand("conflict-1") }, { request: bad, command: durableCommand("conflict-2") }], checkpoint: async () => undefined })).rejects.toThrow(/exact Action id/);
    expect([readProjectActionRun(doc, "conflict-1"), readProjectActionRun(doc, "conflict-2")]).toEqual([null, null]);
    await expect(Promise.all([journal.load({ actionRunId: "conflict-1", outputSlot: "image" }), journal.load({ actionRunId: "conflict-2", outputSlot: "image" })])).resolves.toEqual([undefined, undefined]);
  });

  it("failure creating second private task leaves all queued and replay repairs before all run", async () => {
    const doc = projectDoc();
    const journal = createSqliteDurableRunJournal(await temporaryDataDir());
    let fail = true;
    const controlled = new Proxy(journal, { get(target, property) {
      if (property === "create") return async (run: Parameters<typeof journal.create>[0]) => {
        if (fail && run.actionRunId === "repair-2") throw new Error("injected second task failure");
        return target.create(run);
      };
      const value = target[property as keyof typeof target];
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal: controlled });
    const entries = ["repair-1", "repair-2"].map((id) => ({ request: request(id), command: durableCommand(id) }));
    await expect(bridge.enqueueBatch({ doc, entries, checkpoint: async () => undefined })).rejects.toThrow("injected second task failure");
    expect(entries.map(({ request: item }) => readProjectActionRun(doc, item.actionRunId)?.status)).toEqual(["pending", "pending"]);
    await expect(Promise.all(entries.map(({ request: item }) => journal.load({ actionRunId: item.actionRunId, outputSlot: "image" })))).resolves.toEqual([expect.any(Object), undefined]);
    fail = false;
    const replay = await bridge.enqueueBatch({ doc, entries, checkpoint: async () => undefined });
    expect(replay.map((run) => run.status)).toEqual(["running", "running"]);
    await expect(journal.load({ actionRunId: "repair-2", outputSlot: "image" })).resolves.not.toBeNull();
  });

  it("exact batch replay is idempotent", async () => {
    const doc = projectDoc();
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal: createSqliteDurableRunJournal(await temporaryDataDir()) });
    const entries = ["replay-1", "replay-2"].map((id) => ({ request: request(id), command: durableCommand(id) }));
    const first = await bridge.enqueueBatch({ doc, entries, checkpoint: async () => undefined });
    const checkpoint = vi.fn(async () => undefined);
    await expect(bridge.enqueueBatch({ doc, entries, checkpoint })).resolves.toEqual(first);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("terminal runs are not recreated", async () => {
    const doc = projectDoc();
    const requested = ensureActionRunRequest(doc, request("terminal-1"));
    if (!requested.ok) throw new Error(requested.error.message);
    const completed = commitActionRunOutcome(doc, { actionRunId: "terminal-1", status: "failed" });
    if (!completed.ok) throw new Error(completed.error.message);
    const journal = createSqliteDurableRunJournal(await temporaryDataDir());
    const bridge = createLocalGeneratorRunBridge({ ownerId: "host-1", journal });
    const [run] = await bridge.enqueueBatch({ doc, entries: [{ request: request("terminal-1"), command: durableCommand("terminal-1") }], checkpoint: async () => undefined });
    expect(run?.status).toBe("failed");
    await expect(journal.load({ actionRunId: "terminal-1", outputSlot: "image" })).resolves.toBeUndefined();
  });
});
