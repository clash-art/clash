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
  ACTION_ASSET_BINDING_AUTHORITY_VERSION,
  Canvas,
  actionAssetBindingAuthorityVersion,
  createActionAssetBinding,
  listActionAssetBindings,
  listProjectCanvases,
  listProjectDirectorStages,
  listProjectTimelines,
  markActionAssetBindingAuthority,
  planLegacyActionAssetBindingMaterialization,
  restoreProjectAsset,
  trashProjectAssetIfUnreferenced,
  validateAgentReadProof,
  type ActionAssetBinding,
  type AssetKind,
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

export const PROJECT_ASSET_BATCH_LIMIT = 1000;

/** File-extension fallback for a browser that sent no usable MIME type. Same
 * table as the Node Host's media store, so both adapters seal one fact. */
const PROJECT_ASSET_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

const PROJECT_ASSET_CONTENT_TYPE_BY_KIND: Record<AssetKind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  model: "model/gltf-binary",
};

/**
 * Seal the MIME fact before it becomes an immutable Resource. Lower-case and
 * drop parameters; when the browser sent nothing (or only the generic
 * `application/octet-stream`), recover from the file extension and finally
 * from the Asset kind. Mirrors the Host's table so a later upload of the same
 * bytes cannot conflict on `contentType`.
 */
export function normalizeProjectAssetContentType(input: {
  contentType?: string | undefined;
  fileName?: string | undefined;
  kind: AssetKind;
}): string | undefined {
  const essence = input.contentType
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (essence && essence !== "application/octet-stream") {
    if (essence === "image/jpg") return "image/jpeg";
    if (essence === "audio/x-wav") return "audio/wav";
    if (essence === "audio/mp3") return "audio/mpeg";
    return essence;
  }
  const extension = input.fileName
    ?.split(".")
    .at(-1)
    ?.trim()
    .toLowerCase();
  const fromExtension = extension
    ? PROJECT_ASSET_CONTENT_TYPE_BY_EXTENSION[extension]
    : undefined;
  return fromExtension ?? PROJECT_ASSET_CONTENT_TYPE_BY_KIND[input.kind];
}

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

// ─── Trash / restore (soft delete) ─────────────────────────────────────────
// Same semantics as the local Host: trash flips the entry's lifecycle to
// `trashed` with a delete-operation tombstone (retries with the same
// operation id are idempotent), refuses Assets still used as Action inputs,
// and restore flips it back to `active`. Trashed entries stay in the list, so
// the list is also the trash view. Bytes and Resource rows are never touched;
// purge is a separate, later operation.

/** How long a trashed Asset stays restorable; the local Host's value. */
export const PROJECT_ASSET_PURGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Read proof a lifecycle write presents (`x-clash-client-type`, `x-clash-if-match`). */
export interface ProjectAssetWriteObservation {
  actorClientType?: string;
  expectedReadToken?: string;
}

export type ProjectAssetLifecycleCommand =
  | {
      action: "trash";
      projectId: string;
      projectAssetId: string;
      deleteOperationId: string;
      /** ISO timestamps from the adapter's clock. */
      deletedAt: string;
      purgeAfter: string;
      observation: ProjectAssetWriteObservation;
    }
  | {
      action: "restore";
      projectId: string;
      projectAssetId: string;
      observation: ProjectAssetWriteObservation;
    };

export interface ProjectAssetLifecyclePorts {
  /** True when `receipt` is this adapter's signature over the read `version`. */
  verifyReceipt(version: string, receipt: string): boolean;
}

export type ProjectAssetLifecycleResult =
  | { ok: true; entry: ProjectAssetEntry; mutated: boolean }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> };

/** Validates a trash request body's `deleteOperationId`; null answers 400. */
export function parseProjectAssetDeleteOperationId(body: unknown): string | null {
  const value = (body as { deleteOperationId?: unknown } | null)
    ?.deleteOperationId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && value.length <= 512 ? trimmed : null;
}

export const INVALID_PROJECT_ASSET_TRASH = {
  status: 400 as const,
  body: {
    error: "deleteOperationId is required",
    code: "INVALID_PROJECT_ASSET_TRASH",
  },
};

/**
 * Make the Action Asset binding facts authoritative before a deletion decides
 * "unreferenced": a cloud document that never ran the local cutover may still
 * describe Action inputs only on canvas nodes, Timelines and Director Stages.
 * Same plan as the local Host; returns whether `doc` changed, or a failure.
 */
export function ensureActionAssetBindingAuthority(
  doc: LoroDoc,
  projectId: string,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  const version = actionAssetBindingAuthorityVersion(doc);
  if (version === ACTION_ASSET_BINDING_AUTHORITY_VERSION)
    return { ok: true, changed: false };
  if (version !== undefined)
    return {
      ok: false,
      error: `Unsupported Action Asset binding authority version ${version}.`,
    };
  const plan = planLegacyActionAssetBindingMaterialization({
    projectAssetIds: listProjectAssets(doc, { projectId })
      .filter((entry) => entry.lifecycle.state === "active")
      .map((entry) => entry.id),
    canvasNodes: listProjectCanvases(doc).flatMap((canvas) =>
      new Canvas(doc, () => undefined, canvas.id).listNodes(),
    ),
    timelines: listProjectTimelines(doc),
    directorStages: listProjectDirectorStages(doc),
  });
  if (plan.conflicts.length > 0)
    return { ok: false, error: plan.conflicts[0]!.message };
  const existing = new Set(listActionAssetBindings(doc).map((b) => b.id));
  for (const binding of plan.bindings) {
    if (existing.has(binding.id)) continue;
    const created = createActionAssetBinding(doc, binding);
    if (!created.ok) return { ok: false, error: created.error.message };
  }
  const marked = markActionAssetBindingAuthority(doc);
  if (!marked.ok) return { ok: false, error: marked.error.message };
  return { ok: true, changed: true };
}

const lifecycleFailure = (
  status: 400 | 404 | 409,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): ProjectAssetLifecycleResult => ({
  ok: false,
  status,
  body: { error, code, ...extra },
});

/**
 * Apply a trash or restore command to `doc`. On failure `doc` may hold
 * partial edits: adapters run this on a fork or inside a transaction and
 * discard it unless `ok && mutated`.
 */
export function applyProjectAssetLifecycle(
  doc: LoroDoc,
  command: ProjectAssetLifecycleCommand,
  ports: ProjectAssetLifecyclePorts,
): ProjectAssetLifecycleResult {
  const { projectId, projectAssetId: id } = command;
  const current = readProjectAsset(doc, id, { projectId });
  if (
    command.action === "trash" &&
    current?.lifecycle.state === "trashed" &&
    current.lifecycle.deleteOperationId === command.deleteOperationId
  )
    return { ok: true, entry: current, mutated: false };
  const currentReadToken = projectAssetMutationReadTokenFromDoc(
    doc,
    projectId,
    id,
  );
  if (!current || !currentReadToken)
    return lifecycleFailure(
      404,
      "PROJECT_ASSET_NOT_FOUND",
      `Project Asset ${id} not found.`,
      { projectAssetId: id },
    );
  const proof = validateAgentReadProof({
    actorClientType: command.observation.actorClientType,
    operation:
      command.action === "trash"
        ? "Project Asset deletion"
        : "Project Asset restore",
    currentReadToken,
    expectedReadToken: command.observation.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: (receipt) =>
      ports.verifyReceipt(receipt.baseReadToken, receipt.receipt),
    readCommandHint: `Run clash assets get --asset ${id} again before retrying.`,
  });
  if (!proof.ok)
    return lifecycleFailure(409, proof.code ?? "READ_REQUIRED", proof.error ?? "Read proof rejected", {
      projectAssetId: id,
    });
  if (command.action === "restore") {
    if (current.lifecycle.state === "active")
      return { ok: true, entry: current, mutated: false };
    const restored = restoreProjectAsset(doc, id);
    return restored.ok
      ? { ok: true, entry: restored.entry, mutated: true }
      : lifecycleFailure(
          409,
          restored.error.code,
          restored.error.message,
          { projectAssetId: id },
        );
  }
  if (current.lifecycle.state === "trashed")
    return lifecycleFailure(
      409,
      "STALE_READ",
      `Project Asset ${id} was already deleted by another operation. Read it again before choosing the next action.`,
      { projectAssetId: id },
    );
  const authority = ensureActionAssetBindingAuthority(doc, projectId);
  if (!authority.ok)
    return lifecycleFailure(
      409,
      "ACTION_ASSET_BINDING_MATERIALIZATION_CONFLICT",
      authority.error,
      { projectAssetId: id },
    );
  const trashed = trashProjectAssetIfUnreferenced(doc, {
    id,
    deleteOperationId: command.deleteOperationId,
    deletedAt: command.deletedAt,
    purgeAfter: command.purgeAfter,
  });
  if (trashed.ok) return { ok: true, entry: trashed.entry, mutated: true };
  const { error } = trashed;
  if (error.code === "ASSET_IN_USE")
    return lifecycleFailure(
      409,
      "ASSET_IN_USE",
      `Project Asset ${id} is still used as an Action input.`,
      { projectAssetId: id, references: error.references },
    );
  return lifecycleFailure(
    409,
    error.code,
    "message" in error ? String(error.message) : `Project Asset ${id} cannot be deleted.`,
    { projectAssetId: id },
  );
}
