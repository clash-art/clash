import { lazySchema } from "./lazy-schema.js";
import { LoroMap, type LoroDoc } from "loro-crdt";
import { z } from "zod";

import {
  ProjectAssetEntrySchema,
  ProjectAssetLifecycleSchema,
  ProjectAssetSourceSchema,
  type ProjectAssetEntry,
  type ProjectAssetLifecycle,
  type ProjectAssetSource,
} from "./assets.js";

export const PROJECT_ASSETS_CONTAINER = "projectAssets";
export const PROJECT_ASSET_SCHEMA_CONTAINER = "projectAssetSchema";
export const PROJECT_ASSET_AUTHORITY_VERSION = 1;
const PROJECT_ASSET_AUTHORITY_VERSION_KEY = "authorityVersion";
const PROJECT_ASSET_AUTHORITY_VERSIONS_KEY = "authorityVersions";

export interface ProjectAssetReadContext {
  /** Owning Project of the opened Loro replica, used only to normalize legacy origins. */
  projectId?: string;
}

let LegacyLinkedProjectAssetSourceSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("linked"),
    resourceId: z.string().trim().min(1),
    origin: z.discriminatedUnion("scope", [
      z
        .object({
          scope: z.literal("global"),
          entryId: z.string().trim().min(1),
        })
        .strict(),
      z
        .object({
          scope: z.literal("project"),
          entryId: z.string().trim().min(1),
        })
        .strict(),
      z
        .object({
          scope: z.literal("catalog"),
          entryId: z.string().trim().min(1),
        })
        .strict(),
    ]),
  })
  .strict()
), (real) => { LegacyLinkedProjectAssetSourceSchema = real; });

export type ProjectAssetMutationErrorCode =
  | "INVALID_PROJECT_ASSET"
  | "PROJECT_ASSET_EXISTS"
  | "PROJECT_ASSET_NOT_FOUND"
  | "PROJECT_ASSET_ALREADY_TRASHED"
  | "PROJECT_ASSET_NOT_TRASHED"
  | "PROJECT_ASSET_PURGED"
  | "PROJECT_ASSET_DELETE_CONFLICT"
  | "UNSUPPORTED_PROJECT_ASSET_AUTHORITY";

export interface ProjectAssetMutationError {
  code: ProjectAssetMutationErrorCode;
  message: string;
  projectAssetId?: string;
}

export type ProjectAssetMutationResult =
  | { ok: true; entry: ProjectAssetEntry }
  | { ok: false; error: ProjectAssetMutationError };

export type ProjectAssetAuthorityResult =
  | { ok: true; version: typeof PROJECT_ASSET_AUTHORITY_VERSION }
  | { ok: false; error: ProjectAssetMutationError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoroMap(value: unknown): value is LoroMap {
  return (
    value instanceof LoroMap ||
    Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as { get?: unknown }).get === "function" &&
      typeof (value as { set?: unknown }).set === "function" &&
      typeof (value as { entries?: unknown }).entries === "function",
    )
  );
}

function field(raw: unknown, key: string): unknown {
  if (isLoroMap(raw)) return raw.get(key);
  return isRecord(raw) ? raw[key] : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lifecycleFromFields(raw: unknown): ProjectAssetLifecycle {
  const terminalRaw = field(raw, "terminalLifecycle");
  if (terminalRaw !== undefined) {
    const terminal = ProjectAssetLifecycleSchema.safeParse(terminalRaw);
    if (!terminal.success || terminal.data.state !== "purged") {
      throw new Error("Invalid Project Asset terminal lifecycle.");
    }
    return terminal.data;
  }

  // Compatibility with snapshots written during the Stage 2A development window. New writes use
  // one terminal object so independently merged LWW fields cannot synthesize a tombstone that no
  // replica ever committed.
  const purgedAt = nonEmptyString(field(raw, "purgedAt"));
  const deleteOperationId = nonEmptyString(field(raw, "deleteOperationId"));
  const deletedAt = nonEmptyString(field(raw, "deletedAt"));
  if (purgedAt) {
    if (!deleteOperationId || !deletedAt) {
      throw new Error(
        "A purged Project Asset is missing its delete operation or deletion time.",
      );
    }
    return { state: "purged", deleteOperationId, deletedAt, purgedAt };
  }

  const lifecycleState = field(raw, "lifecycleState");
  if (lifecycleState === "trashed") {
    const purgeAfter = nonEmptyString(field(raw, "purgeAfter"));
    if (!deleteOperationId || !deletedAt || !purgeAfter) {
      throw new Error(
        "A trashed Project Asset is missing its recovery-window facts.",
      );
    }
    return { state: "trashed", deleteOperationId, deletedAt, purgeAfter };
  }
  if (lifecycleState === "active") return { state: "active" };
  throw new Error(
    `Invalid Project Asset lifecycle state: ${String(lifecycleState)}`,
  );
}

function sourceFromFields(
  raw: unknown,
  context?: ProjectAssetReadContext,
): unknown {
  const source = field(raw, "source");
  const current = ProjectAssetSourceSchema.safeParse(source);
  if (current.success) return current.data;

  const legacy = LegacyLinkedProjectAssetSourceSchema.safeParse(source);
  if (!legacy.success) return source;
  const { resourceId, origin } = legacy.data;
  let normalized: ProjectAssetSource;
  switch (origin.scope) {
    case "global":
      normalized = {
        kind: "linked",
        resourceId,
        origin: {
          scope: "global",
          libraryId: "personal",
          entryId: origin.entryId,
        },
      };
      break;
    case "catalog":
      normalized = {
        kind: "linked",
        resourceId,
        origin: {
          scope: "catalog",
          catalogId: "legacy",
          entryId: origin.entryId,
        },
      };
      break;
    case "project": {
      const projectId = nonEmptyString(context?.projectId);
      if (!projectId) {
        throw new Error(
          "A legacy Project Asset origin requires the current Project identity.",
        );
      }
      normalized = {
        kind: "linked",
        resourceId,
        origin: {
          scope: "project",
          projectId,
          entryId: origin.entryId,
        },
      };
      break;
    }
  }
  return normalized;
}

function parseProjectAsset(
  id: string,
  raw: unknown,
  context?: ProjectAssetReadContext,
): ProjectAssetEntry | null {
  if (!isRecord(raw) && !isLoroMap(raw)) return null;
  const candidate = {
    id,
    kind: field(raw, "kind"),
    source: sourceFromFields(raw, context),
    lifecycle: lifecycleFromFields(raw),
    ...(field(raw, "createdAt") === undefined
      ? {}
      : { createdAt: field(raw, "createdAt") }),
    ...(nonEmptyString(field(raw, "name")) ? { name: field(raw, "name") } : {}),
    metadata: field(raw, "metadata"),
    ...(field(raw, "provenance") === undefined
      ? {}
      : { provenance: field(raw, "provenance") }),
  };
  const parsed = ProjectAssetEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Invalid Project Asset ${id}: ${parsed.error.issues[0]?.message ?? "invalid entry"}`,
    );
  }
  return parsed.data;
}
function mutationError(
  code: ProjectAssetMutationErrorCode,
  message: string,
  projectAssetId?: string,
): ProjectAssetMutationResult {
  return {
    ok: false,
    error: { code, message, ...(projectAssetId ? { projectAssetId } : {}) },
  };
}

function authorityError(
  version: unknown,
): Extract<ProjectAssetAuthorityResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED_PROJECT_ASSET_AUTHORITY",
      message: `Unsupported Project Asset authority version: ${String(version)}`,
    },
  };
}

export function projectAssetAuthorityVersion(doc: LoroDoc): number | undefined {
  const value = rawProjectAssetAuthorityVersion(doc);
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function rawProjectAssetAuthorityVersion(doc: LoroDoc): unknown {
  const schema = doc.getMap(PROJECT_ASSET_SCHEMA_CONTAINER);
  const versions: number[] = [];
  const legacy = schema.get(PROJECT_ASSET_AUTHORITY_VERSION_KEY);
  if (legacy !== undefined) {
    if (typeof legacy !== "number" || !Number.isInteger(legacy) || legacy < 1)
      return legacy;
    versions.push(legacy);
  }

  const facts = schema.get(PROJECT_ASSET_AUTHORITY_VERSIONS_KEY);
  if (facts !== undefined) {
    if (!isLoroMap(facts)) return facts;
    for (const [key, value] of facts.entries()) {
      const version = Number(key);
      if (
        value !== true ||
        !Number.isInteger(version) ||
        version < 1 ||
        String(version) !== key
      ) {
        return `invalid authority version fact ${key}`;
      }
      versions.push(version);
    }
  }
  return versions.length === 0 ? undefined : Math.max(...versions);
}

function mutationAuthorityError(
  doc: LoroDoc,
): ProjectAssetMutationResult | undefined {
  const version = rawProjectAssetAuthorityVersion(doc);
  if (version === undefined || version === PROJECT_ASSET_AUTHORITY_VERSION)
    return undefined;
  return { ok: false, error: authorityError(version).error };
}

export function markProjectAssetAuthority(
  doc: LoroDoc,
): ProjectAssetAuthorityResult {
  const current = rawProjectAssetAuthorityVersion(doc);
  if (current !== undefined && current !== PROJECT_ASSET_AUTHORITY_VERSION) {
    return authorityError(current);
  }
  doc
    .getMap(PROJECT_ASSET_SCHEMA_CONTAINER)
    .ensureMergeableMap(PROJECT_ASSET_AUTHORITY_VERSIONS_KEY)
    .set(String(PROJECT_ASSET_AUTHORITY_VERSION), true);
  return { ok: true, version: PROJECT_ASSET_AUTHORITY_VERSION };
}

export function readProjectAsset(
  doc: LoroDoc,
  id: string,
  context?: ProjectAssetReadContext,
): ProjectAssetEntry | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  return parseProjectAsset(
    normalizedId,
    doc.getMap(PROJECT_ASSETS_CONTAINER).get(normalizedId),
    context,
  );
}

export function listProjectAssets(
  doc: LoroDoc,
  context?: ProjectAssetReadContext,
): ProjectAssetEntry[] {
  const entries: ProjectAssetEntry[] = [];
  for (const [id, raw] of doc.getMap(PROJECT_ASSETS_CONTAINER).entries()) {
    const entry = parseProjectAsset(id, raw, context);
    if (entry) entries.push(entry);
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function writeEntry(fields: LoroMap, entry: ProjectAssetEntry): void {
  fields.set("kind", entry.kind);
  fields.set("source", entry.source);
  fields.set("metadata", entry.metadata);
  fields.set("lifecycleState", entry.lifecycle.state);
  if (entry.createdAt === undefined) fields.delete("createdAt");
  else fields.set("createdAt", entry.createdAt);
  if (entry.name === undefined) fields.delete("name");
  else fields.set("name", entry.name);
  if (entry.provenance === undefined) fields.delete("provenance");
  else fields.set("provenance", entry.provenance);
  if (entry.lifecycle.state === "trashed") {
    fields.set("deleteOperationId", entry.lifecycle.deleteOperationId);
    fields.set("deletedAt", entry.lifecycle.deletedAt);
    fields.set("purgeAfter", entry.lifecycle.purgeAfter);
  }
  if (entry.lifecycle.state === "purged") {
    fields.set("terminalLifecycle", entry.lifecycle);
  }
}

export function createProjectAsset(
  doc: LoroDoc,
  input: unknown,
): ProjectAssetMutationResult {
  const parsed = ProjectAssetEntrySchema.safeParse(input);
  if (!parsed.success) {
    return mutationError(
      "INVALID_PROJECT_ASSET",
      parsed.error.issues[0]?.message ?? "Invalid Project Asset",
    );
  }
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;
  const entries = doc.getMap(PROJECT_ASSETS_CONTAINER);
  if (entries.get(parsed.data.id) !== undefined) {
    return mutationError(
      "PROJECT_ASSET_EXISTS",
      `Project Asset ${parsed.data.id} already exists.`,
      parsed.data.id,
    );
  }
  writeEntry(entries.ensureMergeableMap(parsed.data.id), parsed.data);
  return { ok: true, entry: parsed.data };
}

function mutableEntry(
  doc: LoroDoc,
  id: string,
): { entry: ProjectAssetEntry; fields: LoroMap } | ProjectAssetMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;
  const normalizedId = id.trim();
  const raw = doc.getMap(PROJECT_ASSETS_CONTAINER).get(normalizedId);
  const entry = parseProjectAsset(normalizedId, raw);
  if (!entry || !isLoroMap(raw)) {
    return mutationError(
      "PROJECT_ASSET_NOT_FOUND",
      `Project Asset ${normalizedId} not found.`,
      normalizedId,
    );
  }
  return { entry, fields: raw };
}

export function trashProjectAsset(
  doc: LoroDoc,
  input: {
    id: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
  },
): ProjectAssetMutationResult {
  const found = mutableEntry(doc, input.id);
  if ("ok" in found) return found;
  if (found.entry.lifecycle.state === "purged") {
    return mutationError(
      "PROJECT_ASSET_PURGED",
      `Project Asset ${input.id} was purged and cannot be trashed again.`,
      input.id,
    );
  }
  if (found.entry.lifecycle.state === "trashed") {
    if (found.entry.lifecycle.deleteOperationId === input.deleteOperationId) {
      return { ok: true, entry: found.entry };
    }
    return mutationError(
      "PROJECT_ASSET_ALREADY_TRASHED",
      `Project Asset ${input.id} is already trashed by another operation.`,
      input.id,
    );
  }
  const lifecycle = ProjectAssetLifecycleSchema.safeParse({
    state: "trashed",
    deleteOperationId: input.deleteOperationId,
    deletedAt: input.deletedAt,
    purgeAfter: input.purgeAfter,
  });
  if (!lifecycle.success) {
    return mutationError(
      "INVALID_PROJECT_ASSET",
      lifecycle.error.issues[0]?.message ?? "Invalid Project Asset lifecycle",
      input.id,
    );
  }
  if (lifecycle.data.state !== "trashed") {
    return mutationError(
      "INVALID_PROJECT_ASSET",
      "Invalid trashed lifecycle.",
      input.id,
    );
  }
  found.fields.set("lifecycleState", "trashed");
  found.fields.set("deleteOperationId", lifecycle.data.deleteOperationId);
  found.fields.set("deletedAt", lifecycle.data.deletedAt);
  found.fields.set("purgeAfter", lifecycle.data.purgeAfter);
  return { ok: true, entry: { ...found.entry, lifecycle: lifecycle.data } };
}

export function restoreProjectAsset(
  doc: LoroDoc,
  id: string,
): ProjectAssetMutationResult {
  const found = mutableEntry(doc, id);
  if ("ok" in found) return found;
  if (found.entry.lifecycle.state === "purged") {
    return mutationError(
      "PROJECT_ASSET_PURGED",
      `Project Asset ${id} was purged and cannot be restored.`,
      id,
    );
  }
  if (found.entry.lifecycle.state === "active") {
    return { ok: true, entry: found.entry };
  }
  found.fields.set("lifecycleState", "active");
  return {
    ok: true,
    entry: { ...found.entry, lifecycle: { state: "active" } },
  };
}

export function purgeProjectAsset(
  doc: LoroDoc,
  input: { id: string; deleteOperationId: string; purgedAt: string },
): ProjectAssetMutationResult {
  const found = mutableEntry(doc, input.id);
  if ("ok" in found) return found;
  if (found.entry.lifecycle.state === "purged") {
    if (found.entry.lifecycle.deleteOperationId === input.deleteOperationId) {
      return { ok: true, entry: found.entry };
    }
    return mutationError(
      "PROJECT_ASSET_DELETE_CONFLICT",
      `Project Asset ${input.id} was purged by another delete operation.`,
      input.id,
    );
  }
  if (found.entry.lifecycle.state !== "trashed") {
    return mutationError(
      "PROJECT_ASSET_NOT_TRASHED",
      `Project Asset ${input.id} must be trashed before it can be purged.`,
      input.id,
    );
  }
  if (found.entry.lifecycle.deleteOperationId !== input.deleteOperationId) {
    return mutationError(
      "PROJECT_ASSET_DELETE_CONFLICT",
      `Project Asset ${input.id} belongs to another delete operation.`,
      input.id,
    );
  }
  const lifecycle = ProjectAssetLifecycleSchema.safeParse({
    state: "purged",
    deleteOperationId: input.deleteOperationId,
    deletedAt: found.entry.lifecycle.deletedAt,
    purgedAt: input.purgedAt,
  });
  if (!lifecycle.success) {
    return mutationError(
      "INVALID_PROJECT_ASSET",
      lifecycle.error.issues[0]?.message ?? "Invalid Project Asset lifecycle",
      input.id,
    );
  }
  if (lifecycle.data.state !== "purged") {
    return mutationError(
      "INVALID_PROJECT_ASSET",
      "Invalid purged lifecycle.",
      input.id,
    );
  }
  // The terminal lifecycle is one grow-only fact. Splitting its operation id, deletion time, and
  // purge time across LWW registers lets a stale Restore + second Trash merge with the first Purge
  // into a tombstone no replica ever wrote. Reads always prefer this whole object.
  found.fields.set("terminalLifecycle", lifecycle.data);
  return { ok: true, entry: { ...found.entry, lifecycle: lifecycle.data } };
}
