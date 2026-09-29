import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";

import { buildPluginEntrypoint, pluginBuildPlan } from "./plugin-build";

/**
 * `dist/` is a derived artifact, so keeping it current is the host's job.
 *
 * The project already applies this rule to concurrency: read-presence and CAS happen
 * inside mutation commands rather than through a token the agent must remember. A
 * separate build step has the same shape and a worse failure. Editing `src/` without
 * rebuilding leaves `validate` reporting `valid: true`, the contract tests passing
 * against the previous bundle, and `activate` storing stale logic under a fresh
 * content hash -- verified on a real draft before this existed. Nothing in that
 * sequence looks wrong.
 *
 * Which entrypoints are derived is declared, not guessed: `runtime.build.source`
 * says so. Absent means the entrypoint was authored by hand and the host must never
 * overwrite it, which is the normal case for Python.
 */
const created: string[] = [];

after(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function draft(runtime: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clash-plugin-build-"));
  created.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "probe",
      version: "0.1.0",
      name: "Probe",
      runtime,
      contributes: {},
      contractTests: [],
    }),
    "utf8",
  );
  return dir;
}

const NODE_TS = {
  kind: "local",
  transport: "stdio",
  language: "node",
  entrypoint: "dist/stdio.mjs",
  build: { source: "src/stdio.ts" },
};

describe("build plan", () => {
  it("is declared by runtime.build", () => {
    assert.deepEqual(pluginBuildPlan(NODE_TS), {
      source: "src/stdio.ts",
      entrypoint: "dist/stdio.mjs",
    });
  });

  it("is absent for an authored entrypoint", () => {
    // Python is the ordinary case: source is what runs, so there is nothing to build.
    assert.equal(
      pluginBuildPlan({
        kind: "local",
        transport: "stdio",
        language: "python",
        entrypoint: "handler.py",
      }),
      undefined,
    );
    assert.equal(
      pluginBuildPlan({
        kind: "local",
        transport: "stdio",
        language: "node",
        entrypoint: "handler.mjs",
      }),
      undefined,
    );
  });

  it("is absent for a hosted runtime", () => {
    assert.equal(
      pluginBuildPlan({
        kind: "hosted",
        transport: "http",
        endpoint: "https://example.test",
      }),
      undefined,
    );
  });
});

describe("building", () => {
  it("produces identical SDK bundles when an unchanged draft moves to a different directory depth", async () => {
    // Installed acceptance found only SDK installation paths in esbuild comments
    // changing, which made the Host reject an unchanged same-version activation.
    const dir = await draft(NODE_TS);
    const moved = join(dir, "another-workspace", "draft");
    const source = `
      import { ProviderExecutionError } from '@clash/action-sdk';
      console.log(new ProviderExecutionError({code: 'invalid_request', message: 'bad range', retryable: false, requestState: 'rejected'}).message);
    `;
    await mkdir(join(moved, "src"), { recursive: true });
    for (const location of [dir, moved]) {
      await writeFile(join(location, "src", "stdio.ts"), source);
    }
    const first = await buildPluginEntrypoint(dir, NODE_TS);
    const second = await buildPluginEntrypoint(moved, NODE_TS);
    assert.equal(await readFile(second, "utf8"), await readFile(first, "utf8"));
    assert.equal(execFileSync(process.execPath, [second], { encoding: "utf8" }).trim(), "bad range");
  });

  it("bundles the supplied action SDK for a draft outside the Clash checkout", async () => {
    const dir = await draft(NODE_TS);
    await writeFile(join(dir, "src", "stdio.ts"), `
      import { ProviderExecutionError } from '@clash/action-sdk';
      import { executableFailureFromThrown } from '@clash/action-sdk/executable-failure';
      const error = new ProviderExecutionError({code: 'invalid_request', message: 'bad range', retryable: false, requestState: 'rejected'});
      console.log(JSON.stringify(executableFailureFromThrown(error, 'submit')));
    `);
    const artifact = await buildPluginEntrypoint(dir, NODE_TS);
    await rm(join(dir, "src"), { recursive: true });
    const result = JSON.parse(execFileSync(process.execPath, [artifact], { cwd: tmpdir(), encoding: "utf8" }));
    assert.equal(result.code, "invalid_request");
    assert.equal(result.requestState, "rejected");
  });

  it("bundles TypeScript into one ESM artifact", async () => {
    const dir = await draft(NODE_TS);
    await mkdir(join(dir, "src", "lib"), { recursive: true });
    await writeFile(
      join(dir, "src", "lib", "greet.ts"),
      'export const greet = () => "hi";\n',
      "utf8",
    );
    await writeFile(
      join(dir, "src", "stdio.ts"),
      'import { greet } from "./lib/greet";\nprocess.stdout.write(greet());\n',
      "utf8",
    );

    const built = await buildPluginEntrypoint(dir, NODE_TS);
    assert.equal(built, join(dir, "dist", "stdio.mjs"));
    const output = await readFile(built, "utf8");

    // A surviving relative import would make the artifact depend on source files beside it.
    assert.ok(output.includes("hi"), "a local module must be inlined");
    assert.doesNotMatch(
      output,
      /from\s*["']\.\//,
      "no relative import may survive",
    );
  });

  it("keeps node builtins external", async () => {
    const dir = await draft(NODE_TS);
    await writeFile(
      join(dir, "src", "stdio.ts"),
      // Actually reach for the builtin: a discarded import is tree-shaken away, which
      // would make this assertion pass or fail for reasons unrelated to externals.
      'import { createInterface } from "node:readline";\n' +
        'createInterface({ input: process.stdin }).on("line", () => {});\n',
      "utf8",
    );
    const output = await readFile(
      await buildPluginEntrypoint(dir, NODE_TS),
      "utf8",
    );
    assert.match(output, /node:readline/, "builtins stay external");
  });

  it("emits ESM, because the plugin runtime loads the entrypoint as a module", async () => {
    const dir = await draft(NODE_TS);
    await writeFile(
      join(dir, "src", "stdio.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    const output = await readFile(
      await buildPluginEntrypoint(dir, NODE_TS),
      "utf8",
    );
    assert.doesNotMatch(output, /\brequire\(/, "no CommonJS require");
    assert.doesNotMatch(output, /module\.exports/, "no CommonJS exports");
  });

  it("rebuilds after the source changes", async () => {
    const dir = await draft(NODE_TS);
    await writeFile(
      join(dir, "src", "stdio.ts"),
      'process.stdout.write("first");\n',
      "utf8",
    );
    await buildPluginEntrypoint(dir, NODE_TS);

    await writeFile(
      join(dir, "src", "stdio.ts"),
      'process.stdout.write("second");\n',
      "utf8",
    );
    const output = await readFile(
      await buildPluginEntrypoint(dir, NODE_TS),
      "utf8",
    );
    assert.match(output, /second/);
    assert.doesNotMatch(
      output,
      /first/,
      "the previous bundle must not survive",
    );
  });

  it("reports a syntax error instead of writing a broken artifact", async () => {
    const dir = await draft(NODE_TS);
    await writeFile(join(dir, "src", "stdio.ts"), "const broken = (\n", "utf8");
    await assert.rejects(
      () => buildPluginEntrypoint(dir, NODE_TS),
      /stdio\.ts/,
    );
    await assert.rejects(() => stat(join(dir, "dist", "stdio.mjs")), /ENOENT/);
  });

  it("reports a missing source clearly", async () => {
    const dir = await draft(NODE_TS);
    await assert.rejects(
      () => buildPluginEntrypoint(dir, NODE_TS),
      /src\/stdio\.ts/,
    );
  });

  it("refuses a source path escaping the plugin directory", async () => {
    const dir = await draft({ ...NODE_TS, build: { source: "../outside.ts" } });
    await assert.rejects(
      () =>
        buildPluginEntrypoint(dir, {
          ...NODE_TS,
          build: { source: "../outside.ts" },
        }),
      /outside/,
    );
  });
});
