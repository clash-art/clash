import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoroDoc } from "loro-crdt";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
  type ExecutablePluginGeneratorRegistration,
} from "@clash/shared-types";
import { executablePluginSchemaHash } from "@clash/shared-runtime/executable-plugin-schema-hash";
import {
  CONTRACT_SAMPLE_VIDEO_FILE,
  describeProjectHostContract,
} from "@clash/shared-runtime/project-host-contract";
import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import type { LocalProjectAssetReplica } from "./local-project-assets.js";
import { LocalLoroRoomHub } from "./sync.js";

const readJson = async (path: string) =>
  JSON.parse(
    await readFile(new URL(`../../../${path}`, import.meta.url), "utf8"),
  ) as unknown;

/** The bundled Remotion package's Generator, registered as the plugin host does. */
async function remotionGenerators(): Promise<ExecutablePluginGeneratorRegistration[]> {
  const pkg = validateExecutablePluginPackage(
    await readJson("plugins/remotion/manifest.json"),
    {},
    {},
    {
      generators: {
        "generators/timeline.json": await readJson(
          "plugins/remotion/generators/timeline.json",
        ),
      },
    },
  );
  const schemaHash = executablePluginSchemaHash(
    pkg.manifest,
    pkg.cards,
    pkg.providers,
    pkg.modelBindings,
    pkg.generators,
    pkg.views,
  );
  return Object.values(pkg.generators).map((document) => ({
    pluginId: pkg.manifest.id,
    version: pkg.manifest.version,
    schemaHash,
    document,
  }));
}

describeProjectHostContract("local-api (desktop Host)", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "local-api-contract-"));
  const dataDir = join(clashRoot, "local-api");
  const hub = new LocalLoroRoomHub(dataDir, undefined, null);
  const apps = managedLocalApiApps();
  const generators = await remotionGenerators();
  const endpoint = "http://127.0.0.1:49152";
  const app = apps.createApp({
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => endpoint,
    listPluginGenerators: async () => generators,
    resolveGeneratorDefinition: async (pluginId, definitionId) => {
      const registration = generators.find(
        (entry) =>
          entry.pluginId === pluginId &&
          entry.document.spec.definitionId === definitionId,
      );
      if (!registration)
        throw new Error(`Generator Definition ${pluginId}/${definitionId} not found`);
      return generatorDefinitionFromExecutablePluginRegistration(registration);
    },
    projectAssetReplica: {
      inspect: <T>(
        id: string,
        read: Parameters<LocalProjectAssetReplica["inspect"]>[1],
      ) => hub.inspectProject(id, read) as Promise<T>,
      mutate: (
        id: string,
        mutation: Parameters<LocalProjectAssetReplica["mutate"]>[1],
      ) => hub.mutateProject(id, mutation),
    } as LocalProjectAssetReplica,
    generatorProjectAuthority: {
      inspect: <T>(id: string, read: (doc: LoroDoc) => T | Promise<T>) =>
        hub.inspectProject(id, read),
      mutate: <T>(
        id: string,
        mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
      ) => hub.mutateProjectWithCheckpoint(id, mutation),
    },
  });
  return {
    endpoint,
    projectId: "contract-project",
    fetch: async (input, init) =>
      app.request(String(input instanceof Request ? input.url : input), init),
    capabilities: {
      "catalog.generators": "supported",
      "catalog.views": "supported",
      "catalog.actions": "supported",
      "timeline.list": "supported",
      "timeline.create": "supported",
      "timeline.update": "supported",
      "timeline.attach": "supported",
      "timeline.detach": "supported",
      "timeline.delete": "supported",
      "timeline.render": "supported",
      "assets.list": "supported",
      "assets.batch": "supported",
      "assets.get": "supported",
      "assets.references": "supported",
      "assets.import": "supported",
      "assets.import.chunked": "unavailable",
      "assets.trash": "supported",
      "assets.restore": "supported",
      "assets.media": "supported",
      "text.revisions": "supported",
    },
    // A stale Timeline write is rejected, but as HTTP 200 with
    // `{ code: "STALE_READ", error }` rather than 409 (host-command returns
    // every command error body with 200). local-api behaviour is frozen here.
    knownGaps: ["timeline.update"],
    sampleVideo: {
      bytes: new Uint8Array(
        await readFile(
          new URL(
            `../../../packages/shared-runtime/src/project-host-contract/fixtures/${CONTRACT_SAMPLE_VIDEO_FILE}`,
            import.meta.url,
          ),
        ),
      ),
      fileName: CONTRACT_SAMPLE_VIDEO_FILE,
      contentType: "video/mp4",
    },
    close: async () => {
      await apps.close();
      await hub.close();
      await rm(clashRoot, { recursive: true, force: true });
    },
  };
});
