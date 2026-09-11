import { expect, it } from "vitest";
import { createExecutorContext } from "@clash/action-sdk";
import {
  ExecutablePluginManifestSchema,
  ExecutablePluginInvocationSchema,
} from "@clash/shared-types";
import { createLocalExecutablePluginBroker } from "./local-plugin-broker.js";

const context = {
  manifest: ExecutablePluginManifestSchema.parse({
    apiVersion: "clash.plugin/v1",
    id: "test.agent-text",
    version: "1.0.0",
    name: "Agent text",
    runtime: { kind: "local", transport: "stdio", entrypoint: "unused.mjs" },
    contributes: {
      functions: [{ id: "write", kind: "action" }],
      hostTools: ["agent.text"],
    },
  }),
  invocation: ExecutablePluginInvocationSchema.parse({
    protocol: "clash.plugin.invoke/v1",
    invocationId: "invoke-1",
    taskId: "run-1",
    projectId: "project-1",
    target: {
      pluginId: "test.agent-text",
      version: "1.0.0",
      exportId: "write",
      kind: "action",
      schemaHash: `sha256:${"a".repeat(64)}`,
    },
    actor: { kind: "user", id: "user-1" },
    input: { values: {}, references: [] },
  }),
};

it("routes the SDK text request to the invocation's Project and existing Host agent executor", async () => {
  let received: unknown;
  const broker = createLocalExecutablePluginBroker({
    loadProviderAccounts: async () => [],
    generateAgentText: async (input: unknown) => {
      received = input;
      return { text: "First line.\n\nSecond line." };
    },
  });
  const sdk = createExecutorContext({}, async (operation) =>
    broker(
      {
        protocol: "clash.plugin.broker-request/v1",
        requestId: "request-1",
        invocationId: "invoke-1",
        operation,
      },
      context,
    ),
  );
  const generate = (sdk.hostTools as unknown as Record<string, unknown>)
    .agentText as
    ((request: Record<string, unknown>) => Promise<unknown>) | undefined;
  expect(generate).toBeTypeOf("function");
  if (!generate) return;
  await expect(
    generate({
      prompt: "Write two lines.",
      agentId: "test-harness",
      modelId: "selected-model",
      systemPrompt: "Be concise.",
    }),
  ).resolves.toEqual({ text: "First line.\n\nSecond line." });
  expect(received).toEqual({
    projectId: "project-1",
    prompt: "Write two lines.",
    agentId: "test-harness",
    modelId: "selected-model",
    systemPrompt: "Be concise.",
  });
  await expect(
    generate({ prompt: "Write elsewhere.", projectId: "other-project" }),
  ).rejects.toThrow();
});

it("refuses agent execution without the declared Host capability", async () => {
  let executed = false;
  const broker = createLocalExecutablePluginBroker({
    loadProviderAccounts: async () => [],
    generateAgentText: async () => {
      executed = true;
      return { text: "must not run" };
    },
  });
  await expect(
    broker(
      {
        protocol: "clash.plugin.broker-request/v1",
        requestId: "request-1",
        invocationId: "invoke-1",
        operation: { kind: "agent.text.generate", prompt: "Write something." },
      },
      {
        ...context,
        manifest: {
          ...context.manifest,
          contributes: { ...context.manifest.contributes, hostTools: [] },
        },
      },
    ),
  ).rejects.toThrow(/agent text/i);
  expect(executed).toBe(false);
});

it("rejects an invalid Host text result at the SDK boundary", async () => {
  const sdk = createExecutorContext({}, async () => ({
    text: { nested: "not a text body" },
  }));
  await expect(
    sdk.hostTools.agentText({ prompt: "Write something." }),
  ).rejects.toThrow(/invalid agent text/i);
});
