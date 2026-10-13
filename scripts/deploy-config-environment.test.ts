// A committed wrangler config is what `wrangler deploy` ships. Marking any
// part of one as development would let a deployed Worker use the published
// fallback secrets, so the marker may only live in git-ignored `.dev.vars`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function developmentMarkerLines(toml: string): number[] {
  return toml.split("\n").flatMap((line, index) => {
    const code = line.replace(/#.*$/, "");
    return /\bENVIRONMENT\b\s*=\s*["']development["']/.test(code) ? [index + 1] : [];
  });
}

const deployConfigs = execFileSync(
  "git",
  ["ls-files", "--", "*wrangler*.toml", "*wrangler*.json", "*wrangler*.jsonc"],
  { cwd: repoRoot, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

test("the scan sees both Worker deploy configs", () => {
  for (const expected of ["apps/api-cf/wrangler.toml", "apps/web/wrangler.toml"]) {
    assert.ok(deployConfigs.includes(expected), `${expected} is not tracked`);
  }
});

test("the scan recognises a development marker in vars tables and inline tables", () => {
  assert.deepEqual(developmentMarkerLines('[vars]\nENVIRONMENT = "development"\n'), [2]);
  assert.deepEqual(developmentMarkerLines("vars = { ENVIRONMENT = 'development' }"), [1]);
  assert.deepEqual(developmentMarkerLines('# ENVIRONMENT = "development"\nENVIRONMENT = "production"\n'), []);
});

for (const config of deployConfigs) {
  test(`${config} never sets ENVIRONMENT=development`, () => {
    const source = readFileSync(path.join(repoRoot, config), "utf8");
    // JSON configs spell the same assignment with a colon.
    const lines = developmentMarkerLines(source.replace(/"ENVIRONMENT"\s*:/g, "ENVIRONMENT ="));
    assert.deepEqual(lines, [], `${config} marks a deployed Worker as development on line(s) ${lines.join(", ")}`);
  });
}
