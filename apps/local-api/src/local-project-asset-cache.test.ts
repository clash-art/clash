import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { LocalResourceProjection } from "./local-resource-store.js";
import {
  BoundedLruCache,
  LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES,
  invalidateLocalProjectAssetCaches,
  localProjectAssetCachesFor,
  localProjectAssetProjectionKey,
} from "./local-project-asset-cache.js";

function temporaryProjectsRoot(): string {
  return join(tmpdir(), `clash-project-asset-cache-${randomUUID()}`, "projects");
}

describe("Local Project Asset caches", () => {
  it("bounds the projection cache and evicts the least recently used entry", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("keeps the process projection cache at the 4096-entry bound", () => {
    const caches = localProjectAssetCachesFor(temporaryProjectsRoot());
    const extra = 17;
    for (
      let index = 0;
      index < LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES + extra;
      index += 1
    ) {
      caches.projections.set(
        localProjectAssetProjectionKey({
          projectId: "project-bound",
          projectAssetId: `asset:${index}`,
          resourceId: `sha256:${index}`,
        }),
        {} as LocalResourceProjection,
      );
    }

    expect(caches.projections.size).toBe(
      LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES,
    );
    expect(
      caches.projections.get(
        localProjectAssetProjectionKey({
          projectId: "project-bound",
          projectAssetId: "asset:0",
          resourceId: "sha256:0",
        }),
      ),
    ).toBeUndefined();
    expect(
      caches.projections.get(
        localProjectAssetProjectionKey({
          projectId: "project-bound",
          projectAssetId: `asset:${LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES + extra - 1}`,
          resourceId: `sha256:${LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES + extra - 1}`,
        }),
      ),
    ).toBeDefined();
  });

  it("invalidates both caches for one Project only", () => {
    const projectsRoot = temporaryProjectsRoot();
    const caches = localProjectAssetCachesFor(projectsRoot);
    caches.materializedProjects.add("project-a");
    caches.materializedProjects.add("project-b");
    caches.projections.set(
      localProjectAssetProjectionKey({
        projectId: "project-a",
        projectAssetId: "asset:a",
        resourceId: "sha256:a",
      }),
      {} as LocalResourceProjection,
    );
    caches.projections.set(
      localProjectAssetProjectionKey({
        projectId: "project-b",
        projectAssetId: "asset:b",
        resourceId: "sha256:b",
      }),
      {} as LocalResourceProjection,
    );

    invalidateLocalProjectAssetCaches({
      projectsRoot,
      projectId: "project-a",
    });

    expect(caches.materializedProjects.has("project-a")).toBe(false);
    expect(caches.materializedProjects.has("project-b")).toBe(true);
    expect(
      caches.projections.get(
        localProjectAssetProjectionKey({
          projectId: "project-a",
          projectAssetId: "asset:a",
          resourceId: "sha256:a",
        }),
      ),
    ).toBeUndefined();
    expect(
      caches.projections.get(
        localProjectAssetProjectionKey({
          projectId: "project-b",
          projectAssetId: "asset:b",
          resourceId: "sha256:b",
        }),
      ),
    ).toBeDefined();
  });
});
