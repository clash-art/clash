import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import {
  ClashMcpServer,
  describeClashTool,
  McpSchemaCompatibilityTransport,
  projectClashMcpWireJsonSchema,
} from "./index.js";

test("renders one concise operational description contract for every Clash tool", () => {
  assert.equal(
    describeClashTool({
      useWhen: "you know a Canvas node id and need its current product state",
      effect:
        "Read the complete node and record the observation used by guarded mutations",
      returns:
        "The node, immutable status, asset metadata, and execution status",
      next: "Choose update, copy, execute, or no mutation from the returned state",
    }),
    [
      "Use when: you know a Canvas node id and need its current product state.",
      "Effect: Read the complete node and record the observation used by guarded mutations.",
      "Returns: The node, immutable status, asset metadata, and execution status.",
      "Next: Choose update, copy, execute, or no mutation from the returned state.",
    ].join(" "),
  );
  assert.throws(
    () =>
      describeClashTool({
        useWhen: "",
        effect: "read",
        returns: "state",
        next: "continue",
      }),
    /useWhen/i,
  );
});

function arrayItemPaths(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      arrayItemPaths(entry, `${path}[${index}]`),
    );
  }
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record.items) ? [`${path}.items`] : []),
    ...Object.entries(record).flatMap(([key, child]) =>
      arrayItemPaths(child, `${path}.${key}`),
    ),
  ];
}

function firstTextContent(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.content)) return "";
  const first = result.content[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return "";
  const record = first as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : "";
}

test("one shared server boundary projects homogeneous fixed tuples for every tool", async (t) => {
  const server = new ClashMcpServer({
    name: "shared-mcp-test",
    version: "1.0.0",
  });
  server.registerTool(
    "plot_point",
    {
      inputSchema: {
        point: z.tuple([z.number(), z.number()]),
      },
    },
    async ({ point }) => ({
      content: [{ type: "text", text: `${point[0]},${point[1]}` }],
    }),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shared-mcp-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  assert.match(client.getInstructions() ?? "", /progressive/i);
  assert.match(client.getInstructions() ?? "", /root clash tool/i);
  assert.match(
    client.getInstructions() ?? "",
    /descriptions.*schemas.*results/i,
  );

  const advertisedTools = (await client.listTools()).tools;
  assert.ok(advertisedTools.some(({ name }) => name === "clash"));
  const tool = advertisedTools.find(({ name }) => name === "plot_point");
  assert.ok(tool);
  assert.deepEqual(arrayItemPaths(tool.inputSchema), []);
  assert.deepEqual(tool.inputSchema.properties?.point, {
    type: "array",
    items: { type: "number" },
    minItems: 2,
    maxItems: 2,
  });

  const result = await client.callTool({
    name: "plot_point",
    arguments: { point: [3, 4] },
  });
  assert.equal(result.isError, undefined);
  const invalid = await client.callTool({
    name: "plot_point",
    arguments: { point: [3] },
  });
  assert.equal(invalid.isError, true);
});

test("Canvas and composition dispatchers keep tools/list stable while legacy groups remain callable", async (t) => {
  const server = new ClashMcpServer({
    name: "progressive-clash",
    version: "1.0.0",
  });
  const result = (text: string) => ({
    content: [{ type: "text" as const, text }],
  });
  server.registerTool(
    "clash_workspace_init",
    {
      title: "Initialize workspace",
      description: "Bind a workspace.",
    },
    async () => result("workspace"),
  );
  server.registerTool(
    "clash_canvas_get",
    {
      title: "Read Canvas node",
      description: "Read one Canvas node.",
    },
    async () => result("canvas"),
  );
  let assetCalls = 0;
  server.registerTool(
    "clash_assets_get",
    {
      title: "Read Project Asset",
      description: "Read one Project-scoped ResolvedAsset.",
      inputSchema: { assetId: z.string().min(1) },
    },
    async ({ assetId }) => {
      assetCalls += 1;
      return result(`asset:${assetId}`);
    },
  );
  let directorCalls = 0;
  server.registerTool(
    "clash_director_get",
    {
      title: "Read Director stage",
      description: "Read one spatial composition.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      directorCalls += 1;
      return result(`director:${id}`);
    },
  );
  let timelineCalls = 0;
  server.registerTool(
    "clash_timeline_get",
    {
      title: "Read Timeline",
      description: "Read one temporal composition.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      timelineCalls += 1;
      return result(`timeline:${id}`);
    },
  );
  server.registerTool(
    "clash_canvas_snapshot",
    {
      title: "Canvas app snapshot",
      description: "Refresh an app-only projection.",
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => result("app"),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "progressive-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const names = async () =>
    (await client.listTools()).tools.map(({ name }) => name).sort();
  const fixedNames = [
    "clash",
    "clash_assets",
    "clash_canvas",
    "clash_composition",
    "clash_generators",
    "clash_plugin",
    "clash_workspace_init",
  ];
  assert.deepEqual(await names(), fixedNames);

  const root = await client.callTool({ name: "clash", arguments: {} });
  assert.equal(root.isError, undefined);
  const rootView = root.structuredContent as {
    selectedCommand?: string;
    commands: Array<{ id: string; availableOperations: number }>;
    operations?: unknown[];
  };
  assert.equal(rootView.selectedCommand, undefined);
  assert.equal(rootView.operations, undefined);
  assert.equal(
    rootView.commands.find(({ id }) => id === "director")?.availableOperations,
    1,
  );
  assert.equal(
    rootView.commands.find(({ id }) => id === "canvas")?.availableOperations,
    1,
  );
  assert.equal(
    rootView.commands.find(({ id }) => id === "assets")?.availableOperations,
    1,
  );

  const assetNavigation = await client.callTool({
    name: "clash",
    arguments: { command: "assets" },
  });
  assert.equal(
    (assetNavigation.structuredContent as { selectedDispatcher?: string })
      .selectedDispatcher,
    "clash_assets",
  );
  const assets = await client.callTool({ name: "clash_assets", arguments: {} });
  assert.deepEqual(
    (
      assets.structuredContent as {
        operations: Array<{ name: string; operation: string }>;
      }
    ).operations.map(({ name, operation }) => ({ name, operation })),
    [{ name: "clash_assets_get", operation: "get" }],
  );
  const asset = await client.callTool({
    name: "clash_assets",
    arguments: { operation: "get", arguments: { assetId: "asset-1" } },
  });
  assert.equal(asset.isError, undefined);
  assert.equal(assetCalls, 1);

  const director = await client.callTool({
    name: "clash",
    arguments: { command: "director" },
  });
  assert.deepEqual(director.structuredContent, {
    ...rootView,
    selectedCommand: "director",
    selectedDispatcher: "clash_composition",
    selectedKind: "director-stage",
  });
  assert.deepEqual(await names(), fixedNames);

  const timelineNavigation = await client.callTool({
    name: "clash",
    arguments: { command: "timeline" },
  });
  assert.equal(
    (timelineNavigation.structuredContent as { selectedDispatcher?: string })
      .selectedDispatcher,
    "clash_composition",
  );
  assert.equal(
    (timelineNavigation.structuredContent as { selectedKind?: string })
      .selectedKind,
    "timeline",
  );

  const canvas = await client.callTool({ name: "clash_canvas", arguments: {} });
  assert.deepEqual(
    (
      canvas.structuredContent as {
        operations: Array<{ name: string; operation: string }>;
      }
    ).operations.map(({ name, operation }) => ({ name, operation })),
    [{ name: "clash_canvas_get", operation: "get" }],
  );
  assert.deepEqual(await names(), fixedNames);

  const timeline = await client.callTool({
    name: "clash_composition",
    arguments: { kind: "timeline" },
  });
  assert.deepEqual(
    (
      timeline.structuredContent as {
        operations: Array<{ name: string; operation: string }>;
      }
    ).operations.map(({ name, operation }) => ({ name, operation })),
    [{ name: "clash_timeline_get", operation: "get" }],
  );
  const directorView = await client.callTool({
    name: "clash_composition",
    arguments: { kind: "director-stage" },
  });
  assert.deepEqual(
    (
      directorView.structuredContent as { operations: Array<{ name: string }> }
    ).operations.map(({ name }) => name),
    ["clash_director_get"],
  );
  assert.deepEqual(await names(), fixedNames);

  const timelineGet = await client.callTool({
    name: "clash_composition",
    arguments: {
      kind: "timeline",
      operation: "get",
      arguments: { id: "timeline-1" },
    },
  });
  assert.equal(timelineGet.isError, undefined);
  assert.equal(timelineCalls, 1);
  assert.equal(directorCalls, 0);

  const directorGet = await client.callTool({
    name: "clash_composition",
    arguments: {
      kind: "director-stage",
      operation: "get",
      arguments: { id: "stage-1" },
    },
  });
  assert.equal(directorGet.isError, undefined);
  assert.equal(timelineCalls, 1);
  assert.equal(directorCalls, 1);

  const inferredExact = await client.callTool({
    name: "clash_composition",
    arguments: {
      operation: "clash_timeline_get",
      arguments: { id: "timeline-2" },
    },
  });
  assert.equal(inferredExact.isError, undefined);
  assert.equal(timelineCalls, 2);

  for (const invalidArguments of [
    {},
    { operation: "get", arguments: { id: "missing-kind" } },
    {
      kind: "director-stage",
      operation: "clash_timeline_get",
      arguments: { id: "wrong-kind" },
    },
    { operation: "clash_canvas_get", arguments: {} },
    { kind: "canvas" },
  ]) {
    const invalid = await client.callTool({
      name: "clash_composition",
      arguments: invalidArguments,
    });
    assert.equal(
      invalid.isError,
      true,
      JSON.stringify({ invalidArguments, invalid }),
    );
  }
  assert.equal(
    timelineCalls,
    2,
    "invalid composition calls must not reach Timeline",
  );
  assert.equal(
    directorCalls,
    1,
    "invalid composition calls must not reach Director Stage",
  );

  // Known clients may still call old groups directly even though discovery
  // exposes only the composition dispatcher.
  const directLegacy = await client.callTool({
    name: "clash_timeline",
    arguments: {
      operation: "clash_timeline_get",
      arguments: { id: "timeline-legacy" },
    },
  });
  assert.equal(directLegacy.isError, undefined);
  assert.equal(timelineCalls, 3);
  assert.deepEqual(await names(), fixedNames);
});

test("Assets dispatcher reveals one complete operation contract without executing it", async (t) => {
  const server = new ClashMcpServer({
    name: "asset-contract-disclosure-test",
    version: "1.0.0",
  });
  let executions = 0;
  server.registerTool(
    "clash_assets_import_file",
    {
      title: "Import Project Asset file",
      description: describeClashTool({
        useWhen: "a workspace file should become a Project Asset",
        effect: "imports the file through the selected Clash Host",
        returns: "the imported Project Asset",
        next: "use the returned Project Asset ID",
      }),
      inputSchema: {
        filePath: z.string().min(1),
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ filePath }) => {
      executions += 1;
      return {
        content: [{ type: "text", text: `Imported ${filePath}.` }],
        structuredContent: { projectAssetId: "asset-1" },
      };
    },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "asset-contract-disclosure-client",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const disclosed = await client.callTool({
    name: "clash_assets",
    arguments: { contract: "import_file" },
  });
  const contract = (
    disclosed.structuredContent as {
      contract: {
        name: string;
        operation: string;
        title: string;
        inputSchema: { required?: string[] };
        recovery: { retryOperationPath: string };
      };
    }
  ).contract;
  assert.deepEqual(
    {
      name: contract.name,
      operation: contract.operation,
      title: contract.title,
      required: contract.inputSchema.required,
      retryOperationPath: contract.recovery.retryOperationPath,
    },
    {
      name: "clash_assets_import_file",
      operation: "import_file",
      title: "Import Project Asset file",
      required: ["filePath"],
      retryOperationPath: "structuredContent.error.retryTool",
    },
  );
  assert.equal(executions, 0);
});

test("Assets dispatcher reveals a requested contract batch in request order without executing it", async (t) => {
  const server = new ClashMcpServer({
    name: "asset-contract-batch-test",
    version: "1.0.0",
  });
  let executions = 0;
  const registerAssetTool = (
    name: "clash_assets_import_file" | "clash_assets_list" | "clash_assets_get",
    title: string,
    inputSchema: Record<string, z.ZodTypeAny>,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description: describeClashTool({
          useWhen: `${title} is needed`,
          effect: `performs ${title}`,
          returns: `${title} result`,
          next: "continue with the returned Asset",
        }),
        inputSchema,
        _meta: { ui: { visibility: ["model"] } },
      },
      async () => {
        executions += 1;
        return {
          content: [{ type: "text", text: `${title} completed.` }],
          structuredContent: { ok: true },
        };
      },
    );
  };
  registerAssetTool("clash_assets_get", "Read Project Asset", {
    assetId: z.string().min(1),
  });
  registerAssetTool("clash_assets_import_file", "Import Project Asset file", {
    filePath: z.string().min(1),
  });
  registerAssetTool("clash_assets_list", "List Project Assets", {
    projectId: z.string().min(1).optional(),
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "asset-contract-batch-client",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const disclosed = await client.callTool({
    name: "clash_assets",
    arguments: { contracts: ["import_file", "list", "get"] },
  });
  const contracts = (
    disclosed.structuredContent as {
      contracts?: Array<{
        name: string;
        operation: string;
        inputSchema: { required?: string[] };
      }>;
    }
  ).contracts;
  assert.ok(contracts, "expected an explicit contract batch");
  assert.deepEqual(
    contracts.map(({ name, operation, inputSchema }) => ({
      name,
      operation,
      required: inputSchema.required,
    })),
    [
      {
        name: "clash_assets_import_file",
        operation: "import_file",
        required: ["filePath"],
      },
      {
        name: "clash_assets_list",
        operation: "list",
        required: undefined,
      },
      {
        name: "clash_assets_get",
        operation: "get",
        required: ["assetId"],
      },
    ],
  );
  assert.equal(executions, 0);
});

test("Assets dispatcher rejects duplicate operations in one contract batch", async (t) => {
  const server = new ClashMcpServer({
    name: "asset-contract-batch-unique-test",
    version: "1.0.0",
  });
  server.registerTool(
    "clash_assets_get",
    {
      title: "Read Project Asset",
      inputSchema: { assetId: z.string().min(1) },
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => ({
      content: [{ type: "text", text: "Read Asset." }],
      structuredContent: { id: "asset-1" },
    }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "asset-contract-batch-unique-client",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const rejected = await client.callTool({
    name: "clash_assets",
    arguments: { contracts: ["get", "clash_assets_get"] },
  });
  assert.equal(rejected.isError, true);
  assert.match(firstTextContent(rejected), /distinct|duplicate|unique/i);
});

test("Assets dispatcher fails a contract batch closed when one operation is unknown", async (t) => {
  const server = new ClashMcpServer({
    name: "asset-contract-batch-unknown-test",
    version: "1.0.0",
  });
  let executions = 0;
  server.registerTool(
    "clash_assets_get",
    {
      title: "Read Project Asset",
      inputSchema: { assetId: z.string().min(1) },
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => {
      executions += 1;
      return {
        content: [{ type: "text", text: "Read Asset." }],
        structuredContent: { id: "asset-1" },
      };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "asset-contract-batch-unknown-client",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const rejected = await client.callTool({
    name: "clash_assets",
    arguments: { contracts: ["get", "missing"] },
  });
  assert.equal(rejected.isError, true);
  assert.match(firstTextContent(rejected), /missing.*not registered|unknown/i);
  assert.equal(
    (rejected.structuredContent as { contracts?: unknown } | undefined)
      ?.contracts,
    undefined,
  );
  assert.equal(executions, 0);
});

test("Assets dispatcher rejects an unbounded contract batch before disclosure", async (t) => {
  const server = new ClashMcpServer({
    name: "asset-contract-batch-limit-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "asset-contract-batch-limit-client",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const rejected = await client.callTool({
    name: "clash_assets",
    arguments: {
      contracts: Array.from({ length: 64 }, (_, index) => `operation-${index}`),
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(
    firstTextContent(rejected),
    /too (?:many|big)|maximum|at most|<=/i,
  );
});

test("the root Clash tool reveals live leaf contracts and dispatches them without a tools/list refresh", async (t) => {
  const server = new ClashMcpServer({
    name: "root-dispatch",
    version: "1.0.0",
  });
  const calls: Array<{ nodeId: string; requestId: unknown }> = [];
  server.registerTool(
    "clash_canvas_get",
    {
      title: "Read Canvas node",
      description: describeClashTool({
        useWhen: "one current Canvas node is needed",
        effect: "reads the persisted node",
        returns: "the node and revision",
        next: "read it again before retrying a stale mutation",
      }),
      inputSchema: {
        nodeId: z.string().min(1).describe("Stable Canvas node id"),
      },
      annotations: { readOnlyHint: true },
      _meta: {
        "clash/readProof": { recordsObservation: true },
        ui: { visibility: ["model"] },
      },
    },
    async ({ nodeId }, extra) => {
      calls.push({ nodeId, requestId: extra.requestId });
      return {
        content: [{ type: "text", text: `Read ${nodeId}` }],
        structuredContent: { node: { id: nodeId }, revisionId: "revision-1" },
      };
    },
  );
  let mutationCalls = 0;
  const mutation = server.registerTool(
    "clash_canvas_update",
    {
      title: "Update Canvas node",
      description: describeClashTool({
        useWhen: "one Canvas node must change",
        effect: "updates the persisted node once",
        returns: "the updated node identity",
        next: "read the node back before continuing",
      }),
      inputSchema: { nodeId: z.string().min(1) },
      outputSchema: { updated: z.literal(true), nodeId: z.string().min(1) },
    },
    async ({ nodeId }) => {
      mutationCalls += 1;
      return {
        content: [{ type: "text", text: `Updated ${nodeId}` }],
        structuredContent: { updated: true as const, nodeId },
      };
    },
  );
  let hiddenCalls = 0;
  server.registerTool(
    "clash_canvas_hidden",
    {
      description: "App-only Canvas helper.",
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      hiddenCalls += 1;
      return { content: [{ type: "text", text: "hidden" }] };
    },
  );
  let disabledCalls = 0;
  const disabled = server.registerTool(
    "clash_canvas_disabled",
    {
      description: "Disabled Canvas helper.",
    },
    async () => {
      disabledCalls += 1;
      return { content: [{ type: "text", text: "disabled" }] };
    },
  );
  disabled.disable();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "static-tool-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const initialTools = await client.listTools();
  const fixedToolNames = [
    "clash",
    "clash_assets",
    "clash_canvas",
    "clash_composition",
    "clash_generators",
    "clash_plugin",
  ];
  assert.deepEqual(
    initialTools.tools.map(({ name }) => name).sort(),
    fixedToolNames,
  );
  assert.equal(initialTools.tools.length, fixedToolNames.length);
  assert.equal(
    initialTools.tools.find(({ name }) => name === "clash")?.annotations,
    undefined,
    "a dispatcher spanning read, write, destructive, and provider operations must not understate its effects",
  );
  assert.match(
    initialTools.tools.find(({ name }) => name === "clash_canvas")
      ?.description ?? "",
    /operation.*arguments/i,
  );
  const canvasInputSchema = initialTools.tools.find(
    ({ name }) => name === "clash_canvas",
  )?.inputSchema as {
    properties?: Record<string, { description?: unknown }>;
  };
  const compositionInputSchema = initialTools.tools.find(
    ({ name }) => name === "clash_composition",
  )?.inputSchema as {
    properties?: Record<string, { description?: unknown }>;
  };
  assert.match(
    String(canvasInputSchema.properties?.operation?.description ?? ""),
    /omit.*entirely.*live contracts.*empty string.*list_operations.*contracts/i,
  );
  assert.match(
    String(compositionInputSchema.properties?.operation?.description ?? ""),
    /omit.*entirely.*live contracts.*empty string.*list_operations.*contracts/i,
  );

  const rootNavigation = await client.callTool({
    name: "clash",
    arguments: { command: "canvas" },
  });
  assert.equal(
    (rootNavigation.structuredContent as { selectedDispatcher?: string })
      .selectedDispatcher,
    "clash_canvas",
  );
  assert.equal(
    (rootNavigation.structuredContent as { operations?: unknown[] }).operations,
    undefined,
  );
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name).sort(),
    fixedToolNames,
  );

  const revealed = await client.callTool({
    name: "clash_canvas",
    arguments: {},
  });
  const operation = (
    revealed.structuredContent as {
      operations: Array<{
        name: string;
        operation: string;
        inputSchema: Record<string, any>;
        outputSchema?: Record<string, any>;
        recovery: Record<string, string>;
        metadata?: Record<string, unknown>;
      }>;
    }
  ).operations.find(({ name }) => name === "clash_canvas_get");
  assert.ok(operation);
  assert.equal(operation.operation, "get");
  assert.equal(operation.inputSchema.type, "object");
  assert.equal(
    operation.inputSchema.properties.nodeId.description,
    "Stable Canvas node id",
  );
  assert.deepEqual(operation.inputSchema.required, ["nodeId"]);
  assert.deepEqual(operation.recovery, {
    guidance: "read it again before retrying a stale mutation.",
    retryOperationPath: "structuredContent.error.retryTool",
    staleMergePath: "structuredContent.error.recovery",
  });
  assert.deepEqual(operation.metadata, {
    "clash/readProof": { recordsObservation: true },
  });
  const updateOperation = (
    revealed.structuredContent as {
      operations: Array<{
        name: string;
        outputSchema?: Record<string, any>;
      }>;
    }
  ).operations.find(({ name }) => name === "clash_canvas_update");
  assert.equal(updateOperation?.outputSchema?.properties.updated.const, true);
  assert.deepEqual(
    (
      revealed.structuredContent as { operations: Array<{ name: string }> }
    ).operations.map(({ name }) => name),
    ["clash_canvas_get", "clash_canvas_update"],
    "disabled and app-only operations must stay out of root discovery",
  );

  // Deliberately do not call tools/list again: clients such as Codex keep the
  // initial tool set fixed for the turn.
  const dispatched = await client.callTool({
    name: "clash_canvas",
    arguments: {
      operation: "get",
      arguments: { nodeId: "node-7" },
    },
  });
  assert.equal(dispatched.isError, undefined);
  assert.deepEqual(dispatched.structuredContent, {
    node: { id: "node-7" },
    revisionId: "revision-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.nodeId, "node-7");
  assert.notEqual(calls[0]?.requestId, undefined);

  const mutated = await client.callTool({
    name: "clash_canvas",
    arguments: {
      operation: "clash_canvas_update",
      arguments: { nodeId: "node-7" },
    },
  });
  assert.equal(mutated.isError, undefined);
  assert.deepEqual(mutated.structuredContent, {
    updated: true,
    nodeId: "node-7",
  });
  assert.equal(
    mutationCalls,
    1,
    "one root call must invoke a mutating leaf exactly once",
  );

  mutation.update({
    callback: async ({ nodeId }) => {
      mutationCalls += 1;
      return {
        content: [{ type: "text", text: `Invalid update ${nodeId}` }],
        structuredContent: { updated: false, nodeId },
      };
    },
  });
  const invalidOutput = await client.callTool({
    name: "clash",
    arguments: {
      operation: "clash_canvas_update",
      arguments: { nodeId: "node-8" },
    },
  });
  assert.equal(invalidOutput.isError, true);
  assert.match(
    (invalidOutput.content as Array<{ text?: string }>)[0]?.text ?? "",
    /invalid structured content.*clash_canvas_update/i,
  );
  assert.equal(
    mutationCalls,
    2,
    "output validation must not re-run a mutating leaf",
  );

  const invalid = await client.callTool({
    name: "clash_canvas",
    arguments: {
      operation: "get",
      arguments: {},
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(
    (invalid.content as Array<{ text?: string }>)[0]?.text ?? "",
    /nodeId/i,
  );
  assert.equal(
    calls.length,
    1,
    "invalid dispatcher input must not reach the leaf handler",
  );

  const shortWithoutCommand = await client.callTool({
    name: "clash",
    arguments: { operation: "get", arguments: { nodeId: "node-8" } },
  });
  assert.equal(shortWithoutCommand.isError, true);
  assert.match(
    (shortWithoutCommand.content as Array<{ text?: string }>)[0]?.text ?? "",
    /root.*complete.*clash_\*/i,
  );
  assert.equal(calls.length, 1);

  for (const operationName of [
    "clash_canvas_hidden",
    "clash_canvas_disabled",
  ]) {
    const unavailable = await client.callTool({
      name: "clash_canvas",
      arguments: { operation: operationName, arguments: {} },
    });
    assert.equal(unavailable.isError, true);
    assert.match(
      (unavailable.content as Array<{ text?: string }>)[0]?.text ?? "",
      /not registered, enabled, and model-visible/i,
    );
  }
  assert.equal(hiddenCalls, 0);
  assert.equal(disabledCalls, 0);

  const rootCompatible = await client.callTool({
    name: "clash",
    arguments: {
      operation: "clash_canvas_get",
      arguments: { nodeId: "node-root-compatible" },
    },
  });
  assert.equal(rootCompatible.isError, undefined);
  assert.equal(calls.at(-1)?.nodeId, "node-root-compatible");

  const directLegacy = await client.callTool({
    name: "clash_canvas_get",
    arguments: { nodeId: "node-legacy" },
  });
  assert.equal(directLegacy.isError, undefined);
  assert.equal(calls.at(-1)?.nodeId, "node-legacy");
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name).sort(),
    fixedToolNames,
  );
});

test("the fixed plugin dispatcher reveals and executes live plugin operations", async (t) => {
  const server = new ClashMcpServer({
    name: "plugin-dispatch",
    version: "1.0.0",
  });
  server.registerTool(
    "clash_plugin_list",
    {
      title: "List active plugins",
      description: describeClashTool({
        useWhen: "the active executable plugins must be inspected",
        effect: "reads the live local Host plugin catalog",
        returns: "the active plugin summaries",
        next: "create, install, or use the selected plugin",
      }),
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["model"] } },
    },
    async () => ({
      content: [{ type: "text", text: "Found one active plugin." }],
      structuredContent: {
        plugins: [
          {
            id: "acme.caption-helper",
            version: "1.0.0",
            drifted: false,
          },
        ],
      },
    }),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "plugin-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const initialToolNames = (await client.listTools()).tools.map(
    ({ name }) => name,
  );
  assert.ok(initialToolNames.includes("clash_plugin"));
  assert.equal(initialToolNames.includes("clash_plugin_list"), false);

  const navigation = await client.callTool({
    name: "clash",
    arguments: { command: "plugin" },
  });
  assert.equal(
    (navigation.structuredContent as { selectedDispatcher?: string })
      .selectedDispatcher,
    "clash_plugin",
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
    ).operations.map(({ operation, readOnly, destructive }) => ({
      operation,
      readOnly,
      destructive,
    })),
    [{ operation: "list", readOnly: true, destructive: false }],
  );

  const listed = await client.callTool({
    name: "clash_plugin",
    arguments: { operation: "list", arguments: {} },
  });
  assert.deepEqual(listed.structuredContent, {
    plugins: [
      {
        id: "acme.caption-helper",
        version: "1.0.0",
        drifted: false,
      },
    ],
  });
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name),
    initialToolNames,
  );
});

test("the fixed generators dispatcher reveals and dispatches a live registered Project Generator leaf", async (t) => {
  const server = new ClashMcpServer({
    name: "generators-dispatch",
    version: "1.0.0",
  });
  let getCalls = 0;
  server.registerTool(
    "clash_generators_get",
    {
      title: "Read a registered Project Generator",
      description: describeClashTool({
        useWhen: "a registered Project Generator's head revision is needed",
        effect: "reads the live registered Project Generator exactly once",
        returns: "the Project Generator id and its head Revision id",
        next: "run an Action against the returned head Revision",
      }),
      inputSchema: {
        generatorId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ generatorId }) => {
      getCalls += 1;
      return {
        content: [{ type: "text", text: `Read ${generatorId}.` }],
        structuredContent: { generatorId, headRevisionId: "revision-1" },
      };
    },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "generators-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const initialTools = (await client.listTools()).tools;
  const initialToolNames = initialTools.map(({ name }) => name);
  assert.ok(initialToolNames.includes("clash_generators"));
  assert.equal(initialToolNames.includes("clash_generators_get"), false);
  const generatorsDescription = initialTools.find(
    ({ name }) => name === "clash_generators",
  )?.description;
  assert.match(
    generatorsDescription ?? "",
    /image.{0,80}video.{0,80}audio.{0,160}Clash Project/i,
  );

  const navigation = await client.callTool({
    name: "clash",
    arguments: { command: "generators" },
  });
  assert.equal(
    (navigation.structuredContent as { selectedDispatcher?: string })
      .selectedDispatcher,
    "clash_generators",
  );

  const contracts = await client.callTool({
    name: "clash_generators",
    arguments: {},
  });
  assert.deepEqual(
    (
      contracts.structuredContent as {
        operations: Array<{
          name: string;
          operation: string;
          readOnly: boolean;
          destructive: boolean;
        }>;
      }
    ).operations.map(({ name, operation, readOnly, destructive }) => ({
      name,
      operation,
      readOnly,
      destructive,
    })),
    [
      {
        name: "clash_generators_get",
        operation: "get",
        readOnly: true,
        destructive: false,
      },
    ],
  );

  const read = await client.callTool({
    name: "clash_generators",
    arguments: {
      operation: "get",
      arguments: { generatorId: "acme-generator" },
    },
  });
  assert.equal(read.isError, undefined);
  assert.deepEqual(read.structuredContent, {
    generatorId: "acme-generator",
    headRevisionId: "revision-1",
  });
  assert.equal(getCalls, 1);

  const invalid = await client.callTool({
    name: "clash_generators",
    arguments: { operation: "get", arguments: {} },
  });
  assert.equal(invalid.isError, true);
  assert.equal(getCalls, 1, "invalid arguments must not reach the leaf");

  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name),
    initialToolNames,
  );
});

test("wire projection is immutable, idempotent, and does not rewrite example data", () => {
  const source = {
    type: "object",
    properties: {
      point: {
        type: "array",
        items: [{ type: "number" }, { type: "number" }],
        minItems: 2,
        maxItems: 2,
        examples: [{ items: ["this", "is", "data"] }],
      },
    },
  };
  const before = structuredClone(source);
  const projected = projectClashMcpWireJsonSchema(source);
  assert.deepEqual(source, before);
  assert.deepEqual(projected, {
    type: "object",
    properties: {
      point: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        examples: [{ items: ["this", "is", "data"] }],
      },
    },
  });
  assert.deepEqual(projectClashMcpWireJsonSchema(projected), projected);
});

test("projects homogeneous 2020-12 prefixItems through the same policy", () => {
  assert.deepEqual(
    projectClashMcpWireJsonSchema({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "string" }, { type: "string" }],
      items: false,
    }),
    {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
    },
  );
});

test("the shared boundary rejects heterogeneous tuples instead of widening them", async (t) => {
  const server = new ClashMcpServer({
    name: "shared-mcp-test",
    version: "1.0.0",
  });
  server.registerTool(
    "unsafe_tuple",
    {
      inputSchema: {
        value: z.tuple([z.string(), z.number()]),
      },
    },
    async () => ({ content: [{ type: "text", text: "unreachable" }] }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shared-mcp-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await assert.rejects(
    client.listTools(),
    /schema projection failed.*heterogeneous tuple.*unsafe_tuple.*input/i,
  );
});

test("transport decoration preserves lifecycle callbacks, session state, and send options", async () => {
  const sent: Array<{ message: any; options: any }> = [];
  const lifecycle = { close: 0, error: 0, message: 0, protocol: "" };
  const inner: any = {
    sessionId: "session-before",
    onclose: () => {
      lifecycle.close += 1;
    },
    onerror: () => {
      lifecycle.error += 1;
    },
    onmessage: () => {
      lifecycle.message += 1;
    },
    start: async () => undefined,
    send: async (message: any, options: any) => {
      sent.push({ message, options });
    },
    close: async function close() {
      this.onclose?.();
    },
    setProtocolVersion: (version: string) => {
      lifecycle.protocol = version;
    },
  };
  const transport = new McpSchemaCompatibilityTransport(inner);
  let forwardedMessages = 0;
  transport.onmessage = () => {
    forwardedMessages += 1;
  };
  await transport.start();

  transport.sessionId = "session-after";
  assert.equal(inner.sessionId, "session-after");
  assert.equal(transport.sessionId, "session-after");
  transport.setProtocolVersion("2025-06-18");
  assert.equal(lifecycle.protocol, "2025-06-18");

  inner.onmessage({ jsonrpc: "2.0", id: 17, method: "tools/list" });
  assert.equal(lifecycle.message, 1);
  assert.equal(forwardedMessages, 1);
  const options = { relatedRequestId: 17 };
  await transport.send(
    {
      jsonrpc: "2.0",
      id: 17,
      result: {
        tools: [
          {
            name: "tuple_tool",
            inputSchema: {
              type: "object",
              properties: {
                point: {
                  type: "array",
                  items: [{ type: "number" }, { type: "number" }],
                },
              },
            },
          },
        ],
      },
    },
    options,
  );
  assert.equal(sent[0]?.options, options);
  assert.deepEqual(
    sent[0]?.message.result.tools[0].inputSchema.properties.point,
    {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
  );

  await transport.close();
  assert.equal(lifecycle.close, 1);
});
