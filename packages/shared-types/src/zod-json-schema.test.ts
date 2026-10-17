import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { directorStageJsonSchema } from "./director-stage.js";
import { projectGeneratorRequestContract } from "./generator-requests.js";
import { TIMELINE_DSL_DEFINITION } from "./timeline-dsl-schema.js";
import { TIMELINE_OPERATION_CATALOG } from "./timeline-operation-annotations.js";
import { zodToDraft7JsonSchema } from "./zod-json-schema.js";

type JsonSchema = Record<string, any>;

const DRAFT_7 = "http://json-schema.org/draft-07/schema#";

function collectKeys(value: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, key, found);
  } else if (value && typeof value === "object") {
    for (const [entryKey, entry] of Object.entries(value)) {
      if (entryKey === key) found.push(entry);
      collectKeys(entry, key, found);
    }
  }
  return found;
}

describe("zodToDraft7JsonSchema", () => {
  const Sample = z
    .object({
      id: z.string().min(1).describe("Stable id"),
      kind: z.enum(["a", "b"]),
      count: z.number().int().min(0).default(1),
      when: z.string().datetime({ offset: true }),
      position: z.tuple([z.number(), z.number()]),
      extra: z.unknown(),
      tags: z.record(z.string(), z.string()),
      loose: z.object({ x: z.string() }).passthrough(),
      variant: z.discriminatedUnion("type", [
        z.object({ type: z.literal("one") }).strict(),
        z.object({ type: z.literal("two"), n: z.number() }).strict(),
      ]),
    })
    .strict();

  it("keeps the established draft-07 contract shape", () => {
    expect(zodToDraft7JsonSchema(Sample)).toEqual({
      $schema: DRAFT_7,
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Stable id" },
        kind: { type: "string", enum: ["a", "b"] },
        count: { type: "integer", minimum: 0, default: 1 },
        when: { type: "string", format: "date-time" },
        position: {
          type: "array",
          items: [{ type: "number" }, { type: "number" }],
          minItems: 2,
          maxItems: 2,
        },
        extra: {},
        tags: { type: "object", additionalProperties: { type: "string" } },
        loose: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: true,
        },
        variant: {
          anyOf: [
            {
              type: "object",
              properties: { type: { type: "string", const: "one" } },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "two" },
                n: { type: "number" },
              },
              required: ["type", "n"],
              additionalProperties: false,
            },
          ],
        },
      },
      // Defaulted and unknown-valued fields are optional on the input side.
      required: ["id", "kind", "when", "position", "tags", "loose", "variant"],
      additionalProperties: false,
    });
  });

  it("closes non-passthrough objects that Zod would otherwise strip", () => {
    expect(
      zodToDraft7JsonSchema(z.object({ a: z.string() })).additionalProperties,
    ).toBe(false);
  });

  it("publishes a named root beside recursive definitions", () => {
    type Tree = { children: Tree[] };
    const TreeSchema: z.ZodType<Tree> = z.lazy(() =>
      z.object({ children: z.array(TreeSchema) }),
    );
    const schema = zodToDraft7JsonSchema(
      z.object({ root: TreeSchema }),
      { name: "Forest" },
    );
    expect(schema.$schema).toBe(DRAFT_7);
    expect(schema.$ref).toBe("#/definitions/Forest");
    expect(Object.keys(schema.definitions as object)).toContain("Forest");
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate({ root: { children: [{ children: [] }] } })).toBe(true);
    expect(validate({ root: { children: [{ children: "no" }] } })).toBe(false);
  });
});

describe("published JSON Schema contracts", () => {
  it("pins the Director Stage contracts", () => {
    const state = directorStageJsonSchema("state");
    expect(state.$schema).toBe(DRAFT_7);
    expect(state.$ref).toBe("#/definitions/DirectorStageState");
    const root = (state.definitions as JsonSchema).DirectorStageState;
    expect(root.required).toEqual([
      "schemaVersion",
      "scene",
      "objects",
      "cameras",
      "shots",
    ]);
    expect(root.properties.scene.properties.environmentRotation).toEqual({
      type: "array",
      items: [{ type: "number" }, { type: "number" }, { type: "number" }],
      minItems: 3,
      maxItems: 3,
    });
    expect(root.properties.shots).toMatchObject({ type: "array", maxItems: 0 });

    const camera = directorStageJsonSchema("camera");
    const cameraRoot = (camera.definitions as JsonSchema).DirectorStageCamera;
    expect(cameraRoot.properties.fov).toEqual({
      type: "number",
      minimum: 1,
      maximum: 179,
    });
    expect(cameraRoot.properties.optics.properties.projection).toEqual({
      type: "string",
      enum: ["perspective", "orthographic"],
    });
    expect(directorStageJsonSchema("object").$ref).toBe(
      "#/definitions/DirectorStageObject",
    );
  });

  it("pins the Generator request contracts", () => {
    const create = projectGeneratorRequestContract("create")
      .inputSchema as JsonSchema;
    expect(create.$schema).toBe(DRAFT_7);
    expect(create.additionalProperties).toBe(false);
    expect(create.required).toEqual([
      "generatorId",
      "generatorRevisionId",
      "pluginId",
      "definitionId",
      "state",
    ]);
    expect(Object.keys(create.properties)).toEqual([
      "generatorId",
      "generatorRevisionId",
      "pluginId",
      "definitionId",
      "state",
      "persistentInputRefs",
      "forkedFrom",
      "placement",
    ]);
    expect(create.properties.persistentInputRefs.default).toEqual([]);

    const submit = projectGeneratorRequestContract("submit")
      .inputSchema as JsonSchema;
    expect(submit.required).toEqual(["actionRunId", "generatorRevisionId"]);
    expect(submit.properties.parameters.default).toEqual({});
  });

  it("pins the Timeline DSL contract layout", () => {
    const jsonSchema = TIMELINE_DSL_DEFINITION.jsonSchema as JsonSchema;
    expect(jsonSchema.$schema).toBe(DRAFT_7);
    expect(jsonSchema.$ref).toBe("#/definitions/TimelineDsl");
    expect(Object.keys(jsonSchema.definitions)).toEqual([
      "TimelineDsl",
      "TimelineItemMask",
      "TimelineItemKeyframes",
    ]);
    const root = jsonSchema.definitions.TimelineDsl;
    expect(root.required).toEqual(["tracks"]);
    const track = root.properties.tracks.items;
    expect(track.properties.category).toEqual({
      type: "string",
      enum: ["effect", "text", "visual", "primary", "audio"],
      description:
        "Structural lane category controlling order and allowed item types.",
    });
    const item = track.properties.items.items;
    expect(
      item.anyOf.map((variant: JsonSchema) => variant.properties.type.const),
    ).toEqual([
      "video",
      "audio",
      "image",
      "solid",
      "text",
      "sticker",
      "composition",
      "derived-overlay",
      "transition",
    ]);
    expect(item.anyOf[0].additionalProperties).toBe(true);
    expect(item.allOf.length).toBeGreaterThan(0);
  });

  it("pins the Timeline operation catalog projections", () => {
    const open = TIMELINE_OPERATION_CATALOG.agent["timeline.open"];
    expect(open.inputJsonSchema).toEqual({
      $schema: DRAFT_7,
      type: "object",
      properties: { timelineId: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
    const timeline = (open.outputJsonSchema as JsonSchema).properties.timelines
      .items;
    expect(timeline.required).toEqual(["id", "name", "owner", "revisionId"]);
    expect(timeline.properties.state).toEqual({});
  });

  it("never emits oneOf, which function-calling providers reject", () => {
    const published = [
      directorStageJsonSchema("state"),
      directorStageJsonSchema("object"),
      projectGeneratorRequestContract("create").inputSchema,
      projectGeneratorRequestContract("advance").inputSchema,
      projectGeneratorRequestContract("submit").inputSchema,
      TIMELINE_DSL_DEFINITION.jsonSchema,
      TIMELINE_OPERATION_CATALOG,
    ];
    expect(collectKeys(published, "oneOf")).toEqual([]);
  });
});
