import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import timeline from "../../../plugins/remotion/generators/timeline.json";
import { generatorSchemaKey } from "./generator-contract.js";
import {
  compileGeneratorSchema,
  renderPrecompiledGeneratorValidatorModule,
} from "./generator-validator-codegen.js";

type Entries = Array<[string, ((data: unknown) => boolean) & { errors?: unknown }]>;

const directories: string[] = [];
afterAll(() =>
  Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))),
);

async function load(source: string): Promise<Entries> {
  const directory = await mkdtemp(join(tmpdir(), "generator-validators-"));
  directories.push(directory);
  const file = join(directory, "validators.mjs");
  await writeFile(file, source);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)).validators;
}

// Schemas exercising keywords whose standalone code needs Ajv runtime helpers.
const schemas = [
  timeline.spec.stateSchema,
  timeline.spec.actions[0]!.parametersSchema,
  { type: "object", properties: { mode: { enum: [{ a: 1 }, "b"] } } },
];
const samples = [
  { timeline: { name: "Cut", owner: { kind: "project" }, state: {} } },
  { timeline: { name: "😀", owner: { kind: "canvas-action", canvasId: "c", actionNodeId: "a" }, state: {} } },
  { timeline: { name: "", owner: { kind: "project" }, state: {} } },
  { timeline: { name: "Cut", owner: { kind: "canvas-action" }, state: [] } },
  { timeline: {}, extra: true },
  { mode: { a: 1 } },
  { mode: { a: 2 } },
  {},
  [],
  null,
  "text",
];

describe("renderPrecompiledGeneratorValidatorModule", () => {
  it("emits self-contained ESM keyed by generatorSchemaKey", async () => {
    const source = renderPrecompiledGeneratorValidatorModule(
      [...schemas, schemas[0]],
      { exportName: "validators", header: "// test" },
    );
    // Ajv's inert `.code = 'require("…")'` metadata strings may remain; calls may not.
    expect(source).not.toMatch(/(?<!['"])\brequire\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
    const entries = await load(source);
    expect(entries.map(([key]) => key)).toEqual(
      schemas.map(generatorSchemaKey).sort(),
    );
  });

  it("agrees with runtime Ajv compilation on valid and invalid values", async () => {
    const entries = new Map(
      await load(
        renderPrecompiledGeneratorValidatorModule(schemas, {
          exportName: "validators",
          header: "",
        }),
      ),
    );
    for (const schema of schemas) {
      const precompiled = entries.get(generatorSchemaKey(schema))!;
      const compiled = compileGeneratorSchema(schema);
      for (const sample of samples) {
        expect(precompiled(sample)).toBe(compiled(sample));
        expect(precompiled.errors ?? null).toEqual(compiled.errors ?? null);
      }
    }
  });
});
