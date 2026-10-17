/**
 * Plugin catalog for cloud Project Hosts.
 *
 * Bundled plugin packages are validated and projected with the same functions
 * local-api uses for installed plugins, so catalog responses keep one shape.
 * A cloud adapter lists only what it can execute: a Generator is exposed when
 * the adapter handles its projection surface, and `runtime.kind: "local"`
 * Actions never are.
 */
import {
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
  type CustomActionDefinition,
  type ExecutablePluginGeneratorRegistration,
  type ExecutablePluginViewDocument,
  type ExecutablePluginViewRegistration,
  type GeneratorDefinition,
  type GeneratorProjectionSurfaceId,
} from "@clash/shared-types";
import { executablePluginSchemaHash } from "../executable-plugin-schema-hash.js";

export interface CloudPluginPackage {
  manifest: unknown;
  /** Generator documents keyed by their manifest path. */
  generators: Record<string, unknown>;
  /** View documents keyed by their manifest path, when the manifest declares any. */
  views?: Record<string, unknown>;
}

export interface CloudPluginCatalogOptions {
  /**
   * Projection surfaces this adapter executes (today `clash.timeline`). The
   * surface, not the plugin-local `definitionId`, names what a Host command
   * handler serves.
   */
  executableGeneratorIds: readonly GeneratorProjectionSurfaceId[];
}

export type CloudPluginView = Pick<
  ExecutablePluginViewRegistration,
  "pluginId" | "version" | "schemaHash"
> &
  ExecutablePluginViewDocument["spec"];

export interface CloudPluginCatalog {
  /** Same contract as local-api's `options.listPluginGenerators`. */
  listPluginGenerators(): Promise<ExecutablePluginGeneratorRegistration[]>;
  generatorDefinitions(): GeneratorDefinition[];
  resolveGeneratorDefinition(
    pluginId: string,
    definitionId: string,
  ): GeneratorDefinition | undefined;
  /** `GET /api/v1/plugin-views` entries. */
  views(): CloudPluginView[];
  /** `GET /api/v1/plugin-actions` entries; local-runtime Actions are not executable here. */
  actions(): CustomActionDefinition[];
}

export function createCloudPluginCatalog(
  packages: readonly CloudPluginPackage[],
  options: CloudPluginCatalogOptions,
): CloudPluginCatalog {
  const executable = new Set<string>(options.executableGeneratorIds);
  const generators: ExecutablePluginGeneratorRegistration[] = [];
  const views: CloudPluginView[] = [];
  for (const input of packages) {
    const pkg = validateExecutablePluginPackage(
      input.manifest,
      {},
      {},
      { generators: input.generators, views: input.views ?? {} },
    );
    const provenance = {
      pluginId: pkg.manifest.id,
      version: pkg.manifest.version,
      schemaHash: executablePluginSchemaHash(
        pkg.manifest,
        pkg.cards,
        pkg.providers,
        pkg.modelBindings,
        pkg.generators,
        pkg.views,
      ),
    };
    for (const document of Object.values(pkg.generators)) {
      const surface = document.spec.projectionSurface?.id;
      if (surface && executable.has(surface))
        generators.push({ ...provenance, document });
    }
    for (const document of Object.values(pkg.views))
      views.push({ ...provenance, ...document.spec });
  }
  const definitions = generators.map(
    generatorDefinitionFromExecutablePluginRegistration,
  );
  return {
    async listPluginGenerators() {
      return [...generators];
    },
    generatorDefinitions() {
      return [...definitions];
    },
    resolveGeneratorDefinition(pluginId, definitionId) {
      return definitions.find(
        (definition) =>
          definition.pluginId === pluginId &&
          definition.definitionId === definitionId,
      );
    },
    views() {
      return [...views];
    },
    actions() {
      return [];
    },
  };
}
