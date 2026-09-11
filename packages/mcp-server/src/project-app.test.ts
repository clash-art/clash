import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProjectHostClient } from "@clash/shared-runtime/project-host-client";

// Exercise the advertised tool/resource relationship over MCP, including the
// existing /projects/:id route and the official MCP Apps CSP contract.
test("project opener resolves the workspace and binds the real editor to its UI resource", async (t) => {
  const module = await import("./project-app").catch(() => ({}));
  assert.ok(
    "registerProjectApp" in module,
    "project App registration is missing",
  );
  const { registerProjectApp } = module as typeof import("./project-app");
  const server = new McpServer({ name: "project-test", version: "1" });
  const hostClient: Pick<ProjectHostClient, "resolveContext"> = {
    async resolveContext(input) {
      if (input?.cwd === "/missing") throw new Error("Workspace is not linked");
      return { projectId: input?.projectId ?? "my project", source: "marker" };
    },
  };
  registerProjectApp(server, hostClient, {
    webUrl: "http://localhost:3456",
    bundledJavascript: "/* project app bundle */",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  const tool = (await client.listTools()).tools.find(
    (tool) => tool.name === "clash_project_open",
  );
  assert.ok(tool);
  const uri = (tool._meta?.ui as { resourceUri: string }).resourceUri;
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(resource.contents[0]._meta?.ui, {
    prefersBorder: false,
    csp: { frameDomains: ["http://localhost:3456"] },
  });
  const opened = await client.callTool({
    name: tool.name,
    arguments: { cwd: "/workspace" },
  });
  assert.equal(opened.isError, undefined);
  assert.partialDeepStrictEqual(opened.structuredContent, {
    projectId: "my project",
    projectUrl: "http://localhost:3456/projects/my%20project",
  });
  const explicit = await client.callTool({
    name: tool.name,
    arguments: { projectId: "other" },
  });
  assert.partialDeepStrictEqual(explicit.structuredContent, {
    projectUrl: "http://localhost:3456/projects/other",
  });
  const failed = await client.callTool({
    name: tool.name,
    arguments: { cwd: "/missing" },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent, undefined);
});

test("project App discovers the daemon lazily and uses its origin for both tool output and iframe CSP", async (t) => {
  const { registerProjectApp } = await import("./project-app");
  const server = new McpServer({ name: "daemon-project", version: "1" });
  let daemonStarted = false;
  registerProjectApp(
    server,
    {
      async resolveContext() {
        return { projectId: "local", source: "marker" };
      },
    },
    {
      webUrl: async () => {
        daemonStarted = true;
        return "http://127.0.0.1:49123";
      },
      bundledJavascript: "/* app */",
    },
  );
  assert.equal(daemonStarted, false);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  const tool = (await client.listTools()).tools.find(
    ({ name }) => name === "clash_project_open",
  )!;
  const result = await client.callTool({ name: tool.name, arguments: {} });
  assert.partialDeepStrictEqual(result.structuredContent, {
    projectUrl: "http://127.0.0.1:49123/projects/local",
  });
  const resource = await client.readResource({
    uri: (tool._meta?.ui as { resourceUri: string }).resourceUri,
  });
  assert.deepEqual((resource.contents[0]._meta?.ui as { csp: unknown }).csp, {
    frameDomains: ["http://127.0.0.1:49123"],
  });
});
