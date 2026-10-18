import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createGlobalAssetClient,
  type GlobalAssetAuthorityPort,
} from "@clash/asset-sdk";
import {
  GlobalAssetEntrySchema,
  ProjectAssetMetadataSchema,
  ResolvedAssetSchema,
  type AssetKind,
  type Asset,
  type GlobalAssetEntry,
  type ProjectAssetMetadata,
  type ProjectAssetProvenance,
  type ResolvedAsset,
} from "@clash/shared-types";

import { assetPathForRead } from "./local-asset-paths.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalResourceStore,
  LocalResourceError,
  stageLocalResourceInput,
  type LocalResourceProjection,
  type LocalResourceStageInput,
} from "./local-resource-store.js";
import {
  canonicalAssetMediaTypeAssertion,
  type LocalAssetInspectionService,
} from "./local-asset-inspections.js";
import type { LocalAssetInspectionFacts } from "./local-asset-inspections.js";
import type { LocalAssetRepresentationService } from "./local-asset-representations.js";

export type LocalGlobalAssetErrorCode =
  | "GLOBAL_ASSET_NOT_FOUND"
  | "GLOBAL_ASSET_UNAVAILABLE"
  | "GLOBAL_ASSET_FACT_MISMATCH";

export class LocalGlobalAssetError extends Error {
  readonly code: LocalGlobalAssetErrorCode;

  constructor(
    code: LocalGlobalAssetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalGlobalAssetError";
    this.code = code;
  }
}

export interface LocalGlobalAssetService {
  importBytes(
    input: {
      libraryId: string;
      globalAssetId: string;
      kind: AssetKind;
      contentType?: string;
      originalName?: string;
      name?: string;
      metadata?: ProjectAssetMetadata;
      provenance?: ProjectAssetProvenance;
    } & LocalResourceStageInput,
  ): Promise<ResolvedAsset>;
  publishResource(input: {
    libraryId: string;
    globalAssetId: string;
    resourceId: string;
    kind: AssetKind;
    name?: string;
    metadata?: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
  }): Promise<ResolvedAsset>;
  /** Host-private entry lookup for semantic publish/admit operations. */
  readEntry(
    libraryId: string,
    globalAssetId: string,
  ): Promise<GlobalAssetEntry | null>;
  read(libraryId: string, globalAssetId: string): Promise<ResolvedAsset | null>;
  list(libraryId: string): Promise<ResolvedAsset[]>;
  trash(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
  }): Promise<ResolvedAsset>;
  restore(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
  }): Promise<ResolvedAsset>;
  purge(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
    purgedAt: string;
  }): Promise<ResolvedAsset>;
  openProjection(
    libraryId: string,
    globalAssetId: string,
  ): Promise<LocalResourceProjection>;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function mediaUrl(
  origin: string,
  libraryId: string,
  globalAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(globalAssetId)}/media`;
}

function thumbnailUrl(
  origin: string,
  libraryId: string,
  globalAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(globalAssetId)}/thumbnail`;
}

function waveformUrl(
  origin: string,
  libraryId: string,
  globalAssetId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(globalAssetId)}/waveform`;
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

function legacyContentHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function legacyProvenance(asset: Asset): ProjectAssetProvenance {
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

function metadataForResource(input: {
  metadata?: ProjectAssetMetadata;
  byteLength: number;
  contentType?: string;
  originalName?: string;
}): ProjectAssetMetadata {
  if (
    input.metadata?.bytes !== undefined &&
    input.metadata.bytes !== input.byteLength
  ) {
    throw new LocalGlobalAssetError(
      "GLOBAL_ASSET_FACT_MISMATCH",
      "Global Asset metadata byte length does not match its immutable Resource.",
    );
  }
  if (
    input.metadata?.contentType !== undefined &&
    input.metadata.contentType !== input.contentType
  ) {
    throw new LocalGlobalAssetError(
      "GLOBAL_ASSET_FACT_MISMATCH",
      "Global Asset metadata content type does not match its immutable Resource.",
    );
  }
  return {
    ...(input.metadata ?? {}),
    bytes: input.byteLength,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.originalName ? { originalName: input.originalName } : {}),
  };
}

export function createLocalGlobalAssetService(options: {
  dataDir: string;
  clashRoot?: string;
  projectionOrigin: string | (() => string);
  legacyUserId?: string;
  assetInspection?: LocalAssetInspectionService;
  assetRepresentations?: Pick<
    LocalAssetRepresentationService,
    "schedule" | "read"
  >;
}): LocalGlobalAssetService {
  const metadata = createLocalMetadataStore(options.dataDir);
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
  });

  const authority: GlobalAssetAuthorityPort = {
    read: metadata.readGlobalAsset,
    list: metadata.listGlobalAssets,
    create: metadata.createGlobalAsset,
    trash: metadata.trashGlobalAsset,
    restore: metadata.restoreGlobalAsset,
    purge: metadata.purgeGlobalAsset,
  };

  const client = createGlobalAssetClient({
    authority,
    registry: {
      async resolve({ entry }) {
        try {
          let projection = await resources.resolve(entry.resourceId);
          if (
            projection &&
            !projection.resource.contentType &&
            options.assetInspection
          ) {
            await options.assetInspection.inspect({ source: projection });
            projection = await resources.resolve(entry.resourceId);
          }
          const contentType = canonicalAssetMediaTypeAssertion(
            projection?.resource.contentType,
          );
          return projection
            ? {
                status: "ready" as const,
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
      async resolve({ libraryId, entry }) {
        const origin =
          typeof options.projectionOrigin === "function"
            ? options.projectionOrigin()
            : options.projectionOrigin;
        const url = mediaUrl(origin, libraryId, entry.id);
        const representationRole =
          entry.kind === "audio" ? "waveform" : "thumbnail";
        const representation = options.assetRepresentations
          ? await options.assetRepresentations.read(
              entry.resourceId,
              representationRole,
            )
          : undefined;
        options.assetRepresentations?.schedule(entry.resourceId);
        return {
          status: "ready" as const,
          url,
          ...(representation?.role === "thumbnail"
            ? { thumbnailUrl: thumbnailUrl(origin, libraryId, entry.id) }
            : entry.kind === "image"
              ? { thumbnailUrl: url }
              : {}),
          ...(representation?.role === "waveform"
            ? { waveformUrl: waveformUrl(origin, libraryId, entry.id) }
            : {}),
        };
      },
    },
  });

  async function enrichResolved(
    entry: GlobalAssetEntry,
    resolved: ResolvedAsset,
  ): Promise<ResolvedAsset> {
    if (!options.assetInspection || resolved.status !== "ready") {
      return resolved;
    }
    const source = await resources.resolve(entry.resourceId);
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
    libraryId: string,
    entry: GlobalAssetEntry,
  ): Promise<ResolvedAsset> {
    const resolved = await client.read({
      libraryId,
      globalAssetId: entry.id,
    });
    if (!resolved) {
      throw new LocalGlobalAssetError(
        "GLOBAL_ASSET_NOT_FOUND",
        `Global Asset ${entry.id} was not found in library ${libraryId}.`,
      );
    }
    return enrichResolved(entry, resolved);
  }

  async function requireResolved(
    libraryId: string,
    globalAssetId: string,
  ): Promise<ResolvedAsset> {
    const entry = await authority.read(libraryId, globalAssetId);
    if (!entry) {
      throw new LocalGlobalAssetError(
        "GLOBAL_ASSET_NOT_FOUND",
        `Global Asset ${globalAssetId} was not found in library ${libraryId}.`,
      );
    }
    return resolveEntry(libraryId, entry);
  }

  function canonicalMetadata(input: {
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
    metadata?: ProjectAssetMetadata;
    originalName?: string;
  }): ProjectAssetMetadata {
    return ProjectAssetMetadataSchema.parse({
      ...input.facts,
      // Resource and Host byte-probe facts own the canonical media read model.
      // Producer/browser values are hints only and cannot become authority.
      bytes: input.source.resource.byteLength,
      ...(input.metadata?.originalName || input.originalName
        ? { originalName: input.metadata?.originalName ?? input.originalName }
        : {}),
    });
  }

  async function finalizedSource(input: {
    resourceId: string;
    kind: AssetKind;
    metadata?: ProjectAssetMetadata;
  }): Promise<{
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
  }> {
    if (!options.assetInspection) {
      throw new LocalGlobalAssetError(
        "GLOBAL_ASSET_UNAVAILABLE",
        "A verified Host Asset inspection is required before Global publication.",
      );
    }
    try {
      return await options.assetInspection.finalize({
        resourceId: input.resourceId,
        kind: input.kind,
        ...(input.metadata?.contentType
          ? { contentType: input.metadata.contentType }
          : {}),
      });
    } catch (error) {
      throw new LocalGlobalAssetError(
        "GLOBAL_ASSET_UNAVAILABLE",
        `Resource ${input.resourceId} could not be verified for Global publication: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  type GlobalPublicationInput = {
    libraryId: string;
    globalAssetId: string;
    resourceId: string;
    kind: AssetKind;
    name?: string;
    metadata?: ProjectAssetMetadata;
    provenance?: ProjectAssetProvenance;
    originalName?: string;
  };

  async function preparePublication(input: GlobalPublicationInput): Promise<{
    libraryId: string;
    globalAssetId: string;
    entry: GlobalAssetEntry;
  }> {
    const libraryId = nonEmpty(input.libraryId, "libraryId");
    const globalAssetId = nonEmpty(input.globalAssetId, "globalAssetId");
    const resourceId = nonEmpty(input.resourceId, "resourceId");
    const finalized = await finalizedSource({
      resourceId,
      kind: input.kind,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    const projection = finalized.source;
    const entry = GlobalAssetEntrySchema.parse({
      id: globalAssetId,
      kind: input.kind,
      resourceId: projection.resource.id,
      lifecycle: { state: "active" },
      ...(input.name ? { name: input.name } : {}),
      metadata: canonicalMetadata({
        source: projection,
        facts: finalized.facts,
        metadata: input.metadata,
        ...(input.originalName ? { originalName: input.originalName } : {}),
      }),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    } satisfies GlobalAssetEntry);
    return { libraryId, globalAssetId, entry };
  }

  async function publish(
    input: GlobalPublicationInput,
  ): Promise<ResolvedAsset> {
    await ensureLibraryMaterialized(input.libraryId);
    const { libraryId, globalAssetId, entry } = await preparePublication(input);
    const existing = await authority.read(libraryId, globalAssetId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_FACT_MISMATCH",
          `Global Asset ${globalAssetId} already exists with different facts in library ${libraryId}.`,
        );
      }
      return resolveEntry(libraryId, existing);
    }
    try {
      await client.create({ libraryId, entry });
    } catch (error) {
      const raced = await authority.read(libraryId, globalAssetId);
      if (!raced) throw error;
      if (JSON.stringify(raced) !== JSON.stringify(entry)) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_FACT_MISMATCH",
          `Global Asset ${globalAssetId} already exists with different facts in library ${libraryId}.`,
          { cause: error },
        );
      }
      return resolveEntry(libraryId, raced);
    }
    return requireResolved(libraryId, globalAssetId);
  }

  async function materializeLegacyPersonalAssets(): Promise<void> {
    if (await metadata.legacyPersonalGlobalAssetMigrationCompleted()) return;
    const legacy = await metadata.load();
    const legacyUserId = options.legacyUserId?.trim() || "local-user";
    const assetsById = new Map(legacy.assets.map((asset) => [asset.id, asset]));
    const assetIds = [
      ...new Set(
        (legacy.libraryAssetRefs ?? [])
          .filter((reference) => reference.userId === legacyUserId)
          .map((reference) => reference.assetId),
      ),
    ].sort();
    const entries: GlobalAssetEntry[] = [];
    for (const assetId of assetIds) {
      const asset = assetsById.get(assetId);
      if (!asset) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_UNAVAILABLE",
          `Legacy personal Global Asset ${assetId} has no Asset row.`,
        );
      }
      if (asset.userId !== legacyUserId) continue;
      let bytes: Uint8Array;
      try {
        const path = await assetPathForRead(
          options.dataDir,
          legacyStorageKey(asset),
          options.clashRoot,
        );
        bytes = new Uint8Array(await readFile(path));
      } catch (error) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_UNAVAILABLE",
          `Legacy personal Global Asset ${asset.id} has no locally verifiable immutable bytes.`,
          { cause: error },
        );
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const claimedDigest = legacyContentHash(asset.metadata?.contentHash);
      if (
        (typeof asset.metadata?.contentHash === "string" && !claimedDigest) ||
        (claimedDigest !== undefined && claimedDigest !== digest) ||
        (typeof asset.metadata?.bytes === "number" &&
          asset.metadata.bytes !== bytes.byteLength)
      ) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_FACT_MISMATCH",
          `Legacy personal Global Asset ${asset.id} does not match its claimed immutable facts.`,
        );
      }
      const staged = await resources.stage({
        bytes,
        ...(asset.metadata?.originalName
          ? { originalName: asset.metadata.originalName }
          : {}),
      });
      const prepared = await preparePublication({
        libraryId: "personal",
        globalAssetId: asset.id,
        resourceId: staged.resourceId,
        kind: asset.kind,
        ...(asset.metadata?.originalName
          ? {
              name: asset.metadata.originalName,
              originalName: asset.metadata.originalName,
            }
          : {}),
        metadata: {
          ...(asset.metadata?.contentType
            ? { contentType: asset.metadata.contentType }
            : {}),
        },
        provenance: legacyProvenance(asset),
      });
      entries.push(prepared.entry);
    }
    try {
      await metadata.createLegacyPersonalGlobalAssets(entries);
    } catch (error) {
      throw new LocalGlobalAssetError(
        "GLOBAL_ASSET_FACT_MISMATCH",
        "Legacy personal Global Assets conflict with canonical library facts.",
        { cause: error },
      );
    }
  }

  async function ensureLibraryMaterialized(
    libraryIdInput: string,
  ): Promise<string> {
    const libraryId = nonEmpty(libraryIdInput, "libraryId");
    if (libraryId === "personal") await materializeLegacyPersonalAssets();
    return libraryId;
  }

  return {
    async importBytes(input) {
      const staged = await stageLocalResourceInput(
        resources,
        input,
        input.originalName,
      );
      return publish({
        libraryId: input.libraryId,
        globalAssetId: input.globalAssetId,
        resourceId: staged.resourceId,
        kind: input.kind,
        ...((input.name ?? input.originalName)
          ? { name: input.name ?? input.originalName }
          : {}),
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.contentType ? { contentType: input.contentType } : {}),
        },
        ...(input.provenance ? { provenance: input.provenance } : {}),
        ...(input.originalName ? { originalName: input.originalName } : {}),
      });
    },

    publishResource: publish,

    async readEntry(libraryIdInput, globalAssetIdInput) {
      const libraryId = await ensureLibraryMaterialized(libraryIdInput);
      const globalAssetId = nonEmpty(globalAssetIdInput, "globalAssetId");
      const entry = await authority.read(libraryId, globalAssetId);
      return entry ? GlobalAssetEntrySchema.parse(entry) : null;
    },

    async read(libraryIdInput, globalAssetId) {
      const libraryId = await ensureLibraryMaterialized(libraryIdInput);
      const entry = await authority.read(libraryId, globalAssetId);
      return entry ? resolveEntry(libraryId, entry) : null;
    },

    async list(libraryIdInput) {
      const libraryId = await ensureLibraryMaterialized(libraryIdInput);
      return Promise.all(
        (await authority.list(libraryId)).map((entry) =>
          resolveEntry(libraryId, entry),
        ),
      );
    },

    async trash(input) {
      const libraryId = await ensureLibraryMaterialized(input.libraryId);
      const globalAssetId = nonEmpty(input.globalAssetId, "globalAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      if (!(await authority.read(libraryId, globalAssetId))) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_NOT_FOUND",
          `Global Asset ${globalAssetId} was not found in library ${libraryId}.`,
        );
      }
      const reconcileRetry = async (): Promise<ResolvedAsset | null> => {
        const current = await authority.read(libraryId, globalAssetId);
        if (current?.lifecycle.state !== "trashed") return null;
        if (current.lifecycle.deleteOperationId !== deleteOperationId) {
          throw new LocalGlobalAssetError(
            "GLOBAL_ASSET_FACT_MISMATCH",
            `Global Asset ${globalAssetId} is already trashed by another operation.`,
          );
        }
        return resolveEntry(libraryId, current);
      };
      const retried = await reconcileRetry();
      if (retried) return retried;
      try {
        await client.trash({
          ...input,
          libraryId,
          globalAssetId,
          deleteOperationId,
        });
      } catch (error) {
        const raced = await reconcileRetry();
        if (raced) return raced;
        throw error;
      }
      return requireResolved(libraryId, globalAssetId);
    },

    async restore(input) {
      const libraryId = await ensureLibraryMaterialized(input.libraryId);
      const globalAssetId = nonEmpty(input.globalAssetId, "globalAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      if (!(await authority.read(libraryId, globalAssetId))) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_NOT_FOUND",
          `Global Asset ${globalAssetId} was not found in library ${libraryId}.`,
        );
      }
      try {
        await client.restore({ libraryId, globalAssetId, deleteOperationId });
      } catch (error) {
        const current = await authority.read(libraryId, globalAssetId);
        if (current?.lifecycle.state === "purged") throw error;
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_FACT_MISMATCH",
          `Global Asset ${globalAssetId} is not trashed by ${deleteOperationId}.`,
          { cause: error },
        );
      }
      return requireResolved(libraryId, globalAssetId);
    },

    async purge(input) {
      const libraryId = await ensureLibraryMaterialized(input.libraryId);
      await client.purge({ ...input, libraryId });
      return requireResolved(libraryId, input.globalAssetId);
    },

    async openProjection(libraryIdInput, globalAssetIdInput) {
      const libraryId = await ensureLibraryMaterialized(libraryIdInput);
      const globalAssetId = nonEmpty(globalAssetIdInput, "globalAssetId");
      const entry = await authority.read(libraryId, globalAssetId);
      if (!entry) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_NOT_FOUND",
          `Global Asset ${globalAssetId} was not found in library ${libraryId}.`,
        );
      }
      if (entry.lifecycle.state !== "active") {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_UNAVAILABLE",
          `Global Asset ${globalAssetId} is not active.`,
        );
      }
      const projection = await resources.resolve(entry.resourceId);
      if (!projection) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_UNAVAILABLE",
          `Resource ${entry.resourceId} is not installed on this Host.`,
        );
      }
      metadataForResource({
        metadata: entry.metadata,
        byteLength: projection.resource.byteLength,
        ...(projection.resource.contentType
          ? { contentType: projection.resource.contentType }
          : {}),
      });
      if (projection.resource.kind !== entry.kind) {
        throw new LocalGlobalAssetError(
          "GLOBAL_ASSET_FACT_MISMATCH",
          `Global Asset ${globalAssetId} kind does not match its Resource.`,
        );
      }
      return projection;
    },
  };
}
