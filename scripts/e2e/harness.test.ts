import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { capture, CdpClient, evaluate, removeDirBestEffort } from "./harness.ts";

test("CDP transport preserves typed evaluation values, remote failures and screenshot bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-cdp-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const value = { label: "fixture result", nested: [true, "text"] };
  const bytes = Buffer.from("fixture screenshot payload");
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: { expression?: string };
      };
      const result =
        request.method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : request.params.expression === "throw fixture"
            ? { exceptionDetails: { text: "fixture evaluation failed" } }
            : { result: { value } };
      socket.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new CdpClient(`ws://127.0.0.1:${address.port}`);
  try {
    await client.ready();
    assert.deepEqual(
      await evaluate<typeof value>(client, "fixture expression"),
      value,
    );
    await assert.rejects(
      evaluate(client, "throw fixture"),
      /fixture evaluation failed/,
    );
    const path = join(root, "capture.png");
    await capture(client, path);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function notEmpty(dir: string) {
  return Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}'`), { code: "ENOTEMPTY" });
}

test("temp directory cleanup retries a directory that is still being written", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-cleanup-"));
  await mkdir(join(root, "Default"), { recursive: true });
  await writeFile(join(root, "Default", "Preferences"), "{}");
  let calls = 0;
  const removed = await removeDirBestEffort(root, {
    delayMs: 1,
    remove: async (target) => {
      calls += 1;
      if (calls === 1) throw notEmpty(join(target, "Default"));
      await rm(target, { recursive: true, force: true });
    },
  });
  assert.equal(removed, true);
  assert.equal(calls, 2);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("temp directory cleanup reports a persistent failure instead of throwing", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const removed = await removeDirBestEffort("/clash-cleanup-fixture", {
    attempts: 3,
    delayMs: 1,
    remove: async (target) => {
      calls += 1;
      throw notEmpty(target);
    },
  });
  assert.equal(removed, false);
  assert.equal(calls, 3);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /ENOTEMPTY/);
});

test("temp directory cleanup removes a real profile tree and tolerates a missing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-cleanup-"));
  await mkdir(join(root, "Default", "Cache"), { recursive: true });
  await writeFile(join(root, "Default", "Cache", "data_0"), "fixture");
  assert.equal(await removeDirBestEffort(root), true);
  await assert.rejects(stat(root), { code: "ENOENT" });
  assert.equal(await removeDirBestEffort(root), true);
});
