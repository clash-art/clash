import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClashMcpServer } from "./server.js";
import { registerDocumentTools } from "./document-tools.js";

test("Document reads preserve the exact revision and use the existing Assets dispatcher", async () => {
  const tools = new Map<
    string,
    { config: any; call: (args: any) => Promise<any> }
  >();
  const calls: string[] = [];
  const body = {
    revision: { id: "revision/old", documentAssetId: "script/a" },
    body: "Original script\nSecond line",
  };
  registerDocumentTools(
    {
      registerTool: (name: string, config: any, call: any) => {
        tools.set(name, { config, call });
      },
    } as never,
    {
      request: async (path) => {
        calls.push(path);
        return path.endsWith("/missing")
          ? Response.json(
              { error: "Document revision not found" },
              { status: 404 },
            )
          : Response.json({ ...body, readToken: "host-observation" });
      },
    },
  );
  const read = tools.get("clash_assets_document_revision_get")!;
  assert.ok(read);
  assert.equal(read.config.inputSchema.revisionId.safeParse("").success, false);
  assert.equal(read.config.annotations.readOnlyHint, true);
  const response = await read.call({
    projectId: "project/a",
    documentAssetId: "script/a",
    revisionId: "revision/old",
  });
  assert.deepEqual(response.structuredContent, { result: body });
  assert.deepEqual(calls, [
    "/api/v1/projects/project%2Fa/documents/script%2Fa/revisions/revision%2Fold",
  ]);
  await assert.rejects(
    () =>
      read.call({
        projectId: "p",
        documentAssetId: "d",
        revisionId: "missing",
      }),
    /404/,
  );
});

test("the Assets dispatcher discloses and executes Document revision reads", async (t) => {
  const server = new ClashMcpServer({ name: "documents", version: "1.0.0" });
  const paths: string[] = [];
  const result = { revision: { id: "pinned" }, body: "Read this exact body" };
  registerDocumentTools(server, {
    request: async (path) => {
      paths.push(path);
      return Response.json(result);
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "documents-reader", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const contract = await client.callTool({
    name: "clash_assets",
    arguments: { contract: "document_revision_get" },
  });
  assert.notEqual(contract.isError, true);
  assert.match(JSON.stringify(contract), /revisionId/);
  assert.deepEqual(paths, []);
  const read = await client.callTool({
    name: "clash_assets",
    arguments: {
      operation: "document_revision_get",
      arguments: {
        projectId: "p",
        documentAssetId: "script",
        revisionId: "pinned",
      },
    },
  });
  assert.notEqual(read.isError, true);
  assert.deepEqual(read.structuredContent, { result });
  assert.deepEqual(paths, [
    "/api/v1/projects/p/documents/script/revisions/pinned",
  ]);
});
