import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function host(endpoint = "http://127.0.0.1:49321") {
  return {
    schemaVersion: 1 as const,
    protocolVersion: 1,
    dataSchemaVersion: 1,
    hostId: "daemon-test",
    endpoint,
    pid: process.pid,
    launchMode: "user-service" as const,
    startedBy: "plugin" as const,
    profile: "prod" as const,
    startedAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

async function workspace(projectId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clash-mcp-host-client-"));
  await mkdir(join(root, ".clash"), { recursive: true });
  await writeFile(
    join(root, ".clash", "project.toml"),
    ["schema_version = 1", `project_id = ${JSON.stringify(projectId)}`, ""].join("\n"),
    "utf8",
  );
  return root;
}

test("MCP sends a typed command directly to the ensured local-api endpoint", async (t) => {
  const { createMcpProjectHostClient } = await import("./host-runner.js");
  const cwd = await workspace("project-workspace");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: Array<{ url: string; body: unknown }> = [];
  let ensures = 0;
  const client = createMcpProjectHostClient({
    env: {
      CLASH_WORKSPACE_ROOT: cwd,
      // If the implementation regresses to MCP -> CLI this deliberately fails.
      CLASH_CLI_ENTRY_PATH: join(cwd, "must-not-be-executed"),
    },
    hostManager: {
      ensureHost: async () => {
        ensures += 1;
        return host();
      },
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.request({
    command: { action: "list", canvasId: "main" },
  });

  assert.equal(ensures, 1);
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:49321/api/v1/projects/project-workspace/host-command",
    body: { action: "list", canvasId: "main" },
  }]);
  assert.deepEqual(result.value, { nodes: [] });
});

test("an explicit API URL bypasses daemon startup and forwards its API token", async (t) => {
  const { createMcpProjectHostClient } = await import("./host-runner.js");
  const cwd = await mkdtemp(join(tmpdir(), "clash-mcp-unbound-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let ensures = 0;
  let authorization = "";
  const client = createMcpProjectHostClient({
    env: {
      CLASH_WORKSPACE_ROOT: cwd,
      CLASH_API_URL: "https://clash.example.test",
      CLASH_API_KEY: "clsh_direct",
      CLASH_PROJECT_ID: "project-env",
    },
    hostManager: {
      ensureHost: async () => {
        ensures += 1;
        return host();
      },
    },
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ timelines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.request({ command: { action: "list_timelines" } });

  assert.equal(ensures, 0);
  assert.equal(authorization, "Bearer clsh_direct");
  assert.deepEqual(result.value, { timelines: [] });
});
