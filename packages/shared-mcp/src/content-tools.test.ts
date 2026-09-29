import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClashMcpServer } from "./server.js";
import { registerActionTools } from "./action-tools.js";

test("Assets dispatcher lists, searches and reads exact content references in the cwd Project", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "clash-content-mcp-"));
  await mkdir(join(cwd, ".clash"));
  await writeFile(
    join(cwd, ".clash/project.toml"),
    'schema_version = 1\nproject_id = "school-project"\n',
  );
  const server = new ClashMcpServer({ name: "content", version: "1.0.0" });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const ref = {
    kind: "document",
    documentAssetId: "notes/one",
    revisionId: "pinned:old",
  };
  const readValue = {
    revision: { id: ref.revisionId },
    body: "Left sleeve at six seconds",
  };
  registerActionTools(server, {
    request: async (path, init) => {
      calls.push({ path, init });
      if (path.includes("/revisions/")) return Response.json(readValue);
      return Response.json({
        items: [
          {
            ref,
            name: "Observations",
            kind: "document",
            info: { documentKind: "media.observation" },
            matches: [],
          },
        ],
        truncated: false,
        matchMode: init?.method === "POST" ? "literal-text" : null,
        countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 1 },
      });
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "content-reader", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const contract = await client.callTool({
    name: "clash_assets",
    arguments: {
      contracts: ["content_list", "content_search", "content_read"],
    },
  });
  assert.notEqual(contract.isError, true);
  assert.match(JSON.stringify(contract), /within/);
  assert.equal(calls.length, 0);
  const call = (operation: string, args: Record<string, unknown>) =>
    client.callTool({
      name: "clash_assets",
      arguments: { operation, arguments: { cwd, ...args } },
    });
  const listed = await call("content_list", {
    kinds: ["document"],
    limit: 5,
    query: "sleeve",
    cursor: "page-token",
  });
  assert.notEqual(listed.isError, true);
  assert.equal(
    new URL(calls[0].path, "http://host").searchParams.get("cursor"),
    "page-token",
  );
  assert.deepEqual((listed.structuredContent as any).result.items[0].ref, ref);
  assert.equal(
    new URL(calls[0].path, "http://host").pathname,
    "/api/v1/projects/school-project/content",
  );
  assert.equal(
    new URL(calls[0].path, "http://host").searchParams.get("query"),
    "sleeve",
  );
  const searched = await call("content_search", {
    query: "left sleeve",
    cursor: "search-token",
    within: ref,
  });
  assert.notEqual(searched.isError, true);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    query: "left sleeve",
    cursor: "search-token",
    within: ref,
  });
  const read = await call("content_read", {
    ref: (searched.structuredContent as any).result.items[0].ref,
  });
  assert.notEqual(read.isError, true);
  assert.deepEqual(read.structuredContent, { result: readValue });
  assert.equal(
    calls[2].path,
    "/api/v1/projects/school-project/documents/notes%2Fone/revisions/pinned%3Aold",
  );
  const beforeInvalid = calls.length;
  const invalid = await call("content_read", {
    ref: { kind: "document", documentAssetId: "notes/one" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, beforeInvalid);
  for (const operation of ["content_list", "content_search"]) {
    const typo = await call(operation, { query: "sleeve", kinds: ["vedio"] });
    assert.equal(typo.isError, true);
    assert.match(JSON.stringify(typo), /Did you mean.*video/);
    assert.match(JSON.stringify(typo), /image, video, audio, model, document/);
    assert.equal(calls.length, beforeInvalid);
    const unrelated = await call(operation, { kinds: ["not-a-kind"] });
    assert.equal(unrelated.isError, true);
    assert.doesNotMatch(JSON.stringify(unrelated), /Did you mean/);
    assert.match(
      JSON.stringify(unrelated),
      /image, video, audio, model, document/,
    );
    assert.equal(calls.length, beforeInvalid);
  }
  // Enum discovery stays machine-readable; suggestions do not widen accepted values.
  assert.match(JSON.stringify(contract), /"enum"/);
});
