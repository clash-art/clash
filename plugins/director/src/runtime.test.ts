import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("loads the packaged Director executor in plain Node ESM", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = await mkdtemp(join(root, ".runtime-test-"));
  try {
    await exec("pnpm", ["exec", "tsup", "--out-dir", output], { cwd: root });
    const result = await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { plugin } = await import(process.env.DIRECTOR_TEST_ENTRY);
         if (typeof plugin?.invoke !== "function") throw new Error("Missing plugin executor");
         console.log("loaded");`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DIRECTOR_TEST_ENTRY: pathToFileURL(join(output, "stdio.mjs")).href,
        },
      },
    );
    expect(result.stdout.trim()).toBe("loaded");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30_000);
