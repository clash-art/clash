import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";

const cliRoot = join(__dirname, "..", "..");

test("npm test reaches every source test through the two supported runners", async () => {
  const { collectTests, runTestSuites } =
    await import("../../scripts/run-tests.ts");
  const manifest = JSON.parse(
    await readFile(join(cliRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.scripts.test, "node scripts/run-tests.ts");
  const discovered = await collectTests(join(cliRoot, "src"), cliRoot);
  const invoked: string[] = [];
  assert.equal(
    await runTestSuites(cliRoot, async (_label, _command, args) => {
      invoked.push(...args.filter((arg) => arg.endsWith(".test.ts")));
      return 0;
    }),
    0,
  );
  assert.ok(discovered.includes("src/lib/test-runner-coverage.test.ts"));
  assert.deepEqual(invoked.sort(), discovered.sort());
});

test("keeps node:test and Vitest separate and stops after a failed runner", async () => {
  const { runTestSuites } = await import("../../scripts/run-tests.ts");
  const root = await mkdtemp(join(tmpdir(), "clash-runner-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "node.test.ts"),
      'import test from "node:test";\n// from "vitest" is example data',
    );
    await writeFile(
      join(root, "src", "vitest.test.ts"),
      'import { test } from "vitest";',
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    assert.equal(
      await runTestSuites(root, async (_label, command, args) => {
        calls.push({ command, args });
        return 0;
      }),
      0,
    );
    assert.deepEqual(
      calls.map((call) => call.args.filter((arg) => arg.endsWith(".test.ts"))),
      [["src/node.test.ts"], ["src/vitest.test.ts"]],
    );
    assert.equal(calls[0].command, process.execPath);
    assert.ok(calls[0].args.includes("--test"));
    assert.equal(calls[1].command, "pnpm");
    assert.ok(calls[1].args.includes("vitest"));
    const failedCalls: string[] = [];
    assert.equal(
      await runTestSuites(root, async (label) => {
        failedCalls.push(label);
        return 7;
      }),
      7,
    );
    assert.deepEqual(failedCalls, ["CLI node tests"]);
    await writeFile(join(root, "src", "orphan.test.ts"), "export {};");
    await assert.rejects(
      runTestSuites(root, async () => 0),
      /No test runner import/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
