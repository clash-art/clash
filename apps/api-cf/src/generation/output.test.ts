import { describe, expect, it, vi } from "vitest";
import { GenerationContext } from "./context";
import { createGenerationOutputBroker } from "./output";

function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; options: any }>();
  const store = {
    async put(key: string, body: string | Uint8Array, options: any = {}) {
      if (options.onlyIf && objects.has(key)) return null;
      objects.set(key, {
        bytes:
          typeof body === "string"
            ? new TextEncoder().encode(body)
            : body.slice(),
        options,
      });
      return { key };
    },
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        size: value.bytes.length,
        arrayBuffer: async () => value.bytes.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(value.bytes)),
        httpMetadata: value.options.httpMetadata,
      };
    },
  };
  return { store: store as unknown as R2Bucket, objects };
}

describe("cloud output receipts", () => {
  it("returns an opaque media handle only after durable bytes and a receipt, and reuses the first winner", async () => {
    const { store, objects } = bucket();
    const broker = createGenerationOutputBroker(
      store,
      { actionRunId: "task", outputSlot: "output" },
      "project",
    );
    const first = await broker.store(
      new Uint8Array([1, 2, 3]),
      "image/png",
      "image",
    );
    const verified = await broker.resolve(first);
    expect(verified.byteLength).toBe(3);
    expect(first.uri).toBe(`clash-asset://${first.assetId}`);
    expect(first.assetId).not.toContain("/");
    const repeated = await broker.store(
      new Uint8Array([9, 8]),
      "image/png",
      "image",
    );
    expect(repeated).toEqual(first);
    expect(await broker.resolve(repeated)).toEqual(verified);
    objects.delete(verified.storageKey);
    await expect(broker.resolve(first)).rejects.toThrow(/missing/i);
  });

  it("does not return completed media when receipt persistence fails", async () => {
    const { store } = bucket();
    const original = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation((async (
      key: string,
      value: any,
      options: any,
    ) => {
      if (key.endsWith(".json")) throw new Error("receipt unavailable");
      return original(key, value, options);
    }) as any);
    const broker = createGenerationOutputBroker(
      store,
      { actionRunId: "task", outputSlot: "output" },
      "project",
    );
    await expect(
      broker.store(new Uint8Array([1]), "image/png", "image"),
    ).rejects.toThrow("receipt unavailable");
  });
});

it("durably preserves a provider cover separately from the primary video receipt", async () => {
  const { store } = bucket();
  const broker = createGenerationOutputBroker(
    store,
    { actionRunId: "task", outputSlot: "output" },
    "project",
  );
  const cover = createGenerationOutputBroker(
    store,
    { actionRunId: "task", outputSlot: "output:cover" },
    "project",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          new Uint8Array(url.endsWith("cover") ? [4, 5] : [1, 2, 3]),
        ),
    ),
  );
  try {
    const context = new GenerationContext(
      {
        taskId: "task",
        projectId: "project",
        nodeId: "node",
        type: "video_gen",
        actorType: "user",
        actorUserId: "user",
      },
      {} as never,
      broker,
      cover,
    );
    const result = await context.completedVideo(
      "https://vendor.test/video",
      "video/mp4",
      { coverImageUrl: "https://vendor.test/cover" },
    );
    if (result.status !== "completed")
      throw new Error("expected completed media");
    const primary = result.outputs.find((output) => output.slot === "output");
    const hints = result.outputs.find((output) => output.slot === "projection");
    if (primary?.kind !== "asset" || hints?.kind !== "value")
      throw new Error("missing receipts");
    expect((await broker.resolve(primary.asset)).kind).toBe("video");
    expect(await cover.resolve((hints.value as any).cover)).toMatchObject({
      kind: "image",
      byteLength: 2,
    });
    expect(JSON.stringify(result)).not.toContain("vendor.test");
  } finally {
    vi.unstubAllGlobals();
  }
});
