import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AssetSdkContractError,
  createAssetClient,
  resolveProjectAsset,
  type AssetResolverPorts,
  type ProjectAssetMutationObservation,
  type ProjectAssetAuthorityPort,
} from "@clash/asset-sdk";
import {
  ACTION_ASSET_BINDING_AUTHORITY_VERSION,
  Canvas,
  actionAssetBindingAuthorityVersion,
  createActionAssetBinding,
  createProjectAsset,
  ensureActionAssetBinding,
  listActionAssetBindings,
  listActionAssetReferences,
  listProjectCanvases,
  listProjectDirectorStages,
  listProjectAssets,
  listProjectTimelines,
  markActionAssetBindingAuthority,
  markProjectAssetAuthority,
  planLegacyActionAssetBindingMaterialization,
  projectAssetAuthorityVersion,
  projectAssetMutationReadTokenFromDoc,
  ProjectAssetMetadataSchema,
  purgeProjectAsset,
  readActionAssetBinding,
  readProjectCoverAssetId,
  readProjectAsset,
  reconcileProjectCoverBindings,
  ResolvedAssetSchema,
  restoreProjectAsset,
  setProjectCoverAsset,
  trashProjectAssetIfUnreferenced,
  unbindActionAssetBinding,
  validateAgentReadProof,
  type AgentReadReceiptVerifier,
  type ActionAssetBinding,
  type Asset,
  type AssetKind,
  type ProjectAssetEntry,
  ProjectAssetEntrySchema,
  type ProjectAssetMetadata,
  type ProjectAssetProvenance,
  type ResolvedAsset,
} from "@clash/shared-types";

import { assetPathForRead } from "./local-asset-paths.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalResourceStore,
  LocalResourceError,
  resourceIdForSha256,
  stageLocalResourceInput,
  type LocalResourceProjection,
  type LocalResourceStageInput,
  type LocalResourceStagingProjection,
  type LocalResourceStoreEvent,
} from "./local-resource-store.js";
import {
  canonicalAssetMediaTypeAssertion,
  type LocalAssetInspectionService,
} from "./local-asset-inspections.js";
import type { LocalAssetInspectionFacts } from "./local-asset-inspections.js";
import type { LocalAssetRepresentationService } from "./local-asset-representations.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";

export type LocalProjectAssetMigrationErrorCode =
  | "PROJECT_ASSET_ID_COLLISION"
  | "PROJECT_ASSET_DUPLICATE_CONTENT"
  | "PROJECT_ASSET_TRASHED"
  | "PROJECT_ASSET_IMPORT_DIGEST_MISMATCH"
  | "ACTION_ASSET_BINDING_ID_COLLISION"
  | "ACTION_ASSET_BINDING_MATERIALIZATION_CONFLICT"
  | "RESOURCE_DIGEST_UNAVAILABLE"
  | "RESOURCE_DIGEST_MISMATCH"
  | "RESOURCE_KIND_CONFLICT"
  | "RESOURCE_MEDIA_TYPE_CONFLICT"
  | "PROJECT_ASSET_NOT_FOUND";

export class LocalProjectAssetMigrationError extends Error {
  readonly code: LocalProjectAssetMigrationErrorCode;
  /** The identity the caller asked for, when the failure is about one. */
  readonly projectAssetId?: string;
  /** Existing identities the caller should use instead of creating another. */
  readonly existingProjectAssetIds?: string[];

  constructor(
    code: LocalProjectAssetMigrationErrorCode,
    message: string,
    options?: ErrorOptions & {
      projectAssetId?: string;
      existingProjectAssetIds?: string[];
    },
  ) {
    super(message, options);
    this.name = "LocalProjectAssetMigrationError";
    this.code = code;
    this.projectAssetId = options?.projectAssetId;
    this.existingProjectAssetIds = options?.existingProjectAssetIds;
  }
}

/** One install outcome: a replay returns the existing Asset and imports nothing. */
export interface LocalProjectAssetInstallResult {
  asset: ResolvedAsset;
  replayed: boolean;
}

/**
 * Either stream/carry bytes for a new Resource, or adopt a file that an
 * import session already assembled (whose digest is that assembly's one pass).
 */
export type LocalProjectAssetInstallInput = {
  projectId: string;
  projectAssetId: string;
  kind: AssetKind;
  contentType?: string;
  name?: string;
  metadata: ProjectAssetMetadata;
  provenance?: ProjectAssetProvenance;
  /** `reject` fails instead of adding a second active Asset over bytes the Project already holds. */
  duplicateContent?: "allow" | "reject";
  /** A client-computed digest a streamed source must match. */
  expectedDigest?: string;
} & (
  | LocalResourceStageInput
  | {
      assembled: {
        sourcePath: string;
        digest: string;
        byteLength: number;
      };
      source?: never;
      bytes?: never;
      declaredByteLength?: never;
    }
);

export interface LocalProjectAssetService {
  materialize(projectId: string): Promise<void>;
  /** Migrates the already-open Host replica without creating a second Loro writer. */
  materializeDoc(
    projectId: string,
    doc: import("loro-crdt").LoroDoc,
  ): Promise<boolean>;
  /** Installs immutable bytes without publishing Project membership. Durable staging uses this. */
  stageOwned(input: {
    kind: AssetKind;
    bytes: Uint8Array;
    contentType?: string;
    name?: string;
  }): Promise<LocalResourceStagingProjection>;
  /** Host-private lookup for a durable staging receipt; never grants Project membership. */
  resolveStagedOwned(
    resourceId: string,
  ): Promise<LocalResourceStagingProjection>;
  /**
   * Verifies staged bytes and builds the canonical Project fact without mutating Loro.
   * Durable staging uses this before its separately idempotent publication step.
   */
  prepareStagedOwnedEntry(input: {
    projectAssetId: string;
    kind: AssetKind;
    resourceId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ProjectAssetEntry>;
  /**
   * Publishes already-staged immutable bytes and every Action fact in one Project mutation.
   * A failed publication may leave the Resource staged, but cannot leave partial Project facts.
   */
  publishStagedOwnedWithBindings(input: {
    projectId: string;
    projectAssetId: string;
    kind: AssetKind;
    resourceId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
    bindings: readonly ActionAssetBinding[];
    /** Host-private invariant checked inside the same serialized Project mutation. */
    assertProjectState?: (doc: import("loro-crdt").LoroDoc) => void;
  }): Promise<ResolvedAsset>;
  installOwned(input: LocalProjectAssetInstallInput): Promise<ResolvedAsset>;
  /** Same as `installOwned`, also saying whether the existing Asset was replayed. */
  installOwnedResult(
    input: LocalProjectAssetInstallInput,
  ): Promise<LocalProjectAssetInstallResult>;
  /**
   * Decide replay/duplicate/collision/trashed from a client-computed digest
   * before any bytes are uploaded. Returns the existing Asset for a replay.
   */
  inspectExistingImport(input: {
    projectId: string;
    projectAssetId: string;
    sha256: string;
    duplicateContent?: "allow" | "reject";
  }): Promise<ResolvedAsset | null>;
  /** Host-private Project membership read; Resource identity is never exposed by public routes. */
  readEntry(
    projectId: string,
    projectAssetId: string,
  ): Promise<ProjectAssetEntry | null>;
  /** Admits an existing Global Resource without copying immutable bytes. */
  admitLinked(input: {
    projectId: string;
    projectAssetId?: string;
    kind: AssetKind;
    resourceId: string;
    originLibraryId: string;
    originEntryId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ResolvedAsset>;
  /** Publishes one Action usage/lineage fact in the same Project replica. */
  bind(
    projectId: string,
    binding: ActionAssetBinding,
  ): Promise<ActionAssetBinding>;
  /** Removes one Action usage fact. A later use must receive a new binding id. */
  unbind(
    projectId: string,
    bindingId: string,
  ): Promise<ActionAssetBinding | null>;
  read(
    projectId: string,
    projectAssetId: string,
  ): Promise<ResolvedAsset | null>;
  /** Resolves one entry from the already-open Host replica through the canonical Asset resolver. */
  readFromDoc(
    doc: import("loro-crdt").LoroDoc,
    projectId: string,
    projectAssetId: string,
  ): Promise<ResolvedAsset | null>;
  readObserved(
    projectId: string,
    projectAssetId: string,
  ): Promise<LocalProjectAssetObservation<ResolvedAsset> | null>;
  list(projectId: string): Promise<ResolvedAsset[]>;
  readProjectCover(projectId: string): Promise<string | null>;
  setProjectCover(
    projectId: string,
    projectAssetId: string | null,
  ): Promise<string | null>;
  listReferences(
    projectId: string,
    projectAssetId: string,
  ): Promise<ActionAssetBinding[]>;
  listReferencesObserved(
    projectId: string,
    projectAssetId: string,
  ): Promise<LocalProjectAssetObservation<ActionAssetBinding[]>>;
  trash(input: {
    projectId: string;
    projectAssetId: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
    observation?: ProjectAssetMutationObservation;
  }): Promise<LocalProjectAssetObservation<ResolvedAsset>>;
  restore(input: {
    projectId: string;
    projectAssetId: string;
    observation?: ProjectAssetMutationObservation;
  }): Promise<LocalProjectAssetObservation<ResolvedAsset>>;
  openProjection(
    projectId: string,
    projectAssetId: string,
  ): Promise<LocalResourceProjection>;
  openProjectionFromDoc(
    doc: import("loro-crdt").LoroDoc,
    projectId: string,
    projectAssetId: string,
  ): Promise<LocalResourceProjection>;
}

export interface LocalProjectAssetObservation<T> {
  value: T;
  readToken: string;
}

/**
 * The single Project-replica authority used by Project Asset reads and writes.
 *
 * A running Host supplies its live LocalLoroRoom here. Tests and offline tools may use the
 * file-backed default, but an HTTP mutation must never open a sibling snapshot writer beside an
 * active room.
 */
export interface LocalProjectAssetReplica {
  inspect<T>(
    projectId: string,
    read: (doc: import("loro-crdt").LoroDoc) => T | Promise<T>,
  ): Promise<T>;
  mutate<T>(
    projectId: string,
    mutation: (
      doc: import("loro-crdt").LoroDoc,
    ) => { value: T; save?: boolean } | Promise<{ value: T; save?: boolean }>,
  ): Promise<T>;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function sameEntry(left: ProjectAssetEntry, right: ProjectAssetEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contentHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function legacyStorageKey(asset: Asset): string {
  const localBlobKey = asset.metadata?.localBlobKey;
  if (typeof localBlobKey === "string" && localBlobKey.trim()) {
    const normalized = localBlobKey.replace(/\\/g, "/").replace(/^\/+/, "");
    return normalized.startsWith("blobs/")
      ? `local-blobs/${normalized.slice("blobs/".length)}`
      : normalized;
  }
  return asset.srcR2Key;
}

function metadataFromLegacy(
  asset: Asset,
  byteLength: number,
): ProjectAssetMetadata {
  const source = asset.metadata ?? {};
  return {
    ...(typeof source.width === "number" && source.width >= 0
      ? { width: source.width }
      : {}),
    ...(typeof source.height === "number" && source.height >= 0
      ? { height: source.height }
      : {}),
    ...(typeof source.durationMs === "number" && source.durationMs >= 0
      ? { durationMs: source.durationMs }
      : {}),
    bytes: byteLength,
    ...(Array.isArray(source.waveform) ? { waveform: source.waveform } : {}),
    ...(typeof source.contentType === "string" && source.contentType.trim()
      ? { contentType: source.contentType.trim().toLowerCase() }
      : {}),
    ...(typeof source.frameRate === "number" && source.frameRate > 0
      ? { frameRate: source.frameRate }
      : {}),
    ...(typeof source.videoCodec === "string" && source.videoCodec.trim()
      ? { videoCodec: source.videoCodec.trim() }
      : {}),
    ...(typeof source.audioCodec === "string" && source.audioCodec.trim()
      ? { audioCodec: source.audioCodec.trim() }
      : {}),
    ...(typeof source.originalName === "string" && source.originalName.trim()
      ? { originalName: source.originalName.trim() }
      : {}),
  };
}

function provenanceFromLegacy(asset: Asset): ProjectAssetProvenance {
  if (asset.sourceTaskId || asset.sourceModel || asset.sourcePrompt) {
    return {
      kind: "generation",
      ...(asset.sourceTaskId ? { actionRunId: asset.sourceTaskId } : {}),
      ...(asset.sourceModel ? { model: asset.sourceModel } : {}),
      ...(asset.sourcePrompt !== null && asset.sourcePrompt !== undefined
        ? { prompt: asset.sourcePrompt }
        : {}),
    };
  }
  return { kind: "import" };
}

function mediaUrl(
  origin: string,
  projectId: string,
  projectAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(projectAssetId)}/media`;
}

function thumbnailUrl(
  origin: string,
  projectId: string,
  projectAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(projectAssetId)}/thumbnail`;
}

function waveformUrl(
  origin: string,
  projectId: string,
  projectAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(projectAssetId)}/waveform`;
}

function proxyUrl(
  origin: string,
  projectId: string,
  projectAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(projectAssetId)}/proxy`;
}

function mutationFailure(result: {
  ok: false;
  error: { code: string; message: string };
}): never {
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

/** Publishes one already-staged entry into the Host's open Project replica. */
export function publishLocalProjectAsset(
  doc: import("loro-crdt").LoroDoc,
  entry: ProjectAssetEntry,
): { entry: ProjectAssetEntry; changed: boolean } {
  const existing = readProjectAsset(doc, entry.id);
  if (existing) {
    if (sameEntry(existing, entry)) return { entry: existing, changed: false };
    throw new LocalProjectAssetMigrationError(
      "PROJECT_ASSET_ID_COLLISION",
      `Project Asset ${entry.id} already identifies different immutable content. An existing Asset is never overwritten: read ${entry.id} to use it, or publish this content under a new Project Asset ID.`,
      { projectAssetId: entry.id },
    );
  }
  const created = createProjectAsset(doc, entry);
  if (!created.ok) mutationFailure(created);
  const marked = markProjectAssetAuthority(doc);
  if (!marked.ok) mutationFailure(marked);
  return { entry: created.entry, changed: true };
}

function actionAssetBindingFailure(result: {
  ok: false;
  error: { code: string; message: string };
}): never {
  if (result.error.code === "ACTION_ASSET_BINDING_EXISTS") {
    throw new LocalProjectAssetMigrationError(
      "ACTION_ASSET_BINDING_ID_COLLISION",
      result.error.message,
    );
  }
  return mutationFailure(result);
}

function applyLocalProjectAssetPublication(
  doc: import("loro-crdt").LoroDoc,
  entry: ProjectAssetEntry,
  bindings: readonly ActionAssetBinding[],
): {
  entry: ProjectAssetEntry;
  bindings: ActionAssetBinding[];
  changed: boolean;
} {
  const published = publishLocalProjectAsset(doc, entry);
  let changed = published.changed;
  const ensured: ActionAssetBinding[] = [];
  for (const binding of bindings) {
    const result = ensureActionAssetBinding(doc, binding);
    if (!result.ok) actionAssetBindingFailure(result);
    changed ||= result.changed;
    ensured.push(result.binding);
  }
  return { entry: published.entry, bindings: ensured, changed };
}

/**
 * Publishes immutable Project membership and all Action lineage facts as one Loro mutation.
 *
 * A fork validates the complete write set first, so an identity conflict cannot leave the live
 * replica with only the Project Asset or only a prefix of its bindings. The actual write still
 * happens on the caller's open document and therefore remains part of its existing checkpoint.
 */
export function publishLocalProjectAssetWithBindings(
  doc: import("loro-crdt").LoroDoc,
  entry: ProjectAssetEntry,
  bindings: readonly ActionAssetBinding[],
): {
  entry: ProjectAssetEntry;
  bindings: ActionAssetBinding[];
  changed: boolean;
} {
  applyLocalProjectAssetPublication(doc.fork(), entry, bindings);
  return applyLocalProjectAssetPublication(doc, entry, bindings);
}

function actionAssetBindingPlanForDoc(
  doc: import("loro-crdt").LoroDoc,
  projectAssetIds: readonly string[],
) {
  return planLegacyActionAssetBindingMaterialization({
    projectAssetIds,
    canvasNodes: listProjectCanvases(doc).flatMap((canvas) =>
      new Canvas(doc, () => undefined, canvas.id).listNodes(),
    ),
    timelines: listProjectTimelines(doc),
    directorStages: listProjectDirectorStages(doc),
  });
}

function assertActionAssetBindingPlan(
  plan: ReturnType<typeof actionAssetBindingPlanForDoc>,
): void {
  if (plan.conflicts.length === 0) return;
  const first = plan.conflicts[0]!;
  throw new LocalProjectAssetMigrationError(
    "ACTION_ASSET_BINDING_MATERIALIZATION_CONFLICT",
    `${first.message} (${plan.conflicts.length} materialization conflict${plan.conflicts.length === 1 ? "" : "s"}).`,
  );
}

export function createLocalProjectAssetService(options: {
  dataDir: string;
  clashRoot?: string;
  projectionOrigin: string | (() => string);
  assetInspection?: LocalAssetInspectionService;
  assetRepresentations?: Pick<
    LocalAssetRepresentationService,
    "schedule" | "read"
  >;
  replica?: LocalProjectAssetReplica;
  readReceiptVerifier?: AgentReadReceiptVerifier;
  /** Host log sink for Resource-store events such as an EXDEV copy fallback. */
  onResourceEvent?: (event: LocalResourceStoreEvent) => void;
}): LocalProjectAssetService {
  const fileReplicas = new FileReplicaStore(`${options.dataDir}/projects`);
  const replica: LocalProjectAssetReplica = options.replica ?? {
    async inspect(projectId, read) {
      return read(await fileReplicas.recover(projectId));
    },
    mutate(projectId, mutation) {
      return fileReplicas.updateSnapshotAtomic(projectId, mutation);
    },
  };
  const metadata = createLocalMetadataStore(options.dataDir);
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
    ...(options.onResourceEvent ? { onEvent: options.onResourceEvent } : {}),
  });

  async function createEntry(
    projectId: string,
    entry: ProjectAssetEntry,
  ): Promise<ProjectAssetEntry> {
    await materialize(projectId);
    return replica.mutate(projectId, (doc) => {
      const published = publishLocalProjectAsset(doc, entry);
      return { value: published.entry, save: published.changed };
    });
  }

  function assertMutationObservation(
    doc: import("loro-crdt").LoroDoc,
    projectId: string,
    projectAssetId: string,
    operation: string,
    observation?: ProjectAssetMutationObservation,
  ): void {
    const currentReadToken = projectAssetMutationReadTokenFromDoc(
      doc,
      projectId,
      projectAssetId,
    );
    if (!currentReadToken) {
      throw new AssetSdkContractError(
        "PROJECT_ASSET_NOT_FOUND",
        `Project Asset ${projectAssetId} not found.`,
        { projectAssetId },
      );
    }
    const proof = validateAgentReadProof({
      actorClientType: observation?.actorClientType,
      operation,
      currentReadToken,
      expectedReadToken: observation?.expectedReadToken,
      requireReceipt: true,
      readReceiptVerifier: options.readReceiptVerifier,
      readCommandHint: `Run clash assets get --asset ${projectAssetId} again before retrying.`,
    });
    if (proof.ok) return;
    throw new AssetSdkContractError(
      proof.code === "READ_REQUIRED" ||
        proof.code === "STALE_READ" ||
        proof.code === "INVALID_READ_PROOF"
        ? proof.code
        : "AUTHORITY_CONTRACT_VIOLATION",
      proof.error,
      { projectAssetId },
    );
  }

  const authority: ProjectAssetAuthorityPort = {
    async read(projectId, id) {
      return replica.inspect(projectId, (doc) =>
        readProjectAsset(doc, id, { projectId }),
      );
    },
    async list(projectId) {
      return replica.inspect(projectId, (doc) =>
        listProjectAssets(doc, { projectId }),
      );
    },
    create: createEntry,
    async trashIfUnreferenced(projectId, input, observation) {
      return replica.mutate(projectId, (doc) => {
        const current = readProjectAsset(doc, input.id, { projectId });
        if (
          current?.lifecycle.state === "trashed" &&
          current.lifecycle.deleteOperationId === input.deleteOperationId
        ) {
          return {
            value: { ok: true as const, entry: current },
            save: false,
          };
        }
        assertMutationObservation(
          doc,
          projectId,
          input.id,
          "Project Asset deletion",
          observation,
        );
        if (current?.lifecycle.state === "trashed") {
          throw new AssetSdkContractError(
            "STALE_READ",
            `Project Asset ${input.id} was already deleted by another operation. Read it again before choosing the next action.`,
            { projectAssetId: input.id },
          );
        }
        const result = trashProjectAssetIfUnreferenced(doc, input);
        return { value: result, save: result.ok };
      });
    },
    async restore(projectId, id, observation) {
      return replica.mutate(projectId, (doc) => {
        assertMutationObservation(
          doc,
          projectId,
          id,
          "Project Asset restore",
          observation,
        );
        const result = restoreProjectAsset(doc, id);
        if (!result.ok) mutationFailure(result);
        return { value: result.entry };
      });
    },
    async purge(projectId, input) {
      return replica.mutate(projectId, (doc) => {
        const result = purgeProjectAsset(doc, input);
        if (!result.ok) mutationFailure(result);
        return { value: result.entry };
      });
    },
    async bind(projectId, binding) {
      return replica.mutate(projectId, (doc) => {
        const result = ensureActionAssetBinding(doc, binding);
        if (!result.ok) actionAssetBindingFailure(result);
        return { value: result.binding, save: result.changed };
      });
    },
    async unbind(projectId, bindingId) {
      return replica.mutate(projectId, (doc) => {
        const existing = readActionAssetBinding(doc, bindingId);
        if (!existing) return { value: null, save: false };
        const result = unbindActionAssetBinding(doc, bindingId);
        if (!result.ok) mutationFailure(result);
        return { value: result.binding };
      });
    },
    async listReferences(projectId, projectAssetId) {
      return replica.inspect(projectId, (doc) =>
        listActionAssetReferences(doc, projectAssetId),
      );
    },
  };

  const resolverPorts: AssetResolverPorts = {
    registry: {
      async resolve({ entry }) {
        try {
          let projection = await resources.resolve(entry.source.resourceId);
          if (
            projection &&
            !projection.resource.contentType &&
            options.assetInspection
          ) {
            await options.assetInspection.inspect({ source: projection });
            projection = await resources.resolve(entry.source.resourceId);
          }
          const contentType = canonicalAssetMediaTypeAssertion(
            projection?.resource.contentType,
          );
          return projection
            ? {
                status: "ready" as const,
                createdAt: projection.createdAt,
                resource: {
                  ...projection.resource,
                  ...(contentType ? { contentType } : {}),
                },
              }
            : {
                status: "unavailable" as const,
                error:
                  "Immutable Resource bytes are not installed on this Host.",
              };
        } catch (error) {
          return {
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof LocalResourceError
              ? { errorCode: error.code }
              : {}),
          };
        }
      },
    },
    projection: {
      async resolve({ projectId, entry }) {
        const origin =
          typeof options.projectionOrigin === "function"
            ? options.projectionOrigin()
            : options.projectionOrigin;
        const url = mediaUrl(origin, projectId, entry.id);
        const representationRole =
          entry.kind === "audio" ? "waveform" : "thumbnail";
        const representation = options.assetRepresentations
          ? await options.assetRepresentations.read(
              entry.source.resourceId,
              representationRole,
            )
          : undefined;
        const proxy =
          entry.kind === "video"
            ? await options.assetRepresentations?.read(
                entry.source.resourceId,
                "proxy",
              )
            : undefined;
        options.assetRepresentations?.schedule(entry.source.resourceId);
        return {
          status: "ready" as const,
          url,
          ...(proxy?.role === "proxy"
            ? { proxyUrl: proxyUrl(origin, projectId, entry.id) }
            : {}),
          ...(representation?.role === "thumbnail"
            ? { thumbnailUrl: thumbnailUrl(origin, projectId, entry.id) }
            : entry.kind === "image"
              ? { thumbnailUrl: url }
              : {}),
          ...(representation?.role === "waveform"
            ? { waveformUrl: waveformUrl(origin, projectId, entry.id) }
            : {}),
        };
      },
    },
  };
  const client = createAssetClient({ authority, ...resolverPorts });

  async function enrichResolved(
    entry: ProjectAssetEntry,
    resolved: ResolvedAsset,
  ): Promise<ResolvedAsset> {
    if (!options.assetInspection || resolved.status !== "ready") {
      return resolved;
    }
    const source = await resources.resolve(entry.source.resourceId);
    if (!source) return resolved;
    try {
      const inspection = await options.assetInspection.inspect({
        source,
      });
      return ResolvedAssetSchema.parse({
        ...resolved,
        metadata: { ...resolved.metadata, ...inspection.facts },
      });
    } catch {
      // Inspection is enrichment, not Asset availability. A failed probe writes no
      // inspection row, so a later read can retry without hiding immutable media.
      return resolved;
    }
  }

  async function resolveEntry(
    projectId: string,
    entry: ProjectAssetEntry,
  ): Promise<ResolvedAsset> {
    return enrichResolved(
      entry,
      await resolveProjectAsset(resolverPorts, { projectId, entry }),
    );
  }

  function canonicalMetadata(input: {
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
    metadata: ProjectAssetMetadata;
    name?: string;
  }): ProjectAssetMetadata {
    return ProjectAssetMetadataSchema.parse({
      ...input.facts,
      // Resource and Host byte-probe facts own the canonical media read model.
      // Producer/browser values are hints only and cannot become authority.
      bytes: input.source.resource.byteLength,
      ...(input.metadata.originalName || input.name
        ? { originalName: input.metadata.originalName ?? input.name }
        : {}),
    });
  }

  async function finalizedSource(input: {
    resourceId: string;
    kind: AssetKind;
    metadata: ProjectAssetMetadata;
  }): Promise<{
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
  }> {
    if (!options.assetInspection) {
      throw new LocalProjectAssetMigrationError(
        "RESOURCE_DIGEST_UNAVAILABLE",
        "A verified Host Asset inspection is required before Project publication.",
      );
    }
    return options.assetInspection.finalize({
      resourceId: input.resourceId,
      kind: input.kind,
      ...(input.metadata.contentType
        ? { contentType: input.metadata.contentType }
        : {}),
    });
  }

  async function prepareStagedOwnedEntry(input: {
    projectAssetId: string;
    kind: AssetKind;
    resourceId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ProjectAssetEntry> {
    const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
    const resourceId = nonEmpty(input.resourceId, "resourceId");
    const finalized = await finalizedSource(input);
    return ProjectAssetEntrySchema.parse({
      id: projectAssetId,
      kind: input.kind,
      source: { kind: "owned", resourceId },
      lifecycle: { state: "active" },
      createdAt: finalized.source.createdAt,
      ...(input.name ? { name: input.name } : {}),
      metadata: canonicalMetadata({
        source: finalized.source,
        facts: finalized.facts,
        metadata: input.metadata,
        ...(input.name ? { name: input.name } : {}),
      }),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    });
  }

  async function publishInstalled(input: {
    projectId: string;
    projectAssetId: string;
    kind: AssetKind;
    resourceId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ResolvedAsset> {
    const finalized = await finalizedSource(input);
    const entry: ProjectAssetEntry = {
      id: nonEmpty(input.projectAssetId, "projectAssetId"),
      kind: input.kind,
      source: { kind: "owned", resourceId: input.resourceId },
      lifecycle: { state: "active" },
      createdAt: finalized.source.createdAt,
      ...(input.name ? { name: input.name } : {}),
      metadata: canonicalMetadata({
        source: finalized.source,
        facts: finalized.facts,
        metadata: input.metadata,
        ...(input.name ? { name: input.name } : {}),
      }),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };
    await client.createOwned({ projectId: input.projectId, entry });
    const resolved = await client.read({
      projectId: input.projectId,
      projectAssetId: entry.id,
    });
    if (!resolved) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_NOT_FOUND",
        `Project Asset ${entry.id} disappeared after publication.`,
      );
    }
    return enrichResolved(entry, resolved);
  }

  async function publishLinked(input: {
    projectId: string;
    projectAssetId: string;
    kind: AssetKind;
    resourceId: string;
    originLibraryId: string;
    originEntryId: string;
    name?: string;
    metadata: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ResolvedAsset> {
    const finalized = await finalizedSource(input);
    const entry: ProjectAssetEntry = {
      id: nonEmpty(input.projectAssetId, "projectAssetId"),
      kind: input.kind,
      source: {
        kind: "linked",
        resourceId: nonEmpty(input.resourceId, "resourceId"),
        origin: {
          scope: "global",
          libraryId: nonEmpty(input.originLibraryId, "originLibraryId"),
          entryId: nonEmpty(input.originEntryId, "originEntryId"),
        },
      },
      lifecycle: { state: "active" },
      createdAt: finalized.source.createdAt,
      ...(input.name ? { name: input.name } : {}),
      metadata: canonicalMetadata({
        source: finalized.source,
        facts: finalized.facts,
        metadata: input.metadata,
        ...(input.name ? { name: input.name } : {}),
      }),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };
    await materialize(input.projectId);
    await client.admitLinked({ projectId: input.projectId, entry });
    return requireResolved(input.projectId, entry.id);
  }

  async function installLegacy(asset: Asset): Promise<ProjectAssetEntry> {
    let bytes: Uint8Array;
    try {
      const path = await assetPathForRead(
        options.dataDir,
        legacyStorageKey(asset),
        options.clashRoot,
      );
      bytes = new Uint8Array(await readFile(path));
    } catch (error) {
      throw new LocalProjectAssetMigrationError(
        "RESOURCE_DIGEST_UNAVAILABLE",
        `Legacy Asset ${asset.id} has no locally verifiable immutable bytes.`,
        { cause: error },
      );
    }

    const digest = sha256(bytes);
    const claimedDigest = contentHash(asset.metadata?.contentHash);
    if (
      (typeof asset.metadata?.contentHash === "string" && !claimedDigest) ||
      (claimedDigest !== undefined && claimedDigest !== digest) ||
      (typeof asset.metadata?.bytes === "number" &&
        asset.metadata.bytes !== bytes.byteLength)
    ) {
      throw new LocalProjectAssetMigrationError(
        "RESOURCE_DIGEST_MISMATCH",
        `Legacy Asset ${asset.id} does not match its claimed immutable facts.`,
      );
    }

    let projection: LocalResourceProjection;
    try {
      projection = await resources.install({
        kind: asset.kind,
        bytes,
        ...(asset.metadata?.contentType
          ? { contentType: asset.metadata.contentType }
          : {}),
        ...(asset.metadata?.originalName
          ? { originalName: asset.metadata.originalName }
          : {}),
      });
    } catch (error) {
      throw new LocalProjectAssetMigrationError(
        "RESOURCE_KIND_CONFLICT",
        `Legacy Asset ${asset.id} conflicts with immutable Resource ${digest}.`,
        { cause: error },
      );
    }

    const legacyMetadata = metadataFromLegacy(asset, bytes.byteLength);
    return {
      id: asset.id,
      kind: asset.kind,
      source: { kind: "owned", resourceId: projection.resource.id },
      lifecycle: { state: "active" },
      createdAt: asset.createdAt,
      ...(legacyMetadata.originalName
        ? { name: legacyMetadata.originalName }
        : {}),
      metadata: legacyMetadata,
      provenance: provenanceFromLegacy(asset),
    };
  }

  type LegacyMetadataSnapshot = Awaited<ReturnType<typeof metadata.load>>;

  async function legacyEntries(
    projectId: string,
    legacy: LegacyMetadataSnapshot,
    additionalIds: Iterable<string> = [],
  ): Promise<ProjectAssetEntry[]> {
    const membership = new Set<string>();
    for (const ref of legacy.assetRefs ?? []) {
      if (ref.projectId === projectId) membership.add(ref.assetId);
    }
    for (const ref of legacy.assetNodeRefs ?? []) {
      if (ref.projectId === projectId) membership.add(ref.assetId);
    }
    for (const asset of legacy.assets ?? []) {
      if (asset.projectId === projectId) membership.add(asset.id);
    }
    for (const project of legacy.projects ?? []) {
      if (project.id !== projectId) continue;
      for (const preview of project.assets ?? []) membership.add(preview.id);
    }
    for (const id of additionalIds) membership.add(id);

    const byId = new Map(
      (legacy.assets ?? []).map((asset) => [asset.id, asset]),
    );
    const entries: ProjectAssetEntry[] = [];
    for (const id of [...membership].sort()) {
      const asset = byId.get(id);
      if (!asset) {
        throw new LocalProjectAssetMigrationError(
          "RESOURCE_DIGEST_UNAVAILABLE",
          `Legacy Project membership ${id} has no Asset row or immutable bytes.`,
        );
      }
      entries.push(await installLegacy(asset));
    }
    return entries;
  }

  async function prepareLegacyEntries(
    projectId: string,
    doc: import("loro-crdt").LoroDoc,
    legacy: LegacyMetadataSnapshot,
  ): Promise<ProjectAssetEntry[]> {
    if (projectAssetAuthorityVersion(doc) === 1) {
      const plan = actionAssetBindingPlanForDoc(
        doc,
        listProjectAssets(doc, { projectId })
          .filter((entry) => entry.lifecycle.state === "active")
          .map((entry) => entry.id),
      );
      assertActionAssetBindingPlan(plan);
      return [];
    }

    const existing = new Map(
      listProjectAssets(doc, { projectId }).map((entry) => [entry.id, entry]),
    );
    const candidateIds = [
      ...[...existing.values()]
        .filter((entry) => entry.lifecycle.state === "active")
        .map((entry) => entry.id),
      ...(legacy.assets ?? [])
        .filter((asset) => !existing.has(asset.id))
        .map((asset) => asset.id),
    ];
    const plan = actionAssetBindingPlanForDoc(doc, candidateIds);
    assertActionAssetBindingPlan(plan);
    return legacyEntries(
      projectId,
      legacy,
      plan.bindings.map((binding) => binding.projectAssetId),
    );
  }

  function applyMaterialization(
    projectId: string,
    doc: import("loro-crdt").LoroDoc,
    entries: ProjectAssetEntry[],
  ): boolean {
    const assetAuthority = projectAssetAuthorityVersion(doc);
    const bindingAuthority = actionAssetBindingAuthorityVersion(doc);
    if (
      assetAuthority === 1 &&
      bindingAuthority === ACTION_ASSET_BINDING_AUTHORITY_VERSION
    ) {
      return false;
    }
    if (assetAuthority !== undefined && assetAuthority !== 1) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_ID_COLLISION",
        `Unsupported Project Asset authority version ${assetAuthority}.`,
      );
    }
    if (
      bindingAuthority !== undefined &&
      bindingAuthority !== ACTION_ASSET_BINDING_AUTHORITY_VERSION
    ) {
      throw new LocalProjectAssetMigrationError(
        "ACTION_ASSET_BINDING_MATERIALIZATION_CONFLICT",
        `Unsupported Action Asset binding authority version ${bindingAuthority}.`,
      );
    }

    // Preflight every identity before mutating the live room. A failed cutover must not leave an
    // in-memory replica with only half of the Project Asset and binding authority facts applied.
    for (const entry of entries) {
      const existing = readProjectAsset(doc, entry.id, { projectId });
      if (existing && !sameEntry(existing, entry)) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_ID_COLLISION",
          `Project Asset ${entry.id} already identifies different immutable content.`,
        );
      }
    }

    const candidateAssetIds = new Set(
      listProjectAssets(doc, { projectId })
        .filter((entry) => entry.lifecycle.state === "active")
        .map((entry) => entry.id),
    );
    if (assetAuthority !== 1) {
      for (const entry of entries) candidateAssetIds.add(entry.id);
    }
    const bindingPlan = actionAssetBindingPlanForDoc(doc, [
      ...candidateAssetIds,
    ]);
    assertActionAssetBindingPlan(bindingPlan);

    let existingBindings: Map<string, ActionAssetBinding>;
    try {
      existingBindings = new Map(
        listActionAssetBindings(doc).map((binding) => [binding.id, binding]),
      );
    } catch (error) {
      throw new LocalProjectAssetMigrationError(
        "ACTION_ASSET_BINDING_MATERIALIZATION_CONFLICT",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    for (const binding of bindingPlan.bindings) {
      const existing = existingBindings.get(binding.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw new LocalProjectAssetMigrationError(
          "ACTION_ASSET_BINDING_ID_COLLISION",
          `Action Asset binding ${binding.id} already identifies different facts.`,
        );
      }
    }

    let changed = false;
    if (assetAuthority !== 1) {
      for (const entry of entries) {
        if (readProjectAsset(doc, entry.id, { projectId })) continue;
        const created = createProjectAsset(doc, entry);
        if (!created.ok) mutationFailure(created);
        changed = true;
      }
      const marked = markProjectAssetAuthority(doc);
      if (!marked.ok) mutationFailure(marked);
      changed = true;
    }

    if (bindingAuthority !== ACTION_ASSET_BINDING_AUTHORITY_VERSION) {
      for (const binding of bindingPlan.bindings) {
        if (existingBindings.has(binding.id)) continue;
        const created = createActionAssetBinding(doc, binding);
        if (!created.ok) mutationFailure(created);
        changed = true;
      }
      const marked = markActionAssetBindingAuthority(doc);
      if (!marked.ok) mutationFailure(marked);
      changed = true;
    }
    return changed;
  }

  async function materialize(projectIdInput: string): Promise<void> {
    const projectId = nonEmpty(projectIdInput, "projectId");
    const authoritative = await replica.inspect(
      projectId,
      (doc) =>
        projectAssetAuthorityVersion(doc) === 1 &&
        actionAssetBindingAuthorityVersion(doc) ===
          ACTION_ASSET_BINDING_AUTHORITY_VERSION,
    );
    if (authoritative) {
      await replica.mutate(projectId, (doc) => {
        const cover = reconcileProjectCoverBindings(doc);
        const changed = cover.changed;
        return { value: undefined, save: changed };
      });
      return;
    }

    const legacy = await metadata.load();
    const entries = await replica.inspect(projectId, (doc) =>
      prepareLegacyEntries(projectId, doc, legacy),
    );
    await replica.mutate(projectId, (doc) => {
      const changed = applyMaterialization(projectId, doc, entries);
      return { value: undefined, save: changed };
    });
  }

  async function projectionFromEntry(
    projectId: string,
    entry: ProjectAssetEntry | null,
    projectAssetId: string,
  ): Promise<LocalResourceProjection> {
    if (!entry || entry.lifecycle.state !== "active") {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_NOT_FOUND",
        `Project Asset ${projectAssetId} is not available in Project ${projectId}.`,
      );
    }
    const projection = await resources.resolve(entry.source.resourceId);
    if (!projection || projection.resource.kind !== entry.kind) {
      throw new LocalProjectAssetMigrationError(
        "RESOURCE_DIGEST_UNAVAILABLE",
        `Resource ${entry.source.resourceId} is not installed on this Host.`,
      );
    }
    return projection;
  }

  async function requireResolved(
    projectId: string,
    projectAssetId: string,
  ): Promise<ResolvedAsset> {
    const entry = await authority.read(projectId, projectAssetId);
    const resolved = await client.read({ projectId, projectAssetId });
    if (!resolved) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_NOT_FOUND",
        `Project Asset ${projectAssetId} is not available in Project ${projectId}.`,
      );
    }
    return entry ? enrichResolved(entry, resolved) : resolved;
  }

  async function observationSnapshot(
    projectIdInput: string,
    projectAssetIdInput: string,
  ): Promise<{
    projectId: string;
    entry: ProjectAssetEntry;
    references: ActionAssetBinding[];
    readToken: string;
  } | null> {
    const projectId = nonEmpty(projectIdInput, "projectId");
    const projectAssetId = nonEmpty(projectAssetIdInput, "projectAssetId");
    await materialize(projectId);
    return replica.inspect(projectId, (doc) => {
      const entry = readProjectAsset(doc, projectAssetId, { projectId });
      if (!entry) return null;
      const references = listActionAssetReferences(doc, projectAssetId);
      const readToken = projectAssetMutationReadTokenFromDoc(
        doc,
        projectId,
        projectAssetId,
      );
      if (!readToken) return null;
      return { projectId, entry, references, readToken };
    });
  }

  async function resolveObserved(
    projectId: string,
    projectAssetId: string,
  ): Promise<LocalProjectAssetObservation<ResolvedAsset> | null> {
    const observed = await observationSnapshot(projectId, projectAssetId);
    if (!observed) return null;
    return {
      value: await resolveEntry(observed.projectId, observed.entry),
      readToken: observed.readToken,
    };
  }

  async function discardStagedQuietly(resourceId: string): Promise<void> {
    try {
      await resources.discardStaged(resourceId);
    } catch (error) {
      // The import result is already decided; keep the failure visible so the
      // bytes are not a silent leak.
      options.onResourceEvent?.({
        level: "error",
        event: "local_resource_staging.discard_failed",
        fields: {
          resourceId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Decides replay/duplicate/trashed before the Resource store copies, adopts,
   * seals or inspects anything. `resourceId` is already known for an assembled
   * session; a single-shot import only learns it after its one staging pass.
   */
  async function checkImportBeforeInstall(
    input: Pick<
      LocalProjectAssetInstallInput,
      "projectId" | "projectAssetId" | "duplicateContent"
    >,
    resourceId: string,
  ): Promise<{ replay: ProjectAssetEntry | null }> {
    const projectId = nonEmpty(input.projectId, "projectId");
    const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
    await materialize(projectId);
    const entries = await authority.list(projectId);
    const sameContent = (entry: ProjectAssetEntry) =>
      entry.source.resourceId === resourceId;
    const current = entries.find((entry) => entry.id === projectAssetId);
    if (current?.lifecycle.state === "active" && sameContent(current)) {
      return { replay: current };
    }
    // Without this, a re-import of a trashed identity reads as an id
    // collision and hides the one action that brings the Asset back.
    if (current?.lifecycle.state === "trashed" && sameContent(current)) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_TRASHED",
        `Project Asset ${projectAssetId} already holds this content and is in the trash. Importing does not bring it back: restore it instead.`,
        { projectAssetId },
      );
    }
    // Asset identities are immutable, so any existing entry under this id
    // whose content differs would be rejected by createOwned after the bytes
    // were already adopted and sealed. Decide it before that work.
    if (current && !sameContent(current)) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_ID_COLLISION",
        `Project Asset ${projectAssetId} already identifies different immutable content. An existing Asset is never overwritten: read ${projectAssetId} to use it, or publish this content under a new Project Asset ID.`,
        { projectAssetId },
      );
    }
    if (input.duplicateContent === "reject" && !current) {
      const existingProjectAssetIds = entries
        .filter(
          (entry) => entry.lifecycle.state === "active" && sameContent(entry),
        )
        .map((entry) => entry.id)
        .sort();
      if (existingProjectAssetIds.length > 0) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_DUPLICATE_CONTENT",
          `This content is already imported as Project Asset ${existingProjectAssetIds.join(", ")}. Nothing was imported as ${projectAssetId}.`,
          { projectAssetId, existingProjectAssetIds },
        );
      }
    }
    return { replay: null };
  }

  async function existingResolved(
    projectId: string,
    projectAssetId: string,
  ): Promise<ResolvedAsset> {
    // No inspection or representation work: the Asset already exists.
    const resolved = await client.read({ projectId, projectAssetId });
    if (!resolved) {
      throw new LocalProjectAssetMigrationError(
        "PROJECT_ASSET_NOT_FOUND",
        `Project Asset ${projectAssetId} is not available in Project ${projectId}.`,
      );
    }
    return resolved;
  }

  async function publishInstalledInput(
    input: LocalProjectAssetInstallInput,
    staged: LocalResourceStagingProjection,
  ): Promise<ResolvedAsset> {
    return publishInstalled({
      projectId: nonEmpty(input.projectId, "projectId"),
      projectAssetId: nonEmpty(input.projectAssetId, "projectAssetId"),
      kind: input.kind,
      resourceId: staged.resourceId,
      ...(input.name ? { name: input.name } : {}),
      metadata: {
        ...input.metadata,
        bytes: staged.byteLength,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...(input.name && !input.metadata.originalName
          ? { originalName: input.name }
          : {}),
      },
      ...(input.provenance ? { provenance: input.provenance } : {}),
    });
  }

  async function installOwnedResult(
    input: LocalProjectAssetInstallInput,
  ): Promise<LocalProjectAssetInstallResult> {
    const projectId = nonEmpty(input.projectId, "projectId");
    const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
    if ("assembled" in input) {
      if (
        input.expectedDigest !== undefined &&
        input.assembled.digest !== input.expectedDigest
      ) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_IMPORT_DIGEST_MISMATCH",
          "Import session bytes do not match the declared sha256.",
          { projectAssetId },
        );
      }
      // The session assembly hashed these bytes once; deciding before adoption
      // means a duplicate or replay never writes into the Resource store.
      const resourceId = resourceIdForSha256(input.assembled.digest);
      const decision = await checkImportBeforeInstall(input, resourceId);
      if (decision.replay) {
        return {
          asset: await existingResolved(projectId, projectAssetId),
          replayed: true,
        };
      }
      const staged = await resources.adoptAssembled(input.assembled);
      try {
        return {
          asset: await publishInstalledInput(input, staged),
          replayed: false,
        };
      } catch (error) {
        await discardStagedQuietly(staged.resourceId);
        throw error;
      }
    }
    const staged = await stageLocalResourceInput(resources, input, input.name);
    try {
      const decision = await checkImportBeforeInstall(input, staged.resourceId);
      if (decision.replay) {
        await discardStagedQuietly(staged.resourceId);
        return {
          asset: await existingResolved(projectId, projectAssetId),
          replayed: true,
        };
      }
      return {
        asset: await publishInstalledInput(input, staged),
        replayed: false,
      };
    } catch (error) {
      await discardStagedQuietly(staged.resourceId);
      throw error;
    }
  }

  async function inspectExistingImport(input: {
    projectId: string;
    projectAssetId: string;
    sha256: string;
    duplicateContent?: "allow" | "reject";
  }): Promise<ResolvedAsset | null> {
    const projectId = nonEmpty(input.projectId, "projectId");
    const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
    const resourceId = resourceIdForSha256(input.sha256);
    const decision = await checkImportBeforeInstall(
      {
        projectId,
        projectAssetId,
        ...(input.duplicateContent === undefined
          ? {}
          : { duplicateContent: input.duplicateContent }),
      },
      resourceId,
    );
    return decision.replay
      ? existingResolved(projectId, projectAssetId)
      : null;
  }

  return {
    materialize,

    async materializeDoc(projectIdInput, doc) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      if (
        projectAssetAuthorityVersion(doc) === 1 &&
        actionAssetBindingAuthorityVersion(doc) ===
          ACTION_ASSET_BINDING_AUTHORITY_VERSION
      ) {
        const cover = reconcileProjectCoverBindings(doc);
        return cover.changed;
      }
      const legacy = await metadata.load();
      return applyMaterialization(
        projectId,
        doc,
        await prepareLegacyEntries(projectId, doc, legacy),
      );
    },

    stageOwned(input) {
      return resources.stage({
        bytes: input.bytes,
        ...(input.name ? { originalName: input.name } : {}),
      });
    },

    async resolveStagedOwned(resourceIdInput) {
      const resourceId = nonEmpty(resourceIdInput, "resourceId");
      const projection = await resources.resolveStaged(resourceId);
      if (!projection) {
        throw new LocalProjectAssetMigrationError(
          "RESOURCE_DIGEST_UNAVAILABLE",
          `Staged bytes ${resourceId} are not available on this Host.`,
        );
      }
      return projection;
    },

    prepareStagedOwnedEntry,

    async publishStagedOwnedWithBindings(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const entry = await prepareStagedOwnedEntry(input);
      await materialize(projectId);
      const published = await replica.mutate(projectId, (doc) => {
        input.assertProjectState?.(doc);
        const result = publishLocalProjectAssetWithBindings(
          doc,
          entry,
          input.bindings,
        );
        return { value: result.entry, save: result.changed };
      });
      return resolveEntry(projectId, published);
    },

    async installOwned(input) {
      return (await installOwnedResult(input)).asset;
    },

    installOwnedResult,

    inspectExistingImport,

    async readEntry(projectIdInput, projectAssetId) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      await materialize(projectId);
      return authority.read(projectId, projectAssetId);
    },

    async admitLinked(input) {
      return publishLinked({
        projectId: nonEmpty(input.projectId, "projectId"),
        projectAssetId: input.projectAssetId?.trim() || `asset:${randomUUID()}`,
        kind: input.kind,
        resourceId: input.resourceId,
        originLibraryId: input.originLibraryId,
        originEntryId: input.originEntryId,
        ...(input.name ? { name: input.name } : {}),
        metadata: input.metadata,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
    },

    async bind(projectIdInput, binding) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      await materialize(projectId);
      return authority.bind(projectId, binding);
    },

    async unbind(projectIdInput, bindingId) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      await materialize(projectId);
      return authority.unbind(projectId, bindingId);
    },

    async read(projectId, projectAssetId) {
      return (await resolveObserved(projectId, projectAssetId))?.value ?? null;
    },

    async readFromDoc(doc, projectIdInput, projectAssetIdInput) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      const projectAssetId = nonEmpty(projectAssetIdInput, "projectAssetId");
      await this.materializeDoc(projectId, doc);
      const entry = readProjectAsset(doc, projectAssetId, { projectId });
      return entry ? resolveEntry(projectId, entry) : null;
    },

    readObserved(projectId, projectAssetId) {
      return resolveObserved(projectId, projectAssetId);
    },

    async list(projectId) {
      await materialize(projectId);
      return Promise.all(
        (await authority.list(projectId)).map((entry) =>
          resolveEntry(projectId, entry),
        ),
      );
    },

    async readProjectCover(projectIdInput) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      await materialize(projectId);
      return replica.inspect(projectId, (doc) => readProjectCoverAssetId(doc));
    },

    async setProjectCover(projectIdInput, projectAssetIdInput) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      const projectAssetId = projectAssetIdInput?.trim() || null;
      await materialize(projectId);
      return replica.mutate(projectId, (doc) => {
        const result = setProjectCoverAsset(doc, {
          projectAssetId,
          ...(projectAssetId
            ? { bindingId: `project-cover:${randomUUID()}` }
            : {}),
        });
        if (!result.ok) mutationFailure(result);
        return { value: result.coverAssetId, save: result.changed };
      });
    },

    async listReferences(projectIdInput, projectAssetId) {
      return (await this.listReferencesObserved(projectIdInput, projectAssetId))
        .value;
    },

    async listReferencesObserved(projectIdInput, projectAssetId) {
      const observed = await observationSnapshot(
        projectIdInput,
        projectAssetId,
      );
      if (!observed) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_NOT_FOUND",
          `Project Asset ${projectAssetId} is not available in Project ${projectIdInput}.`,
        );
      }
      return { value: observed.references, readToken: observed.readToken };
    },

    async trash(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      await materialize(projectId);
      await client.trash({
        projectId,
        projectAssetId,
        deleteOperationId,
        deletedAt: input.deletedAt,
        purgeAfter: input.purgeAfter,
        ...(input.observation ? { observation: input.observation } : {}),
      });
      const observed = await resolveObserved(projectId, projectAssetId);
      if (!observed) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_NOT_FOUND",
          `Project Asset ${projectAssetId} disappeared after deletion.`,
        );
      }
      return observed;
    },

    async restore(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      await materialize(projectId);
      await client.restore({
        projectId,
        projectAssetId: input.projectAssetId,
        ...(input.observation ? { observation: input.observation } : {}),
      });
      const observed = await resolveObserved(projectId, input.projectAssetId);
      if (!observed) {
        throw new LocalProjectAssetMigrationError(
          "PROJECT_ASSET_NOT_FOUND",
          `Project Asset ${input.projectAssetId} disappeared after restore.`,
        );
      }
      return observed;
    },

    async openProjection(projectId, projectAssetId) {
      await materialize(projectId);
      const entry = await authority.read(projectId, projectAssetId);
      return projectionFromEntry(projectId, entry, projectAssetId);
    },

    async openProjectionFromDoc(doc, projectIdInput, projectAssetId) {
      const projectId = nonEmpty(projectIdInput, "projectId");
      await this.materializeDoc(projectId, doc);
      return projectionFromEntry(
        projectId,
        readProjectAsset(doc, projectAssetId, { projectId }),
        projectAssetId,
      );
    },
  };
}
