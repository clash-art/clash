import { createHash } from "node:crypto";

import type { LoroDoc } from "loro-crdt";

import {
  advanceProjectGeneratorHead,
  createProjectGenerator,
  deleteProjectGenerator,
  projectTimelineFromGeneratorRevision,
  projectTimelineToGeneratorRevisionState,
  readGeneratorRevision,
  readProjectGenerator,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  readProjectActionRun,
  readOutputCommit,
  type ActionRunStatus,
  type OutputCommit,
  type GeneratorDefinition,
  type GeneratorDefinitionRef,
  type GeneratorInputRef,
  type GeneratorRevision,
  type ProjectGeneratorTombstone,
  type ProjectTimeline,
  Canvas,
  DEFAULT_CANVAS_ID,
  ensureProjectCanvas,
} from "@clash/shared-types";

import { validateLocalGeneratorRevisionContract } from "./local-generator-contract.js";

/**
 * Local Host CRUD kernel for the Timeline legacy surface, projected entirely
 * onto native Project Generator identity, immutable revisions, and the
 * `clash.timeline` compatibility surface. This module never touches the
 * legacy `timelines` Loro container; it reads and writes only through the
 * native Generator authority (`projectGenerators` / `generatorRevisions`).
 */

export interface LocalTimelineGeneratorError {
  code: string;
  message: string;
  generatorId?: string;
  generatorRevisionId?: string;
}

export type CreateLocalTimelineGeneratorResult =
  | { ok: true; timeline: ProjectTimeline; changed: boolean }
  | { ok: false; error: LocalTimelineGeneratorError };

export type ReadLocalTimelineGeneratorResult =
  | { ok: true; timeline: ProjectTimeline }
  | { ok: false; error: LocalTimelineGeneratorError };

export type ListLocalTimelineGeneratorsResult =
  | { ok: true; timelines: ProjectTimeline[] }
  | { ok: false; error: LocalTimelineGeneratorError };

export interface LocalTimelineGeneratorRun {
  actionRunId: string;
  timelineId: string;
  sourceTimelineRevisionId: string;
  status: ActionRunStatus;
  outputSlot: string;
  outputCommit?: OutputCommit;
  assetId?: string;
}

export type ListLocalTimelineGeneratorRunsResult =
  | { ok: true; runs: LocalTimelineGeneratorRun[] }
  | { ok: false; error: LocalTimelineGeneratorError };

export type AdvanceLocalTimelineGeneratorResult =
  | { ok: true; timeline: ProjectTimeline; changed: boolean }
  | { ok: false; error: LocalTimelineGeneratorError };

export type DeleteLocalTimelineGeneratorResult =
  | { ok: true; tombstone: ProjectGeneratorTombstone; changed: boolean }
  | { ok: false; error: LocalTimelineGeneratorError };

export type OwnLocalTimelineGeneratorResult =
  | { ok: true; timeline: ProjectTimeline }
  | { ok: false; error: LocalTimelineGeneratorError };

function ownershipError(code: string, message: string, generatorId?: string): OwnLocalTimelineGeneratorResult {
  return { ok: false, error: { code, message, generatorId } };
}

function timelineIdFromActionNode(raw: unknown): string | null {
  if (!isRecord(raw) || raw.type !== "video-editor" || !isRecord(raw.data)) return null;
  return typeof raw.data.timelineId === "string" ? raw.data.timelineId : null;
}

function definitionRefOf(definition: GeneratorDefinition): GeneratorDefinitionRef {
  return {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
}

function definitionRefsMatch(
  a: GeneratorDefinitionRef,
  b: GeneratorDefinitionRef,
): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.definitionId === b.definitionId &&
    a.version === b.version &&
    a.schemaHash === b.schemaHash
  );
}

function isLoroLikeMap(
  value: unknown,
): value is { get(key: string): unknown } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { get?: unknown }).get === "function",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tolerant, schema-independent peek at the raw stored revision's
 * `definitionRef`, used only to decide whether an active head whose
 * revision fact is missing or malformed structurally belongs to this exact
 * Definition family (and must fail closed) or to some other family /
 * genuinely absent fact (which list is entitled to ignore). This never
 * substitutes for `readGeneratorRevision`'s real, schema-validated read.
 */
function rawStoredRevisionDefinitionRef(
  doc: LoroDoc,
  generatorId: string,
  generatorRevisionId: string,
): GeneratorDefinitionRef | null {
  const revisionsForGenerator = doc
    .getMap(GENERATOR_REVISIONS_CONTAINER)
    .get(generatorId);
  if (!isLoroLikeMap(revisionsForGenerator)) return null;
  const raw = revisionsForGenerator.get(generatorRevisionId);
  if (!isRecord(raw) || !isRecord(raw.definitionRef)) return null;
  const ref = raw.definitionRef;
  if (
    typeof ref.pluginId !== "string" ||
    typeof ref.definitionId !== "string" ||
    typeof ref.version !== "string" ||
    typeof ref.schemaHash !== "string"
  ) {
    return null;
  }
  return {
    pluginId: ref.pluginId,
    definitionId: ref.definitionId,
    version: ref.version,
    schemaHash: ref.schemaHash,
  };
}

/**
 * Fail closed before touching any native Generator identity when the
 * installed Definition does not claim the `clash.timeline` compatibility
 * surface at all. Callers that reach here with a Definition that never
 * claimed the surface would otherwise silently read/write an unrelated
 * Generator family's facts.
 */
function requireTimelineSurface(
  definition: GeneratorDefinition,
): { ok: true } | { ok: false; error: LocalTimelineGeneratorError } {
  const surface = definition.projectionSurface;
  if (!surface || surface.id !== "clash.timeline") {
    return {
      ok: false,
      error: {
        code: "GENERATOR_PROJECTION_SURFACE_NOT_CLAIMED",
        message:
          "Definition does not claim the clash.timeline projection surface.",
      },
    };
  }
  if (!surface.mediaInputSlot) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_PROJECTION_SURFACE_MISSING_MEDIA_SLOT",
        message:
          "Projection surface does not declare a persistent media input slot.",
      },
    };
  }
  return { ok: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministically derive the next immutable Generator revision id from the
 * exact semantic facts that revision proposes: the Generator identity, the
 * Definition provenance, the full projected state, the persistent media
 * refs it carries, and its parent lineage. The same proposal from any peer
 * always names the same revision id; nothing here is a mutable head or a
 * random id.
 */
function proposeRevisionId(input: {
  generatorId: string;
  definitionRef: GeneratorDefinitionRef;
  state: Record<string, unknown>;
  persistentInputRefs: readonly GeneratorInputRef[];
  parentRevisionId: string | null;
}): string {
  const canonical = {
    generatorId: input.generatorId,
    definitionRef: input.definitionRef,
    state: input.state,
    persistentInputRefs: input.persistentInputRefs,
    parentRevisionId: input.parentRevisionId,
  };
  const digest = createHash("sha256")
    .update(canonicalJson(canonical))
    .digest("hex");
  return `genrev_sha256:${digest}`;
}

function contractViolationError(error: unknown): LocalTimelineGeneratorError {
  return {
    code: "GENERATOR_CONTRACT_VIOLATION",
    message: error instanceof Error ? error.message : String(error),
  };
}

function buildProposedRevision(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  timeline: ProjectTimeline,
  parentRevisionId: string | undefined,
):
  | { ok: true; revision: GeneratorRevision }
  | { ok: false; error: LocalTimelineGeneratorError } {
  const projected = projectTimelineToGeneratorRevisionState(
    timeline,
    definition,
  );
  if (!projected.ok) {
    return {
      ok: false,
      error: { code: projected.code, message: projected.message },
    };
  }
  const definitionRef = definitionRefOf(definition);
  const revisionId = proposeRevisionId({
    generatorId: timeline.id,
    definitionRef,
    state: projected.state,
    persistentInputRefs: projected.persistentInputRefs,
    parentRevisionId: parentRevisionId ?? null,
  });
  const proposed: GeneratorRevision = {
    id: revisionId,
    generatorId: timeline.id,
    definitionRef,
    state: projected.state,
    persistentInputRefs: projected.persistentInputRefs,
    ...(parentRevisionId ? { parentRevisionId } : {}),
  };
  try {
    const validated = validateLocalGeneratorRevisionContract({
      doc,
      definition,
      revision: proposed,
    });
    return { ok: true, revision: validated };
  } catch (error) {
    return { ok: false, error: contractViolationError(error) };
  }
}

/**
 * Create the native Generator identity for a fresh Timeline. The genesis
 * revision has no parent; its id is a pure function of the Definition
 * provenance, the projected state, and the persistent media refs derived
 * from the Timeline DSL.
 */
export function createLocalTimelineGenerator(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  timeline: ProjectTimeline,
): CreateLocalTimelineGeneratorResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;

  const proposal = buildProposedRevision(doc, definition, timeline, undefined);
  if (!proposal.ok) return proposal;

  const result = createProjectGenerator(doc, {
    head: { id: timeline.id, headRevisionId: proposal.revision.id },
    revision: proposal.revision,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const projectedBack = projectTimelineFromGeneratorRevision(
    { head: result.generator, revision: result.revision },
    definition,
  );
  if (!projectedBack.ok) {
    return {
      ok: false,
      error: {
        code: projectedBack.code,
        message:
          "Failed to project the created native Generator back to a Timeline.",
        generatorId: projectedBack.generatorId,
        generatorRevisionId: projectedBack.revisionId,
      },
    };
  }
  return { ok: true, timeline: projectedBack.timeline, changed: result.changed };
}

/**
 * Read a Timeline projection purely from the native Generator head and its
 * immutable revision. Fails closed (not-found) if the head belongs to a
 * different Definition family.
 */
export function readLocalTimelineGenerator(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  timelineId: string,
): ReadLocalTimelineGeneratorResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;

  const head = readProjectGenerator(doc, timelineId);
  if (!head || !definitionRefsMatch(head.definitionRef, definitionRefOf(definition))) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_NOT_FOUND",
        message: `Project Generator ${timelineId} not found.`,
        generatorId: timelineId,
      },
    };
  }
  const revision = readGeneratorRevision(doc, {
    generatorId: timelineId,
    generatorRevisionId: head.headRevisionId,
  });
  if (!revision) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_REVISION_NOT_FOUND",
        message: `Generator revision ${timelineId}/${head.headRevisionId} not found.`,
        generatorId: timelineId,
        generatorRevisionId: head.headRevisionId,
      },
    };
  }
  const projected = projectTimelineFromGeneratorRevision(
    { head, revision },
    definition,
  );
  if (!projected.ok) {
    return {
      ok: false,
      error: {
        code: projected.code,
        message: "Failed to project the native Generator to a Timeline.",
        generatorId: projected.generatorId,
        generatorRevisionId: projected.revisionId,
      },
    };
  }
  return { ok: true, timeline: projected.timeline };
}

/**
 * Scan native Generator heads and project only the ones that are active
 * (not tombstoned) and belong exactly to the given Definition family. Never
 * reads the legacy `timelines` container.
 *
 * An active head whose `headRevisionId` names this exact Definition family
 * (per the raw stored revision's `definitionRef`) but whose revision fact is
 * missing or fails to project fails the whole call closed with a
 * structured error — that is corruption of our own family's data, not
 * another family's business, so it must never be silently skipped.
 */
export function listLocalTimelineGeneratorRuns(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  status: "completed" | "all",
): ListLocalTimelineGeneratorRunsResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;
  const actionId = definition.projectionSurface!.primaryActionId;
  const action = definition.actions.find((candidate) => candidate.id === actionId);
  const output = action?.outputs[0];
  if (!action || !output) {
    return { ok: false, error: { code: "GENERATOR_PROJECTION_SURFACE_INVALID", message: "Timeline projection surface has no valid primary Action output." } };
  }

  const family = definitionRefOf(definition);
  const runs: LocalTimelineGeneratorRun[] = [];
  for (const [actionRunId, rawFields] of doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).entries()) {
    if (!isLoroLikeMap(rawFields)) continue;
    const rawRequest = rawFields.get("request");
    const rawRevision = isRecord(rawRequest) && isRecord(rawRequest.generatorRevision)
      ? rawRequest.generatorRevision : null;
    const generatorId = rawRevision && typeof rawRevision.generatorId === "string" ? rawRevision.generatorId : null;
    const revisionId = rawRevision && typeof rawRevision.generatorRevisionId === "string" ? rawRevision.generatorRevisionId : null;
    if (!generatorId || !revisionId) continue;
    const rawFamily = rawStoredRevisionDefinitionRef(doc, generatorId, revisionId);
    if (!rawFamily || !definitionRefsMatch(rawFamily, family)) continue;

    const revision = readGeneratorRevision(doc, { generatorId, generatorRevisionId: revisionId });
    const run = readProjectActionRun(doc, actionRunId);
    if (!revision || !run) {
      return { ok: false, error: { code: "INVALID_ACTION_RUN", message: `Action Run ${actionRunId} or its Generator revision is malformed.`, generatorId, generatorRevisionId: revisionId } };
    }
    if (run.actionId !== actionId) continue;
    if (status === "completed" && run.status !== "succeeded") continue;

    const projected: LocalTimelineGeneratorRun = {
      actionRunId: run.actionRunId,
      timelineId: revision.generatorId,
      sourceTimelineRevisionId: revision.id,
      status: run.status,
      outputSlot: output.slot,
    };
    if (run.status === "succeeded") {
      const commit = readOutputCommit(doc, { actionRunId: run.actionRunId, outputSlot: output.slot });
      if (!commit) {
        return { ok: false, error: { code: "REQUIRED_OUTPUT_NOT_COMMITTED", message: `Succeeded Action Run ${run.actionRunId} has no required output commit.`, generatorId, generatorRevisionId: revisionId } };
      }
      projected.outputCommit = commit;
      projected.assetId = commit.asset.kind === "media" ? commit.asset.projectAssetId : commit.asset.documentAssetId;
    }
    runs.push(projected);
  }
  runs.sort((a, b) => a.actionRunId.localeCompare(b.actionRunId));
  return { ok: true, runs };
}

export function listLocalTimelineGenerators(
  doc: LoroDoc,
  definition: GeneratorDefinition,
): ListLocalTimelineGeneratorsResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;

  const definitionRef = definitionRefOf(definition);
  const timelines: ProjectTimeline[] = [];
  const container = doc.getMap(PROJECT_GENERATORS_CONTAINER);
  for (const [generatorId] of container.entries()) {
    const rawEntry = container.get(generatorId);
    if (!isLoroLikeMap(rawEntry)) continue;
    if (rawEntry.get("terminal") !== undefined) continue; // tombstoned
    const rawHead = rawEntry.get("head");
    const rawHeadRevisionId = isRecord(rawHead) ? rawHead.revisionId : undefined;
    if (typeof rawHeadRevisionId !== "string" || !rawHeadRevisionId.trim()) {
      continue; // structurally not even a head; nothing to attribute
    }

    const rawFamilyRef = rawStoredRevisionDefinitionRef(
      doc,
      generatorId,
      rawHeadRevisionId,
    );
    const claimsOurFamily =
      rawFamilyRef !== null && definitionRefsMatch(rawFamilyRef, definitionRef);

    const head = readProjectGenerator(doc, generatorId);
    if (!head) {
      if (claimsOurFamily) {
        return {
          ok: false,
          error: {
            code: "GENERATOR_REVISION_NOT_FOUND",
            message: `Generator revision ${generatorId}/${rawHeadRevisionId} not found.`,
            generatorId,
            generatorRevisionId: rawHeadRevisionId,
          },
        };
      }
      continue; // not our family, or genuinely not attributable to any family
    }
    if (!definitionRefsMatch(head.definitionRef, definitionRef)) continue;

    const revision = readGeneratorRevision(doc, {
      generatorId: head.id,
      generatorRevisionId: head.headRevisionId,
    });
    if (!revision) {
      return {
        ok: false,
        error: {
          code: "GENERATOR_REVISION_NOT_FOUND",
          message: `Generator revision ${head.id}/${head.headRevisionId} not found.`,
          generatorId: head.id,
          generatorRevisionId: head.headRevisionId,
        },
      };
    }
    const projected = projectTimelineFromGeneratorRevision(
      { head, revision },
      definition,
    );
    if (!projected.ok) {
      return {
        ok: false,
        error: {
          code: projected.code,
          message: "Failed to project the native Generator to a Timeline.",
          generatorId: projected.generatorId,
          generatorRevisionId: projected.revisionId,
        },
      };
    }
    timelines.push(projected.timeline);
  }
  timelines.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, timelines };
}

/**
 * Advance the native Generator head to an immutable child revision derived
 * from the edited Timeline. `timeline.revisionId` must name the exact head
 * revision the caller last read; a stale value is rejected with a
 * structured error and the head is left unchanged.
 */
export function advanceLocalTimelineGenerator(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  timeline: ProjectTimeline,
): AdvanceLocalTimelineGeneratorResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;

  const expectedHeadRevisionId = timeline.revisionId;
  if (!expectedHeadRevisionId) {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECT_GENERATOR",
        message: "Advancing a Timeline requires the expected head revision id.",
        generatorId: timeline.id,
      },
    };
  }

  const proposal = buildProposedRevision(
    doc,
    definition,
    timeline,
    expectedHeadRevisionId,
  );
  if (!proposal.ok) return proposal;

  const result = advanceProjectGeneratorHead(doc, {
    generatorId: timeline.id,
    expectedHeadRevisionId,
    revision: proposal.revision,
    editPolicy: definition.editPolicy,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const projectedBack = projectTimelineFromGeneratorRevision(
    { head: result.generator, revision: result.revision },
    definition,
  );
  if (!projectedBack.ok) {
    return {
      ok: false,
      error: {
        code: projectedBack.code,
        message:
          "Failed to project the advanced native Generator back to a Timeline.",
        generatorId: projectedBack.generatorId,
        generatorRevisionId: projectedBack.revisionId,
      },
    };
  }
  return { ok: true, timeline: projectedBack.timeline, changed: result.changed };
}

/**
 * Tombstone the native Generator identity behind a Timeline. Fails closed
 * if the current head belongs to a different Definition family.
 */
/** Attach a standalone native Timeline by advancing ownership and creating its Action node. */
export function attachLocalTimelineGeneratorToCanvas(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  input: {
    timelineId: string;
    canvasId: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  },
): OwnLocalTimelineGeneratorResult {
  const read = readLocalTimelineGenerator(doc, definition, input.timelineId);
  if (!read.ok) return read;
  if (read.timeline.owner.kind !== "project") {
    return ownershipError("TIMELINE_ALREADY_CANVAS_OWNED", `Timeline ${input.timelineId} is already owned by Canvas ${read.timeline.owner.canvasId}`, input.timelineId);
  }
  const canvases = doc.getMap("canvases");
  const mayEnsureMain = input.canvasId === DEFAULT_CANVAS_ID && canvases.size === 0;
  if (!mayEnsureMain && !canvases.get(input.canvasId)) {
    return ownershipError("CANVAS_NOT_FOUND", `Canvas ${input.canvasId} not found`, input.timelineId);
  }
  if (doc.getMap("nodes").get(input.actionNodeId)) {
    return ownershipError("NODE_EXISTS", `Node ${input.actionNodeId} already exists`, input.timelineId);
  }
  const advanced = advanceLocalTimelineGenerator(doc, definition, {
    ...read.timeline,
    owner: { kind: "canvas-action", canvasId: input.canvasId, actionNodeId: input.actionNodeId },
  });
  if (!advanced.ok) return advanced;
  if (mayEnsureMain) ensureProjectCanvas(doc);
  new Canvas(doc, () => {}, input.canvasId).createNode(
    input.actionNodeId, "video-editor", { timelineId: input.timelineId, label: read.timeline.name }, input.position,
  );
  return { ok: true, timeline: advanced.timeline };
}

/** Detach a Canvas-owned native Timeline and remove only its matching owner node. */
export function detachLocalTimelineGeneratorFromCanvas(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  timelineId: string,
): OwnLocalTimelineGeneratorResult {
  const read = readLocalTimelineGenerator(doc, definition, timelineId);
  if (!read.ok) return read;
  if (read.timeline.owner.kind !== "canvas-action") {
    return ownershipError("TIMELINE_ALREADY_STANDALONE", `Timeline ${timelineId} is already standalone`, timelineId);
  }
  const owner = read.timeline.owner;
  const advanced = advanceLocalTimelineGenerator(doc, definition, {
    ...read.timeline,
    owner: { kind: "project" },
  });
  if (!advanced.ok) return advanced;
  const raw = doc.getMap("nodes").get(owner.actionNodeId);
  const nodeCanvasId = isRecord(raw) && typeof raw.canvasId === "string" ? raw.canvasId : DEFAULT_CANVAS_ID;
  if (timelineIdFromActionNode(raw) === timelineId && nodeCanvasId === owner.canvasId) {
    new Canvas(doc, () => {}, owner.canvasId).deleteNode(owner.actionNodeId);
  }
  return { ok: true, timeline: advanced.timeline };
}

/** Copy a Canvas-owned Timeline to a fresh native Generator and Action node. */
export function copyLocalTimelineGeneratorActionToCanvas(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  input: {
    sourceTimelineId: string;
    targetCanvasId: string;
    newTimelineId: string;
    newActionNodeId: string;
    position: { x: number; y: number };
  },
): OwnLocalTimelineGeneratorResult {
  const sourceRead = readLocalTimelineGenerator(doc, definition, input.sourceTimelineId);
  if (!sourceRead.ok) return sourceRead;
  const source = sourceRead.timeline;
  if (source.owner.kind !== "canvas-action") {
    return ownershipError("TIMELINE_STANDALONE", `Timeline ${input.sourceTimelineId} is standalone`, input.sourceTimelineId);
  }
  const canvases = doc.getMap("canvases");
  const mayEnsureMain = input.targetCanvasId === DEFAULT_CANVAS_ID && canvases.size === 0;
  if (!mayEnsureMain && !canvases.get(input.targetCanvasId)) {
    return ownershipError("CANVAS_NOT_FOUND", `Canvas ${input.targetCanvasId} not found`, input.newTimelineId);
  }
  if (doc.getMap(PROJECT_GENERATORS_CONTAINER).get(input.newTimelineId)) {
    return ownershipError("PROJECT_GENERATOR_EXISTS", `Timeline ${input.newTimelineId} already exists`, input.newTimelineId);
  }
  if (doc.getMap("nodes").get(input.newActionNodeId)) {
    return ownershipError("NODE_EXISTS", `Node ${input.newActionNodeId} already exists`, input.newTimelineId);
  }
  const sourceAction = doc.getMap("nodes").get(source.owner.actionNodeId);
  const sourceData = isRecord(sourceAction) && isRecord(sourceAction.data) ? sourceAction.data : {};
  const created = createLocalTimelineGenerator(doc, definition, {
    id: input.newTimelineId,
    name: source.name,
    owner: { kind: "canvas-action", canvasId: input.targetCanvasId, actionNodeId: input.newActionNodeId },
    revisionId: "",
    state: structuredClone(source.state),
  });
  if (!created.ok) return created;
  if (mayEnsureMain) ensureProjectCanvas(doc);
  doc.getMap("nodes").set(input.newActionNodeId, {
    canvasId: input.targetCanvasId,
    type: "video-editor",
    data: { ...sourceData, timelineId: input.newTimelineId, label: source.name },
    position: input.position,
  });
  return { ok: true, timeline: created.timeline };
}

export function deleteLocalTimelineGenerator(
  doc: LoroDoc,
  definition: GeneratorDefinition,
  input: {
    timelineId: string;
    expectedHeadRevisionId: string;
    operationId: string;
  },
): DeleteLocalTimelineGeneratorResult {
  const surfaceCheck = requireTimelineSurface(definition);
  if (!surfaceCheck.ok) return surfaceCheck;

  const head = readProjectGenerator(doc, input.timelineId);
  if (head && !definitionRefsMatch(head.definitionRef, definitionRefOf(definition))) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_DEFINITION_REF_MISMATCH",
        message: `Project Generator ${input.timelineId} does not belong to this Definition family.`,
        generatorId: input.timelineId,
      },
    };
  }

  const result = deleteProjectGenerator(doc, {
    generatorId: input.timelineId,
    expectedHeadRevisionId: input.expectedHeadRevisionId,
    operationId: input.operationId,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, tombstone: result.tombstone, changed: result.changed };
}
