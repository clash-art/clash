import {
  GlobalAssetEntrySchema,
  ProjectAssetPublicationMetadataSchema,
  ResolvedAssetSchema,
  ResourceSchema,
  type GlobalAssetEntry,
  type ResolvedAsset,
  type Resource,
} from "@clash/shared-types";

import {
  AssetSdkContractError,
  type ResourceProjectionResolution,
  type ResourceRegistryResolution,
} from "./asset-client.js";

export interface GlobalAssetTrashInput {
  id: string;
  deleteOperationId: string;
  deletedAt: string;
  purgeAfter: string;
}

export interface GlobalAssetPurgeInput {
  id: string;
  deleteOperationId: string;
  purgedAt: string;
}

export interface GlobalAssetRestoreInput {
  id: string;
  deleteOperationId: string;
}

export interface GlobalAssetAuthorityPort {
  read(libraryId: string, id: string): Promise<GlobalAssetEntry | null>;
  list(libraryId: string): Promise<GlobalAssetEntry[]>;
  create(libraryId: string, entry: GlobalAssetEntry): Promise<GlobalAssetEntry>;
  trash(
    libraryId: string,
    input: GlobalAssetTrashInput,
  ): Promise<GlobalAssetEntry>;
  restore(
    libraryId: string,
    input: GlobalAssetRestoreInput,
  ): Promise<GlobalAssetEntry>;
  purge(
    libraryId: string,
    input: GlobalAssetPurgeInput,
  ): Promise<GlobalAssetEntry>;
}

export type GlobalResourceRegistryIntent = "read" | "create";

export interface GlobalResourceRegistryPort {
  resolve(input: {
    libraryId: string;
    entry: GlobalAssetEntry;
    intent: GlobalResourceRegistryIntent;
  }): Promise<ResourceRegistryResolution>;
}

export interface GlobalResourceProjectionPort {
  resolve(input: {
    libraryId: string;
    entry: GlobalAssetEntry;
    resource: Resource;
  }): Promise<ResourceProjectionResolution>;
}

export interface GlobalAssetClientPorts {
  authority: GlobalAssetAuthorityPort;
  registry: GlobalResourceRegistryPort;
  projection: GlobalResourceProjectionPort;
}

export interface GlobalAssetClient {
  read(input: {
    libraryId: string;
    globalAssetId: string;
  }): Promise<ResolvedAsset | null>;
  list(input: { libraryId: string }): Promise<ResolvedAsset[]>;
  create(input: {
    libraryId: string;
    entry: GlobalAssetEntry;
  }): Promise<GlobalAssetEntry>;
  trash(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
  }): Promise<GlobalAssetEntry>;
  restore(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
  }): Promise<GlobalAssetEntry>;
  purge(input: {
    libraryId: string;
    globalAssetId: string;
    deleteOperationId: string;
    purgedAt: string;
  }): Promise<GlobalAssetEntry>;
}

function error(message: string, cause?: unknown): AssetSdkContractError {
  return new AssetSdkContractError(
    "AUTHORITY_CONTRACT_VIOLATION",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AssetSdkContractError(
      "INVALID_GLOBAL_ASSET",
      `${label} must not be empty.`,
    );
  }
  return normalized;
}

function parseEntry(
  value: unknown,
  code: "INVALID_GLOBAL_ASSET" | "AUTHORITY_CONTRACT_VIOLATION",
): GlobalAssetEntry {
  const parsed = GlobalAssetEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new AssetSdkContractError(
      code,
      parsed.error.issues[0]?.message ?? "Invalid Global Asset",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function validateResult(value: unknown, expectedId?: string): GlobalAssetEntry {
  const entry = parseEntry(value, "AUTHORITY_CONTRACT_VIOLATION");
  if (expectedId !== undefined && entry.id !== expectedId) {
    throw error(
      `Authority returned Global Asset ${entry.id}; expected ${expectedId}.`,
    );
  }
  return entry;
}

function baseResolved(entry: GlobalAssetEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    metadata: entry.metadata,
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    lifecycle: entry.lifecycle,
  };
}

function parseResolved(value: unknown): ResolvedAsset {
  const parsed = ResolvedAssetSchema.safeParse(value);
  if (!parsed.success) {
    throw new AssetSdkContractError(
      "PROJECTION_CONTRACT_VIOLATION",
      parsed.error.issues[0]?.message ?? "Invalid resolved Global Asset",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseResource(value: unknown, entry: GlobalAssetEntry): Resource {
  const parsed = ResourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AssetSdkContractError(
      "RESOURCE_CONTRACT_VIOLATION",
      parsed.error.issues[0]?.message ?? "Invalid Resource registry result",
      { cause: parsed.error },
    );
  }
  const resource = parsed.data;
  if (resource.id !== entry.resourceId || resource.kind !== entry.kind) {
    throw new AssetSdkContractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Resource ${resource.id} does not match Global Asset ${entry.id}.`,
    );
  }
  if (
    entry.metadata.bytes !== undefined &&
    entry.metadata.bytes !== resource.byteLength
  ) {
    throw new AssetSdkContractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Global Asset ${entry.id} byte length does not match Resource ${resource.id}.`,
    );
  }
  if (
    entry.metadata.contentType !== undefined &&
    entry.metadata.contentType !== resource.contentType
  ) {
    throw new AssetSdkContractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Global Asset ${entry.id} content type does not match Resource ${resource.id}.`,
    );
  }
  return resource;
}

async function resolveGlobalAsset(
  ports: GlobalAssetClientPorts,
  libraryId: string,
  entry: GlobalAssetEntry,
): Promise<ResolvedAsset> {
  const base = baseResolved(entry);
  if (entry.lifecycle.state !== "active") {
    return parseResolved({ ...base, status: "unavailable" });
  }

  const registry = await ports.registry.resolve({
    libraryId,
    entry: parseEntry(entry, "INVALID_GLOBAL_ASSET"),
    intent: "read",
  });
  if (!registry || typeof registry !== "object" || !("status" in registry)) {
    throw new AssetSdkContractError(
      "RESOURCE_CONTRACT_VIOLATION",
      "Resource registry returned no status.",
    );
  }
  if (registry.status === "uploading") {
    parseResource(registry.resource, entry);
    return parseResolved({
      ...base,
      status: "uploading",
      ...(registry.progress === undefined
        ? {}
        : { progress: registry.progress }),
    });
  }
  if (registry.status === "failed" || registry.status === "unavailable") {
    return parseResolved({
      ...base,
      status: registry.status,
      ...(registry.error === undefined ? {} : { error: registry.error }),
      ...(registry.status === "failed" && registry.errorCode !== undefined
        ? { errorCode: registry.errorCode }
        : {}),
    });
  }

  const resource = parseResource(registry.resource, entry);
  const projection = await ports.projection.resolve({
    libraryId,
    entry,
    resource,
  });
  if (
    !projection ||
    typeof projection !== "object" ||
    !("status" in projection)
  ) {
    throw new AssetSdkContractError(
      "PROJECTION_CONTRACT_VIOLATION",
      "Resource projection returned no status.",
    );
  }
  switch (projection.status) {
    case "ready":
      return parseResolved({
        ...base,
        status: "ready",
        url: projection.url,
        ...(projection.thumbnailUrl === undefined
          ? {}
          : { thumbnailUrl: projection.thumbnailUrl }),
        ...(projection.waveformUrl === undefined
          ? {}
          : { waveformUrl: projection.waveformUrl }),
      });
    case "downloading":
      return parseResolved({
        ...base,
        status: "downloading",
        ...(projection.progress === undefined
          ? {}
          : { progress: projection.progress }),
      });
    case "failed":
    case "unavailable":
      return parseResolved({
        ...base,
        status: projection.status,
        ...(projection.error === undefined ? {} : { error: projection.error }),
      });
  }
}

export function createGlobalAssetClient(
  ports: GlobalAssetClientPorts,
): GlobalAssetClient {
  return {
    async read(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const id = nonEmpty(input.globalAssetId, "globalAssetId");
      const value = await ports.authority.read(libraryId, id);
      if (value === null) return null;
      return resolveGlobalAsset(ports, libraryId, validateResult(value, id));
    },

    async list(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const values = await ports.authority.list(libraryId);
      if (!Array.isArray(values))
        throw error("Authority Global Asset list must be an array.");
      const entries = values
        .map((value) => validateResult(value))
        .sort((left, right) => left.id.localeCompare(right.id));
      return Promise.all(
        entries.map((entry) => resolveGlobalAsset(ports, libraryId, entry)),
      );
    },

    async create(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const requested = parseEntry(input.entry, "INVALID_GLOBAL_ASSET");
      if (
        !ProjectAssetPublicationMetadataSchema.safeParse(requested.metadata)
          .success
      ) {
        throw new AssetSdkContractError(
          "INVALID_GLOBAL_ASSET",
          `Global Asset ${requested.id} contains legacy derived metadata that cannot be published.`,
        );
      }
      if (requested.lifecycle.state !== "active") {
        throw new AssetSdkContractError(
          "INVALID_GLOBAL_ASSET",
          "A new Global Asset must be active.",
        );
      }
      const registry = await ports.registry.resolve({
        libraryId,
        entry: parseEntry(requested, "INVALID_GLOBAL_ASSET"),
        intent: "create",
      });
      if (registry.status === "failed" || registry.status === "unavailable") {
        throw new AssetSdkContractError(
          "RESOURCE_UNAVAILABLE",
          registry.error ?? `Resource ${requested.resourceId} is unavailable.`,
        );
      }
      parseResource(registry.resource, requested);
      if (registry.status !== "ready") {
        throw new AssetSdkContractError(
          "RESOURCE_NOT_READY",
          `Resource ${requested.resourceId} must be ready before publishing Global Asset ${requested.id}.`,
        );
      }
      const authorityInput = parseEntry(requested, "INVALID_GLOBAL_ASSET");
      const created = validateResult(
        await ports.authority.create(libraryId, authorityInput),
        requested.id,
      );
      if (JSON.stringify(created) !== JSON.stringify(requested)) {
        throw error(
          `Authority changed Global Asset ${requested.id} while creating it.`,
        );
      }
      return created;
    },

    async trash(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const id = nonEmpty(input.globalAssetId, "globalAssetId");
      const lifecycle = {
        state: "trashed" as const,
        deleteOperationId: nonEmpty(
          input.deleteOperationId,
          "deleteOperationId",
        ),
        deletedAt: nonEmpty(input.deletedAt, "deletedAt"),
        purgeAfter: nonEmpty(input.purgeAfter, "purgeAfter"),
      };
      const entry = validateResult(
        await ports.authority.trash(libraryId, {
          id,
          deleteOperationId: lifecycle.deleteOperationId,
          deletedAt: lifecycle.deletedAt,
          purgeAfter: lifecycle.purgeAfter,
        }),
        id,
      );
      if (JSON.stringify(entry.lifecycle) !== JSON.stringify(lifecycle)) {
        throw error(`Authority did not trash Global Asset ${id}.`);
      }
      return entry;
    },

    async restore(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const id = nonEmpty(input.globalAssetId, "globalAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      const entry = validateResult(
        await ports.authority.restore(libraryId, { id, deleteOperationId }),
        id,
      );
      if (entry.lifecycle.state !== "active")
        throw error(`Authority did not restore Global Asset ${id}.`);
      return entry;
    },

    async purge(input) {
      const libraryId = nonEmpty(input.libraryId, "libraryId");
      const id = nonEmpty(input.globalAssetId, "globalAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      const purgedAt = nonEmpty(input.purgedAt, "purgedAt");
      const entry = validateResult(
        await ports.authority.purge(libraryId, {
          id,
          deleteOperationId,
          purgedAt,
        }),
        id,
      );
      if (
        entry.lifecycle.state !== "purged" ||
        entry.lifecycle.deleteOperationId !== deleteOperationId ||
        entry.lifecycle.purgedAt !== purgedAt
      ) {
        throw error(`Authority did not purge Global Asset ${id}.`);
      }
      return entry;
    },
  };
}
