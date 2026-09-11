import assert from "node:assert/strict";
import test from "node:test";
import { createGeneratorsCommand } from "./generators";

function harness(response: Response = Response.json({ ok: true })) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const output: unknown[] = [];
  const command = createGeneratorsCommand({
    request: async (path, init) => {
      calls.push({ path, init });
      return response.clone();
    },
    output: (value) => output.push(value),
  });
  command.exitOverride();
  return { command, calls, output };
}

test("generators argv maps to exact action-run route and JSON body", async () => {
  const h = harness();
  await h.command.parseAsync([
    "node",
    "generators",
    "runs",
    "submit",
    "generator/a",
    "render",
    "--project",
    "project/a",
    "--input",
    '{"revisionId":"r1"}',
  ]);
  assert.equal(
    h.calls[0]?.path,
    "/api/v1/projects/project%2Fa/generators/generator%2Fa/actions/render/runs",
  );
  assert.equal(h.calls[0]?.init?.body, '{"revisionId":"r1"}');
  assert.deepEqual(h.output, [{ ok: true }]);
});

test("generators reports malformed JSON before making a request", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      h.command.parseAsync([
        "node",
        "generators",
        "create",
        "--project",
        "p",
        "--input",
        "{",
      ]),
    /--input must be valid JSON/,
  );
  assert.deepEqual(h.calls, []);
});

test("generators preserves structured HTTP errors", async () => {
  const h = harness(
    Response.json({ code: "STALE", expected: "r2" }, { status: 409 }),
  );
  await assert.rejects(
    () =>
      h.command.parseAsync([
        "node",
        "generators",
        "get",
        "g",
        "--project",
        "p",
      ]),
    (error: any) =>
      error.status === 409 &&
      error.body.code === "STALE" &&
      error.body.expected === "r2",
  );
});

test("generators reveals input contracts without contacting or binding a project", async () => {
  const h = harness();
  await h.command.parseAsync(["node", "generators", "contract", "create"]);
  assert.deepEqual(h.calls, []);
  const contract = h.output[0] as { operation: string; inputSchema: { properties: Record<string, unknown>; required: string[] } };
  assert.equal(contract.operation, "create");
  assert.ok(contract.inputSchema.properties.placement);
  assert.ok(contract.inputSchema.required.includes("generatorRevisionId"));
  const submit = harness();
  await submit.command.parseAsync(["node", "generators", "contract", "submit"]);
  const schema = (submit.output[0] as typeof contract).inputSchema;
  assert.ok(schema.properties.providerAccountId);
  assert.ok(schema.required.includes("generatorRevisionId"));
  assert.deepEqual(submit.calls, []);
});
