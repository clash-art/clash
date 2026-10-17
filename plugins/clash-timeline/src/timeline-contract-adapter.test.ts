import test from "node:test";
import assert from "node:assert/strict";
import {
  TIMELINE_DSL_DEFINITION,
  TIMELINE_OPERATION_REGISTRY,
} from "@clash/shared-types";

async function adapterModule(): Promise<Record<string, any>> {
  return import("./timeline-contract-adapter.js").catch(() => ({}));
}

test("maps MCP tools to the executable annotation registry", async () => {
  const module = await adapterModule();

  assert.deepEqual(module.TIMELINE_PLUGIN_OPERATION_IDS, {
    clash_timeline_open: "timeline.open",
    clash_timeline_schema: "timeline.schema",
    clash_timeline_validate: "timeline.validate",
    clash_timeline_list: "timeline.list",
    clash_timeline_get: "timeline.get",
    clash_timeline_create: "timeline.create",
    clash_timeline_save: "timeline.save",
    clash_timeline_attach: "timeline.attach",
    clash_timeline_detach: "timeline.detach",
    clash_timeline_copy: "timeline.copy",
    clash_timeline_render: "timeline.render",
  });

  for (const [toolName, operationId] of Object.entries(
    module.TIMELINE_PLUGIN_OPERATION_IDS as Record<string, string>,
  )) {
    const metadata = module.timelineOperationMetadata(toolName);
    assert.equal(metadata.id, operationId);
    assert.equal(
      metadata.description,
      (
        TIMELINE_OPERATION_REGISTRY.agent as Record<
          string,
          { description: string }
        >
      )[operationId].description,
    );
    assert.deepEqual(
      metadata,
      (
        TIMELINE_DSL_DEFINITION.operationCatalog.agent as Record<
          string,
          unknown
        >
      )[operationId],
    );
  }

  assert.equal(
    module.timelineOperationMetadata("clash_timeline_unknown"),
    undefined,
  );
});

test("publishes the complete annotation-generated Timeline state schema without copied field lists", async () => {
  const module = await adapterModule();
  const schema: any = module.timelineStateJsonSchema();
  const definition: any = TIMELINE_DSL_DEFINITION;

  assert.deepEqual(schema, TIMELINE_DSL_DEFINITION.jsonSchema);
  const root = (schema as any).definitions.TimelineDsl;
  assert.deepEqual(
    Object.keys(root.properties),
    Object.keys(definition.fieldCatalog.root.fields),
  );

  const track = root.properties.tracks.items;
  assert.deepEqual(
    Object.keys(track.properties),
    Object.keys(definition.fieldCatalog.track.fields),
  );

  const itemVariants = track.properties.items.items.anyOf;
  const itemTypes = itemVariants.map(
    (variant: any) => variant.properties.type.const,
  );
  assert.deepEqual(new Set(itemTypes), new Set(definition.taxonomy.itemTypes));
  for (const variant of itemVariants) {
    const type = variant.properties.type.const as string;
    const expectedFields = new Set([
      ...Object.keys(definition.fieldCatalog.itemBase.fields),
      ...Object.keys(definition.fieldCatalog.itemTypes[type].fields),
    ]);
    assert.deepEqual(
      new Set(Object.keys(variant.properties)),
      expectedFields,
      type,
    );
  }
});

test("adapts shared Zod validation into stable MCP rule ids", async () => {
  const module = await adapterModule();
  const valid = module.validateTimelineState({ tracks: [] });
  assert.deepEqual(valid, { ok: true, issues: [] });

  const invalidState = {
    tracks: [
      {
        id: "visual",
        items: [
          {
            id: "bad-fit",
            type: "image",
            from: 0,
            durationInFrames: 10,
            sourceNodeId: "asset-node",
            mediaFit: "stretch",
          },
        ],
      },
    ],
  };
  const invalid = module.validateTimelineState(invalidState);

  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues[0].ruleId, "timeline.dsl.structure");
  assert.deepEqual(invalid.issues[0].path.slice(-1), ["mediaFit"]);
  assert.throws(
    () => module.assertTimelineState(invalidState),
    (error: any) =>
      error?.code === "TIMELINE_DSL_INVALID" &&
      error?.issues?.[0]?.ruleId === "timeline.dsl.structure",
  );
});

test("runtime validation preserves authoritative fields and rejects retired Asset fields", async () => {
  const module = await adapterModule();
  const state = {
    compositionWidth: 1080,
    compositionHeight: 1920,
    fps: 30,
    durationInFrames: 90,
    primaryTrackId: null,
    assetTranscripts: {
      speech: {
        schemaVersion: 1,
        kind: "clash.editor.asset-transcript",
        assetId: "speech",
        text: "hello",
        durationMs: 1000,
        words: [{ id: "w1", text: "hello", startMs: 0, endMs: 500 }],
      },
    },
    "x-project-extension": { keep: true },
    tracks: [
      {
        id: "voice",
        name: "Voice",
        role: "narration",
        category: "audio",
        hidden: false,
        locked: false,
        "x-track-extension": { keep: true },
        items: [],
      },
    ],
  };

  const parsed = module
    .timelineOperationInputSchema("timeline.save")
    .safeParse({
      timelineId: "rough-cut",
      baseRevisionId: "revision-1",
      state,
    });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.state, state);

  const retiredStates = [
    {
      ...state,
      mediaAssetRefs: [{ assetId: "speech" }],
    },
    {
      ...state,
      tracks: [
        {
          id: "visual",
          items: [
            {
              id: "image",
              type: "image",
              from: 0,
              durationInFrames: 10,
              assetId: "asset-image",
              backingAssetId: "storage-row",
            },
          ],
        },
      ],
    },
  ];
  for (const retiredState of retiredStates) {
    assert.equal(
      module.timelineOperationInputSchema("timeline.validate").safeParse({
        document: retiredState,
      }).success,
      true,
    );
    const retired = module
      .timelineOperationInputSchema("timeline.save")
      .safeParse({
        timelineId: "rough-cut",
        baseRevisionId: "revision-1",
        state: retiredState,
      });
    assert.equal(retired.success, false);
    assert.deepEqual(
      module
        .validateTimelineState(retiredState)
        .issues.map((issue: { ruleId: string }) => issue.ruleId),
      ["timeline.asset.retired-field"],
    );
  }
});
