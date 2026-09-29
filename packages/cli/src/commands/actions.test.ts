import assert from "node:assert/strict";
import test from "node:test";
import { createActionsCommand } from "./actions";

test("actions wait resumes one named Run and exposes its terminal result without submitting", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const output: unknown[] = [];
  const command = createActionsCommand({
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Response.json({
        run: { actionRunId: "known/run", status: "failed" },
      });
    },
    output: (value: unknown) => output.push(value),
  });
  await command.parseAsync([
    "node",
    "actions",
    "wait",
    "known/run",
    "--project",
    "p/a",
    "--wait-ms",
    "0",
  ]);
  assert.equal(
    calls[0]?.path,
    "/api/v1/projects/p%2Fa/generator-runs/known%2Frun",
  );
  assert.ok(
    calls.every((call) => !call.init?.method || call.init.method === "GET"),
  );
  assert.equal((output[0] as any).actionRunId, "known/run");
  assert.equal((output[0] as any).status, "failed");
});

test("malformed action parameters fail before project mutations", async () => {
  const calls: string[] = [];
  const command = createActionsCommand({
    request: async (path: string) => {
      calls.push(path);
      return Response.json({});
    },
  });
  await assert.rejects(
    command.parseAsync([
      "node",
      "actions",
      "run",
      "image-editor.transform",
      "--project",
      "p",
      "--params",
      "[",
    ]),
    /params.*JSON/i,
  );
  assert.deepEqual(calls, []);
});
