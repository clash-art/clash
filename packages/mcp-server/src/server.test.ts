import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("server keeps Studio and Canvas App surfaces quarantined", async () => {
  const { registerClashCanvasMcp } = await import("./server");
  const { CANVAS_MCP_TOOL_NAMES } = await import("./canvas-contract");
  const tools = new Map<
    string,
    { config: any; callback: (input: any) => Promise<any> }
  >();
  const resources = new Map<
    string,
    { uri: string; callback: () => Promise<any> }
  >();
  const fakeServer = {
    registerTool(
      name: string,
      config: any,
      callback: (input: any) => Promise<any>,
    ) {
      tools.set(name, { config, callback });
      return {};
    },
    registerResource(
      name: string,
      uri: string,
      config: any,
      callback: () => Promise<any>,
    ) {
      resources.set(name, { uri, callback });
      return {};
    },
  };

  const register = registerClashCanvasMcp as unknown as (
    server: never,
    gateway: {
      invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
    },
    canvasJavascript: string,
    studioJavascript: string,
  ) => void;
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  register(
    fakeServer as never,
    {
      async invoke(name, input) {
        calls.push({ name, input });
        return name.endsWith("list") || name.endsWith("edges")
          ? []
          : { ok: true };
      },
    },
    "window.__CLASH_CANVAS__ = true;",
    "window.__CLASH_STUDIO__ = true;",
  );

  assert.equal(tools.has("clash_studio_open"), false);
  assert.equal(tools.has("clash_canvas_open"), false);
  assert.equal(tools.has("clash_canvas_snapshot"), false);
  for (const name of CANVAS_MCP_TOOL_NAMES.filter(
    (name) => name !== "clash_canvas_open" && name !== "clash_canvas_snapshot",
  ))
    assert.ok(tools.has(name));
  for (const name of ["clash_canvas_add", "clash_canvas_update"]) {
    assert.ok(
      "contentFile" in (tools.get(name)?.config.inputSchema ?? {}),
      `${name} must expose workspace contentFile ingestion`,
    );
  }
  for (const name of ["clash_canvas_add"]) {
    assert.match(
      tools.get(name)?.config.description ?? "",
      /Asset nodes can only be connected to generation nodes\./,
      `${name} must expose the generation-to-asset graph relationship`,
    );
  }
  assert.ok(tools.has("clash_workspace_init"));
  assert.deepEqual(
    [...tools.keys()].filter((name) => name.startsWith("clash_cli_")),
    [],
    "MCP and CLI are peer transports; MCP must not publish CLI namespace wrappers",
  );
  const workspace = await mkdtemp(join(tmpdir(), "clash-native-mcp-init-"));
  const initialized = await tools.get("clash_workspace_init")?.callback({
    cwd: workspace,
    projectId: "benchmark-project",
  });
  assert.deepEqual(
    calls,
    [],
    "native workspace init must not shell through the CLI runner",
  );
  assert.deepEqual(initialized?.structuredContent, {
    projectId: "benchmark-project",
    workspaceId: initialized?.structuredContent.workspaceId,
    markerPath: join(workspace, ".clash", "project.toml"),
    reused: false,
  });
  assert.deepEqual(initialized?.content, [
    {
      type: "text",
      text: "Created Clash workspace for project benchmark-project.",
    },
  ]);
  assert.match(
    initialized?.structuredContent.workspaceId,
    /^managed:[a-f0-9]{16}$/,
  );
  const markerPath = join(workspace, ".clash", "project.toml");
  const markerBeforeReuse = await readFile(markerPath, "utf8");
  assert.match(markerBeforeReuse, /project_id = "benchmark-project"/);

  const reused = await tools.get("clash_workspace_init")?.callback({
    cwd: workspace,
    projectId: "benchmark-project",
  });
  assert.deepEqual(reused?.structuredContent, {
    ...initialized?.structuredContent,
    reused: true,
  });
  assert.deepEqual(reused?.content, [
    {
      type: "text",
      text: "Reused Clash workspace for project benchmark-project.",
    },
  ]);
  assert.equal(await readFile(markerPath, "utf8"), markerBeforeReuse);

  const conflict = await tools.get("clash_workspace_init")?.callback({
    cwd: workspace,
    projectId: "different-project",
  });
  assert.equal(conflict?.isError, true);
  assert.match(
    conflict?.content[0]?.text,
    /already bound.*benchmark-project.*different-project/i,
  );
  assert.equal(conflict?.structuredContent, undefined);
  assert.equal(await readFile(markerPath, "utf8"), markerBeforeReuse);
  assert.equal(resources.size, 0);
  for (const name of ["clash_canvas_list", "clash_canvas_move"]) {
    assert.equal(
      tools.get(name)?.config._meta.ui.resourceUri,
      undefined,
      `${name} must stay headless instead of opening an MCP App`,
    );
    assert.equal(
      tools.get(name)?.config._meta["ui/resourceUri"],
      undefined,
      `${name} must not publish the legacy App resource key`,
    );
  }
});

test("bundled MCP gives Assets a lightweight operation index before execution", async (t) => {
  const { createClashMcpServer } = await import("./server");
  const assetCalls: Array<{ name: string; input: Record<string, unknown> }> =
    [];
  const server = createClashMcpServer({
    bundledAppJavascript: "window.__CLASH_CANVAS__ = true;",
    bundledStudioAppJavascript: "window.__CLASH_STUDIO__ = true;",
    gateway: {
      async invoke(name) {
        return name.endsWith("list") || name.endsWith("edges")
          ? []
          : { ok: true };
      },
    },
    assetGateway: {
      async invoke(name, input) {
        assetCalls.push({ name, input });
        return name === "clash_assets_list"
          ? []
          : { id: "asset:one", status: "ready" };
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "asset-peer-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const names = (await client.listTools()).tools.map(({ name }) => name).sort();
  assert.deepEqual(names, [
    "clash",
    "clash_assets",
    "clash_canvas",
    "clash_composition",
    "clash_generators",
    "clash_plugin",
    "clash_workspace_init",
  ]);
  const index = await client.callTool({
    name: "clash_assets",
    arguments: {},
  });
  const indexedOperations = (
    index.structuredContent as {
      operations: Array<Record<string, unknown> & { operation: string }>;
    }
  ).operations;
  assert.deepEqual(
    indexedOperations.map(({ operation }) => operation),
    [
      "admit",
      "get",
      "global_get",
      "global_import_file",
      "global_list",
      "global_restore",
      "global_trash",
      "import_file",
      "list",
      "publish",
      "references",
      "restore",
      "trash",
    ],
  );
  for (const operation of indexedOperations) {
    assert.equal("description" in operation, false);
    assert.equal("inputSchema" in operation, false);
    assert.equal("outputSchema" in operation, false);
    assert.equal("recovery" in operation, false);
    assert.equal("metadata" in operation, false);
  }
  assert.deepEqual(assetCalls, []);
  const selected = await client.callTool({
    name: "clash_assets",
    arguments: { contracts: ["import_file", "list", "get"] },
  });
  const selectedContracts = (
    selected.structuredContent as {
      contracts?: Array<{
        operation: string;
        inputSchema: { required?: string[] };
      }>;
    }
  ).contracts;
  assert.ok(selectedContracts, "expected an explicit Asset contract batch");
  assert.deepEqual(
    selectedContracts.map(({ operation, inputSchema }) => ({
      operation,
      required: inputSchema.required,
    })),
    [
      { operation: "import_file", required: ["filePath"] },
      { operation: "list", required: undefined },
      { operation: "get", required: ["assetId"] },
    ],
  );
  assert.deepEqual(assetCalls, []);
  const listed = await client.callTool({
    name: "clash_assets",
    arguments: { operation: "list", arguments: { projectId: "project-a" } },
  });
  assert.deepEqual(listed.structuredContent, { items: [] });
  assert.deepEqual(assetCalls, [
    {
      name: "clash_assets_list",
      input: { projectId: "project-a" },
    },
  ]);
});

test("bundled MCP registers Generator leaves with the authenticated Host API transport", async (t) => {
  const { createClashMcpServer } = await import("./server");
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json([{ definitionId: "render" }]);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const server = createClashMcpServer({
    client: {
      resolveConnection: async () => ({
        endpoint: "http://host.test/",
        token: "secret",
      }),
      resolveContext: async () => ({ projectId: "p", source: "explicit" }),
      request: async <T extends Record<string, unknown>>() => ({
        projectId: "p",
        value: {} as T,
      }),
    },
    bundledAppJavascript: "",
    bundledStudioAppJavascript: "",
    gateway: { invoke: async () => [] },
    assetGateway: { invoke: async () => [] },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "generator-registration",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const contracts = await client.callTool({
    name: "clash_generators",
    arguments: {},
  });
  assert.ok(
    (
      contracts.structuredContent as {
        operations: Array<{ operation: string }>;
      }
    ).operations.some(({ operation }) => operation === "definitions_list"),
  );
  await client.callTool({
    name: "clash_generators",
    arguments: { operation: "definitions_list", arguments: {} },
  });
  assert.deepEqual(requests, [
    {
      url: "http://host.test/api/v1/generator-definitions",
      authorization: "Bearer secret",
    },
  ]);
});

test("bundled MCP exposes executable plugin lifecycle through the fixed plugin dispatcher", async (t) => {
  const { createClashMcpServer } = await import("./server");
  const server = createClashMcpServer({
    bundledAppJavascript: "window.__CLASH_CANVAS__ = true;",
    bundledStudioAppJavascript: "window.__CLASH_STUDIO__ = true;",
    gateway: {
      async invoke(name) {
        return name.endsWith("list") || name.endsWith("edges")
          ? []
          : { ok: true };
      },
    },
    assetGateway: {
      async invoke(name) {
        return name.endsWith("list") ? [] : { id: "asset:one" };
      },
    },
    pluginGateway: {
      async invoke(name: string, input: Record<string, unknown>) {
        return { invoked: name, input };
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "plugin-lifecycle-test",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const toolNames = (await client.listTools()).tools.map(({ name }) => name);
  assert.ok(toolNames.includes("clash_plugin"));
  assert.equal(
    toolNames.some((name) => name.startsWith("clash_plugin_")),
    false,
  );

  const contracts = await client.callTool({
    name: "clash_plugin",
    arguments: {},
  });
  assert.deepEqual(
    (
      contracts.structuredContent as {
        operations: Array<{
          operation: string;
          readOnly: boolean;
          destructive: boolean;
        }>;
      }
    ).operations
      .filter(({ operation }) => !operation.startsWith("dcc_"))
      .map(({ operation, readOnly, destructive }) => ({
        operation,
        readOnly,
        destructive,
      })),
    [
      { operation: "activate", readOnly: false, destructive: false },
      { operation: "checkout", readOnly: false, destructive: false },
      { operation: "create", readOnly: false, destructive: false },
      { operation: "install", readOnly: false, destructive: false },
      { operation: "list", readOnly: true, destructive: false },
      { operation: "rollback", readOnly: false, destructive: true },
      { operation: "uninstall", readOnly: false, destructive: true },
      { operation: "validate", readOnly: false, destructive: false },
    ],
  );

  const created = await client.callTool({
    name: "clash_plugin",
    arguments: {
      operation: "create",
      arguments: {
        cwd: "/work/project",
        directory: "plugins/caption-helper",
        id: "acme.caption-helper",
        name: "Caption Helper",
        kind: "action",
        language: "ts",
      },
    },
  });
  assert.deepEqual(created.structuredContent, {
    invoked: "clash_plugin_create",
    input: {
      cwd: "/work/project",
      directory: "plugins/caption-helper",
      id: "acme.caption-helper",
      name: "Caption Helper",
      kind: "action",
      language: "ts",
    },
  });

  const removed = await client.callTool({
    name: "clash_plugin",
    arguments: {
      operation: "uninstall",
      arguments: { id: "acme.caption-helper" },
    },
  });
  assert.deepEqual(removed.structuredContent, {
    invoked: "clash_plugin_uninstall",
    input: { id: "acme.caption-helper" },
  });
});
