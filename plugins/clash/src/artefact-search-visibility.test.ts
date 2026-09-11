import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceContains,
  sourceMatches,
} from "../../../packages/gui/test-support/source-match.ts";

const repoRoot = join(
  dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
  "..",
  "..",
);

// A generated payload can be publishable while excluded from Git and ordinary
// source searches. Exercise those tools against fixtures, independent of any
// local release build or the current repository index.
test("search ignores generated payloads while explicit reads and npm packaging retain them", () => {
  const root = mkdtempSync(join(tmpdir(), "clash-artifact-boundary-"));
  try {
    const plugin = join(root, "plugins", "clash");
    mkdirSync(join(plugin, "runtime"), { recursive: true });
    mkdirSync(join(plugin, "src"), { recursive: true });
    cpSync(join(repoRoot, ".ignore"), join(root, ".ignore"));
    cpSync(join(repoRoot, ".gitignore"), join(root, ".gitignore"));
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "plugins/clash/package.json"), "utf8"),
    ) as {
      bin: Record<string, string>;
      clashRuntime: { localApi: string };
    };
    cpSync(
      join(repoRoot, "plugins/clash/package.json"),
      join(plugin, "package.json"),
    );
    const bin = Object.values(manifest.bin)[0];
    assert.ok(bin, "the distribution declares its executable artifact");
    const artifactPath = bin.replace(/^\.\//, "");
    const artifact = join(plugin, artifactPath);
    mkdirSync(dirname(artifact), { recursive: true });
    const hostArtifactPath = manifest.clashRuntime.localApi.replace(
      /^\.\//,
      "",
    );
    const hostArtifact = join(plugin, hostArtifactPath);
    mkdirSync(dirname(hostArtifact), { recursive: true });
    writeFileSync(hostArtifact, "// generated Host fixture\n");
    writeFileSync(
      artifact,
      "// generated fixture\nexport const fixtureBoundary = true;\n",
    );
    writeFileSync(
      join(plugin, "src/fixture.ts"),
      "export const fixtureBoundary = true;\n",
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });

    const search = () =>
      execFileSync("rg", ["--files"], { cwd: root, encoding: "utf8" }).split(
        "\n",
      );
    assert.ok(search().includes("plugins/clash/src/fixture.ts"));
    assert.equal(search().includes(`plugins/clash/${artifactPath}`), false);
    // Even an explicitly tracked generated artifact must not shadow its source.
    execFileSync("git", ["add", "-f", `plugins/clash/${artifactPath}`], {
      cwd: root,
    });
    assert.equal(search().includes(`plugins/clash/${artifactPath}`), false);
    assert.ok(
      execFileSync("rg", ["--no-ignore-dot", "fixtureBoundary", artifact], {
        cwd: root,
        encoding: "utf8",
      }).includes("fixtureBoundary"),
    );
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: plugin,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const included = packed.flatMap((entry) =>
      entry.files.map((file) => file.path),
    );
    assert.ok(
      included.includes(artifactPath),
      "npm must include the generated executable declared by bin",
    );
    assert.ok(
      included.includes(hostArtifactPath),
      "npm must include the non-bin Host artifact through its files contract",
    );
    assert.equal(included.includes("src/fixture.ts"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build tooling owns disposable runtime and agent output and marks generated bundles", () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "plugins/clash/package.json"), "utf8"),
  );
  assert.ok(sourceMatches(manifest.scripts.clean, /rm -rf runtime/));
  const emitter = readFileSync(
    join(repoRoot, "packages/cli/scripts/bundle-agents.ts"),
    "utf8",
  );
  assert.ok(
    sourceContains(emitter, 'const DIST = join(root, "dist", "agents")'),
  );
  const builder = readFileSync(
    join(repoRoot, "plugins/clash/scripts/build-host-runtime.ts"),
    "utf8",
  );
  assert.ok(
    sourceContains(builder, 'outfile: resolve(runtimeDir, "local-api.cjs")'),
  );
  assert.ok(sourceContains(builder, "GENERATED FILE -- DO NOT EDIT"));
});
