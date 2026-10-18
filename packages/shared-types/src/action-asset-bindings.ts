import { LoroMap, type LoroDoc } from "loro-crdt";

import {
  ActionAssetBindingSchema,
  type ActionAssetBinding,
  type ActionBindingOwner,
  type ProjectAssetEntry,
} from "./assets.js";
import { agentReadToken } from "./agent-read-proof.js";
import {
  readProjectAsset,
  restoreProjectAsset,
  trashProjectAsset,
  type ProjectAssetMutationResult,
} from "./project-assets.js";

export const ACTION_ASSET_BINDINGS_CONTAINER = "actionAssetBindings";
export const ACTION_ASSET_BINDING_SCHEMA_CONTAINER = "actionAssetBindingSchema";
export const ACTION_ASSET_BINDING_AUTHORITY_VERSION = 1;
const ACTION_ASSET_BINDING_AUTHORITY_VERSION_KEY = "authorityVersion";
const ACTION_ASSET_BINDING_AUTHORITY_VERSIONS_KEY = "authorityVersions";

export type ActionAssetBindingMutationErrorCode =
  | "INVALID_ACTION_ASSET_BINDING"
  | "ACTION_ASSET_BINDING_EXISTS"
  | "ACTION_ASSET_BINDING_NOT_FOUND"
  | "PROJECT_ASSET_NOT_FOUND"
  | "PROJECT_ASSET_NOT_ACTIVE"
  | "UNSUPPORTED_ACTION_ASSET_BINDING_AUTHORITY";

export interface ActionAssetBindingMutationError {
  code: ActionAssetBindingMutationErrorCode;
  message: string;
  bindingId?: string;
  projectAssetId?: string;
}

export type ActionAssetBindingMutationResult =
  | { ok: true; binding: ActionAssetBinding }
  | { ok: false; error: ActionAssetBindingMutationError };

export type ActionAssetBindingEnsureResult =
  | { ok: true; binding: ActionAssetBinding; changed: boolean }
  | { ok: false; error: ActionAssetBindingMutationError };

export type ActionAssetBindingAuthorityResult =
  | { ok: true; version: typeof ACTION_ASSET_BINDING_AUTHORITY_VERSION }
  | { ok: false; error: ActionAssetBindingMutationError };

export interface DraftActionAssetInput {
  slot: string;
  projectAssetId: string;
  role?: ActionAssetBinding["role"];
}

export type ReplaceDraftActionAssetInputBindingsResult =
  | { ok: true; managed: boolean; bindings: ActionAssetBinding[] }
  | { ok: false; error: string };

export type FreezeDraftActionAssetInputBindingsResult =
  | {
      ok: true;
      owner: Extract<ActionBindingOwner, { kind: "run" }>;
      bindings: ActionAssetBinding[];
      changed: boolean;
    }
  | { ok: false; error: string };

export interface AssetInUseError {
  code: "ASSET_IN_USE";
  projectAssetId: string;
  references: ActionAssetBinding[];
}

export interface ActionAssetBindingAuthorityRequiredError {
  code: "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED";
  message: string;
  currentVersion?: number;
  requiredVersion: typeof ACTION_ASSET_BINDING_AUTHORITY_VERSION;
}

export type ProjectAssetTrashIfUnreferencedResult =
  | ProjectAssetMutationResult
  | {
      ok: false;
      error: AssetInUseError | ActionAssetBindingAuthorityRequiredError;
    };

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

function rawActionAssetBindingAuthorityVersion(doc: LoroDoc): unknown {
  const schema = doc.getMap(ACTION_ASSET_BINDING_SCHEMA_CONTAINER);
  const versions: number[] = [];
  const legacy = schema.get(ACTION_ASSET_BINDING_AUTHORITY_VERSION_KEY);
  if (legacy !== undefined) {
    if (typeof legacy !== "number" || !Number.isInteger(legacy) || legacy < 1)
      return legacy;
    versions.push(legacy);
  }

  const facts = schema.get(ACTION_ASSET_BINDING_AUTHORITY_VERSIONS_KEY);
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

export function actionAssetBindingAuthorityVersion(
  doc: LoroDoc,
): number | undefined {
  const value = rawActionAssetBindingAuthorityVersion(doc);
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function authorityError(
  version: unknown,
): Extract<ActionAssetBindingAuthorityResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED_ACTION_ASSET_BINDING_AUTHORITY",
      message: `Unsupported Action Asset binding authority version: ${String(version)}`,
    },
  };
}

function mutationAuthorityError(
  doc: LoroDoc,
): Extract<ActionAssetBindingMutationResult, { ok: false }> | undefined {
  const version = rawActionAssetBindingAuthorityVersion(doc);
  if (
    version === undefined ||
    version === ACTION_ASSET_BINDING_AUTHORITY_VERSION
  ) {
    return undefined;
  }
  return authorityError(version);
}

export function markActionAssetBindingAuthority(
  doc: LoroDoc,
): ActionAssetBindingAuthorityResult {
  const current = rawActionAssetBindingAuthorityVersion(doc);
  if (
    current !== undefined &&
    current !== ACTION_ASSET_BINDING_AUTHORITY_VERSION
  ) {
    return authorityError(current);
  }
  doc
    .getMap(ACTION_ASSET_BINDING_SCHEMA_CONTAINER)
    .ensureMergeableMap(ACTION_ASSET_BINDING_AUTHORITY_VERSIONS_KEY)
    .set(String(ACTION_ASSET_BINDING_AUTHORITY_VERSION), true);
  return { ok: true, version: ACTION_ASSET_BINDING_AUTHORITY_VERSION };
}

function parseBinding(id: string, raw: unknown): ActionAssetBinding | null {
  if ((!isRecord(raw) && !isLoroMap(raw)) || field(raw, "unbound") === true)
    return null;
  const parsed = ActionAssetBindingSchema.safeParse({
    id,
    owner: field(raw, "owner"),
    direction: field(raw, "direction"),
    slot: field(raw, "slot"),
    projectAssetId: field(raw, "projectAssetId"),
    ...(field(raw, "role") === undefined ? {} : { role: field(raw, "role") }),
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid Action Asset binding ${id}: ${parsed.error.issues[0]?.message ?? "invalid binding"}`,
    );
  }
  return parsed.data;
}

function mutationError(
  code: ActionAssetBindingMutationErrorCode,
  message: string,
  details: { bindingId?: string; projectAssetId?: string } = {},
): ActionAssetBindingMutationResult {
  return { ok: false, error: { code, message, ...details } };
}

function requireActiveProjectAsset(
  doc: LoroDoc,
  binding: ActionAssetBinding,
): ActionAssetBindingMutationResult | undefined {
  const asset = readProjectAsset(doc, binding.projectAssetId);
  if (!asset) {
    return mutationError(
      "PROJECT_ASSET_NOT_FOUND",
      `Project Asset ${binding.projectAssetId} not found.`,
      { bindingId: binding.id, projectAssetId: binding.projectAssetId },
    );
  }
  if (asset.lifecycle.state !== "active") {
    return mutationError(
      "PROJECT_ASSET_NOT_ACTIVE",
      `Project Asset ${binding.projectAssetId} is not active.`,
      { bindingId: binding.id, projectAssetId: binding.projectAssetId },
    );
  }
  return undefined;
}

function writeBinding(fields: LoroMap, binding: ActionAssetBinding): void {
  fields.set("owner", binding.owner);
  fields.set("direction", binding.direction);
  fields.set("slot", binding.slot);
  fields.set("projectAssetId", binding.projectAssetId);
  if (binding.role === undefined) fields.delete("role");
  else fields.set("role", binding.role);
}

function assertActiveBindingTarget(
  doc: LoroDoc,
  binding: ActionAssetBinding,
): void {
  // Output bindings are immutable lineage: a trashed result may still be shown in the Action's
  // history, but it is not a live downstream use. Input bindings are executable dependencies and
  // must always resolve to an active Project Asset.
  if (binding.direction === "output") return;
  const asset = readProjectAsset(doc, binding.projectAssetId);
  if (!asset || asset.lifecycle.state !== "active") {
    throw new Error(
      `Action Asset binding ${binding.id} points to Project Asset ${binding.projectAssetId}, which is not active.`,
    );
  }
}

function listStoredBindings(doc: LoroDoc): ActionAssetBinding[] {
  const bindings: ActionAssetBinding[] = [];
  for (const [id, raw] of doc
    .getMap(ACTION_ASSET_BINDINGS_CONTAINER)
    .entries()) {
    const binding = parseBinding(id, raw);
    if (binding) bindings.push(binding);
  }
  return bindings.sort((left, right) => left.id.localeCompare(right.id));
}

export function readActionAssetBinding(
  doc: LoroDoc,
  id: string,
): ActionAssetBinding | null {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const binding = parseBinding(
    normalizedId,
    doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER).get(normalizedId),
  );
  if (binding) assertActiveBindingTarget(doc, binding);
  return binding;
}

/**
 * The draft input bindings stored for one Action, read WITHOUT the active-target
 * assertion. Only for comparing a planned replacement with what is stored; every
 * write still validates its targets (replaceDraftActionAssetInputBindings).
 */
export function storedDraftActionAssetInputs(
  doc: LoroDoc,
  actionId: string,
): DraftActionAssetInput[] {
  const owner: ActionBindingOwner = { kind: "draft", actionId: actionId.trim() };
  return listStoredBindings(doc)
    .filter((binding) => binding.direction === "input" && sameBindingOwner(binding.owner, owner))
    .map((binding) => ({
      slot: binding.slot,
      projectAssetId: binding.projectAssetId,
      ...(binding.role ? { role: binding.role } : {}),
    }));
}

export function listActionAssetBindings(doc: LoroDoc): ActionAssetBinding[] {
  const bindings = listStoredBindings(doc);
  for (const binding of bindings) assertActiveBindingTarget(doc, binding);
  return bindings;
}

export function listActionAssetReferences(
  doc: LoroDoc,
  projectAssetId: string,
): ActionAssetBinding[] {
  // Reference inspection intentionally includes bindings involved in a concurrent delete/bind
  // conflict so deletion can report ASSET_IN_USE rather than hiding or erasing the usage.
  return listStoredBindings(doc)
    .filter((binding) => binding.projectAssetId === projectAssetId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * CAS identity for one Project Asset mutation surface.
 *
 * The Project id prevents a receipt from being replayed against an identical entry in another
 * Project. Only input bindings participate because they are the references that block logical
 * deletion; output lineage is historical and does not change whether this Asset may be trashed.
 */
export function projectAssetMutationReadToken(input: {
  projectId: string;
  entry: ProjectAssetEntry;
  references: readonly ActionAssetBinding[];
}): string {
  const inputBindings = input.references
    .filter((binding) => binding.direction === "input")
    .map((binding) => ({
      id: binding.id,
      owner: binding.owner,
      direction: binding.direction,
      slot: binding.slot,
      projectAssetId: binding.projectAssetId,
      ...(binding.role === undefined ? {} : { role: binding.role }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return agentReadToken({
    namespace: "project-asset",
    subject: {
      projectId: input.projectId.trim(),
      entry: input.entry,
      inputBindings,
    },
  });
}

export function projectAssetMutationReadTokenFromDoc(
  doc: LoroDoc,
  projectId: string,
  projectAssetId: string,
): string | null {
  const entry = readProjectAsset(doc, projectAssetId);
  if (!entry) return null;
  return projectAssetMutationReadToken({
    projectId,
    entry,
    references: listActionAssetReferences(doc, entry.id),
  });
}

export interface ActionAssetBindingTargetReconciliation {
  restoredProjectAssetIds: string[];
}

/**
 * Repairs the only valid concurrent delete/bind race.
 *
 * A binding can be created against an active Project Asset on one replica while another replica
 * logically trashes that Asset. Both operations are locally valid, but their CRDT merge would
 * otherwise leave an executable input pointing at a trashed Asset. An input use wins over logical
 * deletion, so the Host restores the Asset after importing the merged update. Output lineage is
 * historical and therefore does not keep an Asset active.
 *
 * Purged and missing Assets are deliberately not fabricated here: physical purge is terminal and
 * must only happen after its separate retention/reconciliation policy has proved it safe.
 */
export function reconcileActionAssetBindingTargets(
  doc: LoroDoc,
): ActionAssetBindingTargetReconciliation {
  if (
    actionAssetBindingAuthorityVersion(doc) !==
    ACTION_ASSET_BINDING_AUTHORITY_VERSION
  ) {
    return { restoredProjectAssetIds: [] };
  }

  const restoredProjectAssetIds: string[] = [];
  const visited = new Set<string>();
  for (const binding of listStoredBindings(doc)) {
    if (binding.direction !== "input" || visited.has(binding.projectAssetId)) {
      continue;
    }
    visited.add(binding.projectAssetId);
    const entry = readProjectAsset(doc, binding.projectAssetId);
    if (entry?.lifecycle.state !== "trashed") continue;
    const restored = restoreProjectAsset(doc, entry.id);
    if (!restored.ok) continue;
    restoredProjectAssetIds.push(entry.id);
  }
  return { restoredProjectAssetIds: restoredProjectAssetIds.sort() };
}

export function createActionAssetBinding(
  doc: LoroDoc,
  input: unknown,
): ActionAssetBindingMutationResult {
  const parsed = ActionAssetBindingSchema.safeParse(input);
  if (!parsed.success) {
    return mutationError(
      "INVALID_ACTION_ASSET_BINDING",
      parsed.error.issues[0]?.message ?? "Invalid Action Asset binding.",
    );
  }
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;
  const activeError = requireActiveProjectAsset(doc, parsed.data);
  if (activeError) return activeError;
  const bindings = doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER);
  if (bindings.get(parsed.data.id) !== undefined) {
    return mutationError(
      "ACTION_ASSET_BINDING_EXISTS",
      `Action Asset binding ${parsed.data.id} already exists.`,
      { bindingId: parsed.data.id },
    );
  }
  writeBinding(bindings.ensureMergeableMap(parsed.data.id), parsed.data);
  return { ok: true, binding: parsed.data };
}

function sameBindingOwner(
  left: ActionBindingOwner,
  right: ActionBindingOwner,
): boolean {
  if (left.kind !== right.kind || left.actionId !== right.actionId)
    return false;
  if (left.kind === "draft" || right.kind === "draft") return true;
  if (left.actionRevisionId !== right.actionRevisionId) return false;
  if (left.kind === "revision" || right.kind === "revision") return true;
  return left.actionRunId === right.actionRunId;
}

/** Lists one exact editable, revision, or run owner's current binding facts. */
export function listActionAssetBindingsForOwner(
  doc: LoroDoc,
  owner: ActionBindingOwner,
): ActionAssetBinding[] {
  return listActionAssetBindings(doc).filter((binding) =>
    sameBindingOwner(binding.owner, owner),
  );
}

function sameBindingFact(
  left: ActionAssetBinding,
  right: ActionAssetBinding,
): boolean {
  return (
    left.id === right.id &&
    sameBindingOwner(left.owner, right.owner) &&
    left.direction === right.direction &&
    left.slot === right.slot &&
    left.projectAssetId === right.projectAssetId &&
    left.role === right.role
  );
}

/**
 * Publishes one immutable binding fact exactly once.
 *
 * Retrying the same fact is a no-op. Reusing its id for different lineage is an identity
 * collision, never an update; callers that intentionally change editable inputs use the explicit
 * update/replace operations instead.
 */
export function ensureActionAssetBinding(
  doc: LoroDoc,
  input: unknown,
): ActionAssetBindingEnsureResult {
  const parsed = ActionAssetBindingSchema.safeParse(input);
  if (!parsed.success) {
    return mutationError(
      "INVALID_ACTION_ASSET_BINDING",
      parsed.error.issues[0]?.message ?? "Invalid Action Asset binding.",
    ) as Extract<ActionAssetBindingEnsureResult, { ok: false }>;
  }
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;

  const bindings = doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER);
  const raw = bindings.get(parsed.data.id);
  if (raw !== undefined) {
    const existing = parseBinding(parsed.data.id, raw);
    if (existing && sameBindingFact(existing, parsed.data)) {
      return { ok: true, binding: existing, changed: false };
    }
    return mutationError(
      "ACTION_ASSET_BINDING_EXISTS",
      `Action Asset binding ${parsed.data.id} already identifies different facts.`,
      { bindingId: parsed.data.id },
    ) as Extract<ActionAssetBindingEnsureResult, { ok: false }>;
  }

  const created = createActionAssetBinding(doc, parsed.data);
  if (!created.ok) return created;
  return { ok: true, binding: created.binding, changed: true };
}

function frozenRunInputBindingId(actionRunId: string, slot: string): string {
  return (
    `action-asset:run:${encodeURIComponent(actionRunId)}` +
    `:input:${encodeURIComponent(slot)}`
  );
}

/**
 * Freezes one editable Action's authoritative input bindings for a concrete run.
 *
 * The draft owner is read once; later draft rewiring cannot change these immutable run facts.
 * Retrying the freeze is idempotent, while reusing a run id for different inputs is an identity
 * collision. Callers should preflight on a fork when they also create another Project entity in
 * the same higher-level mutation.
 */
export function freezeDraftActionAssetInputBindings(
  doc: LoroDoc,
  input: {
    actionId: string;
    actionRevisionId: string;
    actionRunId: string;
  },
): FreezeDraftActionAssetInputBindingsResult {
  const actionId = input.actionId.trim();
  const actionRevisionId = input.actionRevisionId.trim();
  const actionRunId = input.actionRunId.trim();
  if (!actionId || !actionRevisionId || !actionRunId) {
    return {
      ok: false,
      error: "Action id, revision id, and run id are required to freeze Asset inputs",
    };
  }
  if (
    actionAssetBindingAuthorityVersion(doc) !==
    ACTION_ASSET_BINDING_AUTHORITY_VERSION
  ) {
    return {
      ok: false,
      error:
        "Action Asset binding authority is required before freezing run inputs",
    };
  }

  const draftOwner: ActionBindingOwner = { kind: "draft", actionId };
  const draftInputs = listActionAssetBindingsForOwner(doc, draftOwner).filter(
    (binding) => binding.direction === "input",
  );
  const slots = new Set<string>();
  for (const binding of draftInputs) {
    if (slots.has(binding.slot)) {
      return {
        ok: false,
        error: `Editable Action ${actionId} has duplicate Asset input slot ${binding.slot}`,
      };
    }
    slots.add(binding.slot);
  }

  const owner = {
    kind: "run" as const,
    actionId,
    actionRevisionId,
    actionRunId,
  };
  const bindings: ActionAssetBinding[] = [];
  let changed = false;
  for (const draft of draftInputs) {
    const frozen: ActionAssetBinding = {
      id: frozenRunInputBindingId(actionRunId, draft.slot),
      owner,
      direction: "input",
      slot: draft.slot,
      projectAssetId: draft.projectAssetId,
      ...(draft.role ? { role: draft.role } : {}),
    };
    const ensured = ensureActionAssetBinding(doc, frozen);
    if (!ensured.ok) return { ok: false, error: ensured.error.message };
    bindings.push(ensured.binding);
    changed ||= ensured.changed;
  }
  return {
    ok: true,
    owner,
    bindings: bindings.sort((left, right) => left.slot.localeCompare(right.slot)),
    changed,
  };
}

export function updateActionAssetBinding(
  doc: LoroDoc,
  input: unknown,
): ActionAssetBindingMutationResult {
  const parsed = ActionAssetBindingSchema.safeParse(input);
  if (!parsed.success) {
    return mutationError(
      "INVALID_ACTION_ASSET_BINDING",
      parsed.error.issues[0]?.message ?? "Invalid Action Asset binding.",
    );
  }
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;
  const bindings = doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER);
  const raw = bindings.get(parsed.data.id);
  const existing = parseBinding(parsed.data.id, raw);
  if (!existing || !isLoroMap(raw)) {
    return mutationError(
      "ACTION_ASSET_BINDING_NOT_FOUND",
      `Action Asset binding ${parsed.data.id} not found.`,
      { bindingId: parsed.data.id },
    );
  }
  const activeError = requireActiveProjectAsset(doc, parsed.data);
  if (activeError) return activeError;
  writeBinding(raw, parsed.data);
  return { ok: true, binding: parsed.data };
}

export function unbindActionAssetBinding(
  doc: LoroDoc,
  id: string,
): ActionAssetBindingMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return unsupported;
  const normalizedId = id.trim();
  const raw = doc.getMap(ACTION_ASSET_BINDINGS_CONTAINER).get(normalizedId);
  const binding = parseBinding(normalizedId, raw);
  if (!binding || !isLoroMap(raw)) {
    return mutationError(
      "ACTION_ASSET_BINDING_NOT_FOUND",
      `Action Asset binding ${normalizedId} not found.`,
      { bindingId: normalizedId },
    );
  }
  // A grow-only tombstone ensures a concurrent stale update cannot recreate the usage reference.
  raw.set("unbound", true);
  return { ok: true, binding };
}

function newDirectBindingId(): string {
  const cryptoObject = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  const suffix = cryptoObject?.randomUUID
    ? cryptoObject.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `action-asset:direct:${suffix}`;
}

/**
 * Replaces one editable Action's complete input set inside the current Project
 * transaction. Once binding authority is marked this is the write path for
 * Timeline/Director mutations; the legacy materializer is not a live index.
 */
export function replaceDraftActionAssetInputBindings(
  doc: LoroDoc,
  actionIdInput: string,
  desiredInputs: readonly DraftActionAssetInput[],
): ReplaceDraftActionAssetInputBindingsResult {
  const actionId = actionIdInput.trim();
  if (!actionId) return { ok: false, error: "Action id is required" };
  const authority = rawActionAssetBindingAuthorityVersion(doc);
  if (authority === undefined) {
    return { ok: true, managed: false, bindings: [] };
  }
  if (authority !== ACTION_ASSET_BINDING_AUTHORITY_VERSION) {
    return {
      ok: false,
      error: `Unsupported Action Asset binding authority version: ${String(authority)}`,
    };
  }

  const desiredBySlot = new Map<string, DraftActionAssetInput>();
  for (const candidate of desiredInputs) {
    const slot = candidate.slot.trim();
    const projectAssetId = candidate.projectAssetId.trim();
    if (!slot || !projectAssetId) {
      return {
        ok: false,
        error: "Action Asset input slot and Project Asset id are required",
      };
    }
    if (desiredBySlot.has(slot)) {
      return {
        ok: false,
        error: `Action Asset input slot ${slot} is duplicated`,
      };
    }
    const asset = readProjectAsset(doc, projectAssetId);
    if (!asset || asset.lifecycle.state !== "active") {
      return {
        ok: false,
        error: `Project Asset ${projectAssetId} is not active`,
      };
    }
    desiredBySlot.set(slot, {
      slot,
      projectAssetId,
      ...(candidate.role ? { role: candidate.role } : {}),
    });
  }

  const owner: ActionBindingOwner = { kind: "draft", actionId };
  const currentBySlot = new Map<string, ActionAssetBinding[]>();
  for (const binding of listActionAssetBindings(doc)) {
    if (
      binding.direction !== "input" ||
      !sameBindingOwner(binding.owner, owner)
    ) {
      continue;
    }
    const current = currentBySlot.get(binding.slot) ?? [];
    current.push(binding);
    currentBySlot.set(binding.slot, current);
  }

  const bindings: ActionAssetBinding[] = [];
  for (const [slot, desired] of desiredBySlot) {
    const existing = [...(currentBySlot.get(slot) ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const first = existing.shift();
    if (first) {
      const next: ActionAssetBinding = {
        ...first,
        owner,
        direction: "input",
        slot,
        projectAssetId: desired.projectAssetId,
        ...(desired.role ? { role: desired.role } : { role: undefined }),
      };
      const updated = updateActionAssetBinding(doc, next);
      if (!updated.ok) return { ok: false, error: updated.error.message };
      bindings.push(updated.binding);
    } else {
      const created = createActionAssetBinding(doc, {
        id: newDirectBindingId(),
        owner,
        direction: "input",
        slot,
        projectAssetId: desired.projectAssetId,
        ...(desired.role ? { role: desired.role } : {}),
      });
      if (!created.ok) return { ok: false, error: created.error.message };
      bindings.push(created.binding);
    }
    for (const duplicate of existing) {
      const unbound = unbindActionAssetBinding(doc, duplicate.id);
      if (!unbound.ok) return { ok: false, error: unbound.error.message };
    }
    currentBySlot.delete(slot);
  }

  for (const obsolete of currentBySlot.values()) {
    for (const binding of obsolete) {
      const unbound = unbindActionAssetBinding(doc, binding.id);
      if (!unbound.ok) return { ok: false, error: unbound.error.message };
    }
  }
  return {
    ok: true,
    managed: true,
    bindings: bindings.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function trashProjectAssetIfUnreferenced(
  doc: LoroDoc,
  input: {
    id: string;
    deleteOperationId: string;
    deletedAt: string;
    purgeAfter: string;
  },
): ProjectAssetTrashIfUnreferencedResult {
  const currentVersion = actionAssetBindingAuthorityVersion(doc);
  if (currentVersion !== ACTION_ASSET_BINDING_AUTHORITY_VERSION) {
    return {
      ok: false,
      error: {
        code: "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED",
        message:
          "Project Asset deletion is unavailable until legacy Action Asset references are materialized.",
        ...(currentVersion === undefined ? {} : { currentVersion }),
        requiredVersion: ACTION_ASSET_BINDING_AUTHORITY_VERSION,
      },
    };
  }
  const references = listActionAssetReferences(doc, input.id);
  const blockingReferences = references.filter(
    (binding) => binding.direction === "input",
  );
  if (blockingReferences.length > 0) {
    return {
      ok: false,
      error: {
        code: "ASSET_IN_USE",
        projectAssetId: input.id,
        references: blockingReferences,
      },
    };
  }
  return trashProjectAsset(doc, input);
}
