import { describe, expect, it } from "vitest";
import { TIMELINE_DSL_DEFINITION, validateTimelineDsl } from "./index.js";
import * as semantics from "./timeline-dsl-semantics.js";

function validationRuleIds(state: unknown): string[] {
  const result = validateTimelineDsl(state);
  if (result.ok) return [];
  return result.issues.map((issue) => issue.ruleId);
}

function clip(
  id: string,
  type: string,
  from: number | string,
  fields: Record<string, unknown> = {},
) {
  return { id, type, from, durationInFrames: 30, ...fields };
}

const GLOBAL_RULE_REACHABILITY_CASES = [
  {
    name: "duplicate track ids",
    expected: "timeline.track.duplicate-id",
    state: {
      tracks: [
        { id: "same", items: [] },
        { id: "same", items: [] },
      ],
    },
  },
  {
    name: "duplicate global item ids",
    expected: "timeline.item.duplicate-id",
    state: {
      tracks: [
        { id: "a", items: [clip("same", "solid", 0, { color: "black" })] },
        { id: "b", items: [clip("same", "solid", 30, { color: "white" })] },
      ],
    },
  },
  {
    name: "missing primary track reference",
    expected: "timeline.primary-track.reference",
    state: { primaryTrackId: "missing", tracks: [] },
  },
  {
    name: "primary track with a non-primary category",
    expected: "timeline.primary-track.category",
    state: {
      primaryTrackId: "main",
      tracks: [{ id: "main", category: "visual", items: [] }],
    },
  },
  {
    name: "primary category with standalone audio",
    expected: "timeline.track.category-item-mismatch",
    state: {
      primaryTrackId: "main",
      tracks: [
        {
          id: "main",
          category: "primary",
          items: [clip("audio", "audio", 0, { src: "/voice.wav" })],
        },
      ],
    },
  },
  {
    name: "music role with image",
    expected: "timeline.track.role-item-mismatch",
    state: {
      tracks: [
        {
          id: "music",
          role: "music",
          items: [clip("cover", "image", 0, { src: "/cover.png" })],
        },
      ],
    },
  },
  {
    name: "role and lane category disagree",
    expected: "timeline.track.role-category",
    state: {
      tracks: [
        {
          id: "music",
          role: "music",
          category: "visual",
          items: [],
        },
      ],
    },
  },
  {
    name: "noncanonical category order",
    expected: "timeline.track.category-order",
    state: {
      tracks: [
        { id: "audio", category: "audio", items: [] },
        { id: "visual", category: "visual", items: [] },
      ],
    },
  },
  {
    name: "legacy lane mixing structural categories",
    expected: "timeline.track.mixed-categories",
    state: {
      tracks: [
        {
          id: "mixed",
          items: [
            clip("background", "solid", 0, { color: "black" }),
            clip("title", "text", 0, { text: "Title", color: "white" }),
          ],
        },
      ],
    },
  },
  {
    name: "malformed from expression",
    expected: "timeline.item.from-expression",
    state: {
      tracks: [
        {
          id: "visual",
          items: [
            clip("bad-from", "solid", "not a valid expression!", {
              color: "black",
            }),
          ],
        },
      ],
    },
  },
  {
    name: "fractional Timeline frame",
    expected: "timeline.item.frame-integer",
    state: {
      tracks: [
        {
          id: "visual",
          items: [clip("fractional", "solid", 1.5, { color: "black" })],
        },
      ],
    },
  },
  {
    name: "from expression with an unknown item reference",
    expected: "timeline.item.from-reference",
    state: {
      tracks: [
        {
          id: "visual",
          items: [clip("dependent", "solid", "missing", { color: "black" })],
        },
      ],
    },
  },
  {
    name: "cyclic from expressions",
    expected: "timeline.item.from-cycle",
    state: {
      tracks: [
        {
          id: "visual",
          items: [
            clip("a", "solid", "b", { color: "black" }),
            clip("b", "solid", "a", { color: "white" }),
          ],
        },
      ],
    },
  },
  {
    name: "unresolved media source",
    expected: "timeline.item.source-required",
    state: {
      tracks: [{ id: "visual", items: [clip("missing-src", "video", 0)] }],
    },
  },
  {
    name: "animation longer than clip",
    expected: "timeline.item.animation-duration",
    state: {
      tracks: [
        {
          id: "visual",
          items: [
            clip("animated", "video", 0, {
              src: "/video.mp4",
              entranceAnimation: { type: "fade", durationInFrames: 31 },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "pixel dimensions authored as static item scale",
    expected: "timeline.item.scale-unit",
    state: {
      tracks: [
        {
          id: "visual",
          items: [
            clip("pixel-sized", "image", 0, {
              src: "assets/character.png",
              properties: { x: 0, y: 0, width: 720, height: 1280 },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "ducking outside music lane",
    expected: "timeline.audio.ducking-track-role",
    state: {
      tracks: [
        {
          id: "voice",
          role: "narration",
          items: [
            clip("voice", "audio", 0, {
              src: "/voice.wav",
              audioDucking: {
                amountDb: -18,
                attackFrames: 6,
                releaseFrames: 12,
              },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "remote composition source",
    expected: "timeline.composition.local-path",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("remote", "composition", 0, {
              compositionKind: "custom",
              runtime: "html",
              compositionId: "remote",
              sourcePath: "https://example.com/app.html",
            }),
          ],
        },
      ],
    },
  },
  {
    name: "composition without a required preview artifact",
    expected: "timeline.composition.preview-contract",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("react", "composition", 0, {
              compositionKind: "custom",
              runtime: "react",
              compositionId: "react",
              sourcePath: "compositions/react.tsx",
            }),
          ],
        },
      ],
    },
  },
  {
    name: "HTML motion graphics without a live Canvas source node",
    expected: "timeline.composition.preview-contract",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("bad-mg", "composition", 0, {
              compositionKind: "motion-graphics",
              runtime: "html",
              compositionId: "bad-mg",
              sourcePath: "./bad-mg.html",
              spec: {
                id: "bad-mg",
                width: 1080,
                height: 1920,
                fps: 30,
                durationInFrames: 30,
                layers: [],
              },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "motion graphics with a non-live runtime",
    expected: "timeline.composition.preview-contract",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("react-mg", "composition", 0, {
              compositionKind: "motion-graphics",
              runtime: "react",
              compositionId: "react-mg",
              sourcePath: "compositions/react-mg.tsx",
              sourceNodeId: "canvas-node",
              renderedAssetPath: "compositions/react-mg.mp4",
            }),
          ],
        },
      ],
    },
  },
  {
    name: "subtitle without structured lineage",
    expected: "timeline.caption.structured",
    state: {
      tracks: [
        {
          id: "captions",
          role: "subtitle",
          category: "text",
          items: [
            clip("caption", "text", 0, { text: "hello", color: "white" }),
          ],
        },
      ],
    },
  },
  {
    name: "caption with unverifiable lineage",
    expected: "timeline.caption.lineage",
    state: {
      tracks: [
        {
          id: "captions",
          role: "subtitle",
          category: "text",
          items: [
            clip("caption", "text", 0, {
              text: "hello",
              color: "white",
              cues: [
                {
                  id: "cue-1",
                  startFrame: 0,
                  durationInFrames: 10,
                  text: "hello",
                  wordIds: ["missing"],
                  sourceStartFrame: 0,
                  sourceEndFrame: 10,
                },
              ],
              wordRefs: [
                {
                  id: "word-1",
                  text: "hello",
                  sourceStartFrame: 0,
                  sourceEndFrame: 10,
                },
              ],
              sourceToOutputMap: [
                {
                  sourceStartFrame: 20,
                  sourceEndFrame: 30,
                  outputStartFrame: 0,
                  outputEndFrame: 10,
                },
              ],
            }),
          ],
        },
      ],
    },
  },
  {
    name: "derived overlay with a remote source",
    expected: "timeline.derived-overlay.local-path",
    state: {
      tracks: [
        {
          id: "overlays",
          items: [
            clip("derived", "derived-overlay", 0, {
              mediaType: "image",
              src: "https://example.com/derived.webp",
              sourceAssetId: "source",
              derivedAssetId: "derived",
              derivation: { kind: "crop" },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "derived overlay without copy-on-write identity",
    expected: "timeline.derived-overlay.copy-on-write",
    state: {
      tracks: [
        {
          id: "overlays",
          items: [
            clip("derived", "derived-overlay", 0, {
              mediaType: "image",
              src: "assets/derived.webp",
              sourceAssetId: "same",
              derivedAssetId: "same",
              derivation: { kind: "crop" },
            }),
          ],
        },
      ],
    },
  },
  {
    name: "transition with unknown refs",
    expected: "timeline.transition.reference",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("transition", "transition", 15, {
              transitionType: "crossfade",
              fromItemId: "missing-a",
              toItemId: "missing-b",
            }),
          ],
        },
      ],
    },
  },
  {
    name: "transition between non-contiguous clips",
    expected: "timeline.transition.continuity",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("transition", "transition", 15, {
              transitionType: "crossfade",
              fromItemId: "a",
              toItemId: "b",
            }),
          ],
        },
        {
          id: "visual",
          category: "visual",
          items: [
            clip("a", "video", 0, { src: "assets/a.mp4" }),
            clip("b", "image", 45, { src: "assets/b.webp" }),
          ],
        },
      ],
    },
  },
  {
    name: "transition detached from the clip boundary",
    expected: "timeline.transition.centered-range",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("transition", "transition", 0, {
              durationInFrames: 10,
              transitionType: "crossfade",
              fromItemId: "a",
              toItemId: "b",
            }),
          ],
        },
        {
          id: "visual",
          category: "visual",
          items: [
            clip("a", "video", 0, { src: "assets/a.mp4" }),
            clip("b", "image", 30, { src: "assets/b.webp" }),
          ],
        },
      ],
    },
  },
  {
    name: "transition longer than its available handles",
    expected: "timeline.transition.duration-handles",
    state: {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("transition", "transition", 0, {
              durationInFrames: 11,
              transitionType: "crossfade",
              fromItemId: "a",
              toItemId: "b",
            }),
          ],
        },
        {
          id: "visual",
          category: "visual",
          items: [
            clip("a", "video", 0, { durationInFrames: 5, src: "assets/a.mp4" }),
            clip("b", "image", 5, {
              durationInFrames: 5,
              src: "assets/b.webp",
            }),
          ],
        },
      ],
    },
  },
] as const;

function compositionState(sourcePath: string) {
  return {
    tracks: [
      {
        id: "effects",
        category: "effect",
        items: [
          clip("composition", "composition", 0, {
            compositionKind: "custom",
            runtime: "html",
            compositionId: "composition",
            sourcePath,
          }),
        ],
      },
    ],
  };
}

describe("complete Timeline semantic contract", () => {
  it("accepts a live Remotion component as a visual overlay asset", () => {
    const result = validateTimelineDsl({
      tracks: [
        {
          id: "remotion-overlays",
          role: "overlay",
          category: "visual",
          items: [
            clip("live-character", "composition", 0, {
              compositionKind: "custom",
              runtime: "remotion",
              compositionId: "LiveCharacter",
              sourcePath: "components/live-character.tsx",
              sourceNodeId: "remotion-node-fixed",
            }),
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a live HTML motion-graphics source on an overlay track", () => {
    const result = validateTimelineDsl({
      tracks: [
        {
          id: "html-overlays",
          role: "overlay",
          category: "visual",
          items: [
            clip("live-lower-third", "composition", 0, {
              compositionKind: "motion-graphics",
              runtime: "html",
              compositionId: "lower-third",
              sourcePath: "compositions/lower-third/index.html",
              sourceNodeId: "html-mg-node-fixed",
            }),
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("explains that oversized static item dimensions are multipliers rather than pixels", () => {
    const result = validateTimelineDsl({
      tracks: [
        {
          id: "visual",
          items: [
            clip("pixel-sized", "image", 0, {
              src: "assets/character.png",
              properties: { x: 0, y: 0, width: 720, height: 1280 },
            }),
          ],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        ruleId: "timeline.item.scale-unit",
        path: ["tracks", 0, "items", 0, "properties", "width"],
        message: expect.stringMatching(/unitless.*multiplier.*not pixels.*4/i),
      }),
    );
  });

  it.each(GLOBAL_RULE_REACHABILITY_CASES)(
    "rejects $name with a stable rule id",
    ({ state, expected }) => {
      expect(validationRuleIds(state)).toContain(expected);
    },
  );

  it("has one explicit evaluator owner for every published global rule", () => {
    const published = semantics.TIMELINE_DSL_GLOBAL_SEMANTIC_RULES.map(
      (rule) => rule.id,
    );
    const evaluatorOwners =
      (
        semantics as unknown as {
          TIMELINE_DSL_GLOBAL_SEMANTIC_EVALUATORS?: Record<string, unknown>;
        }
      ).TIMELINE_DSL_GLOBAL_SEMANTIC_EVALUATORS ?? {};

    expect(Object.keys(evaluatorOwners)).toEqual(published);
    expect(
      Object.values(evaluatorOwners).every(
        (owner) => typeof owner === "function",
      ),
    ).toBe(true);
  });

  it("keeps a triggerable regression fixture for every published global rule", () => {
    const published = semantics.TIMELINE_DSL_GLOBAL_SEMANTIC_RULES.map(
      (rule) => rule.id,
    ).sort();
    const reachable = [
      ...new Set(
        GLOBAL_RULE_REACHABILITY_CASES.map(({ expected }) => expected),
      ),
    ].sort();

    expect(reachable).toEqual(published);
  });

  it.each([
    "/tmp/composition.tsx",
    "../outside/composition.tsx",
    "compositions/../../outside.tsx",
    "C:\\outside\\composition.tsx",
  ])("rejects non-project-local composition path %s", (sourcePath) => {
    expect(validationRuleIds(compositionState(sourcePath))).toContain(
      "timeline.composition.local-path",
    );
  });

  it.each([
    "compositions/title.tsx",
    "./compositions/title.tsx",
    "compositions/title..v2.tsx",
  ])("accepts safe relative composition path %s", (sourcePath) => {
    expect(validationRuleIds(compositionState(sourcePath))).not.toContain(
      "timeline.composition.local-path",
    );
  });

  it("accepts transitions between contiguous text clips supported by the renderer", () => {
    const state = {
      tracks: [
        {
          id: "effects",
          category: "effect",
          items: [
            clip("transition", "transition", 25, {
              durationInFrames: 10,
              transitionType: "crossfade",
              fromItemId: "title-a",
              toItemId: "title-b",
            }),
          ],
        },
        {
          id: "titles",
          category: "text",
          items: [
            clip("title-a", "text", 0, { text: "A", color: "white" }),
            clip("title-b", "text", 30, { text: "B", color: "white" }),
          ],
        },
      ],
    };

    expect(validationRuleIds(state)).not.toContain(
      "timeline.transition.continuity",
    );
  });

  it("publishes every executed global rule to agents", () => {
    const published = new Set(
      (TIMELINE_DSL_DEFINITION.jsonSchema as any)[
        "x-clash-semantic-rules"
      ].rules.map((rule: { id: string }) => rule.id),
    );
    for (const id of [
      "timeline.track.duplicate-id",
      "timeline.item.duplicate-id",
      "timeline.primary-track.reference",
      "timeline.track.category-item-mismatch",
      "timeline.track.role-item-mismatch",
      "timeline.track.role-category",
      "timeline.track.category-order",
      "timeline.item.from-expression",
      "timeline.item.frame-integer",
      "timeline.item.source-required",
      "timeline.item.animation-duration",
      "timeline.audio.ducking-track-role",
      "timeline.composition.local-path",
      "timeline.caption.structured",
      "timeline.transition.reference",
    ]) {
      expect(published, id).toContain(id);
    }
  });
});
