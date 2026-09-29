import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  type ExecutablePluginGeneratorRegistration,
} from "@clash/shared-types";
import { createLocalApiApp } from "./app.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const registration = (
  pluginId: string,
): ExecutablePluginGeneratorRegistration => ({
  pluginId,
  version: "1.0.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
  document: {
    apiVersion: "clash.generator/v1",
    kind: "generator",
    spec: {
      definitionId: "edit",
      stateSchema: { type: "object" },
      editPolicy: "advance-head",
      persistentInputs: [],
      actions: [
        {
          id: "run",
          executorExportId: "run",
          parametersSchema: { type: "object" },
          invocationInputs: [],
          outputs: [
            {
              slot: "result",
              assetType: { kind: "media", mediaKind: "image" },
              cardinality: { minItems: 1, maxItems: 1 },
            },
          ],
        },
      ],
    },
  },
});
const scoped = registration("project.editor"),
  global = registration("shared.editor");

async function fixture(withScopes = true) {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-generator-discovery-"));
  directories.push(dataDir);
  return createLocalApiApp({
    dataDir,
    listPluginGenerators: async () => [scoped, global],
    resolveGeneratorDefinition: async (pluginId) =>
      generatorDefinitionFromExecutablePluginRegistration(
        pluginId === scoped.pluginId ? scoped : global,
      ),
    ...(withScopes
      ? {
          pluginAvailableInProject: async (
            pluginId: string,
            projectId?: string,
          ) => pluginId === global.pluginId || projectId === "allowed",
        }
      : {}),
  });
}

it("discovers a project-installed Generator only within its selected project", async () => {
  const host = await fixture();
  const allowed = await host.request(
    "/api/v1/generator-definitions?projectId=allowed",
  );
  expect(await allowed.json()).toEqual({
    definitions: [scoped, global].map(
      generatorDefinitionFromExecutablePluginRegistration,
    ),
  });
  for (const query of ["?projectId=other", ""]) {
    const response = await host.request(
      `/api/v1/generator-definitions${query}`,
    );
    expect(await response.json()).toEqual({
      definitions: [
        generatorDefinitionFromExecutablePluginRegistration(global),
      ],
    });
  }
});

it("applies the same project scope to exact Definition reads without exposing its contract", async () => {
  const host = await fixture();
  const path = `/api/v1/generator-definitions/${scoped.pluginId}/edit`;
  const allowed = await host.request(`${path}?projectId=allowed`);
  expect(await allowed.json()).toEqual({
    definition: generatorDefinitionFromExecutablePluginRegistration(scoped),
  });
  for (const query of ["?projectId=other", ""]) {
    const denied = await host.request(`${path}${query}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).not.toHaveProperty("definition");
  }
});

it("preserves discovery when the Host has no installation-scope policy", async () => {
  const host = await fixture(false);
  const response = await host.request("/api/v1/generator-definitions");
  expect(await response.json()).toEqual({
    definitions: [scoped, global].map(
      generatorDefinitionFromExecutablePluginRegistration,
    ),
  });
  expect(
    (
      await host.request(
        `/api/v1/generator-definitions/${scoped.pluginId}/edit`,
      )
    ).status,
  ).toBe(200);
});
