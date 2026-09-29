import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  createActionClient,
  type ActionInvocation,
} from "@clash/shared-runtime/action-client";
import { createAssetEvidenceClient } from "@clash/shared-runtime/asset-evidence-client";
import { agentDocumentRequest } from "@clash/shared-runtime/document-client";
import type { GeneratorRequest } from "@clash/shared-runtime/generator-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";

function jsonObject(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${String(error)}`);
  }
}
function waitMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000)
    throw new Error("wait-ms must be between 0 and 60000");
  return parsed;
}

export function createActionsCommand(
  deps: { request?: GeneratorRequest; output?: (value: unknown) => void } = {},
) {
  const request = deps.request ?? apiFetch;
  const client = createActionClient(request);
  const evidence = createAssetEvidenceClient(agentDocumentRequest(request));
  const output = deps.output ?? printJson;
  const project = async (value?: string) =>
    (await resolveProjectContext({ project: value })).projectId;
  const command = new Command("actions")
    .summary("Discover, run and resume media operations with visible history")
    .description("Run installed project Actions, including project custom Actions.")
    .addHelpText("after", `

Discover only the operation you need:
  clash actions list --query video-clipper
  clash actions list --query image-editor
  clash actions list --query analysis

The result includes key, parametersSchema, stateSchema and input/output slots.
Use the returned key; short definition.action names work when unambiguous.
Examples for the bundled asset-edit Actions (times are seconds):
  clash actions run video-clipper.crop --asset <id> --params '{"startSec":6,"endSec":8}'
  clash actions run video-clipper.screenshot --asset <id> --params '{"frameTimeSec":0}'
  clash actions run image-editor.transform --asset <id> --params '{"rotation":90}'

--asset supplies a single source slot. For other contracts use --inputs '<JSON>'
for named refs, --params '<JSON>' for operation parameters, and --state '<JSON>'
only when the discovered stateSchema requires it. Add --project <id> to override cwd.

Results include status, actionRunId and outputs[].reference/value. Media outputs
have reference.projectAssetId; Documents retain their exact revision. Sources,
parameters and outputs are recorded on Canvas automatically.

If pending/running, or a disconnect returns an actionRunId:
  clash actions wait <actionRunId>
To read an old Run without waiting: clash actions wait <actionRunId> --wait-ms 0
Default wait is 30 seconds, maximum 60 seconds. Resume that Run, do not resubmit.
For failed work, inspect diagnostics before choosing a recovery or new input.

External work: import its output, then use record for command detail and refs,
or observe for analysis. These records do not execute commands or invent Runs.
Use record --help or observe --help for their file formats.`);
  const scope = (leaf: Command) =>
    leaf
      .option("--project <id>", "Project from cwd by default")
      .option("--json", "Structured output (always enabled)");
  scope(
    command
      .command("list")
      .description(
        "Find installed Actions available to this project, including custom Actions",
      )
      .option(
        "--query <text>",
        "Filter operation names and parameter descriptions",
      ),
  ).action(async (options) =>
    output(
      await client.list(await project(options.project), {
        query: options.query,
      }),
    ),
  );
  scope(
    command
      .command("run <action>")
      .description(
        "Run plugin/definition/action or an unambiguous definition.action, show it on Canvas, and return usable outputs",
      )
      .option("--asset <id>", "Source Asset for an Action with one input slot")
      .option(
        "--inputs <json>",
        "Named input slots mapped to Asset IDs or exact Document references",
      )
      .option(
        "--params <json>",
        "Operation parameters, e.g. '{\"rotation\":90}'",
      )
      .option(
        "--state <json>",
        "Custom Generator state when required by its definition",
      )
      .option(
        "--request-id <id>",
        "Reuse the same ID to recover an uncertain submission",
      )
      .option("--canvas <id>", "Canvas for the operation and result", "main")
      .option("--label <text>", "Human-readable operation label")
      .option(
        "--account <id>",
        "Provider account for direct model execution; media analysis uses Settings routing",
      )
      .option(
        "--wait-ms <ms>",
        "Bounded wait; continue with actions wait if still running",
        waitMs,
        30_000,
      ),
  ).action(async (action, options) => {
    const input: ActionInvocation = {
      action,
      assetId: options.asset,
      parameters: jsonObject(options.params, "params"),
      state: jsonObject(options.state, "state"),
      inputs: jsonObject(options.inputs, "inputs"),
      requestId: options.requestId,
      canvasId: options.canvas,
      label: options.label,
      providerAccountId: options.account,
      waitMs: options.waitMs,
    };
    try {
      output(await client.invoke(await project(options.project), input));
    } catch (error) {
      if (error instanceof Error && "actionRunId" in error)
        output({
          error: error.message,
          actionRunId: error.actionRunId,
          recovery: (error as Error & { recovery?: string }).recovery,
        });
      throw error;
    }
  });
  scope(
    command
      .command("wait <actionRunId>")
      .description("Read or wait on existing work without submitting again")
      .option("--wait-ms <ms>", "Bounded wait in milliseconds", waitMs, 30_000),
  ).action(async (id, options) =>
    output(
      await client.wait(await project(options.project), id, {
        waitMs: options.waitMs,
      }),
    ),
  );
  scope(
    command
      .command("record")
      .description(
        "Record one-off external work and references; detail is text and is never executed",
      )
      .requiredOption("--source <ids...>", "Original Asset IDs")
      .requiredOption("--output <ids...>", "Already imported result Asset IDs")
      .requiredOption("--title <text>", "Human-readable description")
      .option("--detail <text>", "Command or processing notes")
      .option("--detail-file <path>", "Read command/notes verbatim from a file")
      .option(
        "--record-id <id>",
        "Stable identity to recover an interrupted record",
      ),
  ).action(async (options) => {
    if (!!options.detail === !!options.detailFile)
      throw new Error("Provide exactly one of --detail or --detail-file");
    output(
      await evidence.recordTrace(await project(options.project), {
        title: options.title,
        detail: options.detail ?? readFileSync(options.detailFile, "utf8"),
        sources: options.source,
        outputs: options.output,
        recordId: options.recordId,
      }),
    );
  });
  scope(
    command
      .command("observe")
      .description(
        "Attach external analysis to an Asset with honest actor/tool attribution",
      )
      .requiredOption("--asset <id>", "Analysed Asset ID")
      .requiredOption(
        "--file <path>",
        "JSON: summary, optional tool/model and observations with source startMs/endMs",
      )
      .option("--record-id <id>", "Stable identity for replay"),
  ).action(async (options) =>
    output(
      await evidence.recordObservation(await project(options.project), {
        assetId: options.asset,
        body: JSON.parse(readFileSync(options.file, "utf8")),
        recordId: options.recordId,
      }),
    ),
  );
  return command;
}

export const actionsCommand = createActionsCommand();
