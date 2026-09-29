import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectsCommand } from "./projects";
import { writeProjectMarker } from "../lib/project-context";

for (const bound of [false, true]) {
  test(`agent project creation returns success from a ${bound ? "different-project" : "unbound"} workspace`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "clash-project-create-"));
    const previousCwd = process.cwd();
    const previousEnv = { ...process.env };
    const previousFetch = globalThis.fetch;
    const previousLog = console.log;
    const lines: string[] = [];
    const requests: string[] = [];
    const created = { id: "new-project", name: "New project" };
    try {
      if (bound) {
        await writeProjectMarker(cwd, {
          schemaVersion: 1,
          projectId: "existing-project",
        });
      }
      process.chdir(cwd);
      process.env.CLASH_AGENT_MEMBER_ID = "agent-test";
      process.env.CLASH_API_URL = "http://127.0.0.1:49321";
      delete process.env.CLASH_PROJECT_ID;
      globalThis.fetch = async (input, options) => {
        requests.push(`${options?.method} ${String(input)}`);
        assert.deepEqual(JSON.parse(String(options?.body)), {
          name: created.name,
        });
        return Response.json({
          ...created,
          readToken: "project:receipt:internal",
        });
      };
      console.log = (...values: unknown[]) =>
        lines.push(values.map(String).join(" "));

      await projectsCommand.parseAsync(
        ["create", "--name", created.name, "--json"],
        { from: "user" },
      );

      assert.deepEqual(JSON.parse(lines.join("\n")), created);
      assert.deepEqual(requests, [
        "POST http://127.0.0.1:49321/api/v1/projects",
      ]);
      // Creation is global. It must not insert a new project's receipt into
      // another project's observation log or require a marker before success.
      await assert.rejects(access(join(cwd, ".clash", "observed.json")), {
        code: "ENOENT",
      });
    } finally {
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key];
      }
      Object.assign(process.env, previousEnv);
      globalThis.fetch = previousFetch;
      console.log = previousLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
