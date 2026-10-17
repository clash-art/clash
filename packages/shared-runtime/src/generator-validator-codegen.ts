/**
 * Build-time Ajv standalone code generation for Generator schemas.
 *
 * Runtimes that forbid code generation from strings (Cloudflare workerd) load
 * the emitted module and pass its entries to
 * `registerPrecompiledGeneratorValidators`. The module is self-contained ESM:
 * Ajv's CommonJS runtime helpers are inlined, so no `require` or package import
 * remains for the Worker bundler or Vitest to resolve.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import Ajv, { type ValidateFunction } from "ajv";
import standaloneCode from "ajv/dist/standalone";
import type { GeneratorDefinition } from "@clash/shared-types";

import {
  GENERATOR_SCHEMA_AJV_OPTIONS,
  generatorSchemaKey,
} from "./generator-contract.js";

/** Every schema `generator-contract` compiles for these Definitions. */
export function generatorDefinitionSchemas(
  definitions: readonly GeneratorDefinition[],
): unknown[] {
  return definitions.flatMap((definition) => [
    definition.stateSchema,
    ...definition.actions.map((action) => action.parametersSchema),
  ]);
}

/** Runtime compilation with the contract's options, as the reference for generated code. */
export function compileGeneratorSchema(schema: unknown): ValidateFunction {
  return new Ajv(GENERATOR_SCHEMA_AJV_OPTIONS).compile(schema as object);
}

// Not inside the `.code = 'require("…")'` strings Ajv keeps for its own codegen.
const REQUIRE_CALL = /(?<!['"])require\("([^"]+)"\)/g;

/** Replace each `require(...)` with an inlined CommonJS module from the installed package. */
function inlineRequires(code: string): { code: string; prelude: string } {
  const ids = new Map<string, number>();
  const factories: string[] = [];
  const load = (specifier: string, from: string): number => {
    const path = createRequire(from).resolve(specifier);
    const known = ids.get(path);
    if (known !== undefined) return known;
    const id = factories.push("") - 1;
    ids.set(path, id);
    const body = readFileSync(path, "utf8")
      .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
      .replace(REQUIRE_CALL, (_, dependency: string) =>
        `__ajvRuntime(${load(dependency, path)})`,
      )
      .trim();
    factories[id] = `(module, exports) => {\n${body}\n}`;
    return id;
  };
  const rewritten = code.replace(REQUIRE_CALL, (_, specifier: string) =>
    `__ajvRuntime(${load(specifier, import.meta.url)})`,
  );
  if (!factories.length) return { code: rewritten, prelude: "" };
  return {
    code: rewritten,
    prelude: [
      `const __ajvRuntimeModules = [\n${factories.join(",\n")}\n];`,
      "const __ajvRuntimeCache = [];",
      "function __ajvRuntime(id) {",
      "  let module = __ajvRuntimeCache[id];",
      "  if (!module) {",
      "    module = __ajvRuntimeCache[id] = { exports: {} };",
      "    __ajvRuntimeModules[id](module, module.exports);",
      "  }",
      "  return module.exports;",
      "}",
      "",
    ].join("\n"),
  };
}

/**
 * Render one ESM module exporting `exportName` as `[generatorSchemaKey, validate]`
 * entries, one per distinct schema, ordered by key.
 */
export function renderPrecompiledGeneratorValidatorModule(
  schemas: readonly unknown[],
  options: { exportName: string; header: string },
): string {
  const byKey = new Map<string, unknown>();
  for (const schema of schemas) byKey.set(generatorSchemaKey(schema), schema);
  const keys = [...byKey.keys()].sort();
  const ajv = new Ajv({
    ...GENERATOR_SCHEMA_AJV_OPTIONS,
    code: { source: true, esm: true, lines: true },
  });
  const refs: Record<string, string> = {};
  keys.forEach((key, index) => {
    ajv.addSchema(byKey.get(key) as object, `schema${index}`);
    refs[`validate${index}`] = `schema${index}`;
  });
  const standalone = keys.length
    ? standaloneCode(ajv, refs).replace(/^"use strict";\s*/, "")
    : "";
  const { code, prelude } = inlineRequires(standalone);
  const entries = keys
    .map((key, index) => `  [${JSON.stringify(key)}, validate${index}],`)
    .join("\n");
  return `${options.header.trim()}\n${prelude}${code.trim()}${code.trim() ? "\n" : ""}export const ${options.exportName} = [\n${entries}\n];\n`;
}
