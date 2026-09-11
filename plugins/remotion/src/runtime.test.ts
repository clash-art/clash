import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("loads the built plugin in plain Node ESM without test-runner require shims", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = await mkdtemp(join(root, ".runtime-test-"));
  try {
    await exec("pnpm", ["exec", "tsup", "--out-dir", output], { cwd: root });
    const result = await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (["loro-crdt", "yaml"].some(name => specifier === name || specifier.startsWith(name + "/"))) {
            throw new Error('Render executor must not load collaboration or YAML runtime: ' + specifier);
          }
          return nextResolve(specifier, context);
        }
      });
      const { plugin } = await import(process.env.REMOTION_TEST_ENTRY);
      if (typeof plugin?.invoke !== "function") throw new Error("Missing plugin executor");
      console.log("loaded");
    `,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          REMOTION_TEST_ENTRY: pathToFileURL(join(output, "stdio.mjs")).href,
        },
      },
    );
    expect(result.stdout.trim()).toBe("loaded");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30_000);
