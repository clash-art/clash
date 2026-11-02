import { describe, expect, it } from "vitest";
import {
  createLocalResourcePrefetcher,
  LocalResourceDownloadError,
  PREFETCH_RANK,
  resourceDownloadFailureCode,
  type LocalResourceDownloadContext,
  type LocalResourcePrefetchRef,
} from "./local-resource-prefetch";
import { LocalResourceStreamMismatchError } from "./local-resource-store";
import { CloudContentIntegrityError } from "./project-cloud-content";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ref = (resourceId: string): LocalResourcePrefetchRef => ({
  resourceId,
  kind: "image",
});

async function settle() {
  for (let index = 0; index < 5; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("resourceDownloadFailureCode", () => {
  it("maps write, integrity and remote failures onto the coded download set", () => {
    expect(
      resourceDownloadFailureCode(
        Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      ),
    ).toBe("LOCAL_STORE_DISK_FULL");
    expect(
      resourceDownloadFailureCode(
        new Error("write failed", {
          cause: Object.assign(new Error("quota"), { code: "EDQUOT" }),
        }),
      ),
    ).toBe("LOCAL_STORE_DISK_FULL");
    expect(resourceDownloadFailureCode(new CloudContentIntegrityError())).toBe(
      "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY",
    );
    expect(
      resourceDownloadFailureCode(
        new LocalResourceStreamMismatchError("digest mismatch"),
      ),
    ).toBe("LOCAL_RESOURCE_DOWNLOAD_INTEGRITY");
    expect(
      resourceDownloadFailureCode(Object.assign(new Error("gone"), { status: 404 })),
    ).toBe("LOCAL_RESOURCE_REMOTE_MISSING");
    expect(resourceDownloadFailureCode(new TypeError("fetch failed"))).toBe(
      "LOCAL_RESOURCE_DOWNLOAD_FAILED",
    );
  });
});

describe("Host Resource prefetcher", () => {
  it("downloads visible Assets before earlier-queued ones, one per Project", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      download: async (_projectId, item) => {
        started.push(item.resourceId);
        const gate = deferred();
        gates.set(item.resourceId, gate);
        await gate.promise;
      },
    });
    prefetcher.enqueue("project", [
      { ...ref("first"), rank: PREFETCH_RANK.rest },
      { ...ref("second"), rank: PREFETCH_RANK.rest },
      { ...ref("late-visible"), rank: PREFETCH_RANK.rest },
    ]);
    await settle();
    // One per Project even though the Host allows two.
    expect(started).toEqual(["first"]);
    // A visible-Asset hint for a Resource late in document order jumps the queue.
    prefetcher.enqueue("project", [
      { ...ref("late-visible"), rank: PREFETCH_RANK.visible },
    ]);
    gates.get("first")!.resolve();
    await settle();
    expect(started).toEqual(["first", "late-visible"]);
    gates.get("late-visible")!.resolve();
    await settle();
    gates.get("second")!.resolve();
    await prefetcher.idle();
    expect(started).toEqual(["first", "late-visible", "second"]);
    await prefetcher.close();
  });

  it("joins the coordinator onto an in-flight download instead of fetching twice", async () => {
    let downloads = 0;
    const gate = deferred();
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      download: async () => {
        downloads += 1;
        await gate.promise;
      },
    });
    prefetcher.enqueue("project", [{ ...ref("shared"), rank: 0 }]);
    await settle();
    let coordinatorDownloads = 0;
    const joined = prefetcher.run("project", ref("shared"), async () => {
      coordinatorDownloads += 1;
    });
    gate.resolve();
    await joined;
    await prefetcher.idle();
    expect({ downloads, coordinatorDownloads }).toEqual({
      downloads: 1,
      coordinatorDownloads: 0,
    });
    expect(prefetcher.availability("shared")).toBeUndefined();
    await prefetcher.close();
  });

  it("reports queued and in-flight bytes as downloading with progress that never moves backwards", async () => {
    const gate = deferred();
    let context!: LocalResourceDownloadContext;
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      maxConcurrent: 1,
      download: async (_projectId, _item, received) => {
        context = received;
        await gate.promise;
      },
    });
    prefetcher.enqueue("project", [{ ...ref("video"), rank: 0 }]);
    prefetcher.enqueue("other", [{ ...ref("queued"), rank: 0 }]);
    expect(prefetcher.availability("queued")).toEqual({
      status: "downloading",
      progress: 0,
    });
    await settle();
    const seen: number[] = [];
    for (const received of [10, 40, 20, 100]) {
      context.progress(received, 100);
      const state = prefetcher.availability("video");
      if (state?.status === "downloading") seen.push(state.progress);
    }
    expect(seen).toEqual([0.1, 0.4, 0.4, 1]);
    gate.resolve();
    await prefetcher.idle();
    expect(prefetcher.availability("video")).toBeUndefined();
    await prefetcher.close();
  });

  it("records a coded failure per Asset, keeps downloading the others and retries with backoff", async () => {
    let failing = true;
    const attempts: string[] = [];
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      retryBaseMs: 1,
      download: async (_projectId, item) => {
        attempts.push(item.resourceId);
        if (item.resourceId === "broken" && failing)
          throw new LocalResourceDownloadError(
            "LOCAL_RESOURCE_REMOTE_MISSING",
            "no bytes in the cloud",
          );
      },
    });
    prefetcher.enqueue("project", [
      { ...ref("broken"), rank: 0 },
      { ...ref("fine"), rank: 1 },
    ]);
    await prefetcher.idle();
    expect(prefetcher.availability("broken")).toEqual({
      status: "failed",
      errorCode: "LOCAL_RESOURCE_REMOTE_MISSING",
      error: "LOCAL_RESOURCE_REMOTE_MISSING: no bytes in the cloud",
    });
    expect(attempts).toContain("fine");
    expect(prefetcher.availability("fine")).toBeUndefined();
    failing = false;
    await expect
      .poll(() => prefetcher.availability("broken"), { timeout: 2_000 })
      .toBeUndefined();
    expect(attempts.filter((id) => id === "broken").length).toBeGreaterThan(1);
    await prefetcher.close();
  });

  it("pauses on a full store before writing, reports LOCAL_STORE_DISK_FULL and resumes once space returns", async () => {
    let free = 10;
    const written: string[] = [];
    const storeStates: Array<string | undefined> = [];
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => free,
      reserveBytes: 5,
      diskRetryMs: 10,
      download: async (_projectId, item, context) => {
        await context.preflight(100);
        written.push(item.resourceId);
      },
      onStoreState: (_projectId, state) => storeStates.push(state?.code),
    });
    prefetcher.enqueue("project", [
      { ...ref("big"), rank: 0 },
      { ...ref("also-big"), rank: 1 },
    ]);
    await prefetcher.idle();
    expect(written).toEqual([]);
    expect(prefetcher.availability("big")).toMatchObject({
      status: "failed",
      errorCode: "LOCAL_STORE_DISK_FULL",
    });
    // The whole queue waits on the volume, not only the Asset that hit it.
    expect(prefetcher.availability("also-big")).toMatchObject({
      status: "failed",
      errorCode: "LOCAL_STORE_DISK_FULL",
    });
    expect(storeStates).toEqual(["LOCAL_STORE_DISK_FULL"]);

    free = 1_000;
    await expect.poll(() => written.length, { timeout: 2_000 }).toBe(2);
    await prefetcher.idle();
    expect(prefetcher.availability("big")).toBeUndefined();
    expect(prefetcher.availability("also-big")).toBeUndefined();
    expect(storeStates).toEqual(["LOCAL_STORE_DISK_FULL", undefined]);
    await prefetcher.close();
  });

  it("does no work and arms no timer when nothing is queued", async () => {
    let calls = 0;
    const prefetcher = createLocalResourcePrefetcher({
      storePath: "/store",
      freeBytes: async () => {
        calls += 1;
        return 0;
      },
      download: async () => {
        calls += 1;
      },
    });
    prefetcher.enqueue("project", []);
    await prefetcher.idle();
    expect(calls).toBe(0);
    await prefetcher.close();
  });
});
