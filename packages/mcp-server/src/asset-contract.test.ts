import test from "node:test";
import assert from "node:assert/strict";

test("MCP exposes the Project Asset peer surface without public CAS inputs", async () => {
  const { ASSET_MCP_TOOL_NAMES } = await import("./asset-contract");
  const { registerClashAssetMcp } = await import("./server");
  const tools = new Map<
    string,
    { config: any; callback: (input: any) => Promise<any> }
  >();
  const server = {
    registerTool(
      name: string,
      config: any,
      callback: (input: any) => Promise<any>,
    ) {
      tools.set(name, { config, callback });
      return {};
    },
  };
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  registerClashAssetMcp(server as never, {
    async invoke(name, input) {
      calls.push({ name, input });
      return name === "clash_assets_list"
        ? []
        : { id: "asset:one", status: "ready" };
    },
  });

  assert.deepEqual(
    [...ASSET_MCP_TOOL_NAMES],
    [
      "clash_assets_list",
      "clash_assets_get",
      "clash_assets_references",
      "clash_assets_import_file",
      "clash_assets_admit",
      "clash_assets_publish",
      "clash_assets_trash",
      "clash_assets_restore",
      "clash_assets_global_list",
      "clash_assets_global_get",
      "clash_assets_global_import_file",
      "clash_assets_global_trash",
      "clash_assets_global_restore",
    ],
  );
  assert.deepEqual([...tools.keys()], [...ASSET_MCP_TOOL_NAMES]);
  for (const { config } of tools.values()) {
    const schema = JSON.stringify(config.inputSchema);
    assert.doesNotMatch(schema, /readToken|receipt|ifMatch|if-match|force/i);
  }
  assert.equal(
    tools.get("clash_assets_trash")?.config.annotations.destructiveHint,
    true,
  );
  assert.ok(
    tools.get("clash_assets_import_file")?.config.inputSchema.projectAssetId,
  );
  assert.ok(
    tools.get("clash_assets_global_import_file")?.config.inputSchema
      .globalAssetId,
  );
  assert.equal(
    tools.get("clash_assets_global_trash")?.config.annotations.destructiveHint,
    true,
  );
  const listed = await tools
    .get("clash_assets_list")
    ?.callback({ projectId: "project-a" });
  assert.deepEqual(listed?.structuredContent, { items: [] });
  assert.deepEqual(calls, [
    {
      name: "clash_assets_list",
      input: { projectId: "project-a" },
    },
  ]);
});

test("MCP Asset failures preserve Host codes and give read recovery without exposing CAS", async () => {
  const { registerClashAssetMcp } = await import("./server");
  const tools = new Map<string, { callback: (input: any) => Promise<any> }>();
  registerClashAssetMcp(
    {
      registerTool(
        name: string,
        _config: unknown,
        callback: (input: any) => Promise<any>,
      ) {
        tools.set(name, { callback });
        return {};
      },
    } as never,
    {
      async invoke(_name, input) {
        if (input.assetId === "asset:stale") {
          throw {
            body: {
              code: "STALE_READ",
              error: "Project Asset changed after the last read",
              projectAssetId: "asset:stale",
            },
          };
        }
        throw new Error("READ_REQUIRED: Read the Project Asset first");
      },
    },
  );

  const failure = await tools.get("clash_assets_trash")?.callback({
    projectId: "project-a",
    assetId: "asset:one",
  });
  assert.equal(failure?.isError, true);
  const readStep = (assetId: string) => ({
    name: "clash_assets",
    arguments: {
      operation: "get",
      arguments: { projectId: "project-a", assetId },
    },
  });
  assert.equal(failure?.structuredContent.error.code, "READ_REQUIRED");
  assert.equal(
    failure?.structuredContent.error.operation,
    "clash_assets_trash",
  );
  assert.deepEqual(failure?.structuredContent.error.retryTool, {
    name: "clash_assets_get",
    arguments: { projectId: "project-a", assetId: "asset:one" },
  });
  assert.deepEqual(
    failure?.structuredContent.error.nextSteps.map(
      ({ tool }: { tool: unknown }) => tool,
    ),
    [readStep("asset:one")],
  );
  // The text an agent reads carries the same call it can copy.
  assert.ok(
    failure?.content[0].text.includes(
      JSON.stringify(readStep("asset:one").arguments),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(failure),
    /readToken|receipt|ifMatch|if-match|force/i,
  );

  const stale = await tools.get("clash_assets_trash")?.callback({
    projectId: "project-a",
    assetId: "asset:stale",
  });
  assert.equal(stale?.structuredContent.error.code, "STALE_READ");
  assert.equal(stale?.structuredContent.error.projectAssetId, "asset:stale");
  assert.deepEqual(stale?.structuredContent.error.retryTool, {
    name: "clash_assets_get",
    arguments: { projectId: "project-a", assetId: "asset:stale" },
  });
  assert.deepEqual(
    stale?.structuredContent.error.nextSteps.map(
      ({ tool }: { tool: unknown }) => tool,
    ),
    [readStep("asset:stale")],
  );
});

test("MCP Asset misuse answers with what went wrong and the exact next call", async () => {
  const { registerClashAssetMcp } = await import("./server");
  const tools = new Map<string, { callback: (input: any) => Promise<any> }>();
  const failures: Record<string, Record<string, unknown>> = {
    clash_assets_import_file: {
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      error: "This content is already imported",
      projectAssetId: "preassigned",
      existingProjectAssetIds: ["asset:minted"],
    },
    clash_assets_get: {
      code: "PROJECT_ASSET_NOT_FOUND",
      error: "Project Asset not found",
      projectAssetId: "minted",
      suggestedProjectAssetIds: ["asset:minted"],
    },
    clash_assets_admit: {
      code: "PROJECT_ASSET_TRASHED",
      error: "in the trash",
      projectAssetId: "asset:minted",
    },
  };
  registerClashAssetMcp(
    {
      registerTool(
        name: string,
        _config: unknown,
        callback: (input: any) => Promise<any>,
      ) {
        tools.set(name, { callback });
        return {};
      },
    } as never,
    {
      async invoke(name, input) {
        const body = failures[name];
        if (body) throw { body };
        return {
          id: input.assetId,
          lifecycle: { state: name.endsWith("trash") ? "trashed" : "active" },
        };
      },
    },
  );
  const call = (name: string, input: Record<string, unknown>) =>
    tools.get(name)!.callback(input);
  const steps = (result: any) =>
    result.structuredContent.error.nextSteps.map(
      ({ tool }: { tool: { arguments: unknown } }) => tool.arguments,
    );
  const said = (result: any, step: unknown) =>
    assert.ok(
      result.content[0].text.includes(JSON.stringify(step)),
      result.content[0].text,
    );

  // Duplicate import: the file was first imported without the id, then again with it.
  const duplicate = await call("clash_assets_import_file", {
    filePath: "inputs/exact-source.svg",
    projectAssetId: "preassigned",
  });
  assert.equal(duplicate.isError, true);
  assert.equal(
    duplicate.structuredContent.error.code,
    "PROJECT_ASSET_DUPLICATE_CONTENT",
  );
  assert.deepEqual(steps(duplicate), [
    { operation: "get", arguments: { assetId: "asset:minted" } },
    { operation: "trash", arguments: { assetId: "asset:minted" } },
    {
      operation: "import_file",
      arguments: {
        filePath: "inputs/exact-source.svg",
        projectAssetId: "preassigned",
      },
    },
    {
      operation: "import_file",
      arguments: {
        filePath: "inputs/exact-source.svg",
        projectAssetId: "preassigned",
        allowDuplicate: true,
      },
    },
  ]);
  for (const step of steps(duplicate)) said(duplicate, step);

  // Wrong id on a read or lifecycle call: the existing id is offered back.
  const missing = await call("clash_assets_get", { assetId: "minted" });
  assert.deepEqual(steps(missing), [
    { operation: "get", arguments: { assetId: "asset:minted" } },
    { operation: "list", arguments: {} },
  ]);
  said(missing, steps(missing)[0]);

  // Re-importing something that sits in the trash: restore, not import.
  const trashed = await call("clash_assets_admit", {
    globalAssetId: "global:one",
  });
  assert.deepEqual(steps(trashed), [
    { operation: "get", arguments: { assetId: "asset:minted" } },
    { operation: "restore", arguments: { assetId: "asset:minted" } },
  ]);

  // Trashing the wrong Asset: the result carries the one call that undoes it.
  const removed = await call("clash_assets_trash", { assetId: "asset:wrong" });
  assert.notEqual(removed.isError, true);
  assert.ok(
    removed.content[0].text.includes(
      JSON.stringify({
        operation: "restore",
        arguments: { assetId: "asset:wrong" },
      }),
    ),
    removed.content[0].text,
  );
});
