import assert from "node:assert/strict";
import test from "node:test";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { GeneratorHttpError } from "@clash/shared-runtime/generator-client";
import { registerGeneratorTools } from "./generator-tools.js";

test("Generator leaves preserve routes, bodies, results, annotations, and errors", async () => {
  const tools = new Map<
    string,
    { config: any; call: (input: any) => Promise<any> }
  >();
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  registerGeneratorTools(
    {
      registerTool: (name: string, config: any, call: any) =>
        void tools.set(name, { config, call }),
    } as never,
    {
      request: async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith("/generator-runs/bad"))
          return Response.json({ code: "RUN_NOT_FOUND" }, { status: 404 });
        return Response.json({ id: "result-1" });
      },
    },
  );

  const create = tools.get("clash_generators_create")!;
  // Regression from the real Hilo session: disclosure accepted a body without
  // the IDs required by the existing HTTP creation contract.
  assert.equal(create.config.inputSchema.input.safeParse({
    pluginId: "clash.model-generation", definitionId: "video", state: {},
  }).success, false);
  assert.equal(create.config.inputSchema.input.safeParse({
    generatorId: "draft", generatorRevisionId: "draft-r1",
    pluginId: "clash.model-generation", definitionId: "video", state: {},
  }).success, true);
  const disclosed = toJsonSchemaCompat(create.config.inputSchema.input, { pipeStrategy: "input" });
  assert.ok(Array.isArray(disclosed.required));
  assert.ok(disclosed.required.includes("generatorId"));
  assert.ok(disclosed.required.includes("generatorRevisionId"));
  const submit = tools.get("clash_generators_action_run_submit")!;
  assert.equal(submit.config.inputSchema.input.safeParse({ generatorRevisionId: "draft-r1" }).success, false);
  const submitted = submit.config.inputSchema.input.parse({
    actionRunId: "run", generatorRevisionId: "draft-r1", providerAccountId: "hilo-hub-primary",
  });
  assert.equal(submitted.providerAccountId, "hilo-hub-primary");
  const creationInput = {
    generatorId: "draft", generatorRevisionId: "draft-r1", pluginId: "clash.model-generation", definitionId: "video",
    state: { modelId: "minimax-h3", prompt: "A paper city" }, persistentInputRefs: [],
    placement: { canvasId: "main", nodeId: "placement", position: { x: 70, y: 40 } },
  };
  const created = await create.call({ projectId: "project/a", input: creationInput });
  assert.deepEqual(calls[0], {
    path: "/api/v1/projects/project%2Fa/generators",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creationInput),
    },
  });
  assert.deepEqual(created.structuredContent, { result: { id: "result-1" } });
  assert.deepEqual(created.content, [
    { type: "text", text: '{"id":"result-1"}' },
  ]);
  assert.deepEqual(create.config.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
  });
  assert.deepEqual(tools.get("clash_generators_get")!.config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });

  await assert.rejects(
    () =>
      tools
        .get("clash_generators_action_run_get")!
        .call({ projectId: "p", actionRunId: "bad" }),
    (error: unknown) =>
      error instanceof GeneratorHttpError &&
      error.status === 404 &&
      JSON.stringify(error.body) === JSON.stringify({ code: "RUN_NOT_FOUND" }),
  );
});
