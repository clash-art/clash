/**
 * Storage-agnostic Project Asset logic for cloud adapters (api-node, api-cf).
 *
 * Everything here reads or writes one Project Loro document; Resource rows,
 * bytes and media URLs stay behind the caller's ports. Write helpers report
 * failures as JSON results so the adapter can discard the document instead of
 * persisting partial edits.
 */
import type { LoroDoc } from "loro-crdt";
import { resolveProjectAsset } from "@clash/asset-sdk";
import {
  createProjectAsset,
  listActionAssetReferences,
  listProjectAssets,
  markProjectAssetAuthority,
  projectAssetMutationReadTokenFromDoc,
  readProjectAsset,
  type ActionAssetBinding,
  type ProjectAssetEntry,
  type ResolvedAsset,
  type Resource,
} from "@clash/shared-types";

/** The signed message, so every adapter's read receipts verify identically. */
export function projectAssetReceiptMessage(
  userId: string,
  projectId: string,
  version: string,
): string {
  return JSON.stringify(["project-asset", userId, projectId, version]);
}

/**
 * Answer for a Project Asset operation this adapter does not offer: 501
 * COMMAND_UNAVAILABLE, the same shape as unsupported Host commands. Never 404:
 * a 404 is indistinguishable from a missing adapter route.
 */
export function projectAssetOperationUnavailable(operation: string): {
  status: 501;
  body: { error: string; code: "COMMAND_UNAVAILABLE"; operation: string };
} {
  return {
    status: 501,
    body: {
      error: `Project Asset ${operation} is not available on this server.`,
      code: "COMMAND_UNAVAILABLE",
      operation,
    },
  };
}

export const PROJECT_ASSET_BATCH_LIMIT = 1000;

/** Validates a `POST /assets/batch` body; null answers 400 "Invalid asset IDs". */
export function parseProjectAssetBatchIds(body: unknown): string[] | null {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > PROJECT_ASSET_BATCH_LIMIT ||
    ids.some((id: unknown) => typeof id !== "string" || !id.trim())
  )
    return null;
  return ids as string[];
}

/** The listed entries, optionally narrowed to the requested ids (unknown ids are skipped). */
export function selectProjectAssets(
  doc: LoroDoc,
  projectId: string,
  ids?: readonly string[],
): ProjectAssetEntry[] {
  const entries = listProjectAssets(doc, { projectId });
  if (!ids) return entries;
  const wanted = new Set(ids);
  return entries.filter((entry) => wanted.has(entry.id));
}

export interface ProjectAssetObservation {
  entry: ProjectAssetEntry;
  references: ActionAssetBinding[];
  /** Mutation read token; adapters sign it into the read receipt header. */
  version: string;
}

/** One Asset with the observation a later mutation must present; null is 404. */
export function observeProjectAsset(
  doc: LoroDoc,
  projectId: string,
  projectAssetId: string,
): ProjectAssetObservation | null {
  const entry = readProjectAsset(doc, projectAssetId, { projectId });
  if (!entry) return null;
  const version = projectAssetMutationReadTokenFromDoc(
    doc,
    projectId,
    projectAssetId,
  );
  if (!version) return null;
  return {
    entry,
    references: listActionAssetReferences(doc, projectAssetId),
    version,
  };
}

export interface ProjectAssetImportCommand {
  projectId: string;
  projectAssetId: string;
  /** The staged Resource holding the uploaded bytes. */
  resource: Resource;
  name: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  /** `reject` refuses content already imported under another active Asset id. */
  duplicateContent?: "allow" | "reject";
}

export interface ProjectAssetImportPorts {
  /** The Resource recorded for an existing entry, or null when this adapter has none. */
  readResource(resourceId: string): Resource | null | Promise<Resource | null>;
}

export type ProjectAssetImportResult =
  | {
      ok: true;
      /** False when the id already holds the same immutable media (idempotent retry). */
      created: boolean;
      entry: ProjectAssetEntry;
    }
  | { ok: false; status: 409; body: Record<string, unknown> };

const conflict = (body: Record<string, unknown>): ProjectAssetImportResult => ({
  ok: false,
  status: 409,
  body,
});

function sameMedia(stored: Resource | null, uploaded: Resource): boolean {
  return (
    !!stored &&
    stored.digest.value === uploaded.digest.value &&
    stored.kind === uploaded.kind &&
    stored.contentType === uploaded.contentType
  );
}

/**
 * Publish an imported owned Resource under the requested Asset id. Re-importing
 * the same media under an existing id returns that entry; anything else bound
 * to the id is a 409, because Asset identities are immutable.
 */
export async function commitProjectAssetImport(
  doc: LoroDoc,
  command: ProjectAssetImportCommand,
  ports: ProjectAssetImportPorts,
): Promise<ProjectAssetImportResult> {
  const { projectId, projectAssetId, resource } = command;
  const existing = readProjectAsset(doc, projectAssetId, { projectId });
  if (existing) {
    const stored = await ports.readResource(existing.source.resourceId);
    return sameMedia(stored, resource)
      ? { ok: true, created: false, entry: existing }
      : conflict({
          error: "Asset ID already identifies different immutable media",
        });
  }
  if (command.duplicateContent === "reject") {
    const existingProjectAssetIds: string[] = [];
    for (const entry of listProjectAssets(doc, { projectId })) {
      if (entry.lifecycle.state !== "active") continue;
      if (
        entry.source.resourceId === resource.id ||
        (await ports.readResource(entry.source.resourceId))?.digest.value ===
          resource.digest.value
      )
        existingProjectAssetIds.push(entry.id);
    }
    if (existingProjectAssetIds.length > 0) {
      existingProjectAssetIds.sort();
      return conflict({
        error: `This content is already imported as Project Asset ${existingProjectAssetIds.join(", ")}. Nothing was imported as ${projectAssetId}.`,
        code: "PROJECT_ASSET_DUPLICATE_CONTENT",
        projectAssetId,
        existingProjectAssetIds,
      });
    }
  }
  const created = createProjectAsset(doc, {
    id: projectAssetId,
    kind: resource.kind,
    source: { kind: "owned", resourceId: resource.id },
    createdAt: command.createdAt,
    name: command.name,
    metadata: command.metadata,
    provenance: { kind: "import" },
    lifecycle: { state: "active" },
  });
  if (!created.ok) return conflict({ error: created.error.message });
  const marked = markProjectAssetAuthority(doc);
  if (!marked.ok) return conflict({ error: marked.error.message });
  return { ok: true, created: true, entry: created.entry };
}

export interface ProjectAssetProjectionPorts {
  readResource(projectId: string, resourceId: string): Promise<Resource | null>;
  /** Whether this adapter holds the Resource's bytes right now. */
  available(projectId: string, resource: Resource): Promise<boolean>;
  mediaUrl(input: {
    projectId: string;
    entry: ProjectAssetEntry;
    resource: Resource;
  }): string | Promise<string>;
}

/** Project one entry into the shared `ResolvedAsset` contract via asset-sdk. */
export function projectProjectAsset(
  ports: ProjectAssetProjectionPorts,
  input: { projectId: string; entry: ProjectAssetEntry },
): Promise<ResolvedAsset> {
  const { projectId, entry } = input;
  return resolveProjectAsset(
    {
      registry: {
        async resolve() {
          const resource = await ports.readResource(
            projectId,
            entry.source.resourceId,
          );
          if (!resource || !(await ports.available(projectId, resource)))
            return {
              status: "unavailable",
              error: "Media is not available on this server.",
            };
          return { status: "ready", resource };
        },
      },
      projection: {
        async resolve({ resource }) {
          const url = await ports.mediaUrl({ projectId, entry, resource });
          return {
            status: "ready",
            url,
            ...(entry.kind === "image" ? { thumbnailUrl: url } : {}),
          };
        },
      },
    },
    { projectId, entry },
  );
}
