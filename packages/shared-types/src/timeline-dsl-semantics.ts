import {
  TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES,
  TIMELINE_DSL_ROLE_ALLOWED_ITEM_TYPES,
  TIMELINE_DSL_ROLE_CATEGORIES,
  TIMELINE_DSL_TRACK_CATEGORIES,
  type TimelineDslItemType,
  type TimelineDslTrackCategory,
  type TimelineDslTrackRole,
} from "./timeline-field-annotations.js";
import { parseFromExpression } from "./timeline-from-expression.js";

export type TimelineDslSemanticIssue = {
  ruleId: string;
  path: (string | number)[];
  message: string;
};

export const TIMELINE_DSL_GLOBAL_SEMANTIC_RULES = [
  {
    id: "timeline.track.duplicate-id",
    kind: "unique-field",
    objectPath: "tracks[]",
    field: "id",
  },
  {
    id: "timeline.item.duplicate-id",
    kind: "unique-field-global",
    objectPath: "tracks[].items[]",
    field: "id",
  },
  {
    id: "timeline.primary-track.reference",
    kind: "reference",
    objectPath: "primaryTrackId",
    targetPath: "tracks[].id",
  },
  {
    id: "timeline.primary-track.category",
    kind: "referenced-object-field",
    objectPath: "primaryTrackId",
    field: "category",
    allowedValues: ["primary"],
  },
  {
    id: "timeline.track.category-item-mismatch",
    kind: "allowed-item-types",
    objectPath: "tracks[]",
    discriminator: "category",
  },
  {
    id: "timeline.track.role-item-mismatch",
    kind: "allowed-item-types",
    objectPath: "tracks[]",
    discriminator: "role",
  },
  {
    id: "timeline.track.role-category",
    kind: "owner-field-consistency",
    objectPath: "tracks[]",
    fields: ["role", "category"],
    mapping: TIMELINE_DSL_ROLE_CATEGORIES,
  },
  {
    id: "timeline.track.category-order",
    kind: "ordered-enum",
    objectPath: "tracks[]",
    field: "category",
    order: TIMELINE_DSL_TRACK_CATEGORIES,
  },
  {
    id: "timeline.track.mixed-categories",
    kind: "single-structural-category",
    objectPath: "tracks[]",
  },
  {
    id: "timeline.item.from-expression",
    kind: "expression-grammar",
    objectPath: "tracks[].items[]",
    field: "from",
  },
  {
    id: "timeline.item.frame-integer",
    kind: "integer-frame",
    objectPath: "tracks[].items[]",
    field: "from",
  },
  {
    id: "timeline.item.from-reference",
    kind: "reference",
    objectPath: "tracks[].items[].from",
    targetPath: "tracks[].items[].id",
  },
  {
    id: "timeline.item.from-cycle",
    kind: "acyclic-reference",
    objectPath: "tracks[].items[].from",
  },
  {
    id: "timeline.item.source-required",
    kind: "requires-any-field",
    objectPath: "tracks[].items[]",
    fields: ["src", "assetId", "sourceNodeId"],
  },
  {
    id: "timeline.item.animation-duration",
    kind: "maximum-by-owner-field",
    objectPath: "tracks[].items[]",
    fields: [
      "entranceAnimation.durationInFrames",
      "exitAnimation.durationInFrames",
    ],
    maximumPath: "durationInFrames",
  },
  {
    id: "timeline.item.scale-unit",
    kind: "maximum-absolute-value",
    objectPath: "tracks[].items[]",
    fields: ["properties.width", "properties.height"],
    maximum: 4,
    unit: "unitless-source-size-multiplier",
  },
  {
    id: "timeline.audio.ducking-track-role",
    kind: "field-requires-owner-value",
    objectPath: "tracks[].items[]",
    field: "audioDucking",
    ownerField: "role",
    ownerValue: "music",
  },
  {
    id: "timeline.composition.local-path",
    kind: "local-path",
    objectPath: "tracks[].items[]",
    fields: ["sourcePath", "renderedAssetPath"],
  },
  {
    id: "timeline.composition.preview-contract",
    kind: "conditional-required",
    objectPath: "tracks[].items[]",
  },
  {
    id: "timeline.caption.structured",
    kind: "conditional-required",
    objectPath: "tracks[].items[]",
  },
  {
    id: "timeline.caption.lineage",
    kind: "cross-field-lineage",
    objectPath: "tracks[].items[]",
  },
  {
    id: "timeline.derived-overlay.local-path",
    kind: "local-path",
    objectPath: "tracks[].items[]",
    fields: ["src"],
  },
  {
    id: "timeline.derived-overlay.copy-on-write",
    kind: "distinct-fields",
    objectPath: "tracks[].items[]",
    fields: ["sourceAssetId", "derivedAssetId"],
  },
  {
    id: "timeline.transition.reference",
    kind: "references",
    objectPath: "tracks[].items[]",
    fields: ["fromItemId", "toItemId"],
  },
  {
    id: "timeline.transition.continuity",
    kind: "same-track-contiguous-references",
    objectPath: "tracks[].items[]",
  },
  {
    id: "timeline.transition.centered-range",
    kind: "centered-on-reference-boundary",
    objectPath: "tracks[].items[]",
  },
  {
    id: "timeline.transition.duration-handles",
    kind: "maximum-by-reference-handles",
    objectPath: "tracks[].items[]",
  },
] as const;

export type TimelineDslGlobalSemanticRuleId =
  (typeof TIMELINE_DSL_GLOBAL_SEMANTIC_RULES)[number]["id"];

type SemanticItem = Record<string, unknown> & {
  id: string;
  type: TimelineDslItemType;
  from: number | string;
  durationInFrames: number;
};

type SemanticTrack = Record<string, unknown> & {
  id: string;
  role?: TimelineDslTrackRole;
  category?: TimelineDslTrackCategory;
  items: SemanticItem[];
};

type SemanticTimeline = Record<string, unknown> & {
  primaryTrackId?: string | null;
  tracks: SemanticTrack[];
};

type IndexedItem = {
  item: SemanticItem;
  track: SemanticTrack;
  trackIndex: number;
  itemIndex: number;
};

type SemanticEvaluationContext = {
  timeline: SemanticTimeline;
  indexedItems: IndexedItem[];
  itemById: Map<string, IndexedItem>;
};

type SemanticRuleEvaluator = (
  context: SemanticEvaluationContext,
) => TimelineDslSemanticIssue[];

function issue(
  ruleId: TimelineDslGlobalSemanticRuleId,
  path: (string | number)[],
  message: string,
): TimelineDslSemanticIssue {
  return { ruleId, path, message };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocalProjectPath(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

function structuralCategory(
  type: TimelineDslItemType,
): Exclude<TimelineDslTrackCategory, "primary"> {
  if (type === "composition" || type === "transition") return "effect";
  if (type === "text") return "text";
  if (type === "audio") return "audio";
  return "visual";
}

function pushReferenceCycleIssues(
  indexedItems: IndexedItem[],
  itemById: Map<string, IndexedItem>,
  issues: TimelineDslSemanticIssue[],
): void {
  const references = new Map<string, string>();
  for (const indexed of indexedItems) {
    if (typeof indexed.item.from !== "string") continue;
    const expression = parseFromExpression(indexed.item.from);
    if (expression?.kind === "reference" && expression.refId !== "prev") {
      references.set(indexed.item.id, expression.refId);
    }
  }

  const complete = new Set<string>();
  for (const indexed of indexedItems) {
    if (complete.has(indexed.item.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | undefined = indexed.item.id;
    while (cursor && references.has(cursor) && !complete.has(cursor)) {
      const existing = positions.get(cursor);
      if (existing !== undefined) {
        for (const cyclicId of path.slice(existing)) {
          const cyclic = itemById.get(cyclicId);
          if (!cyclic) continue;
          issues.push(
            issue(
              "timeline.item.from-cycle",
              ["tracks", cyclic.trackIndex, "items", cyclic.itemIndex, "from"],
              `from expression for ${cyclicId} participates in a reference cycle`,
            ),
          );
        }
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = references.get(cursor);
    }
    path.forEach((id) => complete.add(id));
  }
}

function validateTransition(
  indexed: IndexedItem,
  itemById: Map<string, IndexedItem>,
  issues: TimelineDslSemanticIssue[],
): void {
  const { item, trackIndex, itemIndex } = indexed;
  if (item.type !== "transition") return;
  const itemPath = ["tracks", trackIndex, "items", itemIndex] as const;
  const fromId = item.fromItemId;
  const toId = item.toItemId;
  const from = nonEmptyString(fromId) ? itemById.get(fromId) : undefined;
  const to = nonEmptyString(toId) ? itemById.get(toId) : undefined;
  if (!from || !to) {
    issues.push(
      issue(
        "timeline.transition.reference",
        [...itemPath],
        "transition must reference two existing Timeline items",
      ),
    );
    return;
  }
  const transitionClipTypes = new Set<TimelineDslItemType>([
    "video",
    "image",
    "solid",
    "text",
  ]);
  const boundary =
    typeof from.item.from === "number"
      ? from.item.from + from.item.durationInFrames
      : Number.NaN;
  if (
    from.track.id !== to.track.id ||
    !transitionClipTypes.has(from.item.type) ||
    !transitionClipTypes.has(to.item.type) ||
    boundary !== to.item.from
  ) {
    issues.push(
      issue(
        "timeline.transition.continuity",
        [...itemPath],
        "transition references must be contiguous visual clips on the same track",
      ),
    );
    return;
  }
  if (typeof item.from === "number") {
    const expectedFrom = boundary - Math.floor(item.durationInFrames / 2);
    if (item.from !== expectedFrom) {
      issues.push(
        issue(
          "timeline.transition.centered-range",
          [...itemPath, "from"],
          `transition range must be centered on frame ${boundary}`,
        ),
      );
    }
  }
  const maximum = Math.max(
    1,
    Math.min(from.item.durationInFrames, to.item.durationInFrames) * 2,
  );
  if (item.durationInFrames > maximum) {
    issues.push(
      issue(
        "timeline.transition.duration-handles",
        [...itemPath, "durationInFrames"],
        `transition duration cannot exceed ${maximum} frames for these clips`,
      ),
    );
  }
}

function validFrameRange(start: unknown, end: unknown): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number)
  );
}

function validateCaption(
  indexed: IndexedItem,
  issues: TimelineDslSemanticIssue[],
): void {
  const { item, track, trackIndex, itemIndex } = indexed;
  if (
    item.type !== "text" ||
    (track.role !== "subtitle" && !Array.isArray(item.cues))
  )
    return;
  const itemPath = ["tracks", trackIndex, "items", itemIndex] as const;
  const cues = Array.isArray(item.cues)
    ? (item.cues as Array<Record<string, unknown>>)
    : [];
  const wordRefs = Array.isArray(item.wordRefs)
    ? (item.wordRefs as Array<Record<string, unknown>>)
    : [];
  const mappings = Array.isArray(item.sourceToOutputMap)
    ? (item.sourceToOutputMap as Array<Record<string, unknown>>)
    : [];
  if (cues.length === 0 || wordRefs.length === 0 || mappings.length === 0) {
    issues.push(
      issue(
        "timeline.caption.structured",
        [...itemPath],
        "structured caption text requires non-empty cues, wordRefs, and sourceToOutputMap",
      ),
    );
    return;
  }

  const wordIds = new Set<string>();
  wordRefs.forEach((word, wordIndex) => {
    if (nonEmptyString(word.id)) wordIds.add(word.id);
    if (
      !nonEmptyString(word.id) ||
      !validFrameRange(word.sourceStartFrame, word.sourceEndFrame)
    ) {
      issues.push(
        issue(
          "timeline.caption.lineage",
          [...itemPath, "wordRefs", wordIndex],
          "caption word reference requires an id and a valid source frame range",
        ),
      );
    }
  });
  mappings.forEach((mapping, mappingIndex) => {
    if (
      !validFrameRange(mapping.sourceStartFrame, mapping.sourceEndFrame) ||
      !validFrameRange(mapping.outputStartFrame, mapping.outputEndFrame)
    ) {
      issues.push(
        issue(
          "timeline.caption.lineage",
          [...itemPath, "sourceToOutputMap", mappingIndex],
          "caption source-to-output mapping requires valid source and output frame ranges",
        ),
      );
    }
  });
  cues.forEach((cue, cueIndex) => {
    const cueStart = cue.startFrame;
    const cueDuration = cue.durationInFrames;
    const cueEnd =
      typeof cueStart === "number" && typeof cueDuration === "number"
        ? cueStart + cueDuration
        : Number.NaN;
    const cueWordIds = Array.isArray(cue.wordIds) ? cue.wordIds : [];
    const covered = mappings.some(
      (mapping) =>
        validFrameRange(mapping.sourceStartFrame, mapping.sourceEndFrame) &&
        validFrameRange(mapping.outputStartFrame, mapping.outputEndFrame) &&
        typeof cue.sourceStartFrame === "number" &&
        typeof cue.sourceEndFrame === "number" &&
        typeof cueStart === "number" &&
        cue.sourceStartFrame >= (mapping.sourceStartFrame as number) &&
        cue.sourceEndFrame <= (mapping.sourceEndFrame as number) &&
        cueStart >= (mapping.outputStartFrame as number) &&
        cueEnd <= (mapping.outputEndFrame as number),
    );
    if (
      !nonEmptyString(cue.id) ||
      !nonEmptyString(cue.text) ||
      !Number.isInteger(cueStart) ||
      !Number.isInteger(cueDuration) ||
      (cueStart as number) < 0 ||
      (cueDuration as number) <= 0 ||
      cueEnd > item.durationInFrames ||
      !validFrameRange(cue.sourceStartFrame, cue.sourceEndFrame) ||
      cueWordIds.length === 0 ||
      cueWordIds.some(
        (wordId) => !nonEmptyString(wordId) || !wordIds.has(wordId),
      ) ||
      !covered
    ) {
      issues.push(
        issue(
          "timeline.caption.lineage",
          [...itemPath, "cues", cueIndex],
          "caption cue must fit the item and be covered by valid source word and frame lineage",
        ),
      );
    }
  });
}

function createSemanticEvaluationContext(
  timeline: SemanticTimeline,
): SemanticEvaluationContext {
  const indexedItems: IndexedItem[] = [];
  const itemById = new Map<string, IndexedItem>();
  timeline.tracks.forEach((track, trackIndex) => {
    track.items.forEach((item, itemIndex) => {
      const indexed = { item, track, trackIndex, itemIndex };
      indexedItems.push(indexed);
      if (!itemById.has(item.id)) itemById.set(item.id, indexed);
    });
  });
  return { timeline, indexedItems, itemById };
}

function evaluateStructuralSemanticRules(
  context: SemanticEvaluationContext,
): TimelineDslSemanticIssue[] {
  const { timeline, itemById } = context;
  const issues: TimelineDslSemanticIssue[] = [];
  const trackIds = new Set<string>();
  const itemIds = new Set<string>();
  let previousCategoryRank = -1;

  timeline.tracks.forEach((track, trackIndex) => {
    if (trackIds.has(track.id)) {
      issues.push(
        issue(
          "timeline.track.duplicate-id",
          ["tracks", trackIndex, "id"],
          `track id ${track.id} is duplicated`,
        ),
      );
    }
    trackIds.add(track.id);

    if (track.category) {
      const rank = TIMELINE_DSL_TRACK_CATEGORIES.indexOf(track.category);
      if (rank < previousCategoryRank) {
        issues.push(
          issue(
            "timeline.track.category-order",
            ["tracks", trackIndex, "category"],
            "track categories must follow effect, text, visual, primary, audio order",
          ),
        );
      }
      previousCategoryRank = Math.max(previousCategoryRank, rank);
    }
    if (track.role && track.category) {
      const expectedCategory = TIMELINE_DSL_ROLE_CATEGORIES[track.role];
      if (expectedCategory !== null && expectedCategory !== track.category) {
        issues.push(
          issue(
            "timeline.track.role-category",
            ["tracks", trackIndex, "category"],
            `track role ${track.role} requires category ${expectedCategory}`,
          ),
        );
      }
    }

    const structuralCategories = new Set(
      track.items.map((item) => structuralCategory(item.type)),
    );
    const legacyPrimary =
      timeline.primaryTrackId === track.id || track.role === "primary-video";
    const primaryCompatible = track.items.every((item) =>
      (
        TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES.primary as readonly string[]
      ).includes(item.type),
    );
    if (
      !track.category &&
      structuralCategories.size > 1 &&
      !(legacyPrimary && primaryCompatible)
    ) {
      issues.push(
        issue(
          "timeline.track.mixed-categories",
          ["tracks", trackIndex, "items"],
          `track ${track.id} mixes incompatible structural item categories`,
        ),
      );
    }

    track.items.forEach((item, itemIndex) => {
      const itemPath = ["tracks", trackIndex, "items", itemIndex] as const;
      if (itemIds.has(item.id)) {
        issues.push(
          issue(
            "timeline.item.duplicate-id",
            [...itemPath, "id"],
            `Timeline item id ${item.id} is duplicated`,
          ),
        );
      }
      itemIds.add(item.id);

      if (track.category) {
        const allowed = TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES[
          track.category
        ] as readonly string[];
        if (!allowed.includes(item.type)) {
          issues.push(
            issue(
              "timeline.track.category-item-mismatch",
              [...itemPath],
              `track category ${track.category} cannot contain ${item.type} items`,
            ),
          );
        }
      }
      if (track.role) {
        const allowed = TIMELINE_DSL_ROLE_ALLOWED_ITEM_TYPES[
          track.role
        ] as readonly string[];
        if (!allowed.includes(item.type)) {
          issues.push(
            issue(
              "timeline.track.role-item-mismatch",
              [...itemPath],
              `track role ${track.role} cannot contain ${item.type} items`,
            ),
          );
        }
      }

      const expression = parseFromExpression(item.from);
      const negativeNumericString =
        typeof item.from === "string" &&
        Number.isFinite(Number(item.from.trim())) &&
        Number(item.from.trim()) < 0;
      if (!expression || negativeNumericString) {
        issues.push(
          issue(
            "timeline.item.from-expression",
            [...itemPath, "from"],
            "from must be a non-negative frame or a valid Timeline relative expression",
          ),
        );
      } else if (
        expression.kind === "reference" &&
        expression.refId !== "prev" &&
        !itemById.has(expression.refId)
      ) {
        issues.push(
          issue(
            "timeline.item.from-reference",
            [...itemPath, "from"],
            `from expression references unknown item ${expression.refId}`,
          ),
        );
      }
      if (
        expression &&
        (expression.kind === "absolute"
          ? !Number.isInteger(expression.value)
          : !Number.isInteger(expression.offset))
      ) {
        issues.push(
          issue(
            "timeline.item.frame-integer",
            [...itemPath, "from"],
            "Timeline frame positions and expression offsets must be integers",
          ),
        );
      }

      if (["video", "audio", "image", "sticker"].includes(item.type)) {
        if (![item.src, item.assetId, item.sourceNodeId].some(nonEmptyString)) {
          issues.push(
            issue(
              "timeline.item.source-required",
              [...itemPath],
              `${item.type} item must provide src, assetId, or sourceNodeId`,
            ),
          );
        }
      }

      for (const animationField of [
        "entranceAnimation",
        "exitAnimation",
      ] as const) {
        const animation = item[animationField] as
          Record<string, unknown> | undefined;
        if (
          animation &&
          typeof animation.durationInFrames === "number" &&
          animation.durationInFrames > item.durationInFrames
        ) {
          issues.push(
            issue(
              "timeline.item.animation-duration",
              [...itemPath, animationField, "durationInFrames"],
              `${animationField} cannot exceed the owning item duration`,
            ),
          );
        }
      }

      const properties = item.properties as Record<string, unknown> | undefined;
      for (const field of ["width", "height"] as const) {
        const value = properties?.[field];
        if (typeof value === "number" && Math.abs(value) > 4) {
          issues.push(
            issue(
              "timeline.item.scale-unit",
              [...itemPath, "properties", field],
              `properties.${field} is a unitless source-size multiplier, not pixels, and must be at most 4`,
            ),
          );
        }
      }

      if (
        item.type === "audio" &&
        item.audioDucking !== undefined &&
        track.role !== "music"
      ) {
        issues.push(
          issue(
            "timeline.audio.ducking-track-role",
            [...itemPath, "audioDucking"],
            "audioDucking is only valid for audio items on a music track",
          ),
        );
      }

      if (item.type === "composition") {
        if (!isLocalProjectPath(item.sourcePath)) {
          issues.push(
            issue(
              "timeline.composition.local-path",
              [...itemPath, "sourcePath"],
              "composition sourcePath must be a local project path",
            ),
          );
        }
        if (
          item.renderedAssetPath !== undefined &&
          !isLocalProjectPath(item.renderedAssetPath)
        ) {
          issues.push(
            issue(
              "timeline.composition.local-path",
              [...itemPath, "renderedAssetPath"],
              "composition renderedAssetPath must be a local project path",
            ),
          );
        }
        if (
          item.compositionKind === "motion-graphics" &&
          item.runtime !== "remotion" &&
          item.runtime !== "html"
        ) {
          issues.push(
            issue(
              "timeline.composition.preview-contract",
              [...itemPath, "runtime"],
              "motion-graphics compositions must use Remotion or HTML with a live Canvas sourceNodeId",
            ),
          );
        }
        if (
          (item.runtime === "remotion" ||
            (item.compositionKind === "motion-graphics" &&
              item.runtime === "html")) &&
          !nonEmptyString(item.sourceNodeId)
        ) {
          issues.push(
            issue(
              "timeline.composition.preview-contract",
              [...itemPath, "sourceNodeId"],
              `${item.runtime === "html" ? "HTML" : "Remotion"} compositions require a live Canvas sourceNodeId`,
            ),
          );
        }
        if (
          item.runtime === "react" &&
          !isLocalProjectPath(item.renderedAssetPath)
        ) {
          issues.push(
            issue(
              "timeline.composition.preview-contract",
              [...itemPath, "renderedAssetPath"],
              "React compositions require a local renderedAssetPath",
            ),
          );
        }
      }

      if (item.type === "derived-overlay") {
        if (!isLocalProjectPath(item.src)) {
          issues.push(
            issue(
              "timeline.derived-overlay.local-path",
              [...itemPath, "src"],
              "derived overlay src must be a local project or asset path",
            ),
          );
        }
        if (
          item.sourceAssetId === item.derivedAssetId ||
          (nonEmptyString(item.assetId) && item.assetId !== item.derivedAssetId)
        ) {
          issues.push(
            issue(
              "timeline.derived-overlay.copy-on-write",
              [...itemPath],
              "derived overlay source and derived identities must be distinct and assetId must identify the derived copy",
            ),
          );
        }
      }
    });
  });

  return issues;
}

function evaluatePrimaryTrackSemanticRules(
  context: SemanticEvaluationContext,
): TimelineDslSemanticIssue[] {
  const { timeline } = context;
  const issues: TimelineDslSemanticIssue[] = [];
  if (nonEmptyString(timeline.primaryTrackId)) {
    const primaryTrack = timeline.tracks.find(
      (track) => track.id === timeline.primaryTrackId,
    );
    if (!primaryTrack) {
      issues.push(
        issue(
          "timeline.primary-track.reference",
          ["primaryTrackId"],
          "primaryTrackId must reference an existing track",
        ),
      );
    } else if (primaryTrack.category && primaryTrack.category !== "primary") {
      issues.push(
        issue(
          "timeline.primary-track.category",
          ["primaryTrackId"],
          "primaryTrackId must reference a primary category track",
        ),
      );
    }
  }
  return issues;
}

function evaluateReferenceCycleSemanticRules(
  context: SemanticEvaluationContext,
): TimelineDslSemanticIssue[] {
  const issues: TimelineDslSemanticIssue[] = [];
  pushReferenceCycleIssues(context.indexedItems, context.itemById, issues);
  return issues;
}

function evaluateCaptionSemanticRules(
  context: SemanticEvaluationContext,
): TimelineDslSemanticIssue[] {
  const issues: TimelineDslSemanticIssue[] = [];
  context.indexedItems.forEach((indexed) => validateCaption(indexed, issues));
  return issues;
}

function evaluateTransitionSemanticRules(
  context: SemanticEvaluationContext,
): TimelineDslSemanticIssue[] {
  const issues: TimelineDslSemanticIssue[] = [];
  context.indexedItems.forEach((indexed) =>
    validateTransition(indexed, context.itemById, issues),
  );
  return issues;
}

/**
 * Exhaustive ownership gate between every published global rule id and the
 * evaluator responsible for it. Several ids intentionally share a composite
 * evaluator so Timeline indexing and traversal happen once; reachability tests
 * prove that each owned id can still be emitted independently.
 */
export const TIMELINE_DSL_GLOBAL_SEMANTIC_EVALUATORS = Object.freeze({
  "timeline.track.duplicate-id": evaluateStructuralSemanticRules,
  "timeline.item.duplicate-id": evaluateStructuralSemanticRules,
  "timeline.primary-track.reference": evaluatePrimaryTrackSemanticRules,
  "timeline.primary-track.category": evaluatePrimaryTrackSemanticRules,
  "timeline.track.category-item-mismatch": evaluateStructuralSemanticRules,
  "timeline.track.role-item-mismatch": evaluateStructuralSemanticRules,
  "timeline.track.role-category": evaluateStructuralSemanticRules,
  "timeline.track.category-order": evaluateStructuralSemanticRules,
  "timeline.track.mixed-categories": evaluateStructuralSemanticRules,
  "timeline.item.from-expression": evaluateStructuralSemanticRules,
  "timeline.item.frame-integer": evaluateStructuralSemanticRules,
  "timeline.item.from-reference": evaluateStructuralSemanticRules,
  "timeline.item.from-cycle": evaluateReferenceCycleSemanticRules,
  "timeline.item.source-required": evaluateStructuralSemanticRules,
  "timeline.item.animation-duration": evaluateStructuralSemanticRules,
  "timeline.item.scale-unit": evaluateStructuralSemanticRules,
  "timeline.audio.ducking-track-role": evaluateStructuralSemanticRules,
  "timeline.composition.local-path": evaluateStructuralSemanticRules,
  "timeline.composition.preview-contract": evaluateStructuralSemanticRules,
  "timeline.caption.structured": evaluateCaptionSemanticRules,
  "timeline.caption.lineage": evaluateCaptionSemanticRules,
  "timeline.derived-overlay.local-path": evaluateStructuralSemanticRules,
  "timeline.derived-overlay.copy-on-write": evaluateStructuralSemanticRules,
  "timeline.transition.reference": evaluateTransitionSemanticRules,
  "timeline.transition.continuity": evaluateTransitionSemanticRules,
  "timeline.transition.centered-range": evaluateTransitionSemanticRules,
  "timeline.transition.duration-handles": evaluateTransitionSemanticRules,
} satisfies Record<TimelineDslGlobalSemanticRuleId, SemanticRuleEvaluator>);

/** Execute every cross-field and cross-object rule published with the DSL. */
export function timelineDslSemanticIssues(
  input: unknown,
): TimelineDslSemanticIssue[] {
  const context = createSemanticEvaluationContext(input as SemanticTimeline);
  const issues: TimelineDslSemanticIssue[] = [];
  const compositeEvaluators = new Set<SemanticRuleEvaluator>(
    Object.values(TIMELINE_DSL_GLOBAL_SEMANTIC_EVALUATORS),
  );
  for (const evaluator of compositeEvaluators)
    issues.push(...evaluator(context));
  return issues;
}
