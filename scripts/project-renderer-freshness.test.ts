import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  recordRendererInputs,
  assertRendererInputsAreFresh,
} from "./project-renderer-freshness.ts";

test("the shipped Host build hashes editor sources through its Web dependency and caches the renderer output", () => {
  const root = resolve(import.meta.dirname, "..");
  const graph = JSON.parse(execFileSync(join(root, "node_modules/.bin/turbo"),
    ["run", "build", "--filter=clash", "--dry=json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )) as { tasks: Array<{ taskId: string; dependencies: string[]; outputs: string[] }> };
  const task = (id: string) => {
    const entry = graph.tasks.find((value) => value.taskId === id);
    assert.ok(entry, `Missing build task ${id}`);
    return entry;
  };
  // Reproduced failure: the package-specific Web override dropped ^build and
  // outputs, so changing the numeric editor restored an older Host renderer.
  assert.ok(task("clash#build").dependencies.includes("@clash/web#build"));
  assert.ok(task("@clash/web#build").dependencies.includes("@clash/remotion-ui#build"));
  assert.ok(task("@clash/web#build").outputs.includes("dist/**"));
});

test("Host packaging rejects a renderer after shared editor input changes, even with preserved timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "clash-renderer-"));
  try {
    const source = join(root, "src");
    mkdirSync(source);
    const file = join(source, "editor.tsx");
    const receipt = join(root, "inputs.json");
    writeFileSync(file, "old editor");
    recordRendererInputs(receipt, [source]);
    assert.doesNotThrow(() => assertRendererInputsAreFresh(receipt));
    writeFileSync(file, "fixed editor");
    utimesSync(file, new Date(0), new Date(0));
    assert.throws(() => assertRendererInputsAreFresh(receipt), /rebuild/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new and deleted production inputs invalidate the renderer; test edits do not", () => {
  const root = mkdtempSync(join(tmpdir(), "clash-renderer-"));
  try {
    const source = join(root, "src");
    mkdirSync(source);
    const file = join(source, "editor.tsx");
    const receipt = join(root, "inputs.json");
    writeFileSync(file, "editor");
    recordRendererInputs(receipt, [source]);
    writeFileSync(join(source, "editor.test.tsx"), "test");
    assert.doesNotThrow(() => assertRendererInputsAreFresh(receipt));
    writeFileSync(join(source, "scroll.ts"), "scroll");
    assert.throws(() => assertRendererInputsAreFresh(receipt), /rebuild/i);
    recordRendererInputs(receipt, [source]);
    rmSync(file);
    assert.throws(() => assertRendererInputsAreFresh(receipt), /rebuild/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy renderer without a build receipt cannot be silently packaged", () => {
  assert.throws(
    () =>
      assertRendererInputsAreFresh(
        join(tmpdir(), "absent-clash-renderer-inputs.json"),
      ),
    /rebuild/i,
  );
});
