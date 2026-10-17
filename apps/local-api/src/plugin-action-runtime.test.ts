import { describe, expect, it, vi } from "vitest";
import { createExecutablePluginActionInvoker } from "./plugin-action-runtime";

describe("local executable plugin action invoker", () => {
  it("invokes the exact Canvas-pinned action binding over the executable-plugin ABI", async () => {
    const binding = {
      pluginId: "test.agent-caption-actions",
      version: "1.2.0",
      exportId: "run-caption-helper",
      schemaHash: `sha256:${"c".repeat(64)}`,
    } as const;
    const invoke = vi.fn(async (_pluginId: string, invocation: any) => ({
      protocol: "clash.plugin.result/v1" as const,
      invocationId: invocation.invocationId,
      status: "completed" as const,
      outputs: [
        { slot: "result", kind: "value" as const, value: { text: "Done" } },
      ],
    }));
    const invoker = createExecutablePluginActionInvoker({
      client: { invoke },
    });

    const result = await invoker({
      binding,
      invocationId: "task-action-1",
      taskId: "task-action-1",
      projectId: "project-action-1",
      nodeId: "node-action-1",
      input: {
        values: { prompt: "Caption this", tone: "concise" },
        references: [
          {
            slot: "image",
            index: 0,
            asset: {
              assetId: "asset-1",
              uri: "clash-asset://asset-1",
              kind: "image",
            },
          },
        ],
      },
      actor: { kind: "agent", id: "agent-1" },
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(invoke).toHaveBeenCalledWith(
      "test.agent-caption-actions",
      expect.objectContaining({
        protocol: "clash.plugin.invoke/v1",
        taskId: "task-action-1",
        target: { ...binding, kind: "action" },
        actor: { kind: "agent", id: "agent-1" },
      }),
      { timeoutMs: 1_800_000 },
    );
  });

  it("carries an accepted Generator Action poll operation and opaque state over the Action ABI", async () => {
    const binding = {
      pluginId: "test.generator-actions",
      version: "1.2.0",
      exportId: "render",
      schemaHash: `sha256:${"d".repeat(64)}`,
    } as const;
    const invoker = createExecutablePluginActionInvoker({
      client: {
        async invoke(_pluginId, invocation) {
          if (
            invocation.operation !== "poll" ||
            JSON.stringify(invocation.pollState) !==
              JSON.stringify({ upstreamTaskId: "vendor-1" })
          ) {
            throw new Error("Generator Action poll identity was lost");
          }
          return {
            protocol: "clash.plugin.result/v1",
            invocationId: invocation.invocationId,
            status: "completed",
            outputs: [],
          };
        },
      },
    });

    await expect(
      invoker({
        binding,
        invocationId: "run-1",
        taskId: "run-1",
        projectId: "project-1",
        input: { values: {}, references: [] },
        actor: { kind: "system", id: "local-api" },
        operation: "poll",
        pollState: { upstreamTaskId: "vendor-1" },
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });
});
