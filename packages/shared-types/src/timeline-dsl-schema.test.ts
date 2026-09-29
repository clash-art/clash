import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import { validateTimelineDsl } from "./timeline-dsl-schema.js";

const repositoryPath = (path: string) => resolve(process.cwd(), "../..", path);

function resolveLocalJsonPointer(
  document: unknown,
  reference: string,
): unknown {
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      document,
    );
}

function localJsonSchemaReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(localJsonSchemaReferences);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "$ref" && typeof entry === "string"
      ? [entry]
      : localJsonSchemaReferences(entry),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

describe("agent-facing Timeline DSL schema", () => {
  it("publishes every clip-mask field and animated channel", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;

    expect(definition).toBeDefined();
    expect(definition.format).toBe("clash.timeline.yaml");
    expect(definition.features.clipMask).toMatchObject({
      yamlPath: "tracks[].items[]",
      appliesToItemTypes: [
        "video",
        "image",
        "solid",
        "text",
        "sticker",
        "composition",
        "derived-overlay",
      ],
      staticFields: [
        "shape",
        "position",
        "size",
        "rotation",
        "feather",
        "inverted",
      ],
      animatedChannels: [
        "maskPosition",
        "maskSize",
        "maskRotation",
        "maskFeather",
      ],
      defaultMask: {
        shape: "rectangle",
        position: [50, 50],
        size: [70, 70],
        rotation: 0,
        feather: 0,
        inverted: false,
      },
    });
    expect(definition.features.clipMask.semantics).toMatchObject({
      geometryUnits: "percent-of-rendered-item-bounds",
      rotationUnit: "degrees",
      featherRange: [0, 100],
      frameSpace: "item-local",
      interpolation: ["hold", "linear"],
      defaultNewKeyframeInterpolation: "linear",
      beforeFirstKeyframe: "use-first-keyframe-value",
      afterLastKeyframe: "use-last-keyframe-value",
      emptyChannelFallback: "matching-item.mask-field",
      duplicateFrames: "rejected-per-channel",
      positiveRotation: "clockwise",
      featherModel:
        "blur-stddev=min(rendered-mask-width,rendered-mask-height)*feather/600",
      staticOnlyFields: ["shape", "inverted"],
      requiresStaticMask: true,
    });
    expect(definition.features.clipMask.operations).toEqual({
      addOrReplaceMask: `write all ${shared.TIMELINE_MASK_FIELDS.length} item.mask fields`,
      updateStaticFallback: "edit the matching item.mask field",
      removeMask: "omit item.mask and remove every mask* keyframe channel",
      upsertKeyframe:
        "replace the entry at the same item-local frame or insert a sorted entry",
      setKeyframeInterpolation:
        "replace the current keyframe interpolation with hold or linear",
      removeKeyframe:
        "remove the entry and omit the channel when it becomes empty",
    });
    expect(definition.features.clipMask.runtimeBehavior).toEqual({
      previewExportParity: true,
      timelineMarkers: "derived-from-mask-keyframe-channels",
      undoRedoPersistence: "editor-history-not-a-dsl-field",
      moveKeyframePolicy: "preserve-item-local-frames",
      trimSplitRippleKeyframePolicy:
        "sample-new-boundaries-then-slice-and-shift-item-local-keys",
      transitionSampling: "referenced-item-local",
      maskedClipMergePolicy: "never-merge-contiguous-items",
    });
  });

  it("exports a machine-readable JSON Schema with field descriptions", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const schemaText = JSON.stringify(definition.jsonSchema);

    expect(definition.jsonSchema.$schema).toContain("json-schema");
    expect(schemaText).toContain("TimelineItemMask");
    expect(schemaText).toContain("maskPosition");
    expect(schemaText).toContain("maskSize");
    expect(schemaText).toContain("maskRotation");
    expect(schemaText).toContain("maskFeather");
    expect(schemaText).toContain("item-local");
    expect(schemaText).toContain("degrees");
  });

  it("keeps standard JSON Schema mask applicability aligned with apply validation", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const validate = new Ajv({ strict: false }).compile(definition.jsonSchema);
    const orphanMaskChannel = {
      tracks: [
        {
          id: "visual",
          items: [
            {
              id: "orphan-mask-channel",
              type: "image",
              from: 0,
              durationInFrames: 10,
              keyframes: {
                maskPosition: [
                  { frame: 0, value: [50, 50], interpolation: "linear" },
                ],
              },
            },
          ],
        },
      ],
    };
    const audioMask = {
      tracks: [
        {
          id: "audio",
          items: [
            {
              id: "audio-mask",
              type: "audio",
              from: 0,
              durationInFrames: 10,
              mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
            },
          ],
        },
      ],
    };

    expect(validate(orphanMaskChannel)).toBe(false);
    expect(validate(audioMask)).toBe(false);
  });

  it("does not publish dangling local references in the root schema fragments", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const references = localJsonSchemaReferences(definition.jsonSchema).filter(
      (reference) => reference.startsWith("#/"),
    );

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(
        resolveLocalJsonPointer(definition.jsonSchema, reference),
        `missing local JSON Schema reference ${reference}`,
      ).toBeDefined();
    }
    const fragments = definition.jsonSchema["x-clash-fragments"];
    expect(fragments.TimelineItemMask).toMatchObject({
      $ref: "#/definitions/TimelineItemMask",
      definitions: { TimelineItemMask: expect.any(Object) },
    });
    expect(fragments.TimelineItemKeyframes).toMatchObject({
      $ref: "#/definitions/TimelineItemKeyframes",
      definitions: { TimelineItemKeyframes: expect.any(Object) },
    });
    const ajv = new Ajv({ strict: false });
    expect(
      ajv.compile(fragments.TimelineItemMask)(
        shared.DEFAULT_TIMELINE_ITEM_MASK,
      ),
    ).toBe(true);
    expect(
      ajv.compile(fragments.TimelineItemKeyframes)({
        maskFeather: [{ frame: 0, value: 10, interpolation: "linear" }],
      }),
    ).toBe(true);
  });

  it("publishes structured semantic rules aligned with executable validation", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const semanticRules = definition.jsonSchema["x-clash-semantic-rules"];
    expect(semanticRules).toMatchObject({
      version: 2,
      rules: expect.arrayContaining([
        expect.objectContaining({
          id: "timeline.clip-mask.item-type",
          kind: "allowed-item-types-when-present",
          field: "mask",
        }),
        expect.objectContaining({
          id: "timeline.clip-mask.requires-mask",
          kind: "requires-field-when-any-channel-present",
          channels: ["maskPosition", "maskSize", "maskRotation", "maskFeather"],
          requiredField: "mask",
        }),
        expect.objectContaining({
          id: "timeline.keyframes.frame-range",
          kind: "frame-range-by-owner-duration",
          exclusiveMaximumPath: "durationInFrames",
        }),
        expect.objectContaining({
          id: "timeline.keyframes.unique-frame",
          kind: "unique-key-by-channel",
          key: "frame",
        }),
        expect.objectContaining({
          id: "timeline.asset.retired-field",
          kind: "forbidden-paths",
          paths: ["mediaAssetRefs", "tracks[].items[].backingAssetId"],
        }),
      ]),
    });

    const invalidCases = [
      {
        expectedRule: "timeline.clip-mask.requires-mask",
        state: {
          tracks: [
            {
              id: "visual",
              items: [
                {
                  id: "orphan-mask-channel",
                  type: "image",
                  from: 0,
                  durationInFrames: 10,
                  keyframes: {
                    maskPosition: [
                      { frame: 0, value: [50, 50], interpolation: "linear" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        expectedRule: "timeline.clip-mask.item-type",
        state: {
          tracks: [
            {
              id: "audio",
              items: [
                {
                  id: "audio-mask",
                  type: "audio",
                  from: 0,
                  durationInFrames: 10,
                  mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
                },
              ],
            },
          ],
        },
      },
      {
        expectedRule: "timeline.keyframes.frame-range",
        state: {
          tracks: [
            {
              id: "visual",
              items: [
                {
                  id: "out-of-range",
                  type: "image",
                  from: 0,
                  durationInFrames: 10,
                  mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
                  keyframes: {
                    maskFeather: [
                      { frame: 10, value: 20, interpolation: "linear" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        expectedRule: "timeline.keyframes.unique-frame",
        state: {
          tracks: [
            {
              id: "visual",
              items: [
                {
                  id: "duplicate-frame",
                  type: "image",
                  from: 0,
                  durationInFrames: 10,
                  mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
                  keyframes: {
                    maskFeather: [
                      { frame: 1, value: 10, interpolation: "linear" },
                      { frame: 1, value: 20, interpolation: "linear" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        expectedRule: "timeline.asset.retired-field",
        expectedPath: ["mediaAssetRefs"],
        state: {
          mediaAssetRefs: [{ assetId: "asset-video" }],
          tracks: [],
        },
      },
      {
        expectedRule: "timeline.asset.retired-field",
        expectedPath: ["tracks", 0, "items", 0, "backingAssetId"],
        state: {
          tracks: [
            {
              id: "visual",
              items: [
                {
                  id: "retired-backing-asset",
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
      },
    ] as const;

    for (const invalidCase of invalidCases) {
      const result = validateTimelineDsl(invalidCase.state);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.map((issue) => issue.ruleId)).toContain(
        invalidCase.expectedRule,
      );
      if ("expectedPath" in invalidCase) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            ruleId: invalidCase.expectedRule,
            path: invalidCase.expectedPath,
          }),
        );
      }
    }
  });

  it("derives a stable contract fingerprint and gates each released schema version", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const { contractFingerprint, ...serializableDefinition } = definition;

    expect(contractFingerprint).toBe(
      `fnv1a32:${fnv1a32(canonicalJson(serializableDefinition))}`,
    );
    const releasedContractFingerprints: Record<number, string> = {
      1: "fnv1a32:0beb21b4",
      2: "fnv1a32:d16ace31",
      3: "fnv1a32:e3826b91",
      4: "fnv1a32:877b6827",
      5: "fnv1a32:9cd7e84a",
      6: "fnv1a32:cefec01e",
      7: "fnv1a32:20e70cf2",
      8: "fnv1a32:bef614be",
      9: "fnv1a32:e79b87fb",
      10: "fnv1a32:bc1b6602",
      11: "fnv1a32:01aeda96",
      12: "fnv1a32:19eca23f",
      13: "fnv1a32:d4911874",
    };
    const released = releasedContractFingerprints[definition.schemaVersion];
    if (released !== undefined) {
      expect(contractFingerprint).toBe(released);
    } else {
      // A new contract must advance the version, rather than rewriting an old
      // fingerprint. Do not invent a new golden hash from this implementation;
      // pin it only once an independently captured release is the authority.
      expect(definition.schemaVersion).toBeGreaterThan(
        Math.max(...Object.keys(releasedContractFingerprints).map(Number)),
      );
    }
  });

  it("ships a complete mask-keyframe example accepted by the real YAML parser", () => {
    const definition = (shared as Record<string, unknown>)
      .TIMELINE_DSL_DEFINITION as any;
    const example = definition.examples.maskKeyframes;
    const yaml = shared.timelineDslToYaml(example);
    const parsed = shared.timelineDslFromYaml(yaml);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const item = parsed.dsl.tracks[0]?.items[0] as any;
    expect(item.mask).toEqual(example.tracks[0].items[0].mask);
    expect(Object.keys(item.keyframes).sort()).toEqual([
      "maskFeather",
      "maskPosition",
      "maskRotation",
      "maskSize",
    ]);
  });

  it("keeps the public YAML example executable", () => {
    const yaml = readFileSync(
      repositoryPath("docs/examples/mask-keyframes.timeline.yaml"),
      "utf8",
    );
    const parsed = shared.timelineDslFromYaml(yaml);

    expect(yaml).toBe(shared.renderTimelineMaskKeyframesExampleYaml());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.dsl.tracks[0]?.items[0] as any)?.mask?.shape).toBe(
      "ellipse",
    );
    expect(
      Object.keys((parsed.dsl.tracks[0]?.items[0] as any)?.keyframes ?? {}),
    ).toHaveLength(4);
  });

  it("keeps generated JavaDoc-style reference output synchronized", () => {
    const markdown = readFileSync(
      repositoryPath("docs/timeline-dsl.md"),
      "utf8",
    );

    expect(markdown).toBe(shared.renderTimelineDslMarkdown());
    expect(markdown).toContain("GENERATED by @clash/shared-types");

    const skill = readFileSync(
      repositoryPath("plugins/clash-timeline/skills/clash-timeline/SKILL.md"),
      "utf8",
    );
    const generatedSkillSection = skill.match(
      /<!-- BEGIN GENERATED TIMELINE MASK CONTRACT -->[\s\S]*?<!-- END GENERATED TIMELINE MASK CONTRACT -->/,
    )?.[0];
    expect(generatedSkillSection).toBe(
      shared.renderTimelineMaskSkillReference(),
    );
    for (const creativeGuidanceUrl of ["plugins/clash/skills/clash/SKILL.md"]) {
      const creativeGuidance = readFileSync(
        repositoryPath(creativeGuidanceUrl),
        "utf8",
      );
      expect(creativeGuidance).not.toContain(
        "BEGIN GENERATED TIMELINE DSL WORKFLOW",
      );
      expect(creativeGuidance).not.toContain("contract fingerprint");
    }
  });

  it("generates direct-submit guidance without presenting validate as a write preflight", () => {
    expect(shared.renderTimelineMaskSkillReference()).toMatch(
      /use the explicit validator only for diagnosis\s+when no write is intended/i,
    );
    expect(shared.renderTimelineAgentWorkflowReference()).toMatch(
      /do not use.*(?:validate|validator).*as a preflight/i,
    );
  });

  it.each([
    {
      name: "orphan mask keyframes",
      item: {
        id: "orphan",
        type: "image",
        from: 0,
        durationInFrames: 10,
        keyframes: {
          maskPosition: [
            { frame: 0, value: [50, 50], interpolation: "linear" },
          ],
        },
      },
    },
    {
      name: "empty orphan mask keyframe channel",
      item: {
        id: "orphan-empty",
        type: "image",
        from: 0,
        durationInFrames: 10,
        keyframes: {
          maskPosition: [],
        },
      },
    },
    {
      name: "out-of-range item-local frame",
      item: {
        id: "range",
        type: "image",
        from: 0,
        durationInFrames: 10,
        mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
        keyframes: {
          maskFeather: [{ frame: 10, value: 20, interpolation: "linear" }],
        },
      },
    },
    {
      name: "mask on audio",
      item: {
        id: "audio-mask",
        type: "audio",
        from: 0,
        durationInFrames: 10,
        mask: shared.DEFAULT_TIMELINE_ITEM_MASK,
      },
    },
  ])("keeps Zod and YAML apply rejection aligned for $name", ({ item }) => {
    const dsl = { tracks: [{ id: "visual", items: [item] }] };
    const zod = shared.TimelineDslSchema.safeParse(dsl);
    const yaml = shared.timelineDslFromYaml(
      shared.timelineDslToYaml(dsl as any),
    );

    expect(zod.success).toBe(false);
    expect(yaml.ok).toBe(false);
  });
});
