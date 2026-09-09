import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GeneratorDefinitionSpecSchema,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function json(relativePath: string) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

describe("first-party media analysis Generator package", () => {
  it("declares an inert bundled Generator whose outputs are the category authority", async () => {
    const manifest = await json("manifest.json");
    const generator = await json("generators/media-analysis.json");
    const validated = validateExecutablePluginPackage(
      manifest,
      {},
      {},
      { generators: { "generators/media-analysis.json": generator } },
    );
    expect(validated.manifest).toMatchObject({
      id: "clash.media-analysis",
      contributes: {
        cards: [],
        generators: [expect.objectContaining({ id: "media-analysis" })],
        functions: [expect.objectContaining({ id: "analyze", kind: "action" })],
        hostTools: ["media.analyze"],
      },
    });
    const definition = GeneratorDefinitionSpecSchema.parse(generator.spec);
    const action = definition.actions[0]!;
    expect(action.selectOutputsByParameter).toBe("categories");
    expect(action.outputs.every((output) => output.cardinality.maxItems === 1)).toBe(true);
    expect(action.outputs.every((output) => output.assetType.kind === "document")).toBe(true);
    expect(action.outputs.some((output) => /transcript/i.test(output.slot))).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/hilo|hub-analyse-media/i);
  });

  it("imports without starting and emits only selected typed Document outputs", async () => {
    const source = join(root, "src/stdio.ts");
    expect(existsSync(source)).toBe(true);
    const { plugin } = (await import(pathToFileURL(source).href)) as {
      plugin: { start?: unknown; invoke(input: unknown, context: unknown): Promise<unknown> };
    };
    expect(plugin.start).toBeUndefined();
    const calls: Array<Record<string, unknown>> = [];
    const invocation = {
      protocol: "clash.plugin.invoke/v1",
      invocationId: "invocation-1",
      taskId: "task-1",
      projectId: "project-1",
      target: {
        pluginId: "clash.media-analysis",
        version: "0.1.0",
        exportId: "analyze",
        schemaHash: `sha256:${"a".repeat(64)}`,
        kind: "action",
      },
      input: {
        values: {
          modelId: "dummy-analysis-card",
          categories: ["description", "tags"],
          source: {
            projectAssetId: "asset-1",
            resourceHash: `sha256:${"b".repeat(64)}`,
            kind: "video",
          },
          generatorRevisionId: "generator-revision-1",
          actionRunId: "action-run-1",
        },
        references: [{
          slot: "source",
          index: 0,
          asset: {
            assetId: "asset-1",
            uri: "clash-asset://asset-1",
            kind: "video",
            mediaType: "video/mp4",
          },
        }],
      },
      assetInputs: [],
      actor: { kind: "agent", id: "agent-1" },
      operation: "submit",
    };
    const result = await plugin.invoke(invocation, {
      document: async ({ slot, ...document }: Record<string, unknown>) => ({ slot, kind: "document", document }),
      hostTools: {
        mediaAnalyze: async (request: Record<string, unknown>) => {
          calls.push(request);
          const category = request.category as string;
          return {
            status: "completed",
            provider: "dummy-provider",
            route: "dummy-shape",
            underlyingModel: "provider-managed",
            result: category === "description"
              ? { text: "A train enters a station." }
              : { tags: ["train", "station"] },
          };
        },
      },
    });
    expect(calls.map((call) => call.category)).toEqual(["description", "tags"]);
    expect(result).toMatchObject({
      status: "completed",
      outputs: [
        { slot: "description", kind: "document", document: { documentKind: "media.analysis.description" } },
        { slot: "tags", kind: "document", document: { documentKind: "media.analysis.tags" } },
      ],
    });

    const question = "Which shot best shows the station entrance, and why?";
    const answer = "Use the opening wide shot: the entrance is unobstructed.";
    const { categories: _categories, ...askValues } = invocation.input.values;
    const asked = await plugin.invoke({
      ...invocation,
      target: invocation.target,
      input: { ...invocation.input, values: {
        ...askValues, prompt: question,
      } },
    }, {
      document: async ({ slot, ...document }: Record<string, unknown>) => ({ slot, kind: "document", document }),
      hostTools: {
        mediaAnalyze: async (request: Record<string, unknown>) => {
          expect(request).toMatchObject({ prompt: question, responseFormat: "text" });
          return { status: "completed", provider: "dummy-provider", route: "dummy-shape",
            underlyingModel: "provider-managed", result: { text: answer } };
        },
      },
    });
    expect(asked).toMatchObject({ status: "completed", outputs: [{
      slot: "description", kind: "document",
      document: { body: { result: { text: answer } } },
    }] });
  });
});
