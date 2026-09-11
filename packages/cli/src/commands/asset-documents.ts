import { Command } from "commander";
import { createDocumentClient, type DocumentRequest } from "@clash/shared-runtime/document-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";

export function createAssetDocumentsCommand(deps: { request?: DocumentRequest; output?: (value: unknown) => void } = {}): Command {
  const client = createDocumentClient(deps.request ?? apiFetch);
  const command = new Command("documents").description("Read immutable Project Document Asset revisions");
  command.command("get <documentAssetId>")
    .requiredOption("--revision <id>", "Exact Revision ID from the Output Commit or pinned input")
    .option("--project <id>", "Project ID, defaults to the working-tree project")
    .action(async (documentAssetId, options) => {
      const { projectId } = await resolveProjectContext({ project: options.project });
      (deps.output ?? printJson)(await client.getRevision(projectId, documentAssetId, options.revision));
    });
  return command;
}
