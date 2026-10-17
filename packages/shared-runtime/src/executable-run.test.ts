import { describe, expect, it } from "vitest";

import type { DurableRunRecord } from "./durable-run-engine.js";
import { createDurableRunRecord } from "./durable-run-engine.js";
import {
  executableProviderRequest,
  executableProviderResultStep,
  executableProviderStep,
  parseFrozenExecutableInput,
  pluginOutputSlotsForDurableRun,
  providerPluginExecutorRequest,
} from "./executable-run.js";

const binding = {
  pluginId: "clash.fal",
  version: "0.2.0",
  exportId: "fal-execute",
  schemaHash: `sha256:${"a".repeat(64)}`,
} as const;

const route = {
  modelCode: "flux-schnell",
  kind: "image" as const,
  providerId: "fal",
  accountId: "fal-primary",
  upstreamId: "fal",
  upstreamModel: "fal-ai/flux/schnell",
  apiShape: "fal",
  executorPluginId: "clash.fal",
  executorExportId: "fal-execute",
  priority: 9,
};

const frozenInput = {
  schemaVersion: 1 as const,
  binding,
  accountId: "fal-primary",
  kind: "image" as const,
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
      modelId: "flux-schnell",
      upstreamModel: "fal-ai/flux/schnell",
      apiShape: "fal",
      prompt: "a frozen prompt",
      modelParams: { num_inference_steps: 4 },
    },
    references: [],
  },
};

function run(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    ...createDurableRunRecord({
      actionRunId: "action-run-1",
      outputSlot: "media",
      owner: { realm: "local", id: "host-1" },
      executorInput: frozenInput as never,
      createdAt: 100,
      deadlineAt: 10_000,
    }),
    ...overrides,
  };
}

describe("frozen executable input", () => {
  it("round-trips every frozen field instead of reconstructing it from the node", () => {
    const parsed = parseFrozenExecutableInput(frozenInput);
    expect(parsed).toEqual(frozenInput);
    expect(parseFrozenExecutableInput(parsed)).toEqual(parsed);
  });

  it("rejects a missing binding instead of falling back to a different executor", () => {
    expect(() =>
      parseFrozenExecutableInput({ schemaVersion: 1, kind: "image" }),
    ).toThrow(/input is invalid/);
  });
});

describe("provider request builder", () => {
  it("builds the same values Local freezes, including the durable task id", () => {
    const request = providerPluginExecutorRequest({
      route,
      kind: "image",
      taskId: "project:project-1:node:node-1:revision:abc",
      projectId: "project-1",
      nodeId: "node-1",
      prompt: "a prompt",
      aspectRatio: "16:9",
      duration: 5,
      modelParams: {
        num_inference_steps: 4,
        provider_id: "forged",
        accountId: "forged",
        credentials: "forged",
        require_real_provider: true,
      },
      references: [
        {
          slot: "content",
          index: 0,
          asset: {
            assetId: "image-1",
            uri: "clash-asset://image-1",
            kind: "image",
            mediaType: "image/png",
          },
        },
      ],
    });
    expect(request).toMatchObject({
      pluginId: "clash.fal",
      exportId: "fal-execute",
      accountId: "fal-primary",
      kind: "image",
      taskId: "project:project-1:node:node-1:revision:abc",
      projectId: "project-1",
      nodeId: "node-1",
      input: {
        values: {
          modelId: "flux-schnell",
          upstreamModel: "fal-ai/flux/schnell",
          apiShape: "fal",
          prompt: "a prompt",
          aspectRatio: "16:9",
          duration: 5,
          modelParams: { num_inference_steps: 4 },
        },
        references: [
          {
            slot: "content",
            index: 0,
            asset: { assetId: "image-1", kind: "image" },
          },
        ],
      },
    });
  });

  it("does not let a pinned binding drift from the selected route", () => {
    expect(() =>
      providerPluginExecutorRequest({
        route,
        kind: "image",
        taskId: "task",
        prompt: "a prompt",
        pluginBinding: { ...binding, pluginId: "clash.other" },
      }),
    ).toThrow(/does not match route executor/);
  });

  it("maps action output ports exactly as the Local durable graph did", () => {
    const action = {
      ...frozenInput,
      targetKind: "action" as const,
      actionId: "action-1",
      actor: { kind: "user" as const },
    };
    expect(pluginOutputSlotsForDurableRun(action, "media")).toEqual([
      "image",
      "media",
    ]);
    expect(
      pluginOutputSlotsForDurableRun(
        { ...action, pluginOutputSlot: "render:output" },
        "render:output",
      ),
    ).toEqual(["render:output"]);
    expect(pluginOutputSlotsForDurableRun(frozenInput, "media")).toEqual([
      "media",
    ]);
  });
});

describe("provider durable step mapping", () => {
  it("remaps a completed plugin media output to the run's durable slot", () => {
    const step = executableProviderResultStep(
      run({ outputSlot: "output" }),
      binding,
      "image",
      {
        protocol: "clash.plugin.result/v1",
        invocationId: "idempotency-key",
        status: "completed",
        outputs: [
          {
            slot: "media",
            kind: "asset",
            asset: {
              assetId: "asset-1",
              uri: "clash-asset://asset-1",
              kind: "image",
              mediaType: "image/png",
            },
          },
        ],
      },
    );
    expect(step).toEqual({
      status: "completed",
      outputs: [
        {
          slot: "output",
          kind: "asset",
          asset: {
            assetId: "asset-1",
            uri: "clash-asset://asset-1",
            kind: "image",
            mediaType: "image/png",
          },
        },
      ],
    });
  });

  it("keeps the opaque poll state and retry advice on acceptance", () => {
    const step = executableProviderResultStep(run(), binding, "image", {
      protocol: "clash.plugin.result/v1",
      invocationId: "idempotency-key",
      status: "accepted",
      pollState: { requestId: "req-1", endpoint: "fal-ai/flux/schnell" },
      retryAfterMs: 1000,
    });
    expect(step).toEqual({
      status: "accepted",
      pollState: { requestId: "req-1", endpoint: "fal-ai/flux/schnell" },
      retryAfterMs: 1000,
    });
  });

  it("rejects a response whose binding drifted from the frozen run", () => {
    expect(() =>
      executableProviderStep(run(), {
        status: "failed",
        binding: { ...binding, version: "9.9.9" },
        error: {
          code: "provider_failed",
          message: "upstream failed",
          retryable: false,
          requestState: "accepted",
        },
      }),
    ).toThrow(/binding drifted/);
  });
});

describe("frozen run provider request", () => {
  it("uses the durable idempotency key, remaining attempt lease and frozen values", () => {
    const record = run({
      activeAttempt: {
        operation: "submit",
        number: 1,
        startedAt: 1000,
        expiresAt: 2500,
      },
    });
    const request = executableProviderRequest(record, "idempotency-key", 1500);
    expect(request).toMatchObject({
      taskId: "idempotency-key",
      timeoutMs: 1000,
      pluginId: "clash.fal",
      exportId: "fal-execute",
      accountId: "fal-primary",
      kind: "image",
      projectId: "project-1",
      nodeId: "node-1",
      input: frozenInput.input,
    });
    expect(request).not.toHaveProperty("pollState");
  });

  it("can only be polled with the checkpointed token", () => {
    const record = run({
      activeAttempt: {
        operation: "poll",
        number: 2,
        startedAt: 1000,
        expiresAt: 2000,
      },
    });
    expect(
      executableProviderRequest(record, "idempotency-key", 1200, {
        requestId: "req-1",
      }),
    ).toMatchObject({
      taskId: "idempotency-key",
      pollState: { requestId: "req-1" },
      timeoutMs: 800,
    });
  });
});
