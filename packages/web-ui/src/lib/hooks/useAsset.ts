import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  createPersonalGlobalAssetHttpClient,
  createProjectAssetHttpClient,
} from "@clash/asset-sdk";
import {
  ActionAssetBindingSchema,
  ResolvedAssetSchema,
  type AssetKind,
  type ResolvedAsset,
} from "@clash/shared-types";
import { fetchWithRetry } from "./retryFetch";

type ScopedAsset = {
  projectId: string;
  assetId: string;
};

type PendingAsset = ScopedAsset & {
  resolve: (asset: ResolvedAsset) => void;
  reject: (error: unknown) => void;
};

/**
 * ResolvedAsset projections are scoped by Project. The same asset id may be
 * visible, unavailable, or projected to a different Host URL in another
 * Project, so every cache and in-flight key includes projectId.
 */
const cache = new Map<string, ResolvedAsset>();
const subscribers = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<ResolvedAsset>>();
const pending = new Map<string, PendingAsset>();
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function scopedKey(projectId: string, assetId: string): string {
  return JSON.stringify([projectId, assetId]);
}

const projectAssets = createProjectAssetHttpClient({
  credentials: "include",
  fetch: (input, init) => fetchWithRetry(String(input), init),
});

const personalGlobalAssets = createPersonalGlobalAssetHttpClient({
  credentials: "include",
  fetch: (input, init) => fetchWithRetry(String(input), init),
});

function cacheAsset(projectId: string, asset: ResolvedAsset): void {
  const key = scopedKey(projectId, asset.id);
  const current = cache.get(key);
  // These are validated JSON projections from the Host. Keep the existing
  // snapshot when a list/availability refresh returns the same facts, while
  // still publishing URL, status, metadata and lifecycle changes immediately.
  if (current && JSON.stringify(current) === JSON.stringify(asset)) return;
  cache.set(key, asset);
  for (const notify of subscribers.get(key) ?? []) notify();
}

function scheduleFlush(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    void flushPending();
  }, 0);
}

async function flushProject(
  projectId: string,
  entries: PendingAsset[],
): Promise<void> {
  const assetIds = entries.map((entry) => entry.assetId);
  try {
    if (entries.length === 1) {
      const asset = (
        await projectAssets.get({ projectId, assetId: entries[0].assetId })
      ).value;
      cacheAsset(projectId, asset);
      entries[0].resolve(asset);
      return;
    }

    const assets = await projectAssets.batch({ projectId, assetIds });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const asset of assets) cacheAsset(projectId, asset);

    for (const entry of entries) {
      const asset = byId.get(entry.assetId);
      if (asset) entry.resolve(asset);
      else
        entry.reject(
          new Error(`Asset ${entry.assetId} not found in Project ${projectId}`),
        );
    }
  } catch (error) {
    for (const entry of entries) entry.reject(error);
  } finally {
    for (const assetId of assetIds)
      inflight.delete(scopedKey(projectId, assetId));
  }
}

async function flushPending(): Promise<void> {
  const entries = Array.from(pending.values());
  pending.clear();
  if (entries.length === 0) return;

  const byProject = new Map<string, PendingAsset[]>();
  for (const entry of entries) {
    const projectEntries = byProject.get(entry.projectId) ?? [];
    projectEntries.push(entry);
    byProject.set(entry.projectId, projectEntries);
  }
  await Promise.all(
    Array.from(byProject, ([projectId, projectEntries]) =>
      flushProject(projectId, projectEntries),
    ),
  );
}

function getOrFetch(
  projectId: string,
  assetId: string,
  options: { useCache?: boolean } = {},
): Promise<ResolvedAsset> {
  const key = scopedKey(projectId, assetId);
  const cached = cache.get(key);
  if (options.useCache !== false && cached) return Promise.resolve(cached);

  let request = inflight.get(key);
  if (!request) {
    request = new Promise<ResolvedAsset>((resolve, reject) => {
      pending.set(key, { projectId, assetId, resolve, reject });
      scheduleFlush();
    });
    inflight.set(key, request);
  }
  return request;
}

/** Resolve a Project-scoped, Host-projected read-only Asset view. */
export function useAsset(
  projectId: string | undefined,
  assetId: string | undefined,
): ResolvedAsset | undefined {
  const key = projectId && assetId ? scopedKey(projectId, assetId) : undefined;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => undefined;
      const scopedSubscribers = subscribers.get(key) ?? new Set<() => void>();
      scopedSubscribers.add(notify);
      subscribers.set(key, scopedSubscribers);
      return () => {
        scopedSubscribers.delete(notify);
        if (scopedSubscribers.size === 0) subscribers.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? cache.get(key) : undefined),
    [key],
  );
  const asset = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!projectId || !assetId) return;
    void getOrFetch(projectId, assetId).catch(() => undefined);
  }, [assetId, projectId]);

  return asset;
}

/** Invalidate one Project-scoped projection after a mutation. */
export function invalidateAsset(projectId: string, assetId: string): void {
  const key = scopedKey(projectId, assetId);
  cache.delete(key);
  inflight.delete(key);
  pending.delete(key);
  for (const notify of subscribers.get(key) ?? []) notify();
}

/** Imperative Project-scoped read for workflow callbacks. */
export async function getAsset(
  projectId: string,
  assetId: string,
): Promise<ResolvedAsset> {
  return getOrFetch(projectId, assetId);
}

/** List the current Host projections for every Asset admitted to a Project. */
export async function listProjectAssets(
  projectId: string,
): Promise<ResolvedAsset[]> {
  const assets = await projectAssets.list({ projectId });
  for (const asset of assets) cacheAsset(projectId, asset);
  return assets;
}

/** Re-read the current Host projection, replacing any cached availability or URL. */
export async function refreshAsset(
  projectId: string,
  assetId: string,
): Promise<ResolvedAsset> {
  return getOrFetch(projectId, assetId, { useCache: false });
}

export interface AssetProjectionWatchScheduler {
  (run: () => void, delayMs: number): () => void;
}

function defaultAssetProjectionWatchScheduler(
  run: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

/**
 * Refresh a device-local projection until it becomes ready or fails terminally.
 * Project identity/lifecycle remains in Loro; only Host availability is polled.
 */
export function watchAssetProjection(input: {
  projectId: string;
  assetId: string;
  onProjection: (asset: ResolvedAsset) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  schedule?: AssetProjectionWatchScheduler;
}): () => void {
  let stopped = false;
  let cancelScheduled: (() => void) | undefined;
  const schedule = input.schedule ?? defaultAssetProjectionWatchScheduler;

  const run = () => {
    if (stopped) return;
    void refreshAsset(input.projectId, input.assetId)
      .then((asset) => {
        if (stopped) return;
        input.onProjection(asset);
        if (
          asset.lifecycle.state === "active" &&
          asset.status !== "ready" &&
          asset.status !== "failed"
        ) {
          cancelScheduled = schedule(run, input.intervalMs ?? 2_000);
        }
      })
      .catch((error) => {
        if (!stopped) input.onError?.(error);
      });
  };

  run();
  return () => {
    stopped = true;
    cancelScheduled?.();
  };
}

/**
 * Import immutable bytes and publish one ProjectAsset in a single Host operation.
 * The client-selected id makes a retried multipart request idempotent; callers only
 * receive the same read-only ResolvedAsset projection used by every other surface.
 */
export async function importProjectAssetFile(
  projectId: string,
  file: File,
  options: { kind: AssetKind; projectAssetId?: string },
): Promise<ResolvedAsset> {
  const projectAssetId =
    options.projectAssetId ?? `asset-${crypto.randomUUID()}`;
  const asset = await projectAssets.importFile({
    projectId,
    file,
    kind: options.kind,
    projectAssetId,
  });
  if (asset.id !== projectAssetId) {
    throw new Error(
      `Project Asset import returned ${asset.id}; expected ${projectAssetId}`,
    );
  }
  cacheAsset(projectId, asset);
  return asset;
}

/**
 * Publish browser-rendered Director bytes without letting the browser invent
 * Action or binding identity. The Host pins the immutable Asset to the exact
 * Stage revision and returns the canonical producer relation.
 */
export async function publishDirectorStageOutputFile(input: {
  projectId: string;
  stageId: string;
  sourceStageRevisionId: string;
  artifactId: string;
  kind: "image" | "video";
  file: File;
}): Promise<ResolvedAsset> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("kind", input.kind);
  form.set("sourceStageRevisionId", input.sourceStageRevisionId);
  form.set("artifactId", input.artifactId);
  const response = await fetchWithRetry(
    `/api/v1/projects/${encodeURIComponent(input.projectId)}/director-stages/${encodeURIComponent(input.stageId)}/outputs`,
    {
      method: "POST",
      credentials: "include",
      body: form,
    },
  );
  const value = (await response.json().catch(() => undefined)) as
    { asset?: unknown; binding?: unknown; error?: unknown } | undefined;
  if (!response.ok) {
    throw new Error(
      typeof value?.error === "string" && value.error.trim()
        ? value.error
        : `Director output publication failed with HTTP ${response.status}`,
    );
  }
  const asset = ResolvedAssetSchema.parse(value?.asset);
  const binding = ActionAssetBindingSchema.parse(value?.binding);
  if (
    binding.direction !== "output" ||
    binding.projectAssetId !== asset.id ||
    binding.owner.kind !== "run" ||
    binding.owner.actionRevisionId !== input.sourceStageRevisionId
  ) {
    throw new Error(
      "Director output publication returned a mismatched binding",
    );
  }
  cacheAsset(input.projectId, asset);
  return asset;
}

/** Admit a pinned personal-library Resource as one Project-scoped Asset identity. */
export async function admitPersonalGlobalAssetToProject(
  projectId: string,
  globalAssetId: string,
): Promise<ResolvedAsset> {
  const asset = await projectAssets.admit({ projectId, globalAssetId });
  cacheAsset(projectId, asset);
  return asset;
}

/** List the personal reusable-media library through the canonical Global Asset adapter. */
export function listPersonalGlobalAssets(): Promise<ResolvedAsset[]> {
  return personalGlobalAssets.list();
}

/** Import immutable bytes into the personal reusable-media library. */
export function importPersonalGlobalAssetFile(
  file: File,
  kind: AssetKind,
  options: { globalAssetId?: string } = {},
): Promise<ResolvedAsset> {
  return personalGlobalAssets.importFile({
    file,
    kind,
    globalAssetId: options.globalAssetId ?? `global:${crypto.randomUUID()}`,
  });
}

/** Publish a Project Resource as an independent personal-library entry. */
export function publishProjectAssetToPersonalLibrary(
  projectId: string,
  projectAssetId: string,
): Promise<ResolvedAsset> {
  return personalGlobalAssets.publish({ projectId, projectAssetId });
}

/** Logically trash one Project Asset after observing its current reference set. */
export async function trashProjectAsset(
  projectId: string,
  projectAssetId: string,
): Promise<ResolvedAsset> {
  const observation = await projectAssets.get({
    projectId,
    assetId: projectAssetId,
  });
  const result = await projectAssets.trash({
    projectId,
    assetId: projectAssetId,
    actorClientType: "gui",
    receipt: observation.receipt,
  });
  cacheAsset(projectId, result.value);
  return result.value;
}

/** Restore a logically trashed Project Asset using the same observed-CAS flow. */
export async function restoreProjectAsset(
  projectId: string,
  projectAssetId: string,
): Promise<ResolvedAsset> {
  const observation = await projectAssets.get({
    projectId,
    assetId: projectAssetId,
  });
  const result = await projectAssets.restore({
    projectId,
    assetId: projectAssetId,
    actorClientType: "gui",
    receipt: observation.receipt,
  });
  cacheAsset(projectId, result.value);
  return result.value;
}

/** Logically trash one personal Global Asset without affecting admitted Projects. */
export function trashPersonalGlobalAsset(input: {
  globalAssetId: string;
}): Promise<ResolvedAsset> {
  return personalGlobalAssets.trash(input);
}

/** Restore one personal Global Asset during its logical recovery window. */
export async function restorePersonalGlobalAsset(
  globalAssetId: string,
  observedDeleteOperationId: string,
): Promise<ResolvedAsset> {
  const deleteOperationId = observedDeleteOperationId.trim();
  if (!deleteOperationId) {
    throw new Error("Observed Global Asset delete operation is required");
  }
  return personalGlobalAssets.restore({
    globalAssetId,
    deleteOperationId,
  });
}
