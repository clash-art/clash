import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export async function collectTests(
  dir: string,
  root = packageRoot,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const tests: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory())
      tests.push(...(await collectTests(fullPath, root)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts"))
      tests.push(relative(root, fullPath));
  }
  return tests;
}

type Run = (
  label: string,
  command: string,
  args: string[],
  root: string,
) => Promise<number>;
const run: Run = (label, command, args, root) =>
  new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(root, "tsconfig.dev.json"),
      },
    });
    child.on("error", (error) => {
      console.error(`${label} failed to start: ${error.message}`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) console.error(`${label} terminated by ${signal}.`);
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });

export async function runTestSuites(
  root = packageRoot,
  execute: Run = run,
): Promise<number> {
  const tests = (await collectTests(join(root, "src"), root)).sort();
  if (!tests.length) throw new Error("No CLI test files found.");
  const nodeTests: string[] = [];
  const vitestTests: string[] = [];
  for (const test of tests) {
    const source = await readFile(join(root, test), "utf8");
    // Prefer the real Node import when a Node test also quotes a Vitest example.
    if (
      source.includes('from "node:test"') ||
      source.includes("from 'node:test'")
    )
      nodeTests.push(test);
    else if (
      source.includes('from "vitest"') ||
      source.includes("from 'vitest'")
    )
      vitestTests.push(test);
    else throw new Error(`No test runner import found in ${test}`);
  }
  if (nodeTests.length) {
    const code = await execute(
      "CLI node tests",
      process.execPath,
      ["--import", "tsx", "--test", ...nodeTests],
      root,
    );
    if (code !== 0) return code;
  }
  if (vitestTests.length)
    return execute(
      "CLI vitest tests",
      "pnpm",
      ["exec", "vitest", "run", ...vitestTests],
      root,
    );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runTestSuites();
}
