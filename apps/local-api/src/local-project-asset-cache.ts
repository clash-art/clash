import { resolve } from "node:path";

import type { LocalResourceProjection } from "./local-resource-store.js";

/** Warm media seeks must not grow this cache without bound. */
export const LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES = 4096;

const PROJECT_KEY_SEPARATOR = "\u0000";

/**
 * Small insertion-ordered LRU. `Map` already preserves insertion order, so a
 * hit is refreshed by deleting and re-inserting the key.
 */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("BoundedLruCache maxEntries must be a positive integer.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (typeof key === "string" && key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface LocalProjectAssetCaches {
  /** Projects whose one-way legacy Asset cutover already ran in this process. */
  readonly materializedProjects: Set<string>;
  /** Immutable Resource projections, keyed by project + Asset + Resource. */
  readonly projections: BoundedLruCache<string, LocalResourceProjection>;
}

const cachesByProjectsRoot = new Map<string, LocalProjectAssetCaches>();

/**
 * Cache lifetime is the Host process, but it is scoped by the Project replica
 * root so every service over the same Host data directory shares the same
 * facts and one invalidation clears all of them.
 */
export function localProjectAssetCachesFor(
  projectsRoot: string,
): LocalProjectAssetCaches {
  const key = resolve(projectsRoot);
  let caches = cachesByProjectsRoot.get(key);
  if (!caches) {
    caches = {
      materializedProjects: new Set(),
      projections: new BoundedLruCache(
        LOCAL_PROJECT_ASSET_PROJECTION_CACHE_MAX_ENTRIES,
      ),
    };
    cachesByProjectsRoot.set(key, caches);
  }
  return caches;
}

export function localProjectAssetProjectionKey(input: {
  projectId: string;
  projectAssetId: string;
  resourceId: string;
}): string {
  return [input.projectId, input.projectAssetId, input.resourceId].join(
    PROJECT_KEY_SEPARATOR,
  );
}

/**
 * Drops both caches for one Project. Every path that deletes, purges,
 * replaces, imports or restores a Project replica must call this: a stale
 * `materializedProjects` entry would otherwise skip the cutover for the new
 * replica and make its Assets silently unavailable.
 */
export function invalidateLocalProjectAssetCaches(input: {
  projectsRoot: string;
  projectId: string;
}): void {
  const caches = cachesByProjectsRoot.get(resolve(input.projectsRoot));
  if (!caches) return;
  caches.materializedProjects.delete(input.projectId);
  caches.projections.deleteByPrefix(
    `${input.projectId}${PROJECT_KEY_SEPARATOR}`,
  );
}
