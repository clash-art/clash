import { describe, expect, it } from "vitest";

import {
  GeneratorDefinitionSchema,
  type GeneratorDefinition,
  type GeneratorRevision,
  type ProjectGenerator,
  type ProjectTimeline,
} from "./index.js";
import {
  ProjectTimelineEnvelopeSchema,
  projectTimelineFromGeneratorRevision,
  projectTimelineToGeneratorRevisionState,
} from "./timeline-generator-projection.js";

const SCHEMA_HASH =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

/** Minimal real Definition claiming the clash.timeline compatibility surface. */
function timelineDefinition(
  overrides: Record<string, unknown> = {},
): GeneratorDefinition {
  return GeneratorDefinitionSchema.parse({
    pluginId: "clash.remotion",
    definitionId: "timeline",
    version: "0.1.0",
    schemaHash: SCHEMA_HASH,
    stateSchema: { type: "object" },
    editPolicy: "advance-head",
    persistentInputs: [
      {
        slot: "timeline:item",
        accepts: [{ kind: "media", mediaKind: "video" }],
        cardinality: { minItems: 0, maxItems: null },
      },
    ],
    actions: [
      {
        id: "render",
        executorExportId: "render-timeline",
        parametersSchema: { type: "object" },
        invocationInputs: [],
        outputs: [
          {
            slot: "render:output",
            assetType: { kind: "media", mediaKind: "video" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
    ],
    projectionSurface: {
      id: "clash.timeline",
      stateKey: "timeline",
      mediaInputSlot: "timeline:item",
      primaryActionId: "render",
    },
    ...overrides,
  });
}

function projectTimelineFixture(
  overrides: Partial<ProjectTimeline> = {},
): ProjectTimeline {
  return {
    id: "timeline-1",
    name: "Rough cut",
    owner: { kind: "project" },
    revisionId: "timeline-rev-1",
    state: {
      tracks: [
        {
          id: "visuals",
          items: [
            {
              id: "shot-b",
              type: "video",
              assetId: "asset-b",
              from: 30,
              durationInFrames: 30,
            },
            {
              id: "shot-a",
              type: "video",
              assetId: "asset-a",
              from: 0,
              durationInFrames: 30,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function definitionRefOf(definition: GeneratorDefinition) {
  return {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
}

describe("Timeline <-> native Generator projection", () => {
  it("exports the strict Timeline envelope contract used by render executors", () => {
    expect(
      ProjectTimelineEnvelopeSchema.parse({
        name: "Rough cut",
        owner: { kind: "project" },
        state: { tracks: [] },
      }),
    ).toEqual({
      name: "Rough cut",
      owner: { kind: "project" },
      state: { tracks: [] },
    });
  });

  it("round-trips a named, owned, multi-item Project Timeline through a native Generator revision", () => {
    const definition = timelineDefinition();
    const timeline = projectTimelineFixture();

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      definition,
    );

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const generatorId = timeline.id;
    const revisionId = "generator-rev-1";

    const head: ProjectGenerator = {
      id: generatorId,
      headRevisionId: revisionId,
      definitionRef: definitionRefOf(definition),
    };

    const revision: GeneratorRevision = {
      id: revisionId,
      generatorId,
      definitionRef: definitionRefOf(definition),
      state: projected.state,
      persistentInputRefs: projected.persistentInputRefs,
    };

    // persistentInputRefs are keyed by item id, sorted stably, using the
    // Definition-declared media slot.
    expect(revision.persistentInputRefs.map((ref) => ref.itemKey)).toEqual([
      "shot-a",
      "shot-b",
    ]);
    for (const ref of revision.persistentInputRefs) {
      expect(ref.slot).toBe(
        definition.projectionSurface?.mediaInputSlot,
      );
    }

    const roundTripped = projectTimelineFromGeneratorRevision(
      { head, revision },
      definition,
    );

    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok) return;

    expect(roundTripped.timeline.id).toBe(timeline.id);
    expect(roundTripped.timeline.name).toBe(timeline.name);
    expect(roundTripped.timeline.owner).toEqual(timeline.owner);
    expect(roundTripped.timeline.state).toEqual(timeline.state);
    expect(roundTripped.timeline.revisionId).toBe(revision.id);
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("fails closed when a media item has a %s assetId", (_label, assetId) => {
    const timeline = projectTimelineFixture();
    const item = (timeline.state as { tracks: Array<{ items: Array<Record<string, unknown>> }> }).tracks[0]!.items[0]!;
    if (assetId === undefined) delete item.assetId;
    else item.assetId = assetId;

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      timelineDefinition(),
    );

    expect(projected).toMatchObject({ ok: false });
    if (projected.ok) return;
    expect(projected.code).toBe("PROJECT_TIMELINE_DSL_INVALID");
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("rejects a media item with a %s stable item id", (_label, itemId) => {
    const timeline = projectTimelineFixture();
    const item = (timeline.state as { tracks: Array<{ items: Array<Record<string, unknown>> }> }).tracks[0]!.items[0]!;
    if (itemId === undefined) delete item.id;
    else item.id = itemId;

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      timelineDefinition(),
    );

    expect(projected).toMatchObject({ ok: false });
    if (projected.ok) return;
    expect(projected.code).toBe(
      itemId === undefined
        ? "PROJECT_TIMELINE_DSL_INVALID"
        : "PROJECT_TIMELINE_MEDIA_ITEM_ID_REQUIRED",
    );
  });

  it("reports the Timeline DSL's global duplicate item-id error", () => {
    const timeline = projectTimelineFixture();
    const items = (timeline.state as { tracks: Array<{ items: Array<Record<string, unknown>> }> }).tracks[0]!.items;
    items[1]!.id = items[0]!.id;

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      timelineDefinition(),
    );

    expect(projected).toMatchObject({
      ok: false,
      code: "PROJECT_TIMELINE_DSL_INVALID",
    });
    if (projected.ok) return;
    expect(projected.message).toContain("duplicated");
  });

  it("does not require an Asset id or emit a persistent input for a non-media item", () => {
    const timeline = projectTimelineFixture({
      state: {
        tracks: [
          {
            id: "titles",
            items: [
              {
                id: "title-a",
                type: "text",
                text: "Hello",
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
        ],
      },
    });

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      timelineDefinition(),
    );

    expect(projected).toMatchObject({ ok: true, persistentInputRefs: [] });
  });

  it("fails closed with a structured error when the revision's definitionRef does not match the Definition", () => {
    const definition = timelineDefinition();
    const timeline = projectTimelineFixture();

    const projected = projectTimelineToGeneratorRevisionState(
      timeline,
      definition,
    );
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const generatorId = timeline.id;
    const revisionId = "generator-rev-1";

    const mismatchedDefinitionRef = {
      pluginId: definition.pluginId,
      definitionId: definition.definitionId,
      version: "0.2.0",
      schemaHash: definition.schemaHash,
    };

    const head: ProjectGenerator = {
      id: generatorId,
      headRevisionId: revisionId,
      definitionRef: mismatchedDefinitionRef,
    };

    const revision: GeneratorRevision = {
      id: revisionId,
      generatorId,
      definitionRef: mismatchedDefinitionRef,
      state: projected.state,
      persistentInputRefs: projected.persistentInputRefs,
    };

    const result = projectTimelineFromGeneratorRevision(
      { head, revision },
      definition,
    );

    expect(result).toEqual({
      ok: false,
      code: "GENERATOR_DEFINITION_REF_MISMATCH",
      generatorId,
      revisionId,
    });
  });
});

it('rejects same-lane overlaps when proposing a new generator revision', () => {
  const result = projectTimelineToGeneratorRevisionState(projectTimelineFixture({
    state: { tracks: [{ id: 'titles', items: [
      { id: 'one', type: 'text', text: 'one', from: 0, durationInFrames: 30 },
      { id: 'two', type: 'text', text: 'two', from: 10, durationInFrames: 30 },
    ] }] },
  }), timelineDefinition());
  expect(result).toMatchObject({ ok: false, code: 'TIMELINE_TRACK_OVERLAP', message: expect.stringContaining('two') });
});
