import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import {
  ACTION_ASSET_BINDINGS_CONTAINER,
  EDGE_IDENTITY_CONTAINER,
  DOCUMENT_ASSET_REVISIONS_CONTAINER,
  DOCUMENT_ASSET_SCHEMA_CONTAINER,
  DOCUMENT_ATTACHMENTS_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GENERATOR_OUTPUT_COMMITS_CONTAINER,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_SCHEMA_CONTAINER,
  PROJECT_ASSETS_CONTAINER,
  PROJECT_ASSET_SCHEMA_CONTAINER,
  PROJECT_DOCUMENT_ASSETS_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  ACTION_ASSET_BINDING_SCHEMA_CONTAINER,
  PROJECT_PRESENTATION_CONTAINER,
  PROJECT_COVER_ACTION_ID,
  NODE_UPSTREAMS_CONTAINER,
  ACTION_ASSET_BINDING_AUTHORITY_VERSION,
  ActionAssetBindingSchema,
  actionAssetBindingAuthorityVersion,
  DocumentAssetRevisionSchema,
  GeneratorRevisionSchema,
  OutputCommitSchema,
  WORKSPACE_BUNDLE_PROJECT_PATH,
  WorkspaceBundleManifestSchema,
  WorkspacePortableJsonObjectSchema,
  WorkspacePortableSourcePathSchema,
  WorkspaceExportPlanSchema,
  WorkspaceImportCommitRequestSchema,
  WorkspaceImportCommitResponseSchema,
  WorkspaceImportFileUploadReceiptSchema,
  WorkspaceImportSessionSchema,
  WorkspaceImportStartSchema,
  listProjectAssets,
  readActionAssetBinding,
  readDocumentAssetRevision,
  readDocumentAttachment,
  readGeneratorRevision,
  readOutputCommit,
  parseDocumentBody,
  normalizeProjectTimelinePersistenceState,
  projectDirectorStageRevisionId,
  projectTimelineRevisionId,
  projectVisibleNodeData,
  readProjectActionRun,
  readProjectAsset,
  readProjectDocumentAsset,
  readProjectDirectorStage,
  readProjectGenerator,
  readProjectTimeline,
  getDocumentKindDefinition,
  type GeneratorDefinitionRef,
  type Resource,
  type TextAppliedRevision,
  type WorkspaceBundleFileRole,
  type WorkspaceBundleManifest,
  type WorkspaceExportPlan,
  type WorkspaceImportCommitRequest,
  type WorkspaceImportCommitResponse,
  type WorkspaceImportFileSlot,
  type WorkspaceImportFileUploadReceipt,
  type WorkspaceImportSession,
  type WorkspaceImportStart,
  type WorkspaceTransferFileCapability,
} from "@clash/shared-types";
import { PROJECT_ASSET_RENDER_CANVAS_ID } from "@clash/shared-types/timeline-contract";
import {
  canonicalMetadataBody,
  readMetadataBody,
  storeMetadataBody,
  workspaceBundleDigest,
} from "@clash/shared-runtime";
import { LoroDoc, LoroMap } from "loro-crdt";

import { createLocalMetadataStore } from "./local-metadata-store.js";
import { createLocalResourceStore } from "./local-resource-store.js";
import type { LocalAssetInspectionService } from "./local-asset-inspections.js";
import {
  storeTextRevisionContentBlob,
  textRevisionContentBlobPath,
  textRevisionContentHash,
} from "./text-revision-content.js";

type WorkspaceSource = WorkspaceBundleManifest["source"];
type WorkspaceContent = WorkspaceBundleManifest["content"];
type WorkspaceSemanticRequirements =
  WorkspaceBundleManifest["semanticRequirements"];

export interface LocalWorkspaceProjectAuthority {
  /** Runs behind the live Project room's serial operation queue. */
  inspect<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T>;
}

export interface LocalWorkspaceImportAuthority {
  install<T>(
    projectId: string,
    reservationId: string,
    snapshot: Uint8Array,
    commitReceiverAuthority: () => Promise<T>,
  ): Promise<T>;
  reconcileCommittedImport(
    projectId: string,
    reservationId: string,
    snapshotSha256: string,
  ): Promise<void>;
}

/**
 * Cross-store Project lease for operations whose checkpoint includes both the
 * live Loro room and a Host-private index. Loro mutations remain serialized by
 * the room itself; text apply and Workspace export additionally share this
 * lease so an export cannot pair a pre-apply snapshot with post-apply history.
 */
export class LocalWorkspaceProjectOperationLease {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(projectIdInput: string, task: () => Promise<T>): Promise<T> {
    const projectId = projectIdInput.trim();
    if (!projectId) throw new Error("Project operation lease requires an id.");
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(projectId, settled);
    try {
      return await run;
    } finally {
      if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
    }
  }
}

export type WorkspaceQuiescenceBlocker = {
  kind: "generator-action-run" | "project-node";
  id: string;
  status: string;
};

export type LocalWorkspaceTransferErrorCode =
  | "WORKSPACE_PROJECT_NOT_FOUND"
  | "WORKSPACE_PROJECT_DELETED"
  | "WORKSPACE_NOT_QUIESCENT"
  | "WORKSPACE_AUTHORITY_INVALID"
  | "WORKSPACE_MIGRATION_REQUIRED"
  | "WORKSPACE_CONTENT_MISSING"
  | "WORKSPACE_CONTENT_MISMATCH"
  | "WORKSPACE_EXPORT_NOT_FOUND"
  | "WORKSPACE_EXPORT_EXPIRED"
  | "WORKSPACE_EXPORT_FILE_NOT_FOUND"
  | "WORKSPACE_IMPORT_NOT_AVAILABLE"
  | "WORKSPACE_IMPORT_NOT_FOUND"
  | "WORKSPACE_IMPORT_EXPIRED"
  | "WORKSPACE_IMPORT_FILE_NOT_FOUND"
  | "WORKSPACE_IMPORT_FILE_MISSING"
  | "WORKSPACE_IMPORT_PROJECT_EXISTS";

export class LocalWorkspaceTransferError extends Error {
  override name = "LocalWorkspaceTransferError";

  constructor(
    readonly code: LocalWorkspaceTransferErrorCode,
    message: string,
    readonly blockers?: WorkspaceQuiescenceBlocker[],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type LocalWorkspaceExportFile = WorkspaceTransferFileCapability;
export type LocalWorkspaceExportPlan = WorkspaceExportPlan;

type Payload = LocalWorkspaceExportFile & {
  load(): Promise<Uint8Array>;
  open?: () => Promise<Readable>;
};

interface ExportSession {
  plan: LocalWorkspaceExportPlan;
  payloads: Map<string, Payload>;
  createdAt: number;
  expiresAt: number;
}

export type LocalWorkspaceImportFile = WorkspaceImportFileSlot;
export type LocalWorkspaceImportSession = WorkspaceImportSession;

interface ImportPayloadSlot {
  descriptor: WorkspaceBundleManifest["files"][number];
  fileId: string;
  stagedPath?: string;
}

interface ImportSessionState {
  public: LocalWorkspaceImportSession;
  manifest: WorkspaceBundleManifest;
  slots: Map<string, ImportPayloadSlot>;
  createdAt: number;
}

type ExportClosure = {
  snapshot: Uint8Array;
  resourceRequirements: Array<{
    resourceId: string;
    kind: Resource["kind"];
    assertedContentType?: string;
    assetAssertions: Array<{
      projectAssetId: string;
      metadata: Record<string, unknown>;
    }>;
  }>;
  documentRevisions: Array<{
    documentKind: string;
    schemaVersion: number;
    body: {
      digest: string;
      byteLength: number;
      contentType: string;
    };
  }>;
  generatorDefinitions: GeneratorDefinitionRef[];
  modelIds: string[];
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.slice()
    : new Uint8Array(bytes);
}

function isLoroMap(value: unknown): value is LoroMap {
  return (
    value instanceof LoroMap ||
    Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as { get?: unknown }).get === "function" &&
      typeof (value as { entries?: unknown }).entries === "function",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorityInvalid(message: string, cause?: unknown): never {
  throw new LocalWorkspaceTransferError(
    "WORKSPACE_AUTHORITY_INVALID",
    message,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function requireParsedAuthority<T>(value: T | null, label: string): T {
  if (value === null) authorityInvalid(`Invalid ${label} authority entry.`);
  return value;
}

function authorityRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (isLoroMap(value)) return Object.fromEntries(value.entries());
  if (isRecord(value)) return value;
  return authorityInvalid(`${label} must be an object authority entry.`);
}

function assertAuthorityFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    authorityInvalid(
      `${label} contains non-portable fields: ${unknown.sort().join(", ")}.`,
    );
  }
}

function assertPortableJson(value: unknown, label: string): void {
  const parsed = WorkspacePortableJsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    authorityInvalid(`${label} contains machine-private JSON.`, parsed.error);
  }
}

function assertPortableSnapshotHistory(snapshot: Uint8Array): void {
  const shallow = new LoroDoc();
  try {
    shallow.import(snapshot);
  } catch (error) {
    authorityInvalid(
      "Portable Loro shallow snapshot cannot be audited.",
      error,
    );
  }
  const updates = shallow.exportJsonUpdates() as unknown;
  if (!isRecord(updates) || !Array.isArray(updates.changes)) {
    authorityInvalid(
      "Portable Loro shallow snapshot has invalid JSON updates.",
    );
  }
  const mapRegisterOperations = new Map<string, number>();
  for (const [changeIndex, change] of updates.changes.entries()) {
    if (!isRecord(change) || !Array.isArray(change.ops)) {
      authorityInvalid(
        `Portable Loro shallow snapshot change ${changeIndex} is invalid.`,
      );
    }
    for (const [operationIndex, operation] of change.ops.entries()) {
      if (!isRecord(operation) || !isRecord(operation.content)) {
        authorityInvalid(
          `Portable Loro shallow snapshot operation ${changeIndex}/${operationIndex} is invalid.`,
        );
      }
      const content = operation.content;
      if (
        typeof operation.container === "string" &&
        operation.container.endsWith(":Map") &&
        typeof content.key === "string" &&
        (content.type === "insert" || content.type === "delete")
      ) {
        const register = `${operation.container}\u0000${content.key}`;
        mapRegisterOperations.set(
          register,
          (mapRegisterOperations.get(register) ?? 0) + 1,
        );
      }
      if (content.type !== "insert") continue;
      const candidate =
        typeof content.key === "string"
          ? { [content.key]: content.value }
          : Object.prototype.hasOwnProperty.call(content, "value")
            ? { value: content.value }
            : undefined;
      if (candidate !== undefined) {
        assertPortableJson(
          candidate,
          `Portable Loro shallow snapshot operation ${changeIndex}/${operationIndex}`,
        );
      }
    }
  }
  if ([...mapRegisterOperations.values()].some((count) => count > 1)) {
    authorityInvalid(
      "Portable Loro shallow snapshot contains an unresolved Map register conflict.",
    );
  }
}

function validateVersionFacts(value: unknown, label: string): void {
  if (!isLoroMap(value)) authorityInvalid(`${label} must be a version map.`);
  for (const [version, marker] of value.entries()) {
    if (version !== "1" || marker !== true) {
      authorityInvalid(`${label} contains an unsupported authority version.`);
    }
  }
}

function validateAuthoritySchemaMaps(doc: LoroDoc): void {
  const specifications = [
    {
      container: PROJECT_ASSET_SCHEMA_CONTAINER,
      allowed: ["authorityVersion", "authorityVersions"],
      legacy: true,
    },
    {
      container: ACTION_ASSET_BINDING_SCHEMA_CONTAINER,
      allowed: ["authorityVersion", "authorityVersions"],
      legacy: true,
    },
    {
      container: GENERATOR_SCHEMA_CONTAINER,
      allowed: ["authorityVersions"],
      legacy: false,
    },
    {
      container: DOCUMENT_ASSET_SCHEMA_CONTAINER,
      allowed: ["authorityVersions"],
      legacy: false,
    },
  ] as const;
  for (const specification of specifications) {
    const schema = doc.getMap(specification.container);
    assertAuthorityFields(
      Object.fromEntries(schema.entries()),
      specification.allowed,
      `${specification.container} schema`,
    );
    const legacy = schema.get("authorityVersion");
    if (legacy !== undefined && (!specification.legacy || legacy !== 1)) {
      authorityInvalid(
        `${specification.container} contains an unsupported authority version.`,
      );
    }
    const versions = schema.get("authorityVersions");
    if (versions !== undefined) {
      validateVersionFacts(versions, `${specification.container} versions`);
    }
  }
  const graph = doc.getMap("graphSchema");
  assertAuthorityFields(
    Object.fromEntries(graph.entries()),
    ["edgeIdentityVersion"],
    "graphSchema schema",
  );
  const graphVersion = graph.get("edgeIdentityVersion");
  if (graphVersion !== undefined && graphVersion !== 1) {
    authorityInvalid("graphSchema contains an unsupported authority version.");
  }
}

function nonEmptyAuthorityString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nodeCanvasId(rawNode: Record<string, unknown>): string {
  return nonEmptyAuthorityString(rawNode.canvasId) ? rawNode.canvasId : "main";
}

function requirePortableAssetReference(
  doc: LoroDoc,
  projectAssetId: string,
  label: string,
): void {
  const asset = readProjectAsset(doc, projectAssetId);
  if (!asset || asset.lifecycle.state === "purged") {
    authorityInvalid(`${label} points to a missing or purged Project Asset.`);
  }
}

function validateActionAssetBindings(doc: LoroDoc): void {
  const bindings = doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER);
  if (
    bindings.size > 0 &&
    actionAssetBindingAuthorityVersion(doc) !==
      ACTION_ASSET_BINDING_AUTHORITY_VERSION
  ) {
    authorityInvalid(
      "Action Asset binding authority version is missing or unsupported.",
    );
  }
  for (const [bindingId, rawBinding] of bindings.entries()) {
    const raw = authorityRecord(
      rawBinding,
      `Action Asset binding ${bindingId}`,
    );
    assertAuthorityFields(
      raw,
      ["owner", "direction", "slot", "projectAssetId", "role", "unbound"],
      `Action Asset binding ${bindingId}`,
    );
    if (raw.unbound !== undefined && raw.unbound !== true) {
      authorityInvalid(
        `Action Asset binding ${bindingId} has an invalid tombstone.`,
      );
    }
    const parsed = ActionAssetBindingSchema.safeParse({
      id: bindingId,
      owner: raw.owner,
      direction: raw.direction,
      slot: raw.slot,
      projectAssetId: raw.projectAssetId,
      ...(raw.role === undefined ? {} : { role: raw.role }),
    });
    if (!parsed.success) {
      authorityInvalid(
        `Action Asset binding ${bindingId} is invalid.`,
        parsed.error,
      );
    }
    if (raw.unbound === true) continue;
    let active;
    try {
      active = readActionAssetBinding(doc, bindingId);
    } catch (error) {
      authorityInvalid(`Action Asset binding ${bindingId} is invalid.`, error);
    }
    if (!active || !isDeepStrictEqual(active, parsed.data)) {
      authorityInvalid(
        `Action Asset binding ${bindingId} has a non-canonical authority entry.`,
      );
    }
    const target = readProjectAsset(doc, parsed.data.projectAssetId);
    if (
      !target ||
      target.lifecycle.state === "purged" ||
      (parsed.data.direction === "input" && target.lifecycle.state !== "active")
    ) {
      authorityInvalid(
        `Action Asset binding ${bindingId} points to an unavailable Project Asset.`,
      );
    }
  }
}

function validateCanvasMetadata(doc: LoroDoc): void {
  for (const [canvasId, rawCanvas] of doc.getMap("canvases").entries()) {
    const canvas = authorityRecord(rawCanvas, `Canvas ${canvasId}`);
    assertAuthorityFields(
      canvas,
      ["id", "name", "position"],
      `Canvas ${canvasId}`,
    );
    if (
      canvas.id !== canvasId ||
      !nonEmptyAuthorityString(canvas.name) ||
      typeof canvas.position !== "number" ||
      !Number.isFinite(canvas.position)
    ) {
      authorityInvalid(`Canvas ${canvasId} is invalid.`);
    }
  }
}

const NODE_AUTHORITY_FIELDS = [
  "id",
  "canvasId",
  "type",
  "data",
  "position",
  "parentId",
  "parent_id",
  "extent",
  "width",
  "height",
  "style",
  "upstream",
] as const;

const UPSTREAM_AUTHORITY_FIELDS = [
  "nodeId",
  "edgeId",
  "type",
  "sourceHandle",
  "targetHandle",
] as const;

function validateRawUpstreamRef(
  value: unknown,
  edgeId: string,
  label: string,
): Record<string, unknown> {
  const ref = authorityRecord(value, label);
  assertAuthorityFields(ref, UPSTREAM_AUTHORITY_FIELDS, label);
  if (
    !nonEmptyAuthorityString(ref.nodeId) ||
    ref.edgeId !== edgeId ||
    (ref.type !== undefined && !nonEmptyAuthorityString(ref.type)) ||
    (ref.sourceHandle !== undefined && typeof ref.sourceHandle !== "string") ||
    (ref.targetHandle !== undefined && typeof ref.targetHandle !== "string")
  ) {
    authorityInvalid(`${label} is invalid.`);
  }
  return ref;
}

function validateCanvasNodes(
  doc: LoroDoc,
): Map<string, Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>();
  const canvasIds = new Set(
    [...doc.getMap("canvases").keys()].map((id) => id.trim()),
  );
  for (const [nodeId, rawNode] of doc.getMap("nodes").entries()) {
    const node = authorityRecord(rawNode, `Canvas node ${nodeId}`);
    assertAuthorityFields(node, NODE_AUTHORITY_FIELDS, `Canvas node ${nodeId}`);
    if (
      (node.id !== undefined && node.id !== nodeId) ||
      !nonEmptyAuthorityString(node.type) ||
      !isRecord(node.data)
    ) {
      authorityInvalid(`Canvas node ${nodeId} is invalid.`);
    }
    const canvasId = nodeCanvasId(node);
    if (
      canvasId !== PROJECT_ASSET_RENDER_CANVAS_ID &&
      (canvasIds.size > 0 ? !canvasIds.has(canvasId) : canvasId !== "main")
    ) {
      authorityInvalid(
        `Canvas node ${nodeId} points to missing Canvas ${canvasId}.`,
      );
    }
    if (node.position !== undefined) {
      const position = authorityRecord(
        node.position,
        `Canvas node ${nodeId} position`,
      );
      assertAuthorityFields(
        position,
        ["x", "y"],
        `Canvas node ${nodeId} position`,
      );
      if (
        typeof position.x !== "number" ||
        !Number.isFinite(position.x) ||
        typeof position.y !== "number" ||
        !Number.isFinite(position.y)
      ) {
        authorityInvalid(`Canvas node ${nodeId} has an invalid position.`);
      }
    }
    if (
      !isDeepStrictEqual(
        node.data,
        projectVisibleNodeData(node.data as Record<string, unknown>),
      )
    ) {
      authorityInvalid(
        `Canvas node ${nodeId} contains machine-private projection fields.`,
      );
    }
    assertPortableJson(node.data, `Canvas node ${nodeId} data`);
    if (node.style !== undefined) {
      assertPortableJson(node.style, `Canvas node ${nodeId} style`);
    }
    if (Array.isArray(node.upstream)) {
      for (const rawRef of node.upstream) {
        const candidate = authorityRecord(
          rawRef,
          `Canvas node ${nodeId} legacy upstream`,
        );
        if (!nonEmptyAuthorityString(candidate.edgeId)) {
          authorityInvalid(
            `Canvas node ${nodeId} has an invalid legacy upstream.`,
          );
        }
        validateRawUpstreamRef(
          candidate,
          candidate.edgeId,
          `Canvas node ${nodeId} legacy upstream ${candidate.edgeId}`,
        );
      }
    } else if (node.upstream !== undefined) {
      authorityInvalid(`Canvas node ${nodeId} has an invalid legacy upstream.`);
    }
    nodes.set(nodeId, node);
  }
  for (const [nodeId, node] of nodes) {
    const parentId = nonEmptyAuthorityString(node.parentId)
      ? node.parentId
      : nonEmptyAuthorityString(node.parent_id)
        ? node.parent_id
        : undefined;
    if (parentId && !nodes.has(parentId)) {
      authorityInvalid(
        `Canvas node ${nodeId} points to missing parent ${parentId}.`,
      );
    }
    const projectAssetId = isRecord(node.data) ? node.data.assetId : undefined;
    if (
      (node.type === "image" ||
        node.type === "video" ||
        node.type === "audio") &&
      nonEmptyAuthorityString(projectAssetId)
    ) {
      requirePortableAssetReference(
        doc,
        projectAssetId,
        `Canvas node ${nodeId}`,
      );
    }
  }
  return nodes;
}

function validateCanvasGraph(
  doc: LoroDoc,
  nodes: ReadonlyMap<string, Record<string, unknown>>,
): void {
  const refsByEdge = new Map<string, { target: string; source: string }>();
  for (const [targetId, rawRefs] of doc
    .getMap(NODE_UPSTREAMS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawRefs)) {
      authorityInvalid(`Node upstream container ${targetId} is invalid.`);
    }
    if (rawRefs.size === 0) continue;
    if (!nodes.has(targetId)) {
      authorityInvalid(
        `Node upstream container ${targetId} has no target node.`,
      );
    }
    for (const [edgeId, rawRef] of rawRefs.entries()) {
      const ref = validateRawUpstreamRef(
        rawRef,
        edgeId,
        `Node upstream ${targetId}/${edgeId}`,
      );
      const sourceId = ref.nodeId as string;
      if (!nodes.has(sourceId)) {
        authorityInvalid(
          `Node upstream ${targetId}/${edgeId} has a missing source.`,
        );
      }
      if (
        nodeCanvasId(nodes.get(sourceId)!) !==
        nodeCanvasId(nodes.get(targetId)!)
      ) {
        authorityInvalid(
          `Node upstream ${targetId}/${edgeId} crosses Canvases.`,
        );
      }
      if (refsByEdge.has(edgeId)) {
        authorityInvalid(
          `Node upstream edge ${edgeId} has multiple downstream owners.`,
        );
      }
      refsByEdge.set(edgeId, { target: targetId, source: sourceId });
    }
  }

  for (const [edgeId, rawIdentity] of doc
    .getMap(EDGE_IDENTITY_CONTAINER)
    .entries()) {
    const identity = authorityRecord(rawIdentity, `Edge identity ${edgeId}`);
    if (identity.deleted === true) {
      assertAuthorityFields(identity, ["deleted"], `Edge identity ${edgeId}`);
      if (refsByEdge.has(edgeId)) {
        authorityInvalid(
          `Deleted edge identity ${edgeId} still owns an upstream ref.`,
        );
      }
      continue;
    }
    assertAuthorityFields(identity, ["target"], `Edge identity ${edgeId}`);
    if (!nonEmptyAuthorityString(identity.target)) {
      authorityInvalid(`Edge identity ${edgeId} is invalid.`);
    }
    const ref = refsByEdge.get(edgeId);
    if (!ref || ref.target !== identity.target) {
      authorityInvalid(
        `Edge identity ${edgeId} has no matching downstream ref.`,
      );
    }
  }

  const identities = doc.getMap(EDGE_IDENTITY_CONTAINER);
  for (const [edgeId, ref] of refsByEdge) {
    const identity = authorityRecord(
      identities.get(edgeId),
      `Edge identity ${edgeId}`,
    );
    if (identity.target !== ref.target) {
      authorityInvalid(`Node upstream ${edgeId} has no active edge identity.`);
    }
  }
  if (identities.size > 0 || refsByEdge.size > 0) {
    if (doc.getMap("graphSchema").get("edgeIdentityVersion") !== 1) {
      authorityInvalid(
        "Canvas graph authority version is missing or unsupported.",
      );
    }
    if (doc.getMap("edges").size > 0) {
      authorityInvalid(
        "Canvas graph mixes legacy edges with node-owned edge identity authority.",
      );
    }
  }

  for (const [edgeId, rawEdge] of doc.getMap("edges").entries()) {
    const edge = authorityRecord(rawEdge, `Legacy Canvas edge ${edgeId}`);
    assertAuthorityFields(
      edge,
      ["id", "source", "target", "type", "sourceHandle", "targetHandle"],
      `Legacy Canvas edge ${edgeId}`,
    );
    if (
      (edge.id !== undefined && edge.id !== edgeId) ||
      !nonEmptyAuthorityString(edge.source) ||
      !nonEmptyAuthorityString(edge.target) ||
      !nodes.has(edge.source) ||
      !nodes.has(edge.target) ||
      nodeCanvasId(nodes.get(edge.source)!) !==
        nodeCanvasId(nodes.get(edge.target)!)
    ) {
      authorityInvalid(`Legacy Canvas edge ${edgeId} is invalid.`);
    }
  }
}

function validateTimelineAuthority(
  doc: LoroDoc,
  nodes: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const [timelineId, rawTimeline] of doc.getMap("timelines").entries()) {
    const raw = authorityRecord(rawTimeline, `Timeline ${timelineId}`);
    assertAuthorityFields(
      raw,
      ["id", "name", "owner", "revision", "state", "revisionId"],
      `Timeline ${timelineId}`,
    );
    if (raw.id !== undefined && raw.id !== timelineId) {
      authorityInvalid(`Timeline ${timelineId} has a mismatched id.`);
    }
    if (raw.revision !== undefined) {
      const revision = authorityRecord(
        raw.revision,
        `Timeline ${timelineId} revision`,
      );
      assertAuthorityFields(
        revision,
        ["revisionId", "state"],
        `Timeline ${timelineId} revision`,
      );
      if (
        !nonEmptyAuthorityString(revision.revisionId) ||
        !Object.prototype.hasOwnProperty.call(revision, "state")
      ) {
        authorityInvalid(`Timeline ${timelineId} has an invalid revision.`);
      }
    } else if (
      !Object.prototype.hasOwnProperty.call(raw, "state") ||
      !nonEmptyAuthorityString(raw.revisionId)
    ) {
      authorityInvalid(
        `Timeline ${timelineId} has an invalid legacy revision.`,
      );
    }
    const timeline = readProjectTimeline(doc, timelineId);
    if (!timeline) authorityInvalid(`Timeline ${timelineId} is invalid.`);
    if (raw.name !== undefined && !nonEmptyAuthorityString(raw.name)) {
      authorityInvalid(`Timeline ${timelineId} has an invalid name.`);
    }
    const owner =
      raw.owner === undefined
        ? { kind: "project" }
        : authorityRecord(raw.owner, `Timeline ${timelineId} owner`);
    if (owner.kind === "project") {
      assertAuthorityFields(owner, ["kind"], `Timeline ${timelineId} owner`);
    } else if (
      owner.kind === "canvas-action" &&
      nonEmptyAuthorityString(owner.canvasId) &&
      nonEmptyAuthorityString(owner.actionNodeId)
    ) {
      assertAuthorityFields(
        owner,
        ["kind", "canvasId", "actionNodeId"],
        `Timeline ${timelineId} owner`,
      );
      const ownerNode = nodes.get(owner.actionNodeId);
      if (
        !ownerNode ||
        nodeCanvasId(ownerNode) !== owner.canvasId ||
        ownerNode.type !== "video-editor" ||
        !isRecord(ownerNode.data) ||
        ownerNode.data.timelineId !== timelineId
      ) {
        authorityInvalid(`Timeline ${timelineId} has an invalid Canvas owner.`);
      }
    } else {
      authorityInvalid(`Timeline ${timelineId} has an invalid owner.`);
    }
    const normalized = normalizeProjectTimelinePersistenceState(timeline.state);
    if (
      !normalized.ok ||
      !isDeepStrictEqual(normalized.state, timeline.state)
    ) {
      authorityInvalid(
        `Timeline ${timelineId} contains machine-private media projection fields.`,
        normalized.ok ? undefined : new Error(normalized.error),
      );
    }
    assertPortableJson(timeline.state, `Timeline ${timelineId} state`);
    if (
      timeline.revisionId !==
      projectTimelineRevisionId(timelineId, timeline.state)
    ) {
      authorityInvalid(`Timeline ${timelineId} revision identity is invalid.`);
    }
    if (isRecord(timeline.state) && Array.isArray(timeline.state.tracks)) {
      for (const track of timeline.state.tracks) {
        if (!isRecord(track) || !Array.isArray(track.items)) continue;
        for (const item of track.items) {
          if (isRecord(item) && nonEmptyAuthorityString(item.assetId)) {
            requirePortableAssetReference(
              doc,
              item.assetId,
              `Timeline ${timelineId} item ${String(item.id ?? "<unknown>")}`,
            );
          }
        }
      }
    }
  }
}

function validateDirectorAuthority(
  doc: LoroDoc,
  nodes: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const [stageId, rawStage] of doc.getMap("directorStages").entries()) {
    const raw = authorityRecord(rawStage, `Director stage ${stageId}`);
    assertAuthorityFields(
      raw,
      ["id", "name", "owner", "revision"],
      `Director stage ${stageId}`,
    );
    if (raw.id !== undefined && raw.id !== stageId) {
      authorityInvalid(`Director stage ${stageId} has a mismatched id.`);
    }
    const revision = authorityRecord(
      raw.revision,
      `Director stage ${stageId} revision`,
    );
    assertAuthorityFields(
      revision,
      ["revisionId", "state"],
      `Director stage ${stageId} revision`,
    );
    if (!nonEmptyAuthorityString(revision.revisionId)) {
      authorityInvalid(`Director stage ${stageId} has an invalid revision id.`);
    }
    const stage = readProjectDirectorStage(doc, stageId);
    if (!stage || !isDeepStrictEqual(stage.state, revision.state)) {
      authorityInvalid(
        `Director stage ${stageId} has invalid or non-portable state.`,
      );
    }
    assertPortableJson(stage.state, `Director stage ${stageId} state`);
    if (
      stage.revisionId !== projectDirectorStageRevisionId(stageId, stage.state)
    ) {
      authorityInvalid(
        `Director stage ${stageId} revision identity is invalid.`,
      );
    }
    const owner =
      raw.owner === undefined
        ? { kind: "project" }
        : authorityRecord(raw.owner, `Director stage ${stageId} owner`);
    if (owner.kind === "project") {
      assertAuthorityFields(owner, ["kind"], `Director stage ${stageId} owner`);
    } else if (
      owner.kind === "canvas-action" &&
      nonEmptyAuthorityString(owner.canvasId) &&
      nonEmptyAuthorityString(owner.actionNodeId)
    ) {
      assertAuthorityFields(
        owner,
        ["kind", "canvasId", "actionNodeId"],
        `Director stage ${stageId} owner`,
      );
      const ownerNode = nodes.get(owner.actionNodeId);
      if (
        !ownerNode ||
        nodeCanvasId(ownerNode) !== owner.canvasId ||
        ownerNode.type !== "director-stage" ||
        !isRecord(ownerNode.data) ||
        ownerNode.data.stageId !== stageId
      ) {
        authorityInvalid(
          `Director stage ${stageId} has an invalid Canvas owner.`,
        );
      }
    } else {
      authorityInvalid(`Director stage ${stageId} has an invalid owner.`);
    }
    const assetIds = [
      stage.state.scene.environmentAssetId,
      ...stage.state.objects.flatMap((object) =>
        object.kind === "model" ? [object.model.assetId] : [],
      ),
      ...(stage.state.motionAssets ?? []).map((motion) => motion.assetId),
    ];
    for (const assetId of assetIds) {
      if (!assetId || assetId.startsWith("builtin:")) continue;
      requirePortableAssetReference(doc, assetId, `Director stage ${stageId}`);
    }
  }
}

function validateProjectPresentation(doc: LoroDoc): void {
  const presentation = Object.fromEntries(
    doc.getMap(PROJECT_PRESENTATION_CONTAINER).entries(),
  );
  assertAuthorityFields(
    presentation,
    ["coverBindingId"],
    "Project presentation",
  );
  if (presentation.coverBindingId === undefined) return;
  if (!nonEmptyAuthorityString(presentation.coverBindingId)) {
    authorityInvalid("Project presentation has an invalid cover binding id.");
  }
  const binding = readActionAssetBinding(doc, presentation.coverBindingId);
  if (
    !binding ||
    binding.owner.kind !== "draft" ||
    binding.owner.actionId !== PROJECT_COVER_ACTION_ID ||
    binding.direction !== "input" ||
    binding.slot !== "cover" ||
    binding.role !== "primary" ||
    readProjectAsset(doc, binding.projectAssetId)?.lifecycle.state !== "active"
  ) {
    authorityInvalid(
      "Project presentation points to an invalid cover binding.",
    );
  }
}

const PORTABLE_PROJECT_ROOT_CONTAINERS = new Set([
  "actionAssetBindings",
  "actionAssetBindingSchema",
  "canvases",
  "customActions",
  "directorStages",
  "documentAssetRevisions",
  "documentAssetSchema",
  "documentAttachments",
  "edgeIdentity",
  "edges",
  "generatorActionRuns",
  "generatorOutputCommits",
  "generatorRevisions",
  "generatorSchema",
  "graphSchema",
  "nodeUpstreams",
  "nodes",
  "projectAssets",
  "projectAssetSchema",
  "projectDocumentAssets",
  "projectGenerators",
  "projectPresentation",
  "tasks",
  "timelines",
]);

function validatePortableProjectSurfaces(doc: LoroDoc): void {
  const unsupportedRoots = Object.keys(doc.toJSON())
    .filter((name) => !PORTABLE_PROJECT_ROOT_CONTAINERS.has(name))
    .sort();
  if (unsupportedRoots.length > 0) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_MIGRATION_REQUIRED",
      `Workspace contains unsupported Project authority containers that cannot be shared safely: ${unsupportedRoots.join(", ")}.`,
    );
  }
  const legacyPrivateTasks = [...doc.getMap("tasks").keys()].sort();
  if (legacyPrivateTasks.length > 0) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_MIGRATION_REQUIRED",
      `Workspace contains legacy owner-private task state that cannot be shared: ${legacyPrivateTasks.join(", ")}.`,
    );
  }
  const legacyCustomActions = [...doc.getMap("customActions").keys()].sort();
  if (legacyCustomActions.length > 0) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_MIGRATION_REQUIRED",
      `Workspace contains legacy custom Action runtime definitions that must migrate to Generator v2: ${legacyCustomActions.join(", ")}.`,
    );
  }
  validateAuthoritySchemaMaps(doc);
  validateCanvasMetadata(doc);
  const nodes = validateCanvasNodes(doc);
  validateCanvasGraph(doc, nodes);
  validateTimelineAuthority(doc, nodes);
  validateDirectorAuthority(doc, nodes);
  validateProjectPresentation(doc);
}

function validateInputTarget(
  doc: LoroDoc,
  target: unknown,
  label: string,
): void {
  if (!isRecord(target))
    authorityInvalid(`${label} has an invalid input target.`);
  if (target.kind === "media") {
    const asset =
      typeof target.projectAssetId === "string"
        ? readProjectAsset(doc, target.projectAssetId)
        : null;
    if (!asset || asset.lifecycle.state === "purged") {
      authorityInvalid(`${label} points to a missing or purged Project Asset.`);
    }
    return;
  }
  if (target.kind === "document") {
    if (
      typeof target.documentAssetId !== "string" ||
      typeof target.revisionId !== "string" ||
      !readDocumentAssetRevision(doc, {
        documentAssetId: target.documentAssetId,
        revisionId: target.revisionId,
      })
    ) {
      authorityInvalid(`${label} points to a missing Document revision.`);
    }
    return;
  }
  if (
    typeof target.generatorId !== "string" ||
    typeof target.generatorRevisionId !== "string" ||
    !readGeneratorRevision(doc, {
      generatorId: target.generatorId,
      generatorRevisionId: target.generatorRevisionId,
    })
  ) {
    authorityInvalid(`${label} points to a missing Generator revision.`);
  }
}

function generatorSortKey(ref: GeneratorDefinitionRef): string {
  return `${ref.pluginId}\u0000${ref.definitionId}\u0000${ref.version}\u0000${ref.schemaHash}`;
}

function validateAndCollectProject(doc: LoroDoc): ExportClosure {
  const blockers: WorkspaceQuiescenceBlocker[] = [];
  const resources = new Map<
    string,
    ExportClosure["resourceRequirements"][number]
  >();
  const modelIds = new Set<string>();

  for (const [id] of doc.getMap(PROJECT_ASSETS_CONTAINER).entries()) {
    const rawAsset = authorityRecord(
      doc.getMap(PROJECT_ASSETS_CONTAINER).get(id),
      `Project Asset ${id}`,
    );
    assertAuthorityFields(
      rawAsset,
      [
        "kind",
        "source",
        "metadata",
        "lifecycleState",
        "createdAt",
        "name",
        "provenance",
        "deleteOperationId",
        "deletedAt",
        "purgeAfter",
        "purgedAt",
        "terminalLifecycle",
      ],
      `Project Asset ${id}`,
    );
    let asset;
    try {
      asset = requireParsedAuthority(
        readProjectAsset(doc, id),
        `Project Asset ${id}`,
      );
    } catch (error) {
      if (error instanceof LocalWorkspaceTransferError) throw error;
      authorityInvalid(`Invalid Project Asset ${id} authority entry.`, error);
    }
    assertPortableJson(asset.metadata, `Project Asset ${id} metadata`);
    if (asset.provenance?.model) modelIds.add(asset.provenance.model);
    if (asset.lifecycle.state === "purged") continue;
    const existing = resources.get(asset.source.resourceId);
    const candidate = {
      resourceId: asset.source.resourceId,
      kind: asset.kind,
      ...(asset.metadata.contentType
        ? { assertedContentType: asset.metadata.contentType }
        : {}),
      assetAssertions: [{ projectAssetId: asset.id, metadata: asset.metadata }],
    };
    if (
      existing &&
      (existing.kind !== candidate.kind ||
        existing.assertedContentType !== candidate.assertedContentType)
    ) {
      authorityInvalid(
        `Project Assets disagree about immutable Resource ${asset.source.resourceId}.`,
      );
    }
    if (existing) existing.assetAssertions.push(...candidate.assetAssertions);
    else resources.set(asset.source.resourceId, candidate);
  }

  validateActionAssetBindings(doc);
  validatePortableProjectSurfaces(doc);

  const generatorDefinitions = new Map<string, GeneratorDefinitionRef>();
  for (const [generatorId, rawRevisions] of doc
    .getMap(GENERATOR_REVISIONS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawRevisions)) {
      authorityInvalid(
        `Generator ${generatorId} has an invalid revision container.`,
      );
    }
    for (const [revisionId, rawRevision] of rawRevisions.entries()) {
      const parsed = GeneratorRevisionSchema.safeParse(rawRevision);
      if (
        !parsed.success ||
        parsed.data.generatorId !== generatorId ||
        parsed.data.id !== revisionId
      ) {
        authorityInvalid(
          `Generator ${generatorId} revision ${revisionId} is invalid.`,
          parsed.error,
        );
      }
      if (
        parsed.data.parentRevisionId &&
        !readGeneratorRevision(doc, {
          generatorId,
          generatorRevisionId: parsed.data.parentRevisionId,
        })
      ) {
        authorityInvalid(
          `Generator ${generatorId}/${revisionId} points to a missing parent revision.`,
        );
      }
      if (
        parsed.data.forkedFrom &&
        !readGeneratorRevision(doc, parsed.data.forkedFrom)
      ) {
        authorityInvalid(
          `Generator ${generatorId}/${revisionId} points to a missing fork source.`,
        );
      }
      for (const ref of parsed.data.persistentInputRefs) {
        validateInputTarget(
          doc,
          ref.target,
          `Generator ${generatorId}/${revisionId}`,
        );
      }
      assertPortableJson(
        parsed.data.state,
        `Generator ${generatorId}/${revisionId} state`,
      );
      generatorDefinitions.set(
        generatorSortKey(parsed.data.definitionRef),
        parsed.data.definitionRef,
      );
      const stateModelId = parsed.data.state.modelId;
      if (typeof stateModelId === "string" && stateModelId.trim()) {
        modelIds.add(stateModelId.trim());
      }
    }
  }
  for (const [generatorId, raw] of doc
    .getMap(PROJECT_GENERATORS_CONTAINER)
    .entries()) {
    if (!isLoroMap(raw)) {
      authorityInvalid(`Project Generator ${generatorId} is invalid.`);
    }
    assertAuthorityFields(
      Object.fromEntries(raw.entries()),
      ["head", "terminal"],
      `Project Generator ${generatorId}`,
    );
    const terminal = raw.get("terminal");
    if (terminal === undefined) {
      const head = authorityRecord(
        raw.get("head"),
        `Project Generator ${generatorId} head`,
      );
      assertAuthorityFields(
        head,
        ["revisionId"],
        `Project Generator ${generatorId} head`,
      );
      requireParsedAuthority(
        readProjectGenerator(doc, generatorId),
        `Project Generator ${generatorId}`,
      );
      continue;
    }
    if (
      !isRecord(terminal) ||
      terminal.state !== "deleted" ||
      typeof terminal.operationId !== "string" ||
      !terminal.operationId.trim() ||
      typeof terminal.headRevisionId !== "string" ||
      !terminal.headRevisionId.trim()
    ) {
      authorityInvalid(
        `Project Generator ${generatorId} tombstone is invalid.`,
      );
    }
    assertAuthorityFields(
      terminal,
      ["state", "operationId", "headRevisionId"],
      `Project Generator ${generatorId} tombstone`,
    );
  }

  for (const [actionRunId, rawRun] of doc
    .getMap(GENERATOR_ACTION_RUNS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawRun)) {
      authorityInvalid(`Generator Action Run ${actionRunId} is invalid.`);
    }
    assertAuthorityFields(
      Object.fromEntries(rawRun.entries()),
      ["request", "started", "outcome"],
      `Generator Action Run ${actionRunId}`,
    );
    const run = requireParsedAuthority(
      readProjectActionRun(doc, actionRunId),
      `Generator Action Run ${actionRunId}`,
    );
    const generatorRevision = readGeneratorRevision(doc, run.generatorRevision);
    if (!generatorRevision) {
      authorityInvalid(
        `Generator Action Run ${actionRunId} points to a missing Generator revision.`,
      );
    }
    if (
      run.executor.pluginId !== generatorRevision.definitionRef.pluginId ||
      run.executor.version !== generatorRevision.definitionRef.version ||
      run.executor.schemaHash !== generatorRevision.definitionRef.schemaHash
    ) {
      authorityInvalid(
        `Generator Action Run ${actionRunId} executor does not match its Generator revision.`,
      );
    }
    for (const ref of run.invocationInputRefs) {
      validateInputTarget(
        doc,
        ref.target,
        `Generator Action Run ${actionRunId}`,
      );
    }
    assertPortableJson(
      run.parameters,
      `Generator Action Run ${actionRunId} parameters`,
    );
    if (run.status === "pending" || run.status === "running") {
      blockers.push({
        kind: "generator-action-run",
        id: actionRunId,
        status: run.status,
      });
    }
    if (
      run.status === "succeeded" &&
      run.outputContract.some(
        (output) =>
          output.cardinality.minItems > 0 &&
          readOutputCommit(doc, {
            actionRunId,
            outputSlot: output.slot,
          }) === null,
      )
    ) {
      authorityInvalid(
        `Succeeded Generator Action Run ${actionRunId} is missing a required output.`,
      );
    }
  }
  for (const [actionRunId, rawCommits] of doc
    .getMap(GENERATOR_OUTPUT_COMMITS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawCommits)) {
      authorityInvalid(
        `Action Run ${actionRunId} has an invalid output container.`,
      );
    }
    const run = requireParsedAuthority(
      readProjectActionRun(doc, actionRunId),
      `Action Run ${actionRunId} output owner`,
    );
    for (const [key, rawCommit] of rawCommits.entries()) {
      const parsed = OutputCommitSchema.safeParse(rawCommit);
      if (!parsed.success || parsed.data.actionRunId !== actionRunId) {
        authorityInvalid(
          `Action Run ${actionRunId} output ${key} is invalid.`,
          parsed.error,
        );
      }
      if (
        !run.outputContract.some(
          (output) => output.slot === parsed.data.outputSlot,
        )
      ) {
        authorityInvalid(
          `Action Run ${actionRunId} output ${key} does not match its output contract.`,
        );
      }
      if (
        !readOutputCommit(doc, {
          actionRunId,
          outputSlot: parsed.data.outputSlot,
          ...(parsed.data.itemKey ? { itemKey: parsed.data.itemKey } : {}),
        })
      ) {
        authorityInvalid(`Action Run ${actionRunId} output ${key} is invalid.`);
      }
      validateInputTarget(
        doc,
        parsed.data.asset,
        `Action Run ${actionRunId} output`,
      );
    }
  }

  const documentRevisions: ExportClosure["documentRevisions"] = [];
  for (const [documentAssetId] of doc
    .getMap(PROJECT_DOCUMENT_ASSETS_CONTAINER)
    .entries()) {
    const rawHead = doc
      .getMap(PROJECT_DOCUMENT_ASSETS_CONTAINER)
      .get(documentAssetId);
    if (!isLoroMap(rawHead)) {
      authorityInvalid(`Project Document Asset ${documentAssetId} is invalid.`);
    }
    assertAuthorityFields(
      Object.fromEntries(rawHead.entries()),
      ["headRevisionId"],
      `Project Document Asset ${documentAssetId}`,
    );
    requireParsedAuthority(
      readProjectDocumentAsset(doc, documentAssetId),
      `Project Document Asset ${documentAssetId}`,
    );
  }
  for (const [documentAssetId, rawRevisions] of doc
    .getMap(DOCUMENT_ASSET_REVISIONS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawRevisions)) {
      authorityInvalid(
        `Document Asset ${documentAssetId} has an invalid revision container.`,
      );
    }
    for (const [revisionId, rawRevision] of rawRevisions.entries()) {
      const parsed = DocumentAssetRevisionSchema.safeParse(rawRevision);
      const revision = readDocumentAssetRevision(doc, {
        documentAssetId,
        revisionId,
      });
      if (
        !parsed.success ||
        !revision ||
        parsed.data.documentAssetId !== documentAssetId ||
        parsed.data.id !== revisionId
      ) {
        authorityInvalid(
          `Document Asset ${documentAssetId} revision ${revisionId} is invalid.`,
          parsed.error,
        );
      }
      if (
        revision.parentRevisionId &&
        !readDocumentAssetRevision(doc, {
          documentAssetId,
          revisionId: revision.parentRevisionId,
        })
      ) {
        authorityInvalid(
          `Document Asset ${documentAssetId} revision ${revisionId} points to a missing parent.`,
        );
      }
      if (
        revision.forkedFrom &&
        !readDocumentAssetRevision(doc, revision.forkedFrom)
      ) {
        authorityInvalid(
          `Document Asset ${documentAssetId} revision ${revisionId} points to a missing fork source.`,
        );
      }
      if (revision.producer.kind === "action-run") {
        requireParsedAuthority(
          readProjectActionRun(doc, revision.producer.actionRunId),
          `Document producer Action Run ${revision.producer.actionRunId}`,
        );
      }
      for (const ref of revision.sourceRefs) {
        validateInputTarget(
          doc,
          ref.target,
          `Document ${documentAssetId}/${revisionId}`,
        );
      }
      documentRevisions.push({
        documentKind: revision.documentKind,
        schemaVersion: revision.schemaVersion,
        body: revision.body,
      });
    }
  }
  for (const [attachmentId, rawAttachment] of doc
    .getMap(DOCUMENT_ATTACHMENTS_CONTAINER)
    .entries()) {
    if (!isLoroMap(rawAttachment)) {
      authorityInvalid(`Document attachment ${attachmentId} is invalid.`);
    }
    assertAuthorityFields(
      Object.fromEntries(rawAttachment.entries()),
      ["target", "slot", "document"],
      `Document attachment ${attachmentId}`,
    );
    const attachment = requireParsedAuthority(
      readDocumentAttachment(doc, attachmentId),
      `Document attachment ${attachmentId}`,
    );
    const documentRevision = readDocumentAssetRevision(doc, {
      documentAssetId: attachment.document.documentAssetId,
      revisionId: attachment.document.revisionId,
    });
    if (!documentRevision) {
      authorityInvalid(
        `Document attachment ${attachmentId} points to a missing Document revision.`,
      );
    }
    const declaration = getDocumentKindDefinition(
      documentRevision.documentKind,
      documentRevision.schemaVersion,
    );
    if (
      !declaration?.allowedAttachmentTargets.includes(attachment.target.kind)
    ) {
      authorityInvalid(
        `Document attachment ${attachmentId} target is not allowed by its Document kind.`,
      );
    }
    if (attachment.target.kind === "project-asset") {
      requirePortableAssetReference(
        doc,
        attachment.target.projectAssetId,
        `Document attachment ${attachmentId}`,
      );
    } else if (
      attachment.target.kind === "generator-revision" &&
      !readGeneratorRevision(doc, attachment.target)
    ) {
      authorityInvalid(
        `Document attachment ${attachmentId} points to a missing Generator revision.`,
      );
    } else if (
      attachment.target.kind === "action-run" &&
      !readProjectActionRun(doc, attachment.target.actionRunId)
    ) {
      authorityInvalid(
        `Document attachment ${attachmentId} points to a missing Action Run.`,
      );
    }
  }

  for (const [nodeId, rawNode] of doc.getMap("nodes").entries()) {
    const rawData = isRecord(rawNode) ? rawNode.data : undefined;
    const status = isRecord(rawData) ? rawData.status : undefined;
    const nodeType = isRecord(rawNode) ? rawNode.type : undefined;
    const modelId = isRecord(rawData)
      ? typeof rawData.modelId === "string"
        ? rawData.modelId
        : typeof rawData.model === "string"
          ? rawData.model
          : undefined
      : undefined;
    if (
      (nodeType === "image" ||
        nodeType === "video" ||
        nodeType === "audio" ||
        nodeType === "text") &&
      modelId?.trim() &&
      !modelId.startsWith("custom:")
    ) {
      modelIds.add(modelId.trim());
    }
    if (
      status === "pending" ||
      status === "running" ||
      status === "generating" ||
      status === "processing"
    ) {
      blockers.push({ kind: "project-node", id: nodeId, status });
    }
  }

  blockers.sort((left, right) =>
    left.kind === right.kind
      ? left.id.localeCompare(right.id)
      : left.kind.localeCompare(right.kind),
  );
  if (blockers.length > 0) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_NOT_QUIESCENT",
      `Workspace export requires terminal public work; ${blockers.length} item${blockers.length === 1 ? " is" : "s are"} unfinished.`,
      blockers,
    );
  }

  let snapshot: Uint8Array;
  try {
    const frontiers = doc.frontiers();
    snapshot = exactBytes(
      frontiers.length === 0
        ? doc.export({ mode: "snapshot" })
        : doc.export({ mode: "shallow-snapshot", frontiers }),
    );
  } catch (error) {
    return authorityInvalid(
      "Project current authority could not be encoded as a portable Loro shallow snapshot.",
      error,
    );
  }
  assertPortableSnapshotHistory(snapshot);
  return {
    snapshot,
    resourceRequirements: [...resources.values()].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
    documentRevisions: documentRevisions.sort(
      (left, right) =>
        left.body.digest.localeCompare(right.body.digest) ||
        left.documentKind.localeCompare(right.documentKind) ||
        left.schemaVersion - right.schemaVersion,
    ),
    generatorDefinitions: [...generatorDefinitions.values()].sort(
      (left, right) =>
        generatorSortKey(left).localeCompare(generatorSortKey(right)),
    ),
    modelIds: [...modelIds].sort((left, right) => left.localeCompare(right)),
  };
}

function filePathForResource(resource: Resource): string {
  return `objects/sha256/${resource.digest.value}`;
}

function filePathForDocument(contentHash: string): string {
  return `objects/sha256/${contentHash.slice("sha256:".length)}`;
}

function filePathForText(digest: string): string {
  return `objects/sha256/${digest}`;
}

const L1_METADATA_KEYS = [
  "width",
  "height",
  "rotationDegrees",
  "durationMs",
  "contentType",
  "frameRate",
  "videoCodec",
  "hasAudio",
  "audioCodec",
  "sampleRate",
  "channelCount",
  "channelLayout",
] as const;

function assertInspectedResourceMatches(
  requirement: ExportClosure["resourceRequirements"][number],
  resource: Resource,
  inspectedFacts: Record<string, unknown>,
): void {
  if (
    resource.kind !== requirement.kind ||
    (requirement.assertedContentType !== undefined &&
      resource.contentType !== requirement.assertedContentType)
  ) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_CONTENT_MISMATCH",
      `Resource ${requirement.resourceId} conflicts with synchronized Project Asset facts.`,
    );
  }
  for (const assertion of requirement.assetAssertions) {
    if (assertion.metadata.bytes !== resource.byteLength) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_CONTENT_MISMATCH",
        `Project Asset ${assertion.projectAssetId} byte length conflicts with Resource ${resource.id}.`,
      );
    }
    for (const key of L1_METADATA_KEYS) {
      if (assertion.metadata[key] !== inspectedFacts[key]) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_CONTENT_MISMATCH",
          `Project Asset ${assertion.projectAssetId} ${key} conflicts with current Host inspection/v4 facts.`,
        );
      }
    }
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function makePayload(input: {
  path: string;
  role: WorkspaceBundleFileRole;
  bytes: Uint8Array;
  load?: () => Promise<Uint8Array>;
  open?: () => Promise<Readable>;
}): Payload {
  const frozen = exactBytes(input.bytes);
  return {
    fileId: randomUUID(),
    path: input.path,
    role: input.role,
    bytes: frozen.byteLength,
    sha256: sha256(frozen),
    mode: "0644",
    load: input.load ?? (async () => frozen.slice()),
    ...(input.open ? { open: input.open } : {}),
  };
}

function makeDeclaredPayload(input: {
  path: string;
  role: WorkspaceBundleFileRole;
  bytes: number;
  sha256: string;
  load: () => Promise<Uint8Array>;
  open?: () => Promise<Readable>;
}): Payload {
  return {
    fileId: randomUUID(),
    path: input.path,
    role: input.role,
    bytes: input.bytes,
    sha256: input.sha256,
    mode: "0644",
    load: input.load,
    ...(input.open ? { open: input.open } : {}),
  };
}

async function assertReadableDigest(input: {
  source: AsyncIterable<Uint8Array>;
  bytes: number;
  sha256: string;
  label: string;
}): Promise<void> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunkInput of input.source) {
    const chunk = exactBytes(chunkInput);
    if (chunk.byteLength > input.bytes - bytes) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_CONTENT_MISMATCH",
        `${input.label} exceeds its immutable byte length.`,
      );
    }
    bytes += chunk.byteLength;
    digest.update(chunk);
  }
  if (bytes !== input.bytes || digest.digest("hex") !== input.sha256) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_CONTENT_MISMATCH",
      `${input.label} bytes do not match immutable content facts.`,
    );
  }
}

function publicFile(payload: Payload): LocalWorkspaceExportFile {
  const { load: _load, open: _open, ...file } = payload;
  return file;
}

function safeTextRevision(revision: TextAppliedRevision): TextAppliedRevision {
  const path = WorkspacePortableSourcePathSchema.safeParse(
    revision.sourceFilePath,
  );
  if (!path.success) {
    throw new LocalWorkspaceTransferError(
      "WORKSPACE_AUTHORITY_INVALID",
      `Text revision ${revision.revisionId} contains a machine-private or unsafe source path.`,
      undefined,
      { cause: path.error },
    );
  }
  return { ...revision, sourceFilePath: path.data };
}

export function createLocalWorkspaceTransferService(options: {
  dataDir: string;
  authority: LocalWorkspaceProjectAuthority;
  importAuthority?: LocalWorkspaceImportAuthority;
  receiverOwnerId?: string;
  assetInspection: LocalAssetInspectionService;
  projectLease?: LocalWorkspaceProjectOperationLease;
  now?: () => number;
  exportTtlMs?: number;
  importTtlMs?: number;
  maxActiveExports?: number;
  maxActiveImports?: number;
}) {
  const metadata = createLocalMetadataStore(options.dataDir);
  const resources = createLocalResourceStore({ dataDir: options.dataDir });
  const exports = new Map<string, ExportSession>();
  const imports = new Map<string, ImportSessionState>();
  const importsByDigest = new Map<string, string>();
  let importCreateTail = Promise.resolve();
  const now = options.now ?? Date.now;
  const exportTtlMs = options.exportTtlMs ?? 15 * 60_000;
  const importTtlMs = options.importTtlMs ?? 24 * 60 * 60_000;
  const maxActiveExports = options.maxActiveExports ?? 32;
  const maxActiveImports = options.maxActiveImports ?? 32;
  if (!Number.isSafeInteger(exportTtlMs) || exportTtlMs <= 0) {
    throw new TypeError(
      "Workspace export TTL must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(importTtlMs) || importTtlMs <= 0) {
    throw new TypeError(
      "Workspace import TTL must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(maxActiveExports) || maxActiveExports <= 0) {
    throw new TypeError(
      "Workspace active export limit must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(maxActiveImports) || maxActiveImports <= 0) {
    throw new TypeError(
      "Workspace active import limit must be a positive safe integer.",
    );
  }

  const pruneExports = (at: number) => {
    for (const [exportId, session] of exports) {
      if (session.expiresAt <= at) exports.delete(exportId);
    }
    while (exports.size > maxActiveExports) {
      const oldest = [...exports.entries()].sort(
        ([, left], [, right]) => left.createdAt - right.createdAt,
      )[0];
      if (!oldest) break;
      exports.delete(oldest[0]);
    }
  };

  const requireExportPayload = (exportId: string, fileId: string): Payload => {
    const session = exports.get(exportId);
    if (!session) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_EXPORT_NOT_FOUND",
        "Workspace export session is not available.",
      );
    }
    if (session.expiresAt <= now()) {
      exports.delete(exportId);
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_EXPORT_EXPIRED",
        "Workspace export session expired.",
      );
    }
    const payload = session.payloads.get(fileId);
    if (!payload) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_EXPORT_FILE_NOT_FOUND",
        "Workspace export file capability is not available.",
      );
    }
    return payload;
  };

  const importStagingRoot = join(options.dataDir, "workspace-import-staging");

  const serializeImportCreate = async <T>(
    work: () => Promise<T>,
  ): Promise<T> => {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = importCreateTail;
    importCreateTail = previous.then(() => turn);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const removeImportSession = async (importId: string): Promise<void> => {
    const session = imports.get(importId);
    if (!session) return;
    imports.delete(importId);
    if (importsByDigest.get(session.public.bundleDigest) === importId) {
      importsByDigest.delete(session.public.bundleDigest);
    }
    await rm(join(importStagingRoot, importId), {
      recursive: true,
      force: true,
    });
  };

  const pruneImports = async (at: number, capacityForNew = 0) => {
    for (const [importId, session] of [...imports]) {
      if (Date.parse(session.public.expiresAt) <= at) {
        await removeImportSession(importId);
      }
    }
    while (imports.size + capacityForNew > maxActiveImports) {
      const oldest = [...imports.entries()].sort(
        ([, left], [, right]) => left.createdAt - right.createdAt,
      )[0];
      if (!oldest) break;
      await removeImportSession(oldest[0]);
    }
  };

  const requireImportSession = async (
    importId: string,
  ): Promise<ImportSessionState> => {
    const session = imports.get(importId);
    if (!session) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_IMPORT_NOT_FOUND",
        "Workspace import session is not available.",
      );
    }
    if (Date.parse(session.public.expiresAt) <= now()) {
      await removeImportSession(importId);
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_IMPORT_EXPIRED",
        "Workspace import session expired.",
      );
    }
    return session;
  };

  const requireImportSlot = (
    session: ImportSessionState,
    fileId: string,
  ): ImportPayloadSlot => {
    const slot = session.slots.get(fileId);
    if (!slot) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_IMPORT_FILE_NOT_FOUND",
        "Workspace import file capability is not available.",
      );
    }
    return slot;
  };

  const stageImportFile = async (
    importId: string,
    fileId: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceImportFileUploadReceipt> => {
    const session = await requireImportSession(importId);
    if (session.public.status === "committed") {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_IMPORT_FILE_NOT_FOUND",
        "A committed Workspace import accepts no more payloads.",
      );
    }
    const slot = requireImportSlot(session, fileId);
    const directory = join(importStagingRoot, importId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, `${fileId}.payload`);
    const temporaryPath = join(directory, `.${fileId}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunkInput of source) {
        const chunk = exactBytes(chunkInput);
        if (chunk.byteLength > slot.descriptor.bytes - bytes) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace import payload ${slot.descriptor.path} exceeds its declared byte length.`,
          );
        }
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            null,
          );
          if (written.bytesWritten === 0) {
            throw new Error("Workspace import upload made no write progress.");
          }
          offset += written.bytesWritten;
        }
        bytes += chunk.byteLength;
      }
      if (
        bytes !== slot.descriptor.bytes ||
        digest.digest("hex") !== slot.descriptor.sha256
      ) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_CONTENT_MISMATCH",
          `Workspace import payload ${slot.descriptor.path} does not match its manifest descriptor.`,
        );
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    if (slot.stagedPath) {
      await rm(temporaryPath, { force: true });
    } else {
      await rename(temporaryPath, finalPath);
      slot.stagedPath = finalPath;
    }
    const publicFile = session.public.files.find(
      (candidate) => candidate.fileId === fileId,
    )!;
    publicFile.state = "present";
    return WorkspaceImportFileUploadReceiptSchema.parse({
      schemaVersion: 1,
      kind: "clash.workspace.import-file-upload-receipt",
      importId,
      fileId,
      state: "present",
      bytes: publicFile.bytes,
      sha256: publicFile.sha256,
    });
  };

  const readImportSlotBytes = async (
    slot: ImportPayloadSlot,
  ): Promise<Uint8Array> => {
    if (!slot.stagedPath) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_IMPORT_FILE_MISSING",
        `Workspace import payload ${slot.descriptor.path} is missing.`,
      );
    }
    const bytes = new Uint8Array(await readFile(slot.stagedPath));
    if (
      bytes.byteLength !== slot.descriptor.bytes ||
      sha256(bytes) !== slot.descriptor.sha256
    ) {
      throw new LocalWorkspaceTransferError(
        "WORKSPACE_CONTENT_MISMATCH",
        `Workspace import payload ${slot.descriptor.path} changed after upload.`,
      );
    }
    return bytes;
  };

  return {
    async createExport(input: {
      projectId: string;
      sourceWorkspaceId: string;
    }): Promise<LocalWorkspaceExportPlan> {
      const projectId = input.projectId.trim();
      const sourceWorkspaceId = input.sourceWorkspaceId.trim();
      if (!projectId || !sourceWorkspaceId) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_AUTHORITY_INVALID",
          "Workspace export requires Project and source Workspace identities.",
        );
      }
      const state = await metadata.load();
      const project = state.projects.find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_PROJECT_NOT_FOUND",
          `Project ${projectId} is not registered on this Host.`,
        );
      }
      if (project.deletedAt) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_PROJECT_DELETED",
          `Deleted Project ${projectId} cannot be exported.`,
        );
      }

      // The callback runs on the live room queue. Snapshot and every semantic
      // reference are therefore observed at one serial checkpoint.
      const inspectCheckpoint = () =>
        options.authority.inspect(projectId, async (doc) => {
          const closure = validateAndCollectProject(doc);
          try {
            return {
              closure,
              textRevisions:
                await metadata.listWorkspaceTextRevisions(projectId),
            };
          } catch (error) {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_AUTHORITY_INVALID",
              `Project ${projectId} contains an invalid text revision authority row.`,
              undefined,
              { cause: error },
            );
          }
        });
      const checkpoint = options.projectLease
        ? await options.projectLease.run(projectId, inspectCheckpoint)
        : await inspectCheckpoint();
      const { closure, textRevisions } = checkpoint;
      const payloads: Payload[] = [
        makePayload({
          path: WORKSPACE_BUNDLE_PROJECT_PATH,
          role: "project",
          bytes: closure.snapshot,
        }),
      ];
      const objectPayloads = new Map<string, Payload>();
      const addObjectPayload = (input: {
        path: string;
        bytes?: Uint8Array;
        declaredBytes?: number;
        declaredSha256?: string;
        load?: () => Promise<Uint8Array>;
        open?: () => Promise<Readable>;
      }): void => {
        const candidate = input.bytes
          ? makePayload({
              path: input.path,
              role: "object",
              bytes: input.bytes,
              ...(input.load ? { load: input.load } : {}),
              ...(input.open ? { open: input.open } : {}),
            })
          : input.declaredBytes !== undefined &&
              input.declaredSha256 !== undefined &&
              input.load
            ? makeDeclaredPayload({
                path: input.path,
                role: "object",
                bytes: input.declaredBytes,
                sha256: input.declaredSha256,
                load: input.load,
                ...(input.open ? { open: input.open } : {}),
              })
            : authorityInvalid(
                `Content-addressed payload ${input.path} has no byte authority.`,
              );
        const existing = objectPayloads.get(candidate.path);
        if (existing) {
          if (
            existing.sha256 !== candidate.sha256 ||
            existing.bytes !== candidate.bytes
          ) {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_CONTENT_MISMATCH",
              `Content-addressed payload ${candidate.path} has conflicting bytes.`,
            );
          }
          return;
        }
        objectPayloads.set(candidate.path, candidate);
      };

      const resourceDescriptors: WorkspaceContent["resources"] = [];
      for (const requirement of closure.resourceRequirements) {
        const projection = await resources.resolve(requirement.resourceId);
        if (!projection) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISSING",
            `Resource ${requirement.resourceId} is referenced by the Project but missing locally.`,
          );
        }
        const resource = projection.resource;
        const inspection = await options.assetInspection.inspect({
          source: projection,
        });
        assertInspectedResourceMatches(
          requirement,
          resource,
          inspection.facts as Record<string, unknown>,
        );
        await assertReadableDigest({
          source: createReadStream(projection.path),
          bytes: resource.byteLength,
          sha256: resource.digest.value,
          label: `Resource ${requirement.resourceId}`,
        });
        const path = filePathForResource(resource);
        resourceDescriptors.push({ resource, path });
        addObjectPayload({
          path,
          declaredBytes: resource.byteLength,
          declaredSha256: resource.digest.value,
          load: async () => new Uint8Array(await readFile(projection.path)),
          open: async () => createReadStream(projection.path),
        });
      }

      const documentDescriptors = new Map<
        string,
        WorkspaceContent["documentBodies"][number]
      >();
      const documentBodies = new Map<
        string,
        { body: unknown; bytes: Uint8Array }
      >();
      for (const revision of closure.documentRevisions) {
        if (revision.body.contentType !== "application/json") {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_AUTHORITY_INVALID",
            `Document body ${revision.body.digest} is not canonical JSON.`,
          );
        }
        let loaded = documentBodies.get(revision.body.digest);
        if (!loaded) {
          let body: unknown;
          try {
            body = await readMetadataBody({
              dataDir: options.dataDir,
              contentHash: revision.body.digest,
            });
          } catch (error) {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_CONTENT_MISSING",
              `Document body ${revision.body.digest} is missing or corrupt.`,
              undefined,
              { cause: error },
            );
          }
          loaded = {
            body,
            bytes: new TextEncoder().encode(canonicalMetadataBody(body)),
          };
          documentBodies.set(revision.body.digest, loaded);
        }
        const { body, bytes } = loaded;
        if (bytes.byteLength !== revision.body.byteLength) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Document body ${revision.body.digest} length conflicts with its revision.`,
          );
        }
        try {
          parseDocumentBody(
            revision.documentKind,
            revision.schemaVersion,
            body,
          );
        } catch (error) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_AUTHORITY_INVALID",
            `Document body ${revision.body.digest} violates ${revision.documentKind}@${revision.schemaVersion}.`,
            undefined,
            { cause: error },
          );
        }
        if (documentDescriptors.has(revision.body.digest)) continue;
        const path = filePathForDocument(revision.body.digest);
        documentDescriptors.set(revision.body.digest, {
          contentHash: revision.body.digest,
          byteLength: bytes.byteLength,
          contentType: "application/json",
          path,
        });
        addObjectPayload({ path, bytes });
      }

      const textDescriptors: WorkspaceContent["textRevisions"] = [];
      for (const rawRevision of textRevisions) {
        const revision = safeTextRevision(rawRevision);
        const blobPath = textRevisionContentBlobPath(
          options.dataDir,
          revision.contentHash,
        );
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(blobPath));
        } catch (error) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISSING",
            `Text revision ${revision.revisionId} body is missing.`,
            undefined,
            { cause: error },
          );
        }
        if (
          textRevisionContentHash(new TextDecoder().decode(bytes)) !==
          revision.contentHash
        ) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Text revision ${revision.revisionId} body hash conflicts with its revision.`,
          );
        }
        const digest = sha256(bytes);
        const path = filePathForText(digest);
        textDescriptors.push({ revision, path });
        addObjectPayload({
          path,
          bytes,
          load: async () => new Uint8Array(await readFile(blobPath)),
        });
      }
      payloads.push(...objectPayloads.values());

      resourceDescriptors.sort((left, right) =>
        left.resource.id.localeCompare(right.resource.id),
      );
      textDescriptors.sort((left, right) =>
        left.revision.revisionId.localeCompare(right.revision.revisionId),
      );
      payloads.sort((left, right) => left.path.localeCompare(right.path));
      const exportId = randomUUID();
      const createdAt = now();
      const expiresAt = createdAt + exportTtlMs;
      const plan = WorkspaceExportPlanSchema.parse({
        schemaVersion: 1,
        kind: "clash.workspace.export-plan",
        exportId,
        expiresAt: new Date(expiresAt).toISOString(),
        source: {
          projectId,
          sourceWorkspaceId,
          display: {
            name: project.name,
            ...(project.description === null
              ? {}
              : { description: project.description }),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        },
        content: {
          workspaceRoot: "workspace",
          project: {
            path: WORKSPACE_BUNDLE_PROJECT_PATH,
            codec: "loro-shallow-snapshot",
            codecVersion: 1,
          },
          resources: resourceDescriptors,
          documentBodies: [...documentDescriptors.values()].sort(
            (left, right) => left.contentHash.localeCompare(right.contentHash),
          ),
          textRevisions: textDescriptors,
        },
        semanticRequirements: {
          generatorDefinitions: closure.generatorDefinitions,
          modelReferences: closure.modelIds.map((modelId) => ({ modelId })),
        },
        files: payloads.map(publicFile),
      });
      exports.set(exportId, {
        plan,
        payloads: new Map(payloads.map((payload) => [payload.fileId, payload])),
        createdAt,
        expiresAt,
      });
      pruneExports(createdAt);
      return plan;
    },

    async readExportFile(
      exportId: string,
      fileId: string,
    ): Promise<Uint8Array> {
      const payload = requireExportPayload(exportId, fileId);
      const bytes = exactBytes(await payload.load());
      if (
        bytes.byteLength !== payload.bytes ||
        sha256(bytes) !== payload.sha256
      ) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_CONTENT_MISMATCH",
          `Workspace export payload ${payload.path} changed after checkpoint.`,
        );
      }
      return bytes;
    },

    getExportFile(exportId: string, fileId: string): LocalWorkspaceExportFile {
      return publicFile(requireExportPayload(exportId, fileId));
    },

    async openExportFile(
      exportId: string,
      fileId: string,
    ): Promise<{ file: LocalWorkspaceExportFile; stream: Readable }> {
      const payload = requireExportPayload(exportId, fileId);
      const source = payload.open
        ? await payload.open()
        : Readable.from([await payload.load()]);
      const stream = Readable.from(
        (async function* () {
          const digest = createHash("sha256");
          let bytes = 0;
          for await (const chunkInput of source) {
            const chunk = exactBytes(chunkInput as Uint8Array);
            if (chunk.byteLength > payload.bytes - bytes) {
              throw new LocalWorkspaceTransferError(
                "WORKSPACE_CONTENT_MISMATCH",
                `Workspace export payload ${payload.path} exceeds its checkpointed size.`,
              );
            }
            bytes += chunk.byteLength;
            digest.update(chunk);
            yield chunk;
          }
          if (
            bytes !== payload.bytes ||
            digest.digest("hex") !== payload.sha256
          ) {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_CONTENT_MISMATCH",
              `Workspace export payload ${payload.path} changed after checkpoint.`,
            );
          }
        })(),
      );
      return { file: publicFile(payload), stream };
    },

    async createImport(
      input: WorkspaceImportStart,
    ): Promise<LocalWorkspaceImportSession> {
      const importAuthority = options.importAuthority;
      if (!importAuthority || !options.receiverOwnerId?.trim()) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_IMPORT_NOT_AVAILABLE",
          "Workspace import authority is not available on this Host.",
        );
      }
      return serializeImportCreate(async () => {
        const start = WorkspaceImportStartSchema.parse(input);
        const manifest = start.manifest;
        const bundleDigest = workspaceBundleDigest(manifest);
        if (bundleDigest !== manifest.integrity.bundleDigest) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            "Workspace bundle digest does not match canonical manifest content.",
          );
        }
        const createdAt = now();
        await pruneImports(createdAt);
        const existingImportId = importsByDigest.get(bundleDigest);
        if (existingImportId) return imports.get(existingImportId)!.public;
        await pruneImports(createdAt, 1);
        const authorityFiles = manifest.files.filter(
          (
            file,
          ): file is WorkspaceBundleManifest["files"][number] & {
            role: Exclude<WorkspaceBundleFileRole, "workspace">;
          } => file.role !== "workspace",
        );
        const expiresAt = new Date(createdAt + importTtlMs).toISOString();
        const makePublicFiles = (
          state: WorkspaceImportFileSlot["state"],
          slots?: Map<string, ImportPayloadSlot>,
        ): WorkspaceImportFileSlot[] =>
          authorityFiles.map((descriptor) => {
            const fileId = randomUUID();
            slots?.set(fileId, { descriptor, fileId });
            return {
              ...descriptor,
              fileId,
              state,
            };
          });
        const receipt = await metadata.readWorkspaceImportReceipt(bundleDigest);
        if (receipt) {
          const projectFile = authorityFiles.find(
            (file) => file.path === manifest.content.project.path,
          );
          if (!projectFile || projectFile.role !== "project") {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_CONTENT_MISMATCH",
              "Workspace Project snapshot descriptor is missing.",
            );
          }
          await importAuthority.reconcileCommittedImport(
            receipt.projectId,
            `workspace-import:${bundleDigest}`,
            projectFile.sha256,
          );
          const importId = `committed-${bundleDigest}`;
          const slots = new Map<string, ImportPayloadSlot>();
          const publicSession = WorkspaceImportSessionSchema.parse({
            schemaVersion: 1,
            kind: "clash.workspace.import-session",
            importId,
            idempotencyKey: start.idempotencyKey,
            bundleDigest,
            source: manifest.source,
            target: { projectId: receipt.projectId },
            expiresAt,
            status: "committed",
            files: makePublicFiles("present", slots),
            committedAt: receipt.importedAt,
          });
          imports.set(importId, {
            public: publicSession,
            manifest,
            slots,
            createdAt,
          });
          importsByDigest.set(bundleDigest, importId);
          return publicSession;
        }
        const localState = await metadata.load();
        if (
          localState.projects.some(
            (project) => project.id === manifest.source.projectId,
          )
        ) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_IMPORT_PROJECT_EXISTS",
            `Project ${manifest.source.projectId} already exists on this Host.`,
          );
        }
        if (!manifest.source.display) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_AUTHORITY_INVALID",
            "Workspace import requires safe Project display metadata.",
          );
        }
        const importId = randomUUID();
        const slots = new Map<string, ImportPayloadSlot>();
        const files = makePublicFiles("missing", slots);
        const session: ImportSessionState = {
          manifest,
          slots,
          createdAt,
          public: WorkspaceImportSessionSchema.parse({
            schemaVersion: 1,
            kind: "clash.workspace.import-session",
            importId,
            idempotencyKey: start.idempotencyKey,
            bundleDigest,
            source: manifest.source,
            target: { projectId: manifest.source.projectId },
            expiresAt,
            status: "staging",
            files,
          }),
        };
        imports.set(importId, session);
        importsByDigest.set(bundleDigest, importId);
        return session.public;
      });
    },

    async putImportFile(
      importId: string,
      fileId: string,
      bytesInput: Uint8Array,
    ): Promise<WorkspaceImportFileUploadReceipt> {
      const bytes = exactBytes(bytesInput);
      return stageImportFile(
        importId,
        fileId,
        (async function* () {
          yield bytes;
        })(),
      );
    },

    async putImportFileStream(
      importId: string,
      fileId: string,
      source: AsyncIterable<Uint8Array>,
    ): Promise<WorkspaceImportFileUploadReceipt> {
      return stageImportFile(importId, fileId, source);
    },

    async getImport(importId: string): Promise<LocalWorkspaceImportSession> {
      const session = await requireImportSession(importId);
      return WorkspaceImportSessionSchema.parse(session.public);
    },

    async commitImport(
      importId: string,
      requestInput: WorkspaceImportCommitRequest,
    ): Promise<WorkspaceImportCommitResponse> {
      if (!options.importAuthority || !options.receiverOwnerId?.trim()) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_IMPORT_NOT_AVAILABLE",
          "Workspace import authority is not available on this Host.",
        );
      }
      const receiverOwnerId = options.receiverOwnerId.trim();
      const request = WorkspaceImportCommitRequestSchema.parse(requestInput);
      const session = await requireImportSession(importId);
      if (
        request.idempotencyKey !== session.public.idempotencyKey ||
        request.bundleDigest !== session.public.bundleDigest
      ) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_CONTENT_MISMATCH",
          "Workspace import commit identity does not match its staged session.",
        );
      }
      const commitResponse = (
        status: WorkspaceImportCommitResponse["status"],
        committedAt: string,
      ): WorkspaceImportCommitResponse =>
        WorkspaceImportCommitResponseSchema.parse({
          schemaVersion: 1,
          kind: "clash.workspace.import-commit-response",
          status,
          importId: session.public.importId,
          idempotencyKey: session.public.idempotencyKey,
          bundleDigest: session.public.bundleDigest,
          source: session.public.source,
          target: session.public.target,
          committedAt,
        });
      if (session.public.status === "committed") {
        return commitResponse("already-committed", session.public.committedAt!);
      }
      const missing = [...session.slots.values()].filter(
        (slot) => !slot.stagedPath,
      );
      if (missing.length > 0) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_IMPORT_FILE_MISSING",
          `Workspace import is missing ${missing.length} declared authority payload${missing.length === 1 ? "" : "s"}.`,
        );
      }
      const manifest = session.manifest;
      const slotByPath = new Map(
        [...session.slots.values()].map((slot) => [slot.descriptor.path, slot]),
      );
      const snapshotSlot = slotByPath.get(manifest.content.project.path);
      if (!snapshotSlot?.stagedPath) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_IMPORT_FILE_MISSING",
          "Workspace Project snapshot payload is missing.",
        );
      }
      const snapshotBytes = await readImportSlotBytes(snapshotSlot);
      const candidate = new LoroDoc();
      try {
        candidate.import(snapshotBytes);
      } catch (error) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_AUTHORITY_INVALID",
          "Workspace Project snapshot is not a valid Loro snapshot.",
          undefined,
          { cause: error },
        );
      }
      const closure = validateAndCollectProject(candidate);

      const expectedResourceIds = closure.resourceRequirements.map(
        (entry) => entry.resourceId,
      );
      const manifestResourceIds = manifest.content.resources.map(
        (entry) => entry.resource.id,
      );
      if (!sameStrings(expectedResourceIds, manifestResourceIds)) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_AUTHORITY_INVALID",
          "Workspace Resource manifest does not equal the Project reference closure.",
        );
      }
      const expectedDocumentHashes = [
        ...new Set(closure.documentRevisions.map((entry) => entry.body.digest)),
      ].sort();
      const manifestDocumentHashes = manifest.content.documentBodies.map(
        (entry) => entry.contentHash,
      );
      if (!sameStrings(expectedDocumentHashes, manifestDocumentHashes)) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_AUTHORITY_INVALID",
          "Workspace Document body manifest does not equal the Project revision closure.",
        );
      }
      if (
        JSON.stringify(closure.generatorDefinitions) !==
          JSON.stringify(manifest.semanticRequirements.generatorDefinitions) ||
        !sameStrings(
          closure.modelIds,
          manifest.semanticRequirements.modelReferences.map(
            (entry) => entry.modelId,
          ),
        )
      ) {
        throw new LocalWorkspaceTransferError(
          "WORKSPACE_AUTHORITY_INVALID",
          "Workspace semantic requirements do not match frozen Project state.",
        );
      }

      for (const [index, descriptor] of manifest.content.resources.entries()) {
        const slot = slotByPath.get(descriptor.path);
        if (!slot?.stagedPath) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_IMPORT_FILE_MISSING",
            `Workspace Resource ${descriptor.resource.id} is missing.`,
          );
        }
        const staged = await resources.stageStream({
          source: createReadStream(slot.stagedPath),
          declaredByteLength: descriptor.resource.byteLength,
          maxByteLength: descriptor.resource.byteLength,
          expectedDigest: descriptor.resource.digest.value,
        });
        if (staged.resourceId !== descriptor.resource.id) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace Resource ${descriptor.resource.id} digest changed during staging.`,
          );
        }
        const finalized = await options.assetInspection.finalize({
          resourceId: staged.resourceId,
          kind: descriptor.resource.kind,
          ...(descriptor.resource.contentType
            ? { contentType: descriptor.resource.contentType }
            : {}),
        });
        if (
          JSON.stringify(finalized.source.resource) !==
          JSON.stringify(descriptor.resource)
        ) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace Resource ${descriptor.resource.id} conflicts with receiver Host facts.`,
          );
        }
        assertInspectedResourceMatches(
          closure.resourceRequirements[index]!,
          finalized.source.resource,
          finalized.facts as Record<string, unknown>,
        );
      }

      for (const descriptor of manifest.content.documentBodies) {
        const slot = slotByPath.get(descriptor.path);
        if (!slot?.stagedPath) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_IMPORT_FILE_MISSING",
            `Workspace Document body ${descriptor.contentHash} is missing.`,
          );
        }
        const bodyBytes = await readImportSlotBytes(slot);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
        } catch (error) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace Document body ${descriptor.contentHash} is not JSON.`,
            undefined,
            { cause: error },
          );
        }
        const canonical = new TextEncoder().encode(canonicalMetadataBody(body));
        if (!Buffer.from(canonical).equals(Buffer.from(bodyBytes))) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace Document body ${descriptor.contentHash} is not canonical JSON.`,
          );
        }
        for (const revision of closure.documentRevisions) {
          if (revision.body.digest !== descriptor.contentHash) continue;
          try {
            parseDocumentBody(
              revision.documentKind,
              revision.schemaVersion,
              body,
            );
          } catch (error) {
            throw new LocalWorkspaceTransferError(
              "WORKSPACE_AUTHORITY_INVALID",
              `Workspace Document body ${descriptor.contentHash} violates ${revision.documentKind}@${revision.schemaVersion}.`,
              undefined,
              { cause: error },
            );
          }
        }
        await storeMetadataBody({
          dataDir: options.dataDir,
          body,
          expectedContentHash: descriptor.contentHash,
        });
      }

      const textRevisions: TextAppliedRevision[] = [];
      for (const descriptor of manifest.content.textRevisions) {
        const slot = slotByPath.get(descriptor.path);
        if (!slot?.stagedPath) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_IMPORT_FILE_MISSING",
            `Workspace text revision ${descriptor.revision.revisionId} body is missing.`,
          );
        }
        const content = new TextDecoder().decode(
          await readImportSlotBytes(slot),
        );
        if (
          textRevisionContentHash(content) !== descriptor.revision.contentHash
        ) {
          throw new LocalWorkspaceTransferError(
            "WORKSPACE_CONTENT_MISMATCH",
            `Workspace text revision ${descriptor.revision.revisionId} body conflicts with its content identity.`,
          );
        }
        await storeTextRevisionContentBlob(
          options.dataDir,
          descriptor.revision,
          content,
        );
        textRevisions.push(descriptor.revision);
      }

      const display = manifest.source.display;
      const committedAt = new Date(now()).toISOString();
      await options.importAuthority.install(
        manifest.source.projectId,
        `workspace-import:${manifest.integrity.bundleDigest}`,
        snapshotBytes,
        () =>
          metadata.commitWorkspaceImport({
            bundleDigest: manifest.integrity.bundleDigest,
            importedAt: committedAt,
            project: {
              id: manifest.source.projectId,
              ownerId: receiverOwnerId,
              name: display.name,
              description: display.description ?? null,
              createdAt: display.createdAt ?? new Date(now()).toISOString(),
              updatedAt: display.updatedAt ?? new Date(now()).toISOString(),
              deletedAt: null,
              assets: [],
            },
            textRevisions,
          }),
      );
      session.public.status = "committed";
      session.public.committedAt = committedAt;
      await rm(join(importStagingRoot, importId), {
        recursive: true,
        force: true,
      });
      return commitResponse("committed", committedAt);
    },
  };
}
