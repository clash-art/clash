import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  distMismatches,
  extractTarGz,
  tarballPinMode,
} from "./verify-openma-prebuilt.ts";

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(size.toString(8).padStart(11, "0"), 124);
  header[156] = 48;
  return header;
}

test("a missing release tarball is a git-dist pin, not a partial one", () => {
  assert.equal(tarballPinMode("", ""), "git");
  assert.equal(
    tarballPinMode("https://example.invalid/a.tgz", "abc"),
    "tarball",
  );
  assert.throws(() => tarballPinMode("https://example.invalid/a.tgz", ""));
});

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

test("gzip tar extraction does not shell out to tar", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openma-tar-"));
  const body = Buffer.from("export const same = 1;\n");
  const header = tarHeader("package/dist/chat-ui/index.js", body.length);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  const archive = path.join(root, "sample.tgz");
  await writeFile(
    archive,
    gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)])),
  );
  const extracted = path.join(root, "out");
  extractTarGz(archive, extracted);
  assert.equal(
    await readFile(
      path.join(extracted, "package/dist/chat-ui/index.js"),
      "utf8",
    ),
    body.toString("utf8"),
  );
  await rm(root, { recursive: true, force: true });
});
