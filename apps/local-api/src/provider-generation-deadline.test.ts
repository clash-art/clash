import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExternalAigcService,
  MockTextGenerationResult,
  ProviderPluginExecutionPlan,
  ProviderPluginExecutor,
} from "./local-aigc.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const CUSTOM_DEADLINE_MS = 123;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable Provider generation deadline", () => {
  it("uses the Host-configured run lifetime for durable final reconciliation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-durable-deadline-"));
    temporaryDirectories.push(dataDir);
    const now = { value: 100 };
    const binding = {
      pluginId: "test.provider",
      version: "1.0.0",
      exportId: "execute",
      schemaHash: `sha256:${"e".repeat(64)}`,
    } as const;
    const plan: ProviderPluginExecutionPlan = {
      binding,
      accountId: "private-account",
      assetInputs: [],
      kind: "image",
      projectId: "deadline-project",
      nodeId: "deadline-image",
      provider: "test-provider",
      modelEndpoint: "image-v1",
      input: {
        values: {
          modelId: "deadline-image-model",
          upstreamModel: "image-v1",
          prompt: "deadline probe",
          modelParams: {},
        },
        references: [],
      },
    };
    const requests: Parameters<ProviderPluginExecutor>[0][] = [];
    const providerPluginExecutor: ProviderPluginExecutor = async (request) => {
      requests.push(structuredClone(request));
      return {
        status: "accepted",
        binding,
        pollState: { taskId: "paid-task" },
        retryAfterMs: THIRTY_MINUTES_MS,
      };
    };
    const aigc: ExternalAigcService = {
      planProviderPlugin: vi.fn(async () => plan),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
      generateAudio: vi.fn(),
      generateText: vi.fn(),
    };
    const doc = new LoroDoc();
    doc.getMap("nodes").set("deadline-image", {
      id: "deadline-image",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "image-gen",
        prompt: "deadline probe",
        modelId: "deadline-image-model",
      },
    });
    const first = createLocalWorkflowProcessor({
      dataDir,
      modelCards: async () => [],
      aigc,
      providerGenerationDeadlineMs: CUSTOM_DEADLINE_MS,
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor,
        now: () => now.value,
      },
    });

    await first.process({ doc, projectId: "deadline-project" });
    now.value += CUSTOM_DEADLINE_MS;
    const reopened = createLocalWorkflowProcessor({
      dataDir,
      modelCards: async () => [],
      aigc,
      providerGenerationDeadlineMs: CUSTOM_DEADLINE_MS,
      durableProviderRuns: {
        ownerId: "local-api",
        providerPluginExecutor,
        now: () => now.value,
      },
    });
    await reopened.process({ doc, projectId: "deadline-project" });

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toHaveProperty("pollState");
    expect(requests[1]).toMatchObject({ pollState: { taskId: "paid-task" } });
    const node = doc.getMap("nodes").get("deadline-image") as Record<
      string,
      any
    >;
    expect(node.data).toMatchObject({
      status: "failed",
      errorCode: "deadline_exceeded",
    });
    for (const field of [
      "providerPollState",
      "providerPollAt",
      "providerAcceptedAt",
      "providerDeadlineAt",
      "providerFinalPolledAt",
      "providerAccountId",
    ]) {
      expect(node.data).not.toHaveProperty(field);
    }

    await reopened.process({ doc, projectId: "deadline-project" });
    expect(requests).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid Host run lifetime %s",
    (providerGenerationDeadlineMs) => {
      expect(() =>
        createLocalWorkflowProcessor({
          dataDir: "/unused",
          providerGenerationDeadlineMs,
        }),
      ).toThrow("providerGenerationDeadlineMs must be a positive safe integer");
    },
  );

  it("applies the same Host lifetime to the synchronous generation path", async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await mkdtemp(join(tmpdir(), "clash-sync-deadline-"));
      temporaryDirectories.push(dataDir);
      const doc = new LoroDoc();
      doc.getMap("nodes").set("sync-text", {
        id: "sync-text",
        type: "text",
        position: { x: 0, y: 0 },
        data: {
          status: "pending",
          actionType: "text-gen",
          prompt: "deadline probe",
          modelId: "gpt-5.4",
          modelParams: {},
        },
      });
      let markGenerationStarted!: () => void;
      const generationStarted = new Promise<void>((resolve) => {
        markGenerationStarted = resolve;
      });
      const processor = createLocalWorkflowProcessor({
        dataDir,
        providerGenerationDeadlineMs: 7,
        aigc: {
          generateText: vi.fn(() => {
            markGenerationStarted();
            return new Promise<MockTextGenerationResult>(() => {});
          }),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
          generateAudio: vi.fn(),
        },
      });

      const processing = processor.process({
        doc,
        projectId: "sync-deadline-project",
      });
      await generationStarted;
      await vi.advanceTimersByTimeAsync(7);
      await processing;

      expect((doc.getMap("nodes").get("sync-text") as any).data).toMatchObject({
        status: "failed",
        error:
          "Generation failed. See the owning Host for private diagnostics.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
