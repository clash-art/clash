import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClashMcpServer } from "./server";

test("the bundled Clash plugin exposes native control and asset import through its existing MCP dispatcher", async (t) => {
  const calls: unknown[] = [];
  const server = createClashMcpServer({
    bundledAppJavascript: "",
    dccGateway: {
      async invoke(action: string, input: unknown) {
        calls.push({ action, input });
        return action === "screenshot"
          ? { mimeType: "image/png", data: "cHJldmlldw==" }
          : { object: "Imported mesh", assetId: "project-asset" };
      },
    },
  });
  const client = new Client({ name: "dcc-integration-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(({ name }) => name === "clash_plugin"));
  assert.ok(
    !tools.tools.some(({ name }) => name.startsWith("clash_plugin_dcc_")),
  );
  const imported = await client.callTool({
    name: "clash_plugin",
    arguments: {
      operation: "dcc_import_asset",
      arguments: {
        app: "blender",
        cwd: "/workspace",
        assetId: "project-asset",
      },
    },
  });
  assert.equal(imported.isError, undefined);
  assert.deepEqual(imported.structuredContent, {
    object: "Imported mesh",
    assetId: "project-asset",
  });
  const screenshot = await client.callTool({
    name: "clash_plugin",
    arguments: {
      operation: "dcc_screenshot",
      arguments: { app: "maya", cwd: "/workspace" },
    },
  });
  assert.ok(
    (screenshot.content as Array<{ type: string }>).some(
      ({ type }) => type === "image",
    ),
  );
  assert.deepEqual(calls, [
    {
      action: "import_asset",
      input: { app: "blender", cwd: "/workspace", assetId: "project-asset" },
    },
    { action: "screenshot", input: { app: "maya", cwd: "/workspace" } },
  ]);
});

test("Maya bundled tool catalog and calls stay behind the existing dispatcher with literal arguments", async (t) => {
  const calls: unknown[] = [];
  const server = createClashMcpServer({
    bundledAppJavascript: "",
    dccGateway: {
      async invoke(action, input) {
        calls.push({ action, input });
        return { result: input.toolArguments ?? [] };
      },
    },
  });
  const client = new Client({ name: "maya-tools-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  const args = { object_name: "模型'\\\\name\n" };
  const result = await client.callTool({
    name: "clash_plugin",
    arguments: {
      operation: "dcc_maya_call",
      arguments: { app: "maya", tool: "select_object", toolArguments: args },
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { result: args });
  const catalog = await client.callTool({
    name: "clash_plugin",
    arguments: { operation: "dcc_maya_tools", arguments: { app: "maya" } },
  });
  assert.equal(catalog.isError, undefined);
  assert.deepEqual(calls, [
    {
      action: "maya_call",
      input: { app: "maya", tool: "select_object", toolArguments: args },
    },
    { action: "maya_tools", input: { app: "maya" } },
  ]);
});
