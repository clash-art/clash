import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateExecutablePluginPackage } from "@clash/shared-types";
import { describe, expect, it, vi } from "vitest";
import * as imagegen from "./stdio";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Codex ImageGen executable action package", () => {
  it("ships a local action Card backed by an installable stdio plugin", async () => {
    const manifestPath = join(root, "manifest.json");
    const cardPath = join(root, "cards", "codex-imagegen.json");
    const generatorPath = join(root, "generators", "codex-imagegen.json");

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(cardPath)).toBe(true);
    expect(existsSync(generatorPath)).toBe(true);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const card = JSON.parse(await readFile(cardPath, "utf8"));
    const generator = JSON.parse(await readFile(generatorPath, "utf8"));
    const contractPath = "contract-tests/generate-image.json";
    const contract = JSON.parse(
      await readFile(join(root, contractPath), "utf8"),
    );
    const validated = validateExecutablePluginPackage(
      manifest,
      {
        "cards/codex-imagegen.json": card,
      },
      {
        [contractPath]: contract,
      },
      {
        generators: { "generators/codex-imagegen.json": generator },
      },
    );

    expect(validated.manifest).toMatchObject({
      id: "clash.codex-imagegen",
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
      },
      contributes: {
        hostTools: ["codex.imagegen"],
        generators: [
          {
            id: "codex-imagegen",
            kind: "generator",
            path: "generators/codex-imagegen.json",
          },
        ],
      },
    });
    expect(validated.manifest).not.toHaveProperty("permissions");
    expect(card).toMatchObject({
      apiVersion: "clash.card/v1",
      kind: "action-card",
      spec: {
        id: "codex-imagegen",
        outputType: "image",
        functionExportId: "generate-image",
        input: { promptModalities: ["text", "image"] },
      },
    });
    expect(validated.generators["generators/codex-imagegen.json"]).toEqual(
      generator,
    );
    expect(generator).toMatchObject({
      apiVersion: "clash.generator/v1",
      kind: "generator",
      spec: {
        definitionId: "codex-imagegen",
        editPolicy: "fork-when-materialized",
        actions: [
          {
            id: "generate",
            executorExportId: "generate-image",
            outputs: [{ slot: "image" }],
          },
        ],
      },
    });
  });

  it("runs Codex ImageGen through the typed host tool", async () => {
    const run = (imagegen as Record<string, unknown>)
      .runCodexImageGeneration as
      | ((
          invocation: unknown,
          services: Record<string, unknown>,
        ) => Promise<any>)
      | undefined;
    expect(run).toBeTypeOf("function");
    if (!run) return;

    const generate = vi.fn(async () => ({
      assetId: "generated-1",
      uri: "clash-asset://generated-1",
      kind: "image" as const,
      mediaType: "image/png",
    }));
    const result = await run(
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-1",
        taskId: "task-1",
        projectId: "project-1",
        target: {
          pluginId: "clash.codex-imagegen",
          version: "0.1.0",
          exportId: "generate-image",
          schemaHash: `sha256:${"a".repeat(64)}`,
          kind: "action",
        },
        input: {
          values: { prompt: "A paper-cut moon", aspect_ratio: "16:9" },
          references: [
            {
              slot: "image",
              index: 0,
              asset: {
                assetId: "reference-1",
                uri: "clash-asset://reference-1",
                kind: "image",
                mediaType: "image/png",
              },
            },
          ],
        },
        actor: { kind: "user", id: "user-1" },
      },
      {
        hostTools: { codexImagegen: { generate } },
      },
    );

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "A paper-cut moon",
        aspectRatio: "16:9",
        slot: "image",
        references: [expect.objectContaining({ assetId: "reference-1" })],
      }),
    );
    expect(result).toEqual({
      protocol: "clash.plugin.result/v1",
      invocationId: "invocation-1",
      status: "completed",
      outputs: [
        {
          slot: "image",
          kind: "asset",
          asset: {
            assetId: "generated-1",
            uri: "clash-asset://generated-1",
            kind: "image",
            mediaType: "image/png",
          },
        },
      ],
    });
  });

  it.each([
    {
      image_model: "gpt-image-2.5-flare",
      quality: "low",
      resolution: "1536x1024",
      background: "transparent",
    },
    {
      image_model: "gpt-image-2.5-sunburst",
      quality: "max",
      resolution: "1280x720",
      background: "opaque",
    },
    {
      image_model: "auto",
      quality: "auto",
      resolution: "auto",
      background: "auto",
    },
  ])("forwards ratio and prompt preferences %j", async (preferences) => {
    const generate = vi.fn(async (_input: { prompt: string }) => ({
      assetId: "generated-free-ratio",
      uri: "clash-asset://generated-free-ratio",
      kind: "image" as const,
      mediaType: "image/png",
    }));

    await imagegen.runCodexImageGeneration(
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-free-ratio",
        taskId: "task-free-ratio",
        projectId: "project-1",
        target: {
          pluginId: "clash.codex-imagegen",
          version: "0.1.0",
          exportId: "generate-image",
          schemaHash: `sha256:${"a".repeat(64)}`,
          kind: "action",
        },
        input: {
          values: {
            prompt: "A paper-cut moon",
            aspect_ratio: "14:10",
            ...preferences,
          },
          references: [],
        },
        actor: { kind: "user", id: "user-1" },
      },
      { hostTools: { codexImagegen: { generate } } },
    );

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "7:5" }),
    );
    const request = generate.mock.calls[0]?.[0] as unknown as {
      prompt: string;
    };
    expect(request.prompt).toContain("A paper-cut moon");
    for (const value of Object.values(preferences)) {
      if (value !== "auto") expect(request.prompt).toContain(value);
    }
    if (preferences.background === "transparent")
      expect(request.prompt).toMatch(/alpha/i);
    if (preferences.image_model === "auto")
      expect(request.prompt).toBe("A paper-cut moon");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("exports the same action as an inert transport-neutral plugin module", async () => {
    const plugin = (imagegen as Record<string, unknown>).plugin as
      | {
          invoke: (
            invocation: unknown,
            context: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      | undefined;
    expect(plugin).toBeDefined();
    if (!plugin) return;

    const generate = vi.fn(async () => ({
      assetId: "generated-module",
      uri: "clash-asset://generated-module",
      kind: "image" as const,
      mediaType: "image/png",
    }));
    await expect(
      plugin.invoke(
        {
          protocol: "clash.plugin.invoke/v1",
          invocationId: "module-invocation",
          taskId: "module-task",
          projectId: "project-1",
          target: {
            pluginId: "clash.codex-imagegen",
            version: "0.1.0",
            exportId: "generate-image",
            schemaHash: `sha256:${"a".repeat(64)}`,
            kind: "action",
          },
          input: {
            values: { prompt: "A silver moon", aspect_ratio: "1:1" },
            references: [],
          },
          actor: { kind: "system", id: "test" },
        },
        { hostTools: { codexImagegen: { generate } } },
      ),
    ).resolves.toMatchObject({
      invocationId: "module-invocation",
      status: "completed",
      outputs: [
        {
          slot: "image",
          kind: "asset",
          asset: { assetId: "generated-module" },
        },
      ],
    });
    expect(generate).toHaveBeenCalledOnce();
  });
});
