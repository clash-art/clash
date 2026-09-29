import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeRuntimeDependencyIdentity } from "./runtime-dependency-identity.ts";

test("dependency identity follows payload changes and ignores packaging location and npm command links", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-dependency-identity-"));
  try {
    const first = join(root, "npm");
    const second = join(root, "desktop");
    await mkdir(join(first, "node_modules", "library"), { recursive: true });
    await mkdir(join(first, "node_modules", ".bin"));
    await writeFile(join(first, "node_modules", "library", "index.js"), "module.exports = 'original';");
    await symlink("../library/index.js", join(first, "node_modules", ".bin", "library"));
    await cp(first, second, { recursive: true, dereference: true });
    const identity = async (directory: string) => writeRuntimeDependencyIdentity(
      join(directory, "node_modules"), directory,
    );
    const original = await identity(first);
    assert.equal(await identity(second), original);
    assert.equal((await readFile(join(first, "runtime-dependencies.sha256"), "utf8")).trim(), original);
    await writeFile(join(second, "node_modules", "library", "index.js"), "module.exports = 'fixed';");
    assert.notEqual(await identity(second), original);
    await writeFile(join(first, "node_modules", ".package-lock.json"), "installation bookkeeping");
    assert.equal(await identity(first), original);
    await rm(join(first, "node_modules", "library"), { recursive: true });
    assert.notEqual(await identity(first), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
