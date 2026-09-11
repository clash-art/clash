import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const cliTsconfig = fileURLToPath(
  new URL("../../tsconfig.dev.json", import.meta.url),
);
const tsxImport = createRequire(import.meta.url).resolve("tsx");
test("retired metadata writers fail before touching manifests and legacy reads remain available", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "clash-metadata-retired-"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", tsxImport, cliEntry, ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: cliTsconfig,
        CLASH_API_URL: "http://127.0.0.1:1",
      },
    });
  try {
    await mkdir(join(cwd, "assets"));
    const identity = {
      kind: "media.description",
      schemaVersion: 1,
      text: "Legacy description",
      sourceHash: `sha256:${"a".repeat(64)}`,
    };
    const manifest = JSON.stringify({
      assets: [{ id: "asset", metadata: { "media.description": identity } }],
    });
    const path = join(cwd, "assets", "manifest.json");
    await writeFile(path, manifest);
    for (const args of [
      [
        "assets",
        "metadata",
        "set",
        "--asset",
        "asset",
        "--kind",
        "media.description",
        "--metadata",
        "missing.json",
      ],
      ["assets", "metadata", "apply", "--file", "missing.json"],
      [
        "projection",
        "apply",
        "--kind",
        "metadata:media.description",
        "--id",
        "asset",
      ],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /METADATA_WRITE_RETIRED/);
      assert.match(result.stderr, /assets documents/);
      assert.equal(await readFile(path, "utf8"), manifest);
    }
    const read = run([
      "assets",
      "metadata",
      "get",
      "--asset",
      "asset",
      "--kind",
      "media.description",
      "--json",
    ]);
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), identity);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
