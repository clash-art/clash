import { ProjectTimelineEnvelopeSchema } from "./timeline-envelope.js";

import type {
  GeneratorDefinition,
  GeneratorDefinitionRef,
  GeneratorInputRef,
  GeneratorRevision,
  ProjectGenerator,
} from "./generator-v2.js";
import type { ExecutablePluginJsonValue } from "./plugin-json-value.js";
import type { ProjectTimeline, TimelineOwner } from "./project-workspace.js";
import { normalizeProjectTimelinePersistenceState } from "./timeline-persistence.js";
import { validateTimelineDsl } from "./timeline-dsl-schema.js";

export {
  ProjectTimelineEnvelopeSchema,
  type ProjectTimelineEnvelope,
} from "./timeline-envelope.js";

export type ProjectTimelineToGeneratorRevisionStateResult =
  | {
      ok: true;
      state: Record<string, ExecutablePluginJsonValue>;
      persistentInputRefs: GeneratorInputRef[];
    }
  | { ok: false; code: string; message: string };

export type ProjectTimelineFromGeneratorRevisionResult =
  | { ok: true; timeline: ProjectTimeline }
  | { ok: false; code: string; generatorId: string; revisionId: string };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project a `ProjectTimeline` onto native Generator revision state under the
 * Definition's `clash.timeline` compatibility surface. This never persists
 * anything and never invents a revision id or hash — the caller supplies
 * those when it actually creates the Generator revision.
 */
export function projectTimelineToGeneratorRevisionState(
  timeline: ProjectTimeline,
  definition: GeneratorDefinition,
): ProjectTimelineToGeneratorRevisionStateResult {
  const surface = definition.projectionSurface;
  if (!surface || surface.id !== "clash.timeline") {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_NOT_CLAIMED",
      message:
        "Definition does not claim the clash.timeline projection surface.",
    };
  }
  if (!surface.mediaInputSlot) {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_MISSING_MEDIA_SLOT",
      message:
        "Projection surface does not declare a persistent media input slot.",
    };
  }

  const sourceValidated = validateTimelineDsl(timeline.state);
  if (!sourceValidated.ok) {
    return {
      ok: false,
      code: "PROJECT_TIMELINE_DSL_INVALID",
      message: sourceValidated.issues.map((issue) => issue.message).join("; "),
    };
  }

  const sourceTracks = isRecord(sourceValidated.value)
    ? Array.isArray(sourceValidated.value.tracks)
      ? sourceValidated.value.tracks
      : []
    : [];
  for (const track of sourceTracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item) || !["image", "video", "audio"].includes(String(item.type))) {
        continue;
      }
      if (typeof item.assetId !== "string" || !item.assetId.trim()) {
        return {
          ok: false,
          code: "PROJECT_TIMELINE_MEDIA_ASSET_ID_REQUIRED",
          message: `Media Timeline item ${String(item.id)} must reference a non-empty Project Asset id.`,
        };
      }
    }
  }

  const normalized = normalizeProjectTimelinePersistenceState(timeline.state);
  if (!normalized.ok) {
    return {
      ok: false,
      code: "PROJECT_TIMELINE_STATE_NOT_PERSISTABLE",
      message: normalized.error,
    };
  }

  const validated = validateTimelineDsl(normalized.state);
  if (!validated.ok) {
    return {
      ok: false,
      code: "PROJECT_TIMELINE_DSL_INVALID",
      message: validated.issues.map((issue) => issue.message).join("; "),
    };
  }

  const envelope = {
    name: timeline.name,
    owner: timeline.owner,
    state: validated.value,
  } as unknown as ExecutablePluginJsonValue;

  const persistentInputRefs: GeneratorInputRef[] = [];
  const tracks = isRecord(validated.value)
    ? Array.isArray((validated.value as Record<string, unknown>).tracks)
      ? ((validated.value as Record<string, unknown>).tracks as unknown[])
      : []
    : [];
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item)) continue;
      if (!["image", "video", "audio"].includes(String(item.type))) continue;
      const assetId = item.assetId;
      const itemId = item.id;
      // Source DSL validation above guarantees both stable item identity and
      // non-empty media Asset identity. Keep this guard fail-closed if that
      // upstream contract changes.
      if (typeof assetId !== "string" || !assetId.trim()) {
        return {
          ok: false,
          code: "PROJECT_TIMELINE_MEDIA_ASSET_ID_REQUIRED",
          message: `Media Timeline item ${String(itemId)} must reference a non-empty Project Asset id.`,
        };
      }
      if (typeof itemId !== "string" || !itemId.trim()) {
        return {
          ok: false,
          code: "PROJECT_TIMELINE_MEDIA_ITEM_ID_REQUIRED",
          message: "Every media Timeline item must have a non-empty stable item id.",
        };
      }
      persistentInputRefs.push({
        slot: surface.mediaInputSlot,
        itemKey: itemId,
        target: { kind: "media", projectAssetId: assetId },
      });
    }
  }
  persistentInputRefs.sort((a, b) =>
    (a.itemKey ?? "").localeCompare(b.itemKey ?? ""),
  );

  return {
    ok: true,
    state: { [surface.stateKey]: envelope },
    persistentInputRefs,
  };
}

/**
 * Reconstruct a `ProjectTimeline` read projection purely from a native
 * Generator head and its immutable revision. The head and the revision must
 * both name exactly the given Definition; anything else fails closed with a
 * structured error rather than guessing.
 */
export function projectTimelineFromGeneratorRevision(
  input: { head: ProjectGenerator; revision: GeneratorRevision },
  definition: GeneratorDefinition,
): ProjectTimelineFromGeneratorRevisionResult {
  const { head, revision } = input;
  const generatorId = head.id;
  const revisionId = revision.id;

  if (revision.generatorId !== head.id) {
    return {
      ok: false,
      code: "GENERATOR_REVISION_GENERATOR_ID_MISMATCH",
      generatorId,
      revisionId,
    };
  }
  if (head.headRevisionId !== revision.id) {
    return {
      ok: false,
      code: "GENERATOR_HEAD_REVISION_ID_MISMATCH",
      generatorId,
      revisionId,
    };
  }

  const definitionRef: GeneratorDefinitionRef = {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
  if (
    !definitionRefsMatch(head.definitionRef, definitionRef) ||
    !definitionRefsMatch(revision.definitionRef, definitionRef)
  ) {
    return {
      ok: false,
      code: "GENERATOR_DEFINITION_REF_MISMATCH",
      generatorId,
      revisionId,
    };
  }

  const surface = definition.projectionSurface;
  if (!surface || surface.id !== "clash.timeline") {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_NOT_CLAIMED",
      generatorId,
      revisionId,
    };
  }
  if (!surface.mediaInputSlot) {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_MISSING_MEDIA_SLOT",
      generatorId,
      revisionId,
    };
  }

  const rawEnvelope = isRecord(revision.state)
    ? revision.state[surface.stateKey]
    : undefined;
  const envelopeParsed = ProjectTimelineEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelopeParsed.success) {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_ENVELOPE_INVALID",
      generatorId,
      revisionId,
    };
  }

  const validated = validateTimelineDsl(envelopeParsed.data.state);
  if (!validated.ok) {
    return {
      ok: false,
      code: "PROJECT_TIMELINE_DSL_INVALID",
      generatorId,
      revisionId,
    };
  }

  const timeline: ProjectTimeline = {
    id: head.id,
    name: envelopeParsed.data.name,
    owner: envelopeParsed.data.owner as TimelineOwner,
    revisionId: revision.id,
    state: validated.value,
  };

  return { ok: true, timeline };
}
