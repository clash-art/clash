import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCommand } from "./projects";

async function captureInit(
  workspace: string,
  args: string[],
  options: { tty: boolean },
): Promise<string[]> {
  const previousCwd = process.cwd();
  const previousIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const previousLog = console.log;
  const lines: string[] = [];

  process.chdir(workspace);
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: options.tty,
  });
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };

  try {
    await initCommand.parseAsync(args, { from: "user" });
    return lines;
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    if (previousIsTty) {
      Object.defineProperty(process.stdout, "isTTY", previousIsTty);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

test("clash init human output distinguishes a created project from a reused project", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-cli-init-human-"));
  const canonicalWorkspace = await realpath(workspace);

  const created = await captureInit(workspace, ["--project", "stable-project"], { tty: true });
  const markerBeforeReuse = await readFile(join(workspace, ".clash", "project.toml"), "utf8");
  const reused = await captureInit(workspace, ["--project", "stable-project"], { tty: true });

  assert.deepEqual(created, [
    "Created Clash project: stable-project",
    `Marker: ${join(canonicalWorkspace, ".clash", "project.toml")}`,
  ]);
  assert.deepEqual(reused, [
    "Reused Clash project: stable-project",
    `Marker: ${join(canonicalWorkspace, ".clash", "project.toml")}`,
  ]);
  assert.equal(await readFile(join(workspace, ".clash", "project.toml"), "utf8"), markerBeforeReuse);
  // CLI users opt into skills; binding an external workspace must not install
  // the focused policy reserved for Clash-hosted agent sessions.
  for (const filename of ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md", "GEMINI.md"]) {
    await assert.rejects(access(join(workspace, filename)), { code: "ENOENT" });
  }
});

test("clash init JSON output remains compatible and includes reused", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-cli-init-json-"));
  const canonicalWorkspace = await realpath(workspace);

  const created = JSON.parse((await captureInit(
    workspace,
    ["--project", "json-project", "--json"],
    { tty: false },
  )).join("\n"));
  const reused = JSON.parse((await captureInit(
    workspace,
    ["--project", "json-project", "--json"],
    { tty: false },
  )).join("\n"));

  assert.deepEqual(created, {
    projectId: "json-project",
    markerPath: join(canonicalWorkspace, ".clash", "project.toml"),
    workspaceId: created.workspaceId,
    reused: false,
  });
  assert.match(created.workspaceId, /^managed:[a-f0-9]{16}$/);
  assert.deepEqual(reused, { ...created, reused: true });
});

test("clash init still fails closed instead of rebinding an existing workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "clash-cli-init-conflict-"));
  await captureInit(workspace, ["--project", "project-a"], { tty: true });
  const markerPath = join(workspace, ".clash", "project.toml");
  const markerBeforeConflict = await readFile(markerPath, "utf8");

  await assert.rejects(
    captureInit(workspace, ["--project", "project-b"], { tty: true }),
    /already bound.*project-a.*project-b/i,
  );
  assert.equal(await readFile(markerPath, "utf8"), markerBeforeConflict);
});
