import {
  ActionAssetBindingSchema,
  ProjectAssetPublicationMetadataSchema,
  ProjectAssetEntrySchema,
  ResolvedAssetSchema,
  ResourceSchema,
  type ActionAssetBinding,
  type ProjectAssetEntry,
  type ProjectAssetTrashIfUnreferencedResult,
  type ResolvedAsset,
  type Resource,
} from "@clash/shared-types";

export type AssetSdkContractErrorCode =
  | "ASSET_IN_USE"
  | "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED"
  | "READ_REQUIRED"
  | "STALE_READ"
  | "INVALID_READ_PROOF"
  | "GLOBAL_ASSET_NOT_FOUND"
  | "INVALID_ACTION_ASSET_BINDING"
  | "INVALID_GLOBAL_ASSET"
  | "INVALID_PROJECT_ASSET"
  | "PROJECT_ASSET_NOT_FOUND"
  | "AUTHORITY_CONTRACT_VIOLATION"
  | "RESOURCE_CONTRACT_VIOLATION"
  | "PROJECTION_CONTRACT_VIOLATION"
  | "RESOURCE_NOT_READY"
  | "RESOURCE_UNAVAILABLE";

export class AssetSdkContractError extends Error {
  readonly code: AssetSdkContractErrorCode;
  readonly projectAssetId?: string;
  readonly references?: ActionAssetBinding[];

  constructor(
    code: AssetSdkContractErrorCode,
    message: string,
    options?: ErrorOptions & {
      projectAssetId?: string;
      references?: ActionAssetBinding[];
    },
  ) {
    super(message, options);
    this.name = "AssetSdkContractError";
    this.code = code;
    this.projectAssetId = options?.projectAssetId;
    this.references = options?.references;
  }
}

export interface ProjectAssetTrashInput {
  id: string;
  deleteOperationId: string;
  deletedAt: string;
  purgeAfter: string;
}

export interface ProjectAssetPurgeInput {
  id: string;
  deleteOperationId: string;
  purgedAt: string;
}

/** Opaque Host observation carried by trusted client glue, never exposed as a user option. */
export interface ProjectAssetMutationObservation {
  actorClientType?: string;
  expectedReadToken?: string;
}

export interface ProjectAssetAuthorityPort {
  /**
   * Reads and writes the Host-owned Project replica. The authority must validate an observation
   * against current Project state inside the same mutation critical section; SDK preflight reads
   * are not a substitute for CAS.
   */
  read(projectId: string, id: string): Promise<ProjectAssetEntry | null>;
  list(projectId: string): Promise<ProjectAssetEntry[]>;
  create(
    projectId: string,
    entry: ProjectAssetEntry,
  ): Promise<ProjectAssetEntry>;
  trashIfUnreferenced(
    projectId: string,
    input: ProjectAssetTrashInput,
    observation?: ProjectAssetMutationObservation,
  ): Promise<ProjectAssetTrashIfUnreferencedResult>;
  restore(
    projectId: string,
    id: string,
    observation?: ProjectAssetMutationObservation,
  ): Promise<ProjectAssetEntry>;
  purge(
    projectId: string,
    input: ProjectAssetPurgeInput,
  ): Promise<ProjectAssetEntry>;
  bind(
    projectId: string,
    binding: ActionAssetBinding,
  ): Promise<ActionAssetBinding>;
  unbind(
    projectId: string,
    bindingId: string,
  ): Promise<ActionAssetBinding | null>;
  listReferences(
    projectId: string,
    projectAssetId: string,
  ): Promise<ActionAssetBinding[]>;
}

export type ResourceRegistryIntent = "read" | "create-owned" | "admit-linked";

export type ResourceRegistryResolution =
  | {
      status: "uploading";
      resource: Resource;
      progress?: number;
      createdAt?: number;
    }
  | { status: "ready"; resource: Resource; createdAt?: number }
  | { status: "unavailable"; error?: string }
  | { status: "failed"; error: string };

export interface ResourceRegistryPort {
  /**
   * Verifies or stages a Resource. Even for `admit-linked`, this must not create the durable
   * Project claim: the reconciler derives that claim only after the Loro entry is authoritative.
   */
  resolve(input: {
    projectId: string;
    entry: ProjectAssetEntry;
    intent: ResourceRegistryIntent;
  }): Promise<ResourceRegistryResolution>;
}

export type ResourceProjectionResolution =
  | {
      status: "ready";
      url: string;
      thumbnailUrl?: string;
      waveformUrl?: string;
      proxyUrl?: string;
    }
  | { status: "downloading"; progress?: number }
  | { status: "unavailable"; error?: string }
  | { status: "failed"; error: string };

export interface ResourceProjectionPort {
  resolve(input: {
    projectId: string;
    entry: ProjectAssetEntry;
    resource: Resource;
  }): Promise<ResourceProjectionResolution>;
}

export interface AssetResolverPorts {
  registry: ResourceRegistryPort;
  projection: ResourceProjectionPort;
}

function contractError(
  code: AssetSdkContractErrorCode,
  message: string,
  cause?: unknown,
): AssetSdkContractError {
  return new AssetSdkContractError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseEntry(
  value: unknown,
  code: "INVALID_PROJECT_ASSET" | "AUTHORITY_CONTRACT_VIOLATION",
): ProjectAssetEntry {
  const parsed = ProjectAssetEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw contractError(
      code,
      parsed.error.issues[0]?.message ?? "Invalid Project Asset",
      parsed.error,
    );
  }
  return parsed.data;
}

function parseBinding(
  value: unknown,
  code: "INVALID_ACTION_ASSET_BINDING" | "AUTHORITY_CONTRACT_VIOLATION",
): ActionAssetBinding {
  const parsed = ActionAssetBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw contractError(
      code,
      parsed.error.issues[0]?.message ?? "Invalid Action Asset binding",
      parsed.error,
    );
  }
  return parsed.data;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw contractError("INVALID_PROJECT_ASSET", `${label} must not be empty.`);
  return normalized;
}

function baseResolved(entry: ProjectAssetEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    ...(entry.name === undefined ? {} : { name: entry.name }),
    metadata: entry.metadata,
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    lifecycle: entry.lifecycle,
  };
}

function parseResolved(
  value: unknown,
  code: AssetSdkContractErrorCode,
): ResolvedAsset {
  const parsed = ResolvedAssetSchema.safeParse(value);
  if (!parsed.success) {
    throw contractError(
      code,
      parsed.error.issues[0]?.message ?? "Invalid resolved Asset",
      parsed.error,
    );
  }
  return parsed.data;
}

function parseResource(value: unknown, entry: ProjectAssetEntry): Resource {
  const parsed = ResourceSchema.safeParse(value);
  if (!parsed.success) {
    throw contractError(
      "RESOURCE_CONTRACT_VIOLATION",
      parsed.error.issues[0]?.message ?? "Invalid Resource registry result",
      parsed.error,
    );
  }
  if (
    parsed.data.id !== entry.source.resourceId ||
    parsed.data.kind !== entry.kind
  ) {
    throw contractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Resource ${parsed.data.id} does not match Project Asset ${entry.id}.`,
    );
  }
  if (
    entry.metadata.bytes !== undefined &&
    entry.metadata.bytes !== parsed.data.byteLength
  ) {
    throw contractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Project Asset ${entry.id} byte length does not match Resource ${parsed.data.id}.`,
    );
  }
  if (
    entry.metadata.contentType !== undefined &&
    entry.metadata.contentType !== parsed.data.contentType
  ) {
    throw contractError(
      "RESOURCE_CONTRACT_VIOLATION",
      `Project Asset ${entry.id} content type does not match Resource ${parsed.data.id}.`,
    );
  }
  return parsed.data;
}

function registryFailure(
  entry: ProjectAssetEntry,
  resolution: Extract<
    ResourceRegistryResolution,
    { status: "failed" | "unavailable" }
  >,
): AssetSdkContractError {
  return contractError(
    "RESOURCE_UNAVAILABLE",
    resolution.error ?? `Resource ${entry.source.resourceId} is unavailable.`,
  );
}

async function resolveRegistry(
  ports: AssetResolverPorts,
  projectId: string,
  entry: ProjectAssetEntry,
  intent: ResourceRegistryIntent,
): Promise<ResourceRegistryResolution> {
  // Adapters receive their own parsed copy. A registry implementation is outside the product
  // authority boundary and must not be able to mutate the identity that will be committed later.
  const adapterEntry = parseEntry(entry, "INVALID_PROJECT_ASSET");
  const resolution: ResourceRegistryResolution = await ports.registry.resolve({
    projectId,
    entry: adapterEntry,
    intent,
  });
  if (
    !resolution ||
    typeof resolution !== "object" ||
    !("status" in resolution)
  ) {
    throw contractError(
      "RESOURCE_CONTRACT_VIOLATION",
      "Resource registry returned no status.",
    );
  }
  return resolution;
}

export async function resolveProjectAsset(
  ports: AssetResolverPorts,
  input: { projectId: string; entry: ProjectAssetEntry },
): Promise<ResolvedAsset> {
  const projectId = nonEmpty(input.projectId, "projectId");
  const entry = parseEntry(input.entry, "INVALID_PROJECT_ASSET");
  const base = baseResolved(entry);

  if (entry.lifecycle.state !== "active") {
    return parseResolved(
      { ...base, status: "unavailable" },
      "AUTHORITY_CONTRACT_VIOLATION",
    );
  }

  const registry = await resolveRegistry(ports, projectId, entry, "read");
  switch (registry.status) {
    case "uploading": {
      parseResource(registry.resource, entry);
      return parseResolved(
        {
          ...base,
          ...(entry.createdAt === undefined && registry.createdAt !== undefined
            ? { createdAt: registry.createdAt }
            : {}),
          status: "uploading",
          ...(registry.progress === undefined
            ? {}
            : { progress: registry.progress }),
        },
        "RESOURCE_CONTRACT_VIOLATION",
      );
    }
    case "unavailable":
    case "failed":
      return parseResolved(
        {
          ...base,
          status: registry.status,
          ...(registry.error === undefined ? {} : { error: registry.error }),
        },
        "RESOURCE_CONTRACT_VIOLATION",
      );
    case "ready": {
      const resource = parseResource(registry.resource, entry);
      const readyBase = {
        ...base,
        ...(entry.createdAt === undefined && registry.createdAt !== undefined
          ? { createdAt: registry.createdAt }
          : {}),
      };
      const projection: ResourceProjectionResolution =
        await ports.projection.resolve({
          projectId,
          entry,
          resource,
        });
      if (
        !projection ||
        typeof projection !== "object" ||
        !("status" in projection)
      ) {
        throw contractError(
          "PROJECTION_CONTRACT_VIOLATION",
          "Resource projection returned no status.",
        );
      }
      switch (projection.status) {
        case "ready":
          return parseResolved(
            {
              ...readyBase,
              status: "ready",
              url: projection.url,
              ...(projection.thumbnailUrl === undefined
                ? {}
                : { thumbnailUrl: projection.thumbnailUrl }),
              ...(projection.waveformUrl === undefined
                ? {}
                : { waveformUrl: projection.waveformUrl }),
              ...(projection.proxyUrl === undefined
                ? {}
                : { proxyUrl: projection.proxyUrl }),
            },
            "PROJECTION_CONTRACT_VIOLATION",
          );
        case "downloading":
          return parseResolved(
            {
              ...readyBase,
              status: "downloading",
              ...(projection.progress === undefined
                ? {}
                : { progress: projection.progress }),
            },
            "PROJECTION_CONTRACT_VIOLATION",
          );
        case "unavailable":
        case "failed":
          return parseResolved(
            {
              ...readyBase,
              status: projection.status,
              ...(projection.error === undefined
                ? {}
                : { error: projection.error }),
            },
            "PROJECTION_CONTRACT_VIOLATION",
          );
        default:
          throw contractError(
            "PROJECTION_CONTRACT_VIOLATION",
            "Unknown Resource projection status.",
          );
      }
    }
    default:
      throw contractError(
        "RESOURCE_CONTRACT_VIOLATION",
        "Unknown Resource registry status.",
      );
  }
}

export interface AssetClientPorts extends AssetResolverPorts {
  authority: ProjectAssetAuthorityPort;
}

export interface AssetClient {
  read(input: {
    projectId: string;
    projectAssetId: string;
  }): Promise<ResolvedAsset | null>;
  list(input: { projectId: string }): Promise<ResolvedAsset[]>;
  createOwned(input: {
    projectId: string;
    entry: ProjectAssetEntry;
  }): Promise<ProjectAssetEntry>;
  admitLinked(input: {
    projectId: string;
    entry: ProjectAssetEntry;
  }): Promise<ProjectAssetEntry>;
  trash(input: {
    projectId: string;
    projectAssetId: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
    observation?: ProjectAssetMutationObservation;
  }): Promise<ProjectAssetEntry>;
  restore(input: {
    projectId: string;
    projectAssetId: string;
    observation?: ProjectAssetMutationObservation;
  }): Promise<ProjectAssetEntry>;
  purge(input: {
    projectId: string;
    projectAssetId: string;
    deleteOperationId: string;
    purgedAt: string;
  }): Promise<ProjectAssetEntry>;
  bind(input: {
    projectId: string;
    binding: ActionAssetBinding;
  }): Promise<ActionAssetBinding>;
  unbind(input: {
    projectId: string;
    bindingId: string;
  }): Promise<ActionAssetBinding | null>;
  listReferences(input: {
    projectId: string;
    projectAssetId: string;
  }): Promise<ActionAssetBinding[]>;
}

function validateAuthorityEntry(
  value: unknown,
  expectedId?: string,
): ProjectAssetEntry {
  const parsed = parseEntry(value, "AUTHORITY_CONTRACT_VIOLATION");
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw contractError(
      "AUTHORITY_CONTRACT_VIOLATION",
      `Authority returned Project Asset ${parsed.id}; expected ${expectedId}.`,
    );
  }
  return parsed;
}

function validateCreatedEntry(
  value: unknown,
  requested: ProjectAssetEntry,
): ProjectAssetEntry {
  const created = validateAuthorityEntry(value, requested.id);
  if (JSON.stringify(created) !== JSON.stringify(requested)) {
    throw contractError(
      "AUTHORITY_CONTRACT_VIOLATION",
      `Authority changed Project Asset ${requested.id} while creating it.`,
    );
  }
  return created;
}

async function createEntry(
  ports: AssetClientPorts,
  projectId: string,
  rawEntry: ProjectAssetEntry,
  sourceKind: "owned" | "linked",
): Promise<ProjectAssetEntry> {
  const entry = parseEntry(rawEntry, "INVALID_PROJECT_ASSET");
  if (!ProjectAssetPublicationMetadataSchema.safeParse(entry.metadata).success) {
    throw contractError(
      "INVALID_PROJECT_ASSET",
      `Project Asset ${entry.id} contains legacy derived metadata that cannot be published.`,
    );
  }
  if (entry.source.kind !== sourceKind || entry.lifecycle.state !== "active") {
    throw contractError(
      "INVALID_PROJECT_ASSET",
      `This operation requires an active ${sourceKind} Project Asset.`,
    );
  }
  const intent = sourceKind === "owned" ? "create-owned" : "admit-linked";
  const resolution = await resolveRegistry(ports, projectId, entry, intent);
  if (resolution.status === "failed" || resolution.status === "unavailable") {
    throw registryFailure(entry, resolution);
  }
  parseResource(resolution.resource, entry);
  if (resolution.status !== "ready") {
    throw contractError(
      "RESOURCE_NOT_READY",
      `Resource ${entry.source.resourceId} must be ready before publishing Project Asset ${entry.id}.`,
    );
  }
  const authorityInput = parseEntry(entry, "INVALID_PROJECT_ASSET");
  return validateCreatedEntry(
    await ports.authority.create(projectId, authorityInput),
    entry,
  );
}

export function createAssetClient(ports: AssetClientPorts): AssetClient {
  return {
    async read(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const id = nonEmpty(input.projectAssetId, "projectAssetId");
      const value = await ports.authority.read(projectId, id);
      if (value === null) return null;
      const entry = validateAuthorityEntry(value, id);
      return resolveProjectAsset(ports, { projectId, entry });
    },

    async list(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const values = await ports.authority.list(projectId);
      if (!Array.isArray(values)) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          "Authority list result must be an array.",
        );
      }
      const entries = values
        .map((value) => validateAuthorityEntry(value))
        .sort((left, right) => left.id.localeCompare(right.id));
      return Promise.all(
        entries.map((entry) =>
          resolveProjectAsset(ports, { projectId, entry }),
        ),
      );
    },

    createOwned(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      return createEntry(ports, projectId, input.entry, "owned");
    },

    admitLinked(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      return createEntry(ports, projectId, input.entry, "linked");
    },

    async trash(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const id = nonEmpty(input.projectAssetId, "projectAssetId");
      const requestedLifecycle = {
        state: "trashed" as const,
        deleteOperationId: nonEmpty(
          input.deleteOperationId,
          "deleteOperationId",
        ),
        deletedAt: nonEmpty(input.deletedAt, "deletedAt"),
        purgeAfter: nonEmpty(input.purgeAfter, "purgeAfter"),
      };
      const result = await ports.authority.trashIfUnreferenced(
        projectId,
        {
          id,
          deleteOperationId: requestedLifecycle.deleteOperationId,
          deletedAt: requestedLifecycle.deletedAt,
          purgeAfter: requestedLifecycle.purgeAfter,
        },
        input.observation,
      );
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.ok !== "boolean"
      ) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          "Authority returned an invalid trash-if-unreferenced result.",
        );
      }
      if (!result.ok) {
        if (result.error.code === "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED") {
          if (
            typeof result.error.message !== "string" ||
            !result.error.message.trim() ||
            !Number.isInteger(result.error.requiredVersion) ||
            (result.error.currentVersion !== undefined &&
              !Number.isInteger(result.error.currentVersion))
          ) {
            throw contractError(
              "AUTHORITY_CONTRACT_VIOLATION",
              "Authority returned malformed Action Asset binding cutover details.",
            );
          }
          throw new AssetSdkContractError(
            "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED",
            result.error.message,
            { projectAssetId: id },
          );
        }
        if (result.error.code !== "ASSET_IN_USE") {
          throw contractError(
            "AUTHORITY_CONTRACT_VIOLATION",
            "Authority returned an unsupported Project Asset trash error.",
          );
        }
        if (
          result.error.projectAssetId !== id ||
          !Array.isArray(result.error.references)
        ) {
          throw contractError(
            "AUTHORITY_CONTRACT_VIOLATION",
            "Authority returned malformed ASSET_IN_USE details.",
          );
        }
        const references = result.error.references
          .map((value) => parseBinding(value, "AUTHORITY_CONTRACT_VIOLATION"))
          .sort((left, right) => left.id.localeCompare(right.id));
        if (references.some((binding) => binding.projectAssetId !== id)) {
          throw contractError(
            "AUTHORITY_CONTRACT_VIOLATION",
            "Authority returned an ASSET_IN_USE reference for another Project Asset.",
          );
        }
        throw new AssetSdkContractError(
          "ASSET_IN_USE",
          `Project Asset ${id} is still referenced.`,
          { projectAssetId: id, references },
        );
      }
      const entry = validateAuthorityEntry(result.entry, id);
      if (
        entry.lifecycle.state !== "trashed" ||
        entry.lifecycle.deleteOperationId !==
          requestedLifecycle.deleteOperationId
      ) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          `Authority did not trash Project Asset ${id} with the requested operation.`,
        );
      }
      return entry;
    },

    async restore(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const id = nonEmpty(input.projectAssetId, "projectAssetId");
      const entry = validateAuthorityEntry(
        await ports.authority.restore(projectId, id, input.observation),
        id,
      );
      if (entry.lifecycle.state !== "active") {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          `Authority did not restore Project Asset ${id}.`,
        );
      }
      return entry;
    },

    async purge(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const id = nonEmpty(input.projectAssetId, "projectAssetId");
      const deleteOperationId = nonEmpty(
        input.deleteOperationId,
        "deleteOperationId",
      );
      const purgedAt = nonEmpty(input.purgedAt, "purgedAt");
      const entry = validateAuthorityEntry(
        await ports.authority.purge(projectId, {
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
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          `Authority did not purge Project Asset ${id} with the requested operation.`,
        );
      }
      return entry;
    },

    async bind(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const requested = parseBinding(
        input.binding,
        "INVALID_ACTION_ASSET_BINDING",
      );
      const authorityInput = parseBinding(
        requested,
        "INVALID_ACTION_ASSET_BINDING",
      );
      const bound = parseBinding(
        await ports.authority.bind(projectId, authorityInput),
        "AUTHORITY_CONTRACT_VIOLATION",
      );
      if (JSON.stringify(bound) !== JSON.stringify(requested)) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          `Authority changed Action Asset binding ${requested.id} while binding it.`,
        );
      }
      return bound;
    },

    async unbind(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const id = nonEmpty(input.bindingId, "bindingId");
      const value = await ports.authority.unbind(projectId, id);
      if (value === null) return null;
      const binding = parseBinding(value, "AUTHORITY_CONTRACT_VIOLATION");
      if (binding.id !== id) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          `Authority unbound ${binding.id}; expected ${id}.`,
        );
      }
      return binding;
    },

    async listReferences(input) {
      const projectId = nonEmpty(input.projectId, "projectId");
      const projectAssetId = nonEmpty(input.projectAssetId, "projectAssetId");
      const values = await ports.authority.listReferences(
        projectId,
        projectAssetId,
      );
      if (!Array.isArray(values)) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          "Authority reference list must be an array.",
        );
      }
      const bindings = values
        .map((value) => parseBinding(value, "AUTHORITY_CONTRACT_VIOLATION"))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (
        bindings.some((binding) => binding.projectAssetId !== projectAssetId)
      ) {
        throw contractError(
          "AUTHORITY_CONTRACT_VIOLATION",
          "Authority returned a reference for another Project Asset.",
        );
      }
      return bindings;
    },
  };
}
