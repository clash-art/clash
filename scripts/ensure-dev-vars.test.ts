import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDevVars } from "./ensure-dev-vars.ts";

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clash-dev-vars-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const environmentLines = (dir: string) =>
  readFileSync(path.join(dir, ".dev.vars"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("ENVIRONMENT="));

test("creates the local development marker when .dev.vars is missing", () => {
  withDir((dir) => {
    assert.equal(ensureDevVars(dir), true);
    assert.deepEqual(environmentLines(dir), ["ENVIRONMENT=development"]);
  });
});

test("extends an existing .dev.vars without dropping its entries", () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, ".dev.vars"), "GOOGLE_API_KEY=local-key");
    assert.equal(ensureDevVars(dir), true);
    const content = readFileSync(path.join(dir, ".dev.vars"), "utf8");
    assert.match(content, /^GOOGLE_API_KEY=local-key$/m);
    assert.deepEqual(environmentLines(dir), ["ENVIRONMENT=development"]);
    assert.equal(ensureDevVars(dir), false);
  });
});

test("never overrides an ENVIRONMENT the developer chose", () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, ".dev.vars"), "ENVIRONMENT=staging\n");
    assert.equal(ensureDevVars(dir), false);
    assert.deepEqual(environmentLines(dir), ["ENVIRONMENT=staging"]);
  });
});
