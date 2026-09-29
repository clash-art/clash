import { Command } from "commander";
import { createAssetSearchClient } from "@clash/shared-runtime/asset-search-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";

export function createAssetSearchCommand() {
  return new Command("search")
    .description(
      "Find project media by attached descriptions, analysis or transcript; returns exact evidence and source times",
    )
    .argument("[query]", "Content to find; omit to read attached evidence")
    .option("--asset <id>", "Restrict to one Asset")
    .option("--project <id>", "Project from cwd by default")
    .option("--json", "Structured output (always enabled)")
    .action(async (query: string | undefined, options) => {
      const { projectId } = await resolveProjectContext({
        project: options.project,
      });
      printJson(
        await createAssetSearchClient(apiFetch).search(projectId, {
          query,
          assetId: options.asset,
        }),
      );
    });
}
