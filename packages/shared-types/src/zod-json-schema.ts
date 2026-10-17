import { z } from "zod";

type JsonSchemaObject = Record<string, unknown>;

const DRAFT_7_SCHEMA_URI = "http://json-schema.org/draft-07/schema#";

/**
 * Keep generated contracts in the shape tools and LLM function-calling
 * consumers have always received (the former zod-to-json-schema output):
 * - fields with `.default()` are optional (input side of the contract), and so
 *   are `z.unknown()` / `z.any()` fields, which accept a missing key;
 * - non-passthrough objects reject unknown keys (`additionalProperties: false`,
 *   which `io: "input"` would otherwise leave open) and passthrough objects
 *   publish `additionalProperties: true`;
 * - unions are `anyOf`, never `oneOf`, which several function-calling
 *   providers reject;
 * - fixed-length tuples keep their `minItems` / `maxItems` (no `additionalItems`);
 * - redundant Zod 4 additions are dropped: safe-integer bounds, the date-time
 *   regex beside `format`, and `type: "string"` on record `propertyNames`.
 */
function normalizeJsonSchemaNode(ctx: {
  zodSchema: z.core.$ZodType;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  const def = ctx.zodSchema._zod.def;
  const json = ctx.jsonSchema;
  if (def.type === "object") {
    const objectDef = def as z.core.$ZodObjectDef;
    if (!objectDef.catchall && json.additionalProperties === undefined) {
      json.additionalProperties = false;
    }
    if (Array.isArray(json.required)) {
      const required = json.required.filter((key) => {
        const fieldType = objectDef.shape[key]?._zod.def.type;
        return fieldType !== "unknown" && fieldType !== "any";
      });
      if (required.length > 0) json.required = required;
      else delete json.required;
    }
    if (isEmptyObject(json.additionalProperties)) {
      json.additionalProperties = true;
    }
  }
  if (json.oneOf && !json.anyOf) {
    json.anyOf = json.oneOf;
    delete json.oneOf;
  }
  if (def.type === "tuple") {
    const tupleDef = def as z.core.$ZodTupleDef;
    if (!tupleDef.rest) {
      json.minItems = tupleDef.items.length;
      json.maxItems = tupleDef.items.length;
      // Zod >= 4.6 also emits `additionalItems: false`, which maxItems
      // already implies; keep the established shape.
      delete (json as Record<string, unknown>).additionalItems;
    }
  }
  if (json.type === "integer") {
    if (json.minimum === Number.MIN_SAFE_INTEGER) delete json.minimum;
    if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
  }
  if (json.type === "string" && json.format === "date-time") {
    delete json.pattern;
  }
  if (
    json.propertyNames &&
    typeof json.propertyNames === "object" &&
    json.propertyNames.type === "string"
  ) {
    const { type: _type, ...keyConstraints } = json.propertyNames;
    if (isEmptyObject(keyConstraints)) delete json.propertyNames;
    else json.propertyNames = keyConstraints;
  }
}

function isEmptyObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Draft-07 JSON Schema projection of a Zod contract, built with Zod's native
 * `z.toJSONSchema`. With `name`, the schema is published as
 * `{ $ref: "#/definitions/<name>", definitions: { <name>: ... } }` so callers
 * can address the named root and any recursive definitions side by side.
 */
export function zodToDraft7JsonSchema(
  schema: z.core.$ZodType,
  options: { name?: string } = {},
): JsonSchemaObject {
  const generated = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
    override: normalizeJsonSchemaNode,
  }) as JsonSchemaObject;
  if (!options.name) return generated;
  const { $schema: _schema, definitions, ...root } = generated;
  return {
    $ref: `#/definitions/${options.name}`,
    definitions: {
      [options.name]: root,
      ...(definitions as JsonSchemaObject | undefined),
    },
    $schema: DRAFT_7_SCHEMA_URI,
  };
}
