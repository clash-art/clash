import { createHash } from "node:crypto";
import type { LoroDoc } from "loro-crdt";
import {
  projectCanvasPreviewFromDoc,
  type ProjectCanvasPreview,
} from "@clash/shared-types";

import type {
  CachedProjectCanvasPreview,
  FileReplicaStore,
} from "./loro/file-replica-store.js";

/** Identity of the whole Project document, used only to validate cached previews. */
export function projectCanvasDocVersion(doc: LoroDoc): string {
  return createHash("sha256").update(doc.version().encode()).digest("hex");
}

/**
 * The preview cache is keyed twice: by the document version that produced it
 * (validation) and by the drawn preview content (thumbnail identity). A
 * timeline-only edit advances the former and leaves the latter untouched.
 */
export function projectCanvasPreviewCacheEntryFromDoc(
  doc: LoroDoc,
  generatedAt = new Date().toISOString(),
): CachedProjectCanvasPreview {
  const preview = projectCanvasPreviewFromDoc(doc);
  return {
    sourceVersion: createHash("sha256")
      .update(JSON.stringify(preview))
      .digest("hex"),
    docVersion: projectCanvasDocVersion(doc),
    generatedAt,
    preview,
  };
}

/**
 * Reads the saved preview on the hot path. The cached entry is only trusted
 * when it was derived from the current document version; otherwise it is
 * regenerated from the canonical replica, which also repairs a preview write
 * that a Host stop interrupted inside the debounce window.
 */
export async function readThroughProjectCanvasPreview(options: {
  projectId: string;
  store: FileReplicaStore;
  inspect: <T>(read: (doc: LoroDoc) => T | Promise<T>) => Promise<T>;
}): Promise<ProjectCanvasPreview> {
  return (await readThroughProjectCanvasPreviewEntry(options)).preview;
}

export async function readThroughProjectCanvasPreviewEntry(options: {
  projectId: string;
  store: FileReplicaStore;
  inspect: <T>(read: (doc: LoroDoc) => T | Promise<T>) => Promise<T>;
}): Promise<CachedProjectCanvasPreview> {
  const cached = await options.store.readCanvasPreview(options.projectId);
  if (cached) {
    const docVersion = await options.inspect(projectCanvasDocVersion);
    if (cached.docVersion === docVersion) return cached;
  }

  const entry = await options.inspect((doc) =>
    projectCanvasPreviewCacheEntryFromDoc(doc),
  );
  await options.store.writeCanvasPreview(options.projectId, entry);
  return entry;
}
