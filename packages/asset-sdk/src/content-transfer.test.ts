import { describe, expect, it } from "vitest";
import {
  assertContentTransferSize,
  readBoundedContent,
  readContentTransferLimitError,
  ContentTransferLimitError,
  contentTransferMaxBytes,
} from "./content-transfer.js";

function stream(chunks: Uint8Array[]) {
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    cancelled: () => cancelled,
  };
}

describe("bounded content transfer", () => {
  it("accepts the requested 512 MiB object boundary and rejects the next byte", () => {
    // Product requirement: the user explicitly raised the object cap to 512 MiB.
    const requestedLimit = 512 * 1024 * 1024;
    expect(() => assertContentTransferSize(requestedLimit)).not.toThrow();
    expect(() => assertContentTransferSize(requestedLimit + 1)).toThrow(
      ContentTransferLimitError,
    );
    expect(contentTransferMaxBytes()).toBe(requestedLimit);
    expect(contentTransferMaxBytes(8)).toBe(8);
    expect(() => contentTransferMaxBytes(requestedLimit + 1)).toThrow(
      RangeError,
    );
  });
  it("accepts the configured boundary and rejects oversized declared facts before reading", async () => {
    expect(() => assertContentTransferSize(8, 8)).not.toThrow();
    expect(() => assertContentTransferSize(9, 8)).toThrow(
      ContentTransferLimitError,
    );
    expect(
      await readBoundedContent(
        stream([new Uint8Array(3), new Uint8Array(5)]).body,
        { maxBytes: 8 },
      ),
    ).toHaveLength(8);
  });
  it("rejects chunked overflow even with no trustworthy Content-Length and cancels the reader", async () => {
    const source = stream([
      new Uint8Array(4),
      new Uint8Array(5),
      new Uint8Array(1),
    ]);
    await expect(
      readBoundedContent(source.body, { maxBytes: 8 }),
    ).rejects.toMatchObject({ code: "CLOUD_CONTENT_TOO_LARGE", maxBytes: 8 });
    expect(source.cancelled()).toBe(true);
  });
});

it("preserves a remote smaller cap and does not invent a limit for an unknown413", async () => {
  const response = new Response(
    JSON.stringify({ code: "CLOUD_CONTENT_TOO_LARGE", maxBytes: 8 }),
    { status: 413 },
  );
  expect(await readContentTransferLimitError(response)).toMatchObject({
    code: "CLOUD_CONTENT_TOO_LARGE",
    maxBytes: 8,
  });
  expect(
    await readContentTransferLimitError(
      new Response("proxy request too large", { status: 413 }),
    ),
  ).toBeNull();
});
