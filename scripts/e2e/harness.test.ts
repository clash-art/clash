import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { capture, CdpClient, evaluate } from "./harness.ts";

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
