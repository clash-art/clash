import assert from "node:assert/strict";
import test from "node:test";
import { createAssetDocumentsCommand } from "./asset-documents";

test("assets documents get reads only the explicitly selected revision", async () => {
  const calls: string[] = [];
  const output: unknown[] = [];
  const command = createAssetDocumentsCommand({ request: async (path) => { calls.push(path); return Response.json({ body: "Pinned script" }); }, output: (value) => output.push(value) });
  command.exitOverride();
  await command.parseAsync(["node", "documents", "get", "script/a", "--revision", "old/revision", "--project", "project/a"]);
  assert.deepEqual(calls, ["/api/v1/projects/project%2Fa/documents/script%2Fa/revisions/old%2Frevision"]);
  assert.deepEqual(output, [{ body: "Pinned script" }]);
  const missingRevision = createAssetDocumentsCommand({ request: async (path) => { calls.push(path); return Response.json({}); } }).exitOverride();
  for (const child of missingRevision.commands) child.exitOverride();
  await assert.rejects(() => missingRevision.parseAsync(["node", "documents", "get", "script/a", "--project", "project/a"]), /revision/);
  assert.equal(calls.length, 1);
});
