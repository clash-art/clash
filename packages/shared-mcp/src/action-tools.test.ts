import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerActionTools } from "./action-tools.js";

test("Action wait resolves cwd project and does not resubmit work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "clash-actions-mcp-"));
  const tools = new Map<
    string,
    { config: any; call: (args: any) => Promise<any> }
  >();
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  try {
    await mkdir(join(cwd, ".clash"));
    await writeFile(
      join(cwd, ".clash/project.toml"),
      'schema_version = 1\nproject_id = "school-project"\n',
    );
    registerActionTools(
      {
        registerTool: (name: string, config: any, call: any) =>
          tools.set(name, { config, call }),
      } as never,
      {
        request: async (path: string, init?: RequestInit) => {
          requests.push({ path, init });
          return Response.json({
            run: { actionRunId: "existing", status: "running" },
          });
        },
      },
    );
    const wait = tools.get("clash_generators_action_wait");
    assert.ok(wait, "The task-oriented wait operation must be discoverable");
    const result = await wait.call({ cwd, actionRunId: "existing", waitMs: 0 });
    assert.equal(result.structuredContent.result.status, "running");
    assert.equal(
      requests[0]?.path,
      "/api/v1/projects/school-project/generator-runs/existing",
    );
    assert.ok(
      requests.every(
        (request) => !request.init?.method || request.init.method === "GET",
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
