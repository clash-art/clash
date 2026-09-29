import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineCommand } from "./timeline";
import { writeProjectMarker } from "../lib/project-context";

test("Timeline list is compact by default and full state is an explicit choice", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "clash-timeline-list-"));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const timeline = {
    id: "cut",
    name: "Cut",
    revisionId: "revision",
    owner: { kind: "project" },
    state: {
      fps: 30,
      durationInFrames: 90,
      compositionWidth: 1920,
      compositionHeight: 1080,
      tracks: [
        {
          id: "titles",
          items: [{ id: "text", text: "private full clip body" }],
        },
      ],
    },
  };
  const lines: string[] = [];
  try {
    await writeProjectMarker(cwd, {
      schemaVersion: 1,
      projectId: "test-project",
    });
    process.chdir(cwd);
    process.env.CLASH_API_URL = "http://127.0.0.1:49321";
    delete process.env.CLASH_AGENT_MEMBER_ID;
    delete process.env.CLASH_PROJECT_ID;
    globalThis.fetch = async () =>
      Response.json({ timelines: [timeline], versions: {} });
    console.log = (...values: unknown[]) =>
      lines.push(values.map(String).join(" "));
    const list = timelineCommand.commands.find(
      (command) => command.name() === "list",
    )!;
    await list.parseAsync(["--json"], { from: "user" });
    const compact = JSON.parse(lines.join("\n"));
    assert.equal(compact[0].state, undefined);
    assert.equal(compact[0].trackCount, 1);
    assert.equal(compact[0].itemCount, 1);
    assert.equal(compact[0].durationInFrames, 90);
    assert.equal(compact[0].revisionId, timeline.revisionId);
    assert.ok(!JSON.stringify(compact).includes("private full clip body"));
    lines.length = 0;
    await list.parseAsync(["--full", "--json"], { from: "user" });
    assert.deepEqual(JSON.parse(lines.join("\n")), [timeline]);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    for (const key of Object.keys(process.env))
      if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(cwd, { recursive: true, force: true });
  }
});
