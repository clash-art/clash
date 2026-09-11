// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import {
  admitPersonalGlobalAssetToProject,
  getAsset,
  importPersonalGlobalAssetFile,
  importProjectAssetFile,
  invalidateAsset,
  listProjectAssets,
  listPersonalGlobalAssets,
  publishDirectorStageOutputFile,
  publishProjectAssetToPersonalLibrary,
  refreshAsset,
  restoreProjectAsset,
  restorePersonalGlobalAsset,
  trashProjectAsset,
  trashPersonalGlobalAsset,
  useAsset,
  watchAssetProjection,
} from "./useAsset";
import type { ResolvedAsset } from "@clash/shared-types";

function makeAsset(over: Partial<ResolvedAsset> = {}): ResolvedAsset {
  return {
    id: "asset-1",
    kind: "image",
    name: "Source image",
    metadata: { width: 1024, height: 768, contentType: "image/png" },
    lifecycle: { state: "active" },
    status: "ready",
    url: "https://media.clash.test/assets/asset-1",
    thumbnailUrl: "https://media.clash.test/thumbnails/asset-1",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-clash-read-receipt": "browser-read-receipt",
    },
  });
}

describe("useAsset", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    // Wipe module-level cache between tests by invalidating known IDs we touch.
    invalidateAsset("project-1", "asset-1");
    invalidateAsset("project-1", "asset-2");
    invalidateAsset("project-1", "asset-3");
    invalidateAsset("project-1", "asset-cover");
    invalidateAsset("project-1", "asset-error");
    invalidateAsset("project-1", "asset-refresh");
    invalidateAsset("project-1", "asset-watch");
    invalidateAsset("project-1", "asset-subscribed");
    invalidateAsset("project-1", "asset-admitted");
    invalidateAsset("project-2", "asset-1");
  });

  it("does not rerender unchanged asset consumers on a project refresh, but publishes changed projections", async () => {
    let first = makeAsset();
    let second = makeAsset({ id: "asset-2" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ assets: [first, second] }),
    );
    await listProjectAssets("project-1");
    let firstRenders = 0;
    let secondRenders = 0;
    const one = renderHook(() => {
      firstRenders++;
      return useAsset("project-1", "asset-1");
    });
    const two = renderHook(() => {
      secondRenders++;
      return useAsset("project-1", "asset-2");
    });
    const before = [firstRenders, secondRenders];
    const original = one.result.current;
    await act(async () => {
      await listProjectAssets("project-1");
    });
    expect(one.result.current).toBe(original);
    expect([firstRenders, secondRenders]).toEqual(before);
    second = makeAsset({
      id: "asset-2",
      url: "https://media.clash.test/new-delivery",
      metadata: { width: 2048 },
    });
    await act(async () => {
      await listProjectAssets("project-1");
    });
    expect(firstRenders).toBe(before[0]);
    expect(two.result.current?.url).toBe(second.url);
    expect(two.result.current?.metadata.width).toBe(2048);
    first = makeAsset({ status: "failed", error: "Projection unavailable" });
    await act(async () => {
      await listProjectAssets("project-1");
    });
    expect(one.result.current?.status).toBe("failed");
    expect(one.result.current?.error).toBe("Projection unavailable");
  });

  it("returns undefined immediately when assetId is undefined", () => {
    const { result } = renderHook(() => useAsset("project-1", undefined));
    expect(result.current).toBeUndefined();
  });

  it("fetches and resolves a fresh asset", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(makeAsset()));

    const { result } = renderHook(() => useAsset("project-1", "asset-1"));
    expect(result.current).toBeUndefined();

    await waitFor(() => expect(result.current?.id).toBe("asset-1"));
    // fetchWithRetry passes a second arg with the (possibly undefined) signal; match loosely.
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "/api/v1/projects/project-1/assets/asset-1",
    );
  });

  it("URL-encodes the asset id (handles slashes/colons)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(makeAsset({ id: "weird/id:1" })));
    renderHook(() => useAsset("project/one", "weird/id:1"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "/api/v1/projects/project%2Fone/assets/weird%2Fid%3A1",
    );
  });

  it("uses the injected runtime API base URL", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      apiBaseUrl: "http://127.0.0.1:49152",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(makeAsset({ id: "asset-runtime" })));

    renderHook(() => useAsset("project-1", "asset-runtime"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://127.0.0.1:49152/api/v1/projects/project-1/assets/asset-runtime",
    );
  });

  it("dedupes concurrent requests for the same id (one network call)", async () => {
    let resolveFetch: (r: Response) => void;
    const promise = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(promise);

    const r1 = renderHook(() => useAsset("project-1", "asset-2"));
    const r2 = renderHook(() => useAsset("project-1", "asset-2"));
    const r3 = renderHook(() => useAsset("project-1", "asset-2"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "/api/v1/projects/project-1/assets/asset-2",
    );

    await act(async () => {
      resolveFetch!(jsonResponse(makeAsset({ id: "asset-2" })));
      await promise;
    });

    await waitFor(() => {
      expect(r1.result.current?.id).toBe("asset-2");
      expect(r2.result.current?.id).toBe("asset-2");
      expect(r3.result.current?.id).toBe("asset-2");
    });
  });

  it("batches concurrent requests for different ids", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        assets: [makeAsset({ id: "asset-1" }), makeAsset({ id: "asset-2" })],
      }),
    );

    const r1 = renderHook(() => useAsset("project-1", "asset-1"));
    const r2 = renderHook(() => useAsset("project-1", "asset-2"));

    await waitFor(() => {
      expect(r1.result.current?.id).toBe("asset-1");
      expect(r2.result.current?.id).toBe("asset-2");
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "/api/v1/projects/project-1/assets/batch",
    );
    expect(
      JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({
      ids: ["asset-1", "asset-2"],
    });
  });

  it("serves subsequent reads from cache (no second fetch)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(makeAsset({ id: "asset-3" })));

    const r1 = renderHook(() => useAsset("project-1", "asset-3"));
    await waitFor(() => expect(r1.result.current?.id).toBe("asset-3"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // New mount → cache hit, no extra fetch
    const r2 = renderHook(() => useAsset("project-1", "asset-3"));
    await waitFor(() => expect(r2.result.current?.id).toBe("asset-3"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidateAsset forces a re-fetch on next read", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(makeAsset({ id: "asset-cover", thumbnailUrl: undefined })),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          makeAsset({
            id: "asset-cover",
            thumbnailUrl: "https://media.clash.test/thumbnails/asset-cover",
          }),
        ),
      );

    const r1 = renderHook(() => useAsset("project-1", "asset-cover"));
    await waitFor(() =>
      expect(r1.result.current?.thumbnailUrl).toBeUndefined(),
    );

    invalidateAsset("project-1", "asset-cover");

    const r2 = renderHook(() => useAsset("project-1", "asset-cover"));
    await waitFor(() =>
      expect(r2.result.current?.thumbnailUrl).toBe(
        "https://media.clash.test/thumbnails/asset-cover",
      ),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined after fetch retries are exhausted (does not throw)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));

    const { result } = renderHook(() => useAsset("project-1", "asset-error"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();
  });

  it("getAsset (imperative) returns the same cached value", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(makeAsset({ id: "asset-1" })),
    );

    const a = await getAsset("project-1", "asset-1");
    expect(a.id).toBe("asset-1");

    // Second call hits cache (no new fetch, but should still resolve identically)
    const b = await getAsset("project-1", "asset-1");
    expect(b).toEqual(a);
  });

  it("refreshAsset bypasses a stale unavailable projection and replaces the cache", async () => {
    const unavailable = makeAsset({
      id: "asset-refresh",
      status: "unavailable",
      url: undefined,
      thumbnailUrl: undefined,
      error: "Not installed on this Host",
    });
    const ready = makeAsset({ id: "asset-refresh" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(ready));

    await expect(getAsset("project-1", "asset-refresh")).resolves.toEqual(
      unavailable,
    );
    await expect(refreshAsset("project-1", "asset-refresh")).resolves.toEqual(
      ready,
    );
    await expect(getAsset("project-1", "asset-refresh")).resolves.toEqual(
      ready,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("watches retryable Host availability until the projection becomes ready", async () => {
    const unavailable = makeAsset({
      id: "asset-watch",
      status: "unavailable",
      url: undefined,
      thumbnailUrl: undefined,
    });
    const ready = makeAsset({ id: "asset-watch" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(ready));
    const scheduled: Array<() => void> = [];
    const onProjection = vi.fn();

    const stop = watchAssetProjection({
      projectId: "project-1",
      assetId: "asset-watch",
      onProjection,
      schedule: (run) => {
        scheduled.push(run);
        return () => undefined;
      },
    });

    await waitFor(() => expect(onProjection).toHaveBeenCalledWith(unavailable));
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await waitFor(() => expect(onProjection).toHaveBeenLastCalledWith(ready));
    expect(scheduled).toHaveLength(0);
    stop();
  });

  it("publishes refreshed projections to every mounted useAsset consumer", async () => {
    const unavailable = makeAsset({
      id: "asset-subscribed",
      status: "unavailable",
      url: undefined,
      thumbnailUrl: undefined,
    });
    const ready = makeAsset({ id: "asset-subscribed" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(ready));

    const first = renderHook(() => useAsset("project-1", "asset-subscribed"));
    const second = renderHook(() => useAsset("project-1", "asset-subscribed"));
    await waitFor(() => expect(first.result.current).toEqual(unavailable));

    await act(async () => {
      await refreshAsset("project-1", "asset-subscribed");
    });

    await waitFor(() => expect(first.result.current).toEqual(ready));
    expect(second.result.current).toEqual(ready);
  });

  it("does not share a cached asset across project scopes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(makeAsset({ name: "Project one asset" })),
      )
      .mockResolvedValueOnce(
        jsonResponse(makeAsset({ name: "Project two asset" })),
      );

    await expect(getAsset("project-1", "asset-1")).resolves.toMatchObject({
      name: "Project one asset",
    });
    await expect(getAsset("project-2", "asset-1")).resolves.toMatchObject({
      name: "Project two asset",
    });

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/projects/project-1/assets/asset-1",
      "/api/v1/projects/project-2/assets/asset-1",
    ]);
  });

  it("imports bytes through the Project-scoped Host endpoint and caches the returned projection", async () => {
    const imported = makeAsset({
      id: "asset-imported",
      name: "opening.png",
      url: "https://media.clash.test/api/v1/projects/project-1/assets/asset-imported/media",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(imported));
    const file = new File(["png bytes"], "opening.png", { type: "image/png" });

    await expect(
      importProjectAssetFile("project-1", file, {
        kind: "image",
        projectAssetId: "asset-imported",
      }),
    ).resolves.toEqual(imported);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/projects/project-1/assets/import-file");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("kind")).toBe("image");
    expect(form.get("projectAssetId")).toBe("asset-imported");

    await expect(getAsset("project-1", "asset-imported")).resolves.toEqual(
      imported,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes a Director output through the revision-scoped Host facade", async () => {
    const published = makeAsset({
      id: "director-capture:host-owned",
      name: "opening.png",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          asset: published,
          binding: {
            id: "action-asset:host-owned",
            owner: {
              kind: "run",
              actionId: "director:stage-a",
              actionRevisionId: "revision-a",
              actionRunId: "director-capture:host-owned",
            },
            direction: "output",
            slot: "director:output:opening",
            projectAssetId: published.id,
            role: "primary",
          },
        },
        201,
      ),
    );
    const file = new File(["png bytes"], "opening.png", {
      type: "image/png",
    });

    await expect(
      publishDirectorStageOutputFile({
        projectId: "project-1",
        stageId: "stage-a",
        sourceStageRevisionId: "revision-a",
        artifactId: "opening",
        kind: "image",
        file,
      }),
    ).resolves.toEqual(published);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "/api/v1/projects/project-1/director-stages/stage-a/outputs",
    );
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    const form = init?.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("kind")).toBe("image");
    expect(form.get("sourceStageRevisionId")).toBe("revision-a");
    expect(form.get("artifactId")).toBe("opening");
    expect([...form.keys()].sort()).toEqual([
      "artifactId",
      "file",
      "kind",
      "sourceStageRevisionId",
    ]);
    await expect(getAsset("project-1", published.id)).resolves.toEqual(
      published,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("admits a personal Global Asset through the Project transport and caches it", async () => {
    const admitted = makeAsset({ id: "asset-admitted" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(admitted, 201));

    await expect(
      admitPersonalGlobalAssetToProject("project-1", "global:one"),
    ).resolves.toEqual(admitted);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/v1/projects/project-1/assets/admit",
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ globalAssetId: "global:one" }),
    });
    await expect(getAsset("project-1", "asset-admitted")).resolves.toEqual(
      admitted,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("lists Project Asset projections through the canonical Project transport", async () => {
    const asset = makeAsset();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ assets: [asset] }))
      .mockResolvedValueOnce(jsonResponse(asset));

    await expect(listProjectAssets("project-1")).resolves.toEqual([asset]);
    await expect(getAsset("project-1", asset.id)).resolves.toEqual(asset);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/projects/project-1/assets",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses the personal Global client for list, import, and publish", async () => {
    const globalAsset = makeAsset({ id: "global:one" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ assets: [globalAsset] }))
      .mockResolvedValueOnce(jsonResponse(globalAsset, 201))
      .mockResolvedValueOnce(jsonResponse(globalAsset, 201));
    const file = new File(["png bytes"], "library.png", {
      type: "image/png",
    });

    await expect(listPersonalGlobalAssets()).resolves.toEqual([globalAsset]);
    await expect(importPersonalGlobalAssetFile(file, "image")).resolves.toEqual(
      globalAsset,
    );
    await expect(
      publishProjectAssetToPersonalLibrary("project-1", "asset-1"),
    ).resolves.toEqual(globalAsset);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/libraries/personal/assets",
      "/api/v1/libraries/personal/assets/import-file",
      "/api/v1/libraries/personal/assets/publish",
    ]);
    const importForm = fetchSpy.mock.calls[1]?.[1]?.body as FormData;
    expect(importForm.get("file")).toBe(file);
    expect(importForm.get("kind")).toBe("image");
    expect(String(importForm.get("globalAssetId"))).toMatch(/^global:/u);
    expect(fetchSpy.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({
        projectId: "project-1",
        projectAssetId: "asset-1",
      }),
    });
  });

  it("uses the observed Project revision for logical trash and restore", async () => {
    const trashed = makeAsset({
      lifecycle: {
        state: "trashed",
        deleteOperationId: "delete-1",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-09-12T00:00:00.000Z",
      },
      status: "unavailable",
      url: undefined,
      thumbnailUrl: undefined,
    });
    const restored = makeAsset();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(makeAsset()))
      .mockResolvedValueOnce(jsonResponse(trashed))
      .mockResolvedValueOnce(jsonResponse(trashed))
      .mockResolvedValueOnce(jsonResponse(restored));

    await expect(trashProjectAsset("project-1", "asset-1")).resolves.toEqual(
      trashed,
    );
    await expect(restoreProjectAsset("project-1", "asset-1")).resolves.toEqual(
      restored,
    );

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/projects/project-1/assets/asset-1",
      "/api/v1/projects/project-1/assets/asset-1",
      "/api/v1/projects/project-1/assets/asset-1",
      "/api/v1/projects/project-1/assets/asset-1/restore",
    ]);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({
        "x-clash-client-type": "gui",
        "x-clash-if-match": "browser-read-receipt",
      }),
    });
    expect(fetchSpy.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "x-clash-if-match": "browser-read-receipt",
      }),
    });
  });

  it("restores a personal Global Asset from the delete operation already observed by the GUI", async () => {
    const trashed = makeAsset({
      id: "global:one",
      lifecycle: {
        state: "trashed",
        deleteOperationId: "delete:global-one",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-09-12T00:00:00.000Z",
      },
      status: "unavailable",
      url: undefined,
      thumbnailUrl: undefined,
    });
    const restored = makeAsset({ id: "global:one" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(restored));

    if (trashed.lifecycle.state !== "trashed") {
      throw new Error("fixture must expose a trashed lifecycle observation");
    }

    await expect(
      restorePersonalGlobalAsset(
        "global:one",
        trashed.lifecycle.deleteOperationId,
      ),
    ).resolves.toEqual(restored);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/libraries/personal/assets/global%3Aone/restore",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ deleteOperationId: "delete:global-one" }),
    });
  });

  it("keeps one Global trash operation id when the same GUI command retries an unknown result", async () => {
    const trashed = makeAsset({
      id: "global:one",
      lifecycle: {
        state: "trashed",
        deleteOperationId: "delete:returned",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-09-12T00:00:00.000Z",
      },
      status: "unavailable",
    });
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(init ?? {});
      if (requests.length <= 3) throw new TypeError("connection lost");
      return jsonResponse(trashed);
    });
    const command = { globalAssetId: "global:one" };

    await expect(trashPersonalGlobalAsset(command)).rejects.toThrow(
      "fetchWithRetry gave up",
    );
    await trashPersonalGlobalAsset(command);
    const operationIds = requests
      .filter(({ body }) => body)
      .map(({ body }) => JSON.parse(String(body)).deleteOperationId);
    expect(operationIds[0]).toBeTruthy();
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it("surfaces ASSET_IN_USE instead of hiding a downstream Action reference", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(makeAsset()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "ASSET_IN_USE",
            error: "Project Asset asset-1 is still referenced.",
            references: [
              {
                id: "binding-1",
                owner: { kind: "draft", actionId: "timeline:cut" },
                direction: "input",
                slot: "timeline:item:clip-1",
                projectAssetId: "asset-1",
              },
            ],
          },
          409,
        ),
      );

    await expect(
      trashProjectAsset("project-1", "asset-1"),
    ).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: "ASSET_IN_USE" }),
    });
  });
});
