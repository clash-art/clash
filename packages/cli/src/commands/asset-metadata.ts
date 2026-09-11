import { Command } from "commander";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  listDeclaredAssetMetadataKinds,
  parseDeclaredAssetMetadata,
} from "@clash/shared-types";

import { isJsonMode, printJson } from "../lib/output";
import { readAssetMetadataBody } from "../lib/legacy-metadata-body";
import { loadWorkspaceMetadataKinds } from "../lib/workspace-metadata-kinds";

export const assetMetadataCommand = new Command("metadata").description(
  "Read legacy declared metadata on an asset; writes use native Documents",
);

async function readJsonArgument(value: string): Promise<unknown> {
  const contents =
    value === "-" ? readFileSync(0, "utf8") : await readFile(value, "utf8");
  return JSON.parse(contents) as unknown;
}

async function readAssetManifest(cwd: string, assetsPath?: string) {
  const path = assetsPath ?? join(cwd, "assets", "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    assets?: Array<{ id: string; metadata?: Record<string, unknown> }>;
  };
  return { path, manifest };
}

assetMetadataCommand
  .command("kinds")
  .description("List every metadata kind this build declares")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await loadWorkspaceMetadataKinds(process.cwd());
    const kinds = listDeclaredAssetMetadataKinds();
    if (isJsonMode(options)) {
      printJson(kinds);
      return;
    }
    for (const kind of kinds) console.log(kind);
  });

assetMetadataCommand
  .command("list")
  .description("List the metadata attached to one asset")
  .requiredOption("--asset <id>", "Asset id")
  .option("--assets <path>", "Asset manifest path")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const { manifest } = await readAssetManifest(
        process.cwd(),
        options.assets,
      );
      const asset = manifest.assets?.find(
        (candidate) => candidate.id === options.asset,
      );
      if (!asset) throw new Error(`Asset ${options.asset} not found`);
      const attached: Array<Record<string, unknown>> = Object.entries(
        asset.metadata ?? {},
      )
        .filter(
          ([key, value]) =>
            key !== "metadataFills" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value),
        )
        .map(([kind, value]) => ({
          ...(value as Record<string, unknown>),
          kind,
        }));
      if (isJsonMode(options)) {
        printJson(attached);
        return;
      }
      for (const entry of attached) {
        console.log(
          `${entry.kind}${entry.bodyHash ? `  body ${String(entry.bodyHash).slice(0, 19)}…` : ""}`,
        );
      }
      if (attached.length === 0) console.log("No metadata attached.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

assetMetadataCommand
  .command("get")
  .description("Read one attached metadata kind, or its stored body")
  .requiredOption("--asset <id>", "Asset id")
  .requiredOption("--kind <kind>", "Declared metadata kind")
  .option("--body", "Print the stored body instead of the attached identity")
  .option("--assets <path>", "Asset manifest path")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const { manifest } = await readAssetManifest(
        process.cwd(),
        options.assets,
      );
      const asset = manifest.assets?.find(
        (candidate) => candidate.id === options.asset,
      );
      if (!asset) throw new Error(`Asset ${options.asset} not found`);
      const attached = asset.metadata?.[options.kind];
      if (!attached)
        throw new Error(
          `Asset ${options.asset} has no ${options.kind} metadata`,
        );
      if (!options.body) {
        printJson(attached);
        return;
      }
      const bodyHash = (attached as { bodyHash?: unknown }).bodyHash;
      if (typeof bodyHash !== "string") {
        throw new Error(
          `${options.kind} on ${options.asset} has no stored body`,
        );
      }
      printJson(await readAssetMetadataBody({ contentHash: bodyHash }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

function retiredMetadataWrite(): never {
  throw new Error(
    "METADATA_WRITE_RETIRED: Manifest metadata is read-only. Use clash assets documents create --kind <kind> --file <body>, then documents pull/apply and documents attach. Descriptive media facts are not Document bodies.",
  );
}
assetMetadataCommand
  .command("set")
  .description("Retired manifest metadata write")
  .option("--asset <id>")
  .option("--kind <kind>")
  .option("--metadata <path>")
  .option("--body <path>")
  .option("--producer <id>")
  .option("--assets <path>")
  .option("--json")
  .action(retiredMetadataWrite);
assetMetadataCommand
  .command("apply")
  .description("Retired manifest metadata projection write")
  .option("--file <path>")
  .option("--assets <path>")
  .option("--json")
  .action(retiredMetadataWrite);

assetMetadataCommand
  .command("validate")
  .description(
    "Check a metadata document against its declared schema without writing",
  )
  .requiredOption("--kind <kind>", "Declared metadata kind")
  .requiredOption("--metadata <path>", "Metadata JSON path, or - for stdin")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      await loadWorkspaceMetadataKinds(process.cwd());
      parseDeclaredAssetMetadata(
        options.kind,
        await readJsonArgument(options.metadata),
      );
      if (isJsonMode(options)) {
        printJson({ valid: true, kind: options.kind });
        return;
      }
      console.log(`${options.kind}: valid`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
