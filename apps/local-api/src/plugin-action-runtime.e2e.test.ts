import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActionsHost } from "./runtime/host/lib/actions-loader.js";
import {
  PluginHostClient,
  startPluginHostIpcServer,
} from "./runtime/host/lib/plugin-host-ipc.js";
import { expect, it } from "vitest";

import { createExecutablePluginActionInvoker } from "./plugin-action-runtime";
import {
  activateHostExecutablePluginPackage,
  type HostExecutablePluginPackage,
} from "./runtime/plugin-package.js";

function encodeDocument(value: unknown): string {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64");
}

function executableActionPackage(version: string, prefix = ""): HostExecutablePluginPackage {
  const id = "test.caption-helper";
  const cardPath = `cards/${id}.json`;
  const contractPath = `contract-tests/${id}.json`;
  const entrypoint = "handler.mjs";
  const manifest = {
    apiVersion: "clash.plugin/v1",
    id,
    version,
    name: "Caption Helper",
    runtime: {
      kind: "local",
      transport: "stdio",
      language: "node",
      entrypoint,
    },
    contributes: {
      cards: [{ id, kind: "action-card", path: cardPath }],
      functions: [{ id, kind: "action" }],
    },
    contractTests: [contractPath],
  };
  const card = {
    apiVersion: "clash.card/v1",
    kind: "action-card",
    spec: {
      id,
      name: "Caption Helper",
      parameters: [],
      outputType: "text",
      input: { requiresPrompt: true, inputMode: {}, promptModalities: ["text"] },
      functionExportId: id,
    },
  };
  const contract = {
    apiVersion: "clash.plugin.contract-test/v1",
    id: `${id}-basic`,
    target: { exportId: id, kind: "action" },
    input: { values: { prompt: "Describe the result" }, references: [] },
    expect: {
      status: "completed",
      outputs: [{
        slot: "result",
        kind: "value",
        value: { text: `${prefix}Describe the result` },
      }],
    },
  };
  const handler = [
    'import { createInterface } from "node:readline";',
    "",
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    "  const invocation = JSON.parse(line);",
    '  if (invocation.protocol !== "clash.plugin.invoke/v1") return;',
    '  const prompt = typeof invocation.input?.values?.prompt === "string"',
    "    ? invocation.input.values.prompt",
    '    : "";',
    "  const result = {",
    '    protocol: "clash.plugin.result/v1",',
    "    invocationId: invocation.invocationId,",
    '    status: "completed",',
    `    outputs: [{ slot: "result", kind: "value", value: { text: ${JSON.stringify(prefix)} + prompt } }],`,
    "  };",
    "  process.stdout.write(`${JSON.stringify(result)}\\n`);",
    "});",
    "",
  ].join("\n");

  return {
    id,
    manifest,
    files: {
      [cardPath]: encodeDocument(card),
      [contractPath]: encodeDocument(contract),
      [entrypoint]: Buffer.from(handler).toString("base64"),
    },
  };
}

async function replaceActivePackage(
  actionsRoot: string,
  pkg: HostExecutablePluginPackage,
): Promise<void> {
  await rm(join(actionsRoot, pkg.id), { recursive: true, force: true });
  await activateHostExecutablePluginPackage(pkg, actionsRoot);
}

async function waitForBindingVersion(
  client: PluginHostClient,
  version: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const binding = await client.resolveBinding("test.caption-helper", "test.caption-helper", "action");
      if (binding.version === version) return binding;
      lastError = new Error(`Expected ${version}, received ${binding.version}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for caption-helper ${version}.`);
}

it("runs a host-owned action Card through activation, hot discovery, and exact stdio ABI", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-agent-action-e2e-"));
  const actionsRoot = join(workspace, "actions");
  const v1 = executableActionPackage("0.1.0");
  await activateHostExecutablePluginPackage(v1, actionsRoot);

  const host = new ActionsHost({
    actionsRoot,
  });
  const socketPath = join(workspace, "plugin-host.sock");
  let ipc: Awaited<ReturnType<typeof startPluginHostIpcServer>> | null = null;
  try {
    await host.start();
    ipc = await startPluginHostIpcServer({ host, socketPath });
    const client = new PluginHostClient({ socketPath });
    const [registration] = await client.listCards();
    expect(registration).toMatchObject({
      pluginId: "test.caption-helper",
      version: "0.1.0",
      document: { kind: "action-card", spec: { id: "test.caption-helper" } },
    });
    const binding = await client.resolveBinding("test.caption-helper", "test.caption-helper", "action");
    const result = await createExecutablePluginActionInvoker({ client })({
      binding,
      invocationId: "task-caption-e2e",
      taskId: "task-caption-e2e",
      projectId: "project-caption-e2e",
      nodeId: "node-caption-e2e",
      input: { values: { prompt: "Caption this" }, references: [] },
      actor: { kind: "agent", id: "agent-e2e" },
    });
    expect(result).toMatchObject({
      status: "completed",
      outputs: [{ slot: "result", kind: "value", value: { text: "Caption this" } }],
    });

    const v2 = executableActionPackage("0.2.0", "v2:");
    await replaceActivePackage(actionsRoot, v2);
    const v2Binding = await waitForBindingVersion(client, "0.2.0");
    expect(v2Binding.schemaHash).not.toBe(binding.schemaHash);
    const v2Result = await createExecutablePluginActionInvoker({ client })({
      binding: v2Binding,
      invocationId: "task-caption-v2",
      taskId: "task-caption-v2",
      projectId: "project-caption-e2e",
      nodeId: "node-caption-e2e",
      input: { values: { prompt: "Caption this" }, references: [] },
      actor: { kind: "agent", id: "agent-e2e" },
    });
    expect(v2Result.status).toBe("completed");
    if (v2Result.status === "failed") throw new Error(v2Result.error.message);
    if (v2Result.status !== "completed") throw new Error(`Unexpected status ${v2Result.status}`);
    expect(v2Result.outputs).toEqual([
      { slot: "result", kind: "value", value: { text: "v2:Caption this" } },
    ]);

    await replaceActivePackage(actionsRoot, v1);
    const restoredBinding = await waitForBindingVersion(client, "0.1.0");
    expect(restoredBinding.schemaHash).toBe(binding.schemaHash);
    const restoredResult = await createExecutablePluginActionInvoker({ client })({
      binding: restoredBinding,
      invocationId: "task-caption-restored",
      taskId: "task-caption-restored",
      projectId: "project-caption-e2e",
      nodeId: "node-caption-e2e",
      input: { values: { prompt: "Caption this" }, references: [] },
      actor: { kind: "agent", id: "agent-e2e" },
    });
    expect(restoredResult.status).toBe("completed");
    if (restoredResult.status === "failed") throw new Error(restoredResult.error.message);
    if (restoredResult.status !== "completed") throw new Error(`Unexpected status ${restoredResult.status}`);
    expect(restoredResult.outputs).toEqual([
      { slot: "result", kind: "value", value: { text: "Caption this" } },
    ]);
  } finally {
    await ipc?.close();
    await host.stopAll();
  }
});
