import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { distMismatches } from "./verify-openma-prebuilt.ts";

test("dist comparison accepts identical trees and reports drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openma-dist-"));
  const packed = path.join(root, "packed");
  const source = path.join(root, "source");
  await mkdir(path.join(packed, "chat-ui"), { recursive: true });
  await mkdir(path.join(source, "chat-ui"), { recursive: true });
  await writeFile(
    path.join(packed, "chat-ui", "index.js"),
    "export const same = 1;\n",
  );
  await writeFile(
    path.join(source, "chat-ui", "index.js"),
    "export const same = 1;\n",
  );
  assert.deepEqual(distMismatches(packed, source), []);

  await writeFile(
    path.join(source, "chat-ui", "index.js"),
    "export const changed = 1;\n",
  );
  await writeFile(path.join(source, "extra.js"), "extra\n");
  const mismatches = distMismatches(packed, source);
  assert.equal(
    mismatches.some((line) => line.includes("hash mismatch")),
    true,
  );
  assert.equal(
    mismatches.some((line) => line.includes("extra in checkout")),
    true,
  );
  await rm(root, { recursive: true, force: true });
});
