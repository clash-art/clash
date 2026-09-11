import assert from "node:assert/strict";
import test from "node:test";
import { createAssetDocumentsCommand } from "./asset-documents";

test("assets documents get reads only the explicitly selected revision", async () => {
  const calls: string[] = [];
  const output: unknown[] = [];
  const command = createAssetDocumentsCommand({
    request: async (path) => {
      calls.push(path);
      return Response.json({ body: "Pinned script" });
    },
    output: (value) => output.push(value),
  });
  command.exitOverride();
  await command.parseAsync([
    "node",
    "documents",
    "get",
    "script/a",
    "--revision",
    "old/revision",
    "--project",
    "project/a",
  ]);
  assert.deepEqual(calls, [
    "/api/v1/projects/project%2Fa/documents/script%2Fa/revisions/old%2Frevision",
  ]);
  assert.deepEqual(output, [{ body: "Pinned script" }]);
  const headOutput: unknown[] = [];
  const head = createAssetDocumentsCommand({
    request: async (path) => {
      calls.push(path);
      return Response.json({ body: "Current script", readToken: "internal" });
    },
    output: (value) => headOutput.push(value),
  }).exitOverride();
  await head.parseAsync([
    "node",
    "documents",
    "get",
    "script/a",
    "--project",
    "project/a",
  ]);
  assert.equal(
    calls.at(-1),
    "/api/v1/projects/project%2Fa/documents/script%2Fa",
  );
  assert.deepEqual(headOutput.at(-1), { body: "Current script" });
});
