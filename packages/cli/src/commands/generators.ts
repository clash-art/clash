import { projectGeneratorRequestContract } from "@clash/shared-types";
import { Command } from "commander";
import {
  createGeneratorClient,
  type GeneratorRequest,
} from "@clash/shared-runtime/generator-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";

function parseInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`--input must be valid JSON: ${(error as Error).message}`);
  }
}

async function projectId(value?: string): Promise<string> {
  return (await resolveProjectContext({ project: value })).projectId;
}

export function createGeneratorsCommand(
  deps: { request?: GeneratorRequest; output?: (value: unknown) => void } = {},
): Command {
  const client = createGeneratorClient(deps.request ?? apiFetch);
  const output = deps.output ?? printJson;
  const command = new Command("generators").description(
    "Inspect and operate native Project Generators and Action Runs",
  );

  command
    .command("contract <operation>")
    .description("Show the shared --input JSON Schema for create, advance, or submit; no project required")
    .action((operation) => output(projectGeneratorRequestContract(operation)));

  command
    .command("definitions")
    .description("List registered GeneratorDefinitions")
    .action(async () => output(await client.listDefinitions()));
  command
    .command("definition <pluginId> <definitionId>")
    .description("Read one registered GeneratorDefinition")
    .action(async (pluginId, definitionId) =>
      output(await client.getDefinition(pluginId, definitionId)),
    );

  command
    .command("create")
    .requiredOption("--input <json>", "Request JSON; see generators contract create")
    .option("--project <id>")
    .action(async (options) =>
      output(
        await client.createGenerator(
          await projectId(options.project),
          parseInput(options.input),
        ),
      ),
    );
  command
    .command("get <generatorId>")
    .option("--project <id>")
    .action(async (generatorId, options) =>
      output(
        await client.getGenerator(
          await projectId(options.project),
          generatorId,
        ),
      ),
    );
  command
    .command("advance <generatorId>")
    .requiredOption("--input <json>", "Request JSON; see generators contract advance")
    .option("--project <id>")
    .action(async (generatorId, options) =>
      output(
        await client.advanceGenerator(
          await projectId(options.project),
          generatorId,
          parseInput(options.input),
        ),
      ),
    );

  const runs = command
    .command("runs")
    .description("Submit and read native Generator Action Runs");
  runs
    .command("submit <generatorId> <actionId>")
    .requiredOption("--input <json>", "Request JSON; see generators contract submit")
    .option("--project <id>")
    .action(async (generatorId, actionId, options) =>
      output(
        await client.submitActionRun(
          await projectId(options.project),
          generatorId,
          actionId,
          parseInput(options.input),
        ),
      ),
    );
  runs
    .command("get <actionRunId>")
    .option("--project <id>")
    .action(async (actionRunId, options) =>
      output(
        await client.getActionRun(
          await projectId(options.project),
          actionRunId,
        ),
      ),
    );
  runs
    .command("output <actionRunId> <outputSlot>")
    .option("--project <id>")
    .action(async (actionRunId, outputSlot, options) =>
      output(
        await client.getOutputCommit(
          await projectId(options.project),
          actionRunId,
          outputSlot,
        ),
      ),
    );
  return command;
}

export const generatorsCommand = createGeneratorsCommand();
