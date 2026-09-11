import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectStatus } from "./projects";

test("CLI uses the selected Project's live Host readiness and fails closed on another Project", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-cli-readiness-"));
  const previousFetch = globalThis.fetch;
  try {
    await mkdir(join(clashRoot, "run"));
    await writeFile(
      join(clashRoot, "run", "host.json"),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        dataSchemaVersion: 1,
        hostId: "host",
        endpoint: "http://127.0.0.1:49321",
        pid: process.pid,
        launchMode: "user-service",
        startedBy: "cli",
        profile: "prod",
        startedAt: "2026-09-04T00:00:00Z",
        updatedAt: "2026-09-04T00:00:00Z",
      }),
    );
    let responseProject = "selected";
    globalThis.fetch = async (input) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:49321/api/v1/projects/selected/status",
      );
      return new Response(
        JSON.stringify({
          projectId: responseProject,
          syncMode: "cloud-sync",
          collaboration: {
            mode: "synced",
            webOpenable: true,
            actions: { shareProject: { allowed: true } },
          },
        }),
      );
    };
    const options = { project: "selected", clashRoot, env: {} };
    const ready = await resolveProjectStatus(options);
    assert.equal(ready.collaboration.webOpenable, true);
    responseProject = "different";
    const mismatched = await resolveProjectStatus(options);
    assert.equal(mismatched.collaboration.webOpenable, false);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const offline = await resolveProjectStatus(options);
    assert.equal(offline.collaboration.actions.shareProject.allowed, false);
    assert.equal(offline.collaboration.actions.runLocalAgent.allowed, true);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(clashRoot, { recursive: true, force: true });
  }
});
