import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { executablePluginSchemaHash } from "@clash/shared-runtime/executable-plugin-schema-hash";

import { readHostedPackage } from "./runtime/host/lib/actions-loader.js";

/**
 * The Cloudflare adapter binds first-party plugins from their `./module` entry, which lists the
 * plugin's JSON documents statically. A drifted list would give the cloud a different schemaHash
 * than local, and every binding equality check would fail as a contract violation.
 */
describe("cloud plugin module schema hash parity", () => {
  it("clash.fal ./module hashes exactly what the local loader reads from disk", async () => {
    const pluginDir = realpathSync(
      fileURLToPath(new URL("../node_modules/@clash-plugin/fal", import.meta.url)),
    );
    const disk = await readHostedPackage(pluginDir);
    const fromDisk = executablePluginSchemaHash(
      disk.manifest,
      disk.cards,
      disk.providers,
      disk.modelBindings,
      disk.generators,
      disk.views,
    );
    const cloud = await import("@clash-plugin/fal/module");
    expect(cloud.schemaHash).toBe(fromDisk);
    expect(cloud.manifestDocument.version).toBe(disk.manifest.version);
  });
});
