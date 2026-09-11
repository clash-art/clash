import { expect, it, vi } from "vitest";
import {
  exactLengthContentStream,
  handleMultipartContent,
} from "./project-content-transfer";

it("streams bytes incrementally and fails truncated or oversized actual bodies", async () => {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      send = controller;
    },
  });
  const reader = exactLengthContentStream(body, 2).getReader();
  send.enqueue(new Uint8Array([7]));
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  send.enqueue(new Uint8Array([8]));
  expect((await reader.read()).value).toEqual(new Uint8Array([8]));
  send.close();
  expect((await reader.read()).done).toBe(true);
  for (const bytes of [new Uint8Array(1), new Uint8Array(3)]) {
    const stream = exactLengthContentStream(new Response(bytes).body!, 2);
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow(
      "length mismatch",
    );
  }
});

it("rejects unsupported multipart storage without attempting a buffered put", async () => {
  const put = vi.fn();
  const store = { head: () => undefined, get: () => undefined, put };
  await expect(
    handleMultipartContent(
      new Request(
        "https://cloud.test/upload?upload=begin&uploadId=fixture-session-id",
        { method: "PUT" },
      ),
      store,
      {
        identity: "project/replica/document",
        locator: "private-body",
        byteLength: 1,
        digest: `sha256:${"0".repeat(64)}`,
      },
      async () => {},
    ),
  ).rejects.toMatchObject({ status: 501 });
  expect(put).not.toHaveBeenCalled();
});
