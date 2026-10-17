import { describe, expect, it, vi } from "vitest";
import { createContentReferenceIndexer } from "./content-index";

describe("content reference indexer", () => {
  it("debounces bursts, skips unchanged writes, refresh returns refs", async () => {
    let refs = { resources: [], documents: [{ digest: "sha256:a", byteLength: 1, contentType: "x" }] };
    const replace = vi.fn(async () => {});
    const indexer = createContentReferenceIndexer({ compute: () => refs, writer: { replace }, debounceMs: 5 });
    indexer.changed();
    indexer.changed();
    indexer.changed();
    await new Promise((r) => setTimeout(r, 20));
    await indexer.flush();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await indexer.refresh()).toBe(refs);
    expect(replace).toHaveBeenCalledTimes(1);
    refs = { resources: [], documents: [] };
    await indexer.refresh();
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("reports writer failures and retries on next change", async () => {
    const onError = vi.fn();
    const replace = vi.fn().mockRejectedValueOnce(new Error("d1 down")).mockResolvedValue(undefined);
    const indexer = createContentReferenceIndexer({ compute: () => ({ resources: [], documents: [] }), writer: { replace }, onError });
    await expect(indexer.refresh()).rejects.toThrow("d1 down");
    await indexer.flush();
    expect(onError).toHaveBeenCalled();
    await indexer.refresh();
    expect(replace).toHaveBeenCalledTimes(2);
  });
});
