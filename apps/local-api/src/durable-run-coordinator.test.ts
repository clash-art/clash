import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoundedRetryPolicy } from "@clash/shared-runtime";
import type { ExecutablePluginOutput } from "@clash/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalDurableRunCoordinator,
  localDurableRunOwnerId,
  type LocalDurableRunCoordinatorOptions,
} from "./durable-run-coordinator";
import { createSqliteDurableRunJournal } from "./durable-run-journal";
import {
  ProviderPluginHostUnavailableError,
  type ProviderPluginExecutor,
} from "./local-aigc";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "clash-durable-run-coordinator-"),
  );
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

const binding = {
  pluginId: "clash.minimax",
  version: "1.2.3",
  exportId: "minimax-execute",
  schemaHash: `sha256:${"a".repeat(64)}`,
} as const;

function createCommand() {
  return {
    type: "create" as const,
    actionRunId: "action-run-1",
    outputSlot: "media",
    deadlineAt: 10_000,
    executor: {
      binding,
      accountId: "minimax-primary",
      kind: "video" as const,
      projectId: "project-1",
      nodeId: "node-1",
      assetInputs: [
        {
          match: { kinds: ["image" as const], slots: ["startFrame"] },
          representations: ["provider-url" as const, "bytes" as const],
          mediaTypes: ["image/png"],
        },
      ],
      input: {
        values: {
          modelId: "minimax-h3",
          upstreamModel: "MiniMax-H3",
          prompt: "A frozen prompt",
        },
        references: [],
      },
    },
  };
}

function createCustomActionCommand(kind: "image" | "text") {
  return {
    type: "create" as const,
    actionRunId: `custom-${kind}-run-1`,
    outputSlot: kind === "text" ? "text" : "media",
    deadlineAt: 10_000,
    executor: {
      targetKind: "action" as const,
      binding,
      actionId: "legacy-custom-action",
      actor: { kind: "user" as const, id: "local-user" },
      kind,
      projectId: "project-1",
      nodeId: "custom-action-node",
      input: { values: {}, references: [] },
    },
  };
}

function createLocalExecutorCommand() {
  return {
    type: "create" as const,
    actionRunId: "local-executor-run-1",
    outputSlot: "render:output",
    deadlineAt: 10_000,
    executor: {
      targetKind: "local-executor" as const,
      binding,
      actionId: "timeline:render",
      actor: { kind: "system" as const, id: "local-api" },
      kind: "video" as const,
      projectId: "project-1",
      nodeId: "render-node",
      input: { values: {}, references: [] },
    },
  };
}

function valueOutput(slot: string, value: string): ExecutablePluginOutput {
  return { slot, kind: "value", value };
}

function assetOutput(
  slot: string,
  kind: "image" | "video",
): ExecutablePluginOutput {
  return {
    slot,
    kind: "asset",
    asset: {
      assetId: `${kind}-asset-1`,
      uri: `clash-asset://${kind}-asset-1`,
      kind,
      mediaType: kind === "video" ? "video/mp4" : "image/png",
    },
  };
}

function harness(input: {
  dataDir: string;
  provider: ProviderPluginExecutor;
  executablePluginAction?: LocalDurableRunCoordinatorOptions["executablePluginAction"];
  localExecutor?: LocalDurableRunCoordinatorOptions["localExecutor"];
  ownerId?: string;
  now: { value: number };
  recoveryFinalizationTimeoutMs?: number;
}) {
  const staged = vi.fn(
    async ({ idempotencyKey }: { idempotencyKey: string }) => ({
      resourceId: `resource:${idempotencyKey}`,
    }),
  );
  const published = vi.fn(async () => undefined);
  const publishedFailure = vi.fn(async () => undefined);
  const options = {
    ownerId: input.ownerId ?? "host-1",
    journal: createSqliteDurableRunJournal(input.dataDir),
    providerPluginExecutor: input.provider,
    ...(input.executablePluginAction
      ? { executablePluginAction: input.executablePluginAction }
      : {}),
    ...(input.localExecutor ? { localExecutor: input.localExecutor } : {}),
    outputStore: { stage: staged },
    publisher: {
      publish: published,
      publishFailure: publishedFailure,
    },
    retryPolicy: createBoundedRetryPolicy({
      maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
      baseDelayMs: 1,
      maxDelayMs: 1,
    }),
    clock: { now: () => input.now.value },
    ...(input.recoveryFinalizationTimeoutMs === undefined
      ? {}
      : {
          recoveryFinalizationTimeoutMs: input.recoveryFinalizationTimeoutMs,
        }),
  } satisfies LocalDurableRunCoordinatorOptions;
  return {
    coordinator: createLocalDurableRunCoordinator(options),
    journal: options.journal,
    staged,
    published,
    publishedFailure,
  };
}

async function advanceCompletedExecutable(
  input:
    | {
        targetKind: "action";
        kind: "image" | "text";
        outputs: ExecutablePluginOutput[];
      }
    | {
        targetKind: "local-executor";
        outputs: ExecutablePluginOutput[];
      },
) {
  const dataDir = await temporaryDataDir();
  const execute = async () => ({
    protocol: "clash.plugin.result/v1" as const,
    invocationId: "executable-result-1",
    status: "completed" as const,
    outputs: input.outputs,
  });
  const run = harness({
    dataDir,
    now: { value: 100 },
    provider: async () => {
      throw new Error("Provider path must not run for an Action executor.");
    },
    ...(input.targetKind === "action"
      ? { executablePluginAction: execute }
      : { localExecutor: execute }),
  });
  const command =
    input.targetKind === "action"
      ? createCustomActionCommand(input.kind)
      : createLocalExecutorCommand();
  const identity = {
    actionRunId: command.actionRunId,
    outputSlot: command.outputSlot,
  };

  await run.coordinator.coordinate(command);
  await run.coordinator.coordinate({ type: "advance", identity });
  await run.coordinator.coordinate({ type: "advance", identity });
  return { run, identity };
}

describe("Local Durable Run coordinator", () => {
  it("keeps the local durable owner stable when the discovery host restarts", () => {
    expect(localDurableRunOwnerId("discovery-host-before-restart")).toBe(
      localDurableRunOwnerId("discovery-host-after-restart"),
    );
  });

  it.each([
    {
      name: "two legacy text values",
      input: {
        targetKind: "action" as const,
        kind: "text" as const,
        outputs: [
          valueOutput("result", "first"),
          valueOutput("result", "second"),
        ],
      },
    },
    {
      name: "a text value and an Asset sibling",
      input: {
        targetKind: "action" as const,
        kind: "text" as const,
        outputs: [
          valueOutput("result", "caption"),
          assetOutput("media", "image"),
        ],
      },
    },
    {
      name: "an Asset envelope for a text Action",
      input: {
        targetKind: "action" as const,
        kind: "text" as const,
        outputs: [assetOutput("result", "image")],
      },
    },
    {
      name: "a value envelope for a media Action",
      input: {
        targetKind: "action" as const,
        kind: "image" as const,
        outputs: [valueOutput("media", "not an Asset")],
      },
    },
    {
      name: "a video Asset for an image Action",
      input: {
        targetKind: "action" as const,
        kind: "image" as const,
        outputs: [assetOutput("media", "video")],
      },
    },
    {
      name: "custom text through the durable text slot",
      input: {
        targetKind: "action" as const,
        kind: "text" as const,
        outputs: [valueOutput("text", "caption")],
      },
    },
    {
      name: "custom media through an undeclared thumbnail slot",
      input: {
        targetKind: "action" as const,
        kind: "image" as const,
        outputs: [assetOutput("thumbnail", "image")],
      },
    },
    {
      name: "Host-local output through a different durable slot",
      input: {
        targetKind: "local-executor" as const,
        outputs: [assetOutput("media", "video")],
      },
    },
  ])(
    "fails closed before staging when an executable returns $name",
    async ({ input }) => {
      const { run, identity } = await advanceCompletedExecutable(input);

      await expect(run.journal.load(identity)).resolves.toMatchObject({
        phase: "failed",
        failure: {
          code: "contract_violation",
          retryable: false,
          requestState: "accepted",
        },
      });
      expect(run.staged).not.toHaveBeenCalled();
      expect(run.published).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "legacy text value",
      input: {
        targetKind: "action" as const,
        kind: "text" as const,
        outputs: [valueOutput("result", "caption")],
      },
      durableOutput: valueOutput("text", "caption"),
    },
    {
      name: "legacy media Asset",
      input: {
        targetKind: "action" as const,
        kind: "image" as const,
        outputs: [assetOutput("media", "image")],
      },
      durableOutput: assetOutput("media", "image"),
    },
    {
      name: "typed image Asset",
      input: {
        targetKind: "action" as const,
        kind: "image" as const,
        outputs: [assetOutput("image", "image")],
      },
      durableOutput: assetOutput("media", "image"),
    },
    {
      name: "Host-local output",
      input: {
        targetKind: "local-executor" as const,
        outputs: [assetOutput("render:output", "video")],
      },
      durableOutput: assetOutput("render:output", "video"),
    },
  ])(
    "normalizes one valid $name into its frozen durable slot",
    async ({ input, durableOutput }) => {
      const { run, identity } = await advanceCompletedExecutable(input);

      await expect(run.journal.load(identity)).resolves.toMatchObject({
        phase: "finalizing",
        providerOutputs: [durableOutput],
      });
    },
  );

  it.each(["A chestnut horse", "", "  keep authored whitespace  "])("freezes a node-less Project Asset delivery without changing prompt %j", async (prompt) => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const run = harness({
      dataDir,
      now,
      provider: async () => {
        throw new Error("creation must not invoke the Provider");
      },
    });
    const command = createCommand();
    const { nodeId: _nodeId, ...executor } = command.executor;

    await run.coordinator.coordinate({
      ...command,
      actionRunId: "director-run-1",
      executor: {
        ...executor,
        delivery: {
          kind: "project-asset",
          actionId: "director:model-generation",
          name: "generated-model.glb",
          prompt,
        },
      },
    });

    await expect(
      run.journal.load({
        actionRunId: "director-run-1",
        outputSlot: "media",
      }),
    ).resolves.toMatchObject({
      phase: "queued",
      executorInput: {
        projectId: "project-1",
        delivery: {
          kind: "project-asset",
          actionId: "director:model-generation",
          name: "generated-model.glb",
          prompt,
        },
      },
    });
  });

  it("freezes executor route/account/input and resumes submit/poll with one stable identity", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const requests: Parameters<ProviderPluginExecutor>[0][] = [];
    const firstProvider: ProviderPluginExecutor = async (request) => {
      requests.push(structuredClone(request));
      return {
        status: "accepted",
        binding,
        pollState: { taskId: "provider-task-1", region: "global" },
        retryAfterMs: 5,
      };
    };
    const first = harness({ dataDir, provider: firstProvider, now });
    const command = createCommand();

    await expect(first.coordinator.coordinate(command)).resolves.toMatchObject({
      kind: "created",
      run: {
        actionRunId: "action-run-1",
        outputSlot: "media",
        owner: { realm: "local", id: "host-1" },
        phase: "queued",
      },
    });
    command.executor.input.values.prompt = "mutated after create";
    command.executor.assetInputs[0]!.representations = ["bytes"];

    await first.coordinator.coordinate({
      type: "advance",
      identity: { actionRunId: "action-run-1", outputSlot: "media" },
    });
    await first.coordinator.coordinate({
      type: "advance",
      identity: { actionRunId: "action-run-1", outputSlot: "media" },
    });

    expect(requests).toEqual([
      expect.objectContaining({
        taskId: "action-run-1:media",
        timeoutMs: 9_900,
        accountId: "minimax-primary",
        binding,
        assetInputs: [
          {
            match: { kinds: ["image"], slots: ["startFrame"] },
            representations: ["provider-url", "bytes"],
            mediaTypes: ["image/png"],
          },
        ],
        input: {
          values: expect.objectContaining({ prompt: "A frozen prompt" }),
          references: [],
        },
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("pollState");

    now.value = 106;
    const secondProvider: ProviderPluginExecutor = async (request) => {
      requests.push(structuredClone(request));
      return {
        status: "completed",
        binding,
        media: {
          assetId: "plugin-output:result-video",
          uri: "clash-asset://plugin-output:result-video",
          kind: "video",
          mediaType: "video/mp4",
        },
      };
    };
    const reopened = harness({ dataDir, provider: secondProvider, now });
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };
    await reopened.coordinator.coordinate({ type: "advance", identity });

    expect(requests[1]).toMatchObject({
      taskId: "action-run-1:media",
      timeoutMs: 9_894,
      pollState: { taskId: "provider-task-1", region: "global" },
      accountId: "minimax-primary",
      binding,
    });
    await expect(reopened.journal.load(identity)).resolves.toMatchObject({
      phase: "finalizing",
      providerOutputs: [
        {
          slot: "media",
          kind: "asset",
          asset: {
            assetId: "plugin-output:result-video",
            uri: "clash-asset://plugin-output:result-video",
            kind: "video",
            mediaType: "video/mp4",
          },
        },
      ],
      executorInput: expect.objectContaining({
        accountId: "minimax-primary",
        binding,
      }),
    });

    await reopened.coordinator.coordinate({ type: "advance", identity });
    await reopened.coordinator.coordinate({ type: "advance", identity });
    expect(reopened.staged).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "action-run-1:media",
      }),
    );
    expect(reopened.published).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "action-run-1:media",
      }),
    );
    await expect(reopened.journal.load(identity)).resolves.toMatchObject({
      phase: "succeeded",
      projectedAt: 106,
    });
  });

  it("preserves structured failures and projects terminal failure through the shared engine", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const failure = {
      code: "content_rejected" as const,
      message: "provider policy rejected the prompt",
      retryable: false,
      requestState: "rejected" as const,
      providerCode: "SAFETY_12",
    };
    const run = harness({
      dataDir,
      now,
      provider: async () => ({ status: "failed", binding, error: failure }),
    });
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };

    await run.coordinator.coordinate(createCommand());
    await run.coordinator.coordinate({ type: "advance", identity });
    await run.coordinator.coordinate({ type: "advance", identity });
    const failed = await run.journal.load(identity);
    expect(failed).toMatchObject({
      phase: "failed",
      failure,
    });
    expect(failed).not.toHaveProperty("projectedAt");
    await run.coordinator.coordinate({ type: "advance", identity });

    expect(run.publishedFailure).toHaveBeenCalledWith({
      run: expect.objectContaining({ actionRunId: "action-run-1", failure }),
      failure: {
        code: "content_rejected",
        message:
          "Generation failed. See the owning Host for private diagnostics.",
      },
    });
    await expect(run.journal.load(identity)).resolves.toMatchObject({
      phase: "failed",
      failure,
      projectedAt: 100,
    });
  });

  it("classifies plugin invocation timeouts without losing the submit/poll request boundary", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    let calls = 0;
    const run = harness({
      dataDir,
      now,
      provider: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("Plugin invocation submit-1 timed out.");
        }
        if (calls === 2) {
          return {
            status: "accepted",
            binding,
            pollState: { taskId: "accepted-task" },
            retryAfterMs: 1,
          };
        }
        throw new Error("Clash plugin host IPC timed out.");
      },
    });
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };

    await run.coordinator.coordinate(createCommand());
    await run.coordinator.coordinate({ type: "advance", identity });
    await expect(
      run.coordinator.coordinate({ type: "advance", identity }),
    ).resolves.toMatchObject({
      run: {
        phase: "submitting",
        failure: {
          code: "transport_timeout",
          requestState: "unknown",
          retryable: true,
        },
      },
    });

    now.value += 1;
    await run.coordinator.coordinate({ type: "advance", identity });
    now.value += 1;
    await expect(
      run.coordinator.coordinate({ type: "advance", identity }),
    ).resolves.toMatchObject({
      run: {
        phase: "polling",
        failure: {
          code: "transport_timeout",
          requestState: "accepted",
          retryable: true,
        },
      },
    });
  });

  it("does not retry a deterministic plugin execution exception", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const provider = vi.fn(async () => {
      throw new Error("Provider plugin returned an invalid completed output.");
    });
    const run = harness({ dataDir, now, provider });
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };

    await run.coordinator.coordinate(createCommand());
    await run.coordinator.coordinate({ type: "advance", identity });
    await expect(
      run.coordinator.coordinate({ type: "advance", identity }),
    ).resolves.toMatchObject({
      run: {
        phase: "failed",
        failure: {
          code: "execution_failed",
          requestState: "unknown",
          retryable: false,
        },
      },
    });

    now.value += 100;
    await run.coordinator.coordinate({ type: "advance", identity });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("retries only an explicitly unavailable plugin Host", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const run = harness({
      dataDir,
      now,
      provider: async () => {
        throw new ProviderPluginHostUnavailableError(
          "Executable plugin clash.minimax is not running.",
        );
      },
    });
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };

    await run.coordinator.coordinate(createCommand());
    await run.coordinator.coordinate({ type: "advance", identity });
    await expect(
      run.coordinator.coordinate({ type: "advance", identity }),
    ).resolves.toMatchObject({
      run: {
        phase: "submitting",
        failure: {
          code: "plugin_unavailable",
          requestState: "unknown",
          retryable: true,
        },
      },
    });
  });

  it("exposes recoverable identities and rejects a different Local owner", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 100 };
    const first = harness({
      dataDir,
      now,
      provider: async () => ({
        status: "accepted",
        binding,
        pollState: { taskId: "x" },
      }),
    });
    await first.coordinator.coordinate(createCommand());

    await expect(
      first.coordinator.coordinate({ type: "recoverable" }),
    ).resolves.toEqual({
      kind: "recoverable",
      identities: [{ actionRunId: "action-run-1", outputSlot: "media" }],
    });

    const otherOwner = harness({
      dataDir,
      now,
      ownerId: "host-2",
      provider: vi.fn(),
    });
    await expect(
      otherOwner.coordinator.coordinate({
        type: "advance",
        identity: { actionRunId: "action-run-1", outputSlot: "media" },
      }),
    ).rejects.toThrow(/owned by local\/host-1.*not local\/host-2/i);
  });

  it("persists the Host-configured recovery finalization deadline once", async () => {
    const dataDir = await temporaryDataDir();
    const now = { value: 0 };
    let calls = 0;
    const run = harness({
      dataDir,
      now,
      recoveryFinalizationTimeoutMs: 75,
      provider: async () => {
        calls += 1;
        return calls === 1
          ? {
              status: "accepted",
              binding,
              pollState: { taskId: "accepted-task" },
            }
          : {
              status: "completed",
              binding,
              media: {
                assetId: "plugin-output:recovered-video",
                uri: "clash-asset://plugin-output:recovered-video",
                kind: "video",
                mediaType: "video/mp4",
              },
            };
      },
    });
    const command = { ...createCommand(), deadlineAt: 100 };
    const identity = { actionRunId: "action-run-1", outputSlot: "media" };

    await run.coordinator.coordinate(command);
    await run.coordinator.coordinate({ type: "advance", identity });
    await run.coordinator.coordinate({ type: "advance", identity });
    now.value = 200;
    await run.coordinator.coordinate({ type: "advance", identity });
    await run.coordinator.coordinate({ type: "advance", identity });

    await expect(run.journal.load(identity)).resolves.toMatchObject({
      phase: "finalizing",
      recoveryFinalizationDeadlineAt: 275,
    });
    expect(calls).toBe(2);
  });
});
