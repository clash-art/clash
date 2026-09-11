import { Command } from "commander";
import { resolveClashProfile } from "@clash/shared-runtime/local-paths";
import { assetsCommand } from "./commands/assets";
import { auditCommand } from "./commands/audit";
import { authCommand } from "./commands/auth";
import { canvasCommand } from "./commands/canvas";
import { canvasesCommand } from "./commands/canvases";
import { directorCommand } from "./commands/director";
import { doctorCommand } from "./commands/doctor";
import { effectCommand } from "./commands/effects";
import { logsCommand } from "./commands/logs";
import { hostCommand } from "./commands/host";
import { generatorsCommand } from "./commands/generators";
import { modelsCommand } from "./commands/models";
import { pluginCommand } from "./commands/plugin";
import { projectionCommand } from "./commands/projection";
import { initCommand, projectsCommand } from "./commands/projects";
import { registerProviderCommands } from "./commands/providers";
import { textCommand } from "./commands/text";
import { timelineCommand } from "./commands/timeline";
import { workspaceCommand } from "./commands/workspace";
import { installCliTrace } from "./lib/cli-trace";

const DESCRIPTION = `Clash CLI — AI video production from your terminal

Local setup:
  1. Open Clash Desktop or start the local-api host
  2. clash init --project <id>    # link this cwd through .clash/project.toml
  3. clash host status            # verify the local-api host

Local commands do not require cloud authentication.
Optional cloud sync: clash auth login

Environment variables:
  CLASH_API_URL      Override the discovered local host or optional cloud API URL
  CLASH_HOME         Local Clash home (default: ~/.clash)
  CLASH_PROFILE      Runtime profile: dev or prod (default: prod)
  CLASH_PROJECT_ID   Project override when no cwd marker is available
  CLASH_CANVAS_ID    Canvas scope for canvas node commands
  CLASH_API_KEY      Remote/cloud credential override (not needed for local-api)

Project identity lives in .clash/project.toml. Collaborative state remains in
the host-owned Project Loro replica; cwd files are editable projections and drafts.`;

export type CliProgramOptions = {
  beforeAction?: (program: Command) => void | Promise<void>;
};

/**
 * Builds the one public Clash command surface.
 *
 * Source development and the packaged distribution differ only in how they
 * ensure a local-api host exists. Commands, help, profiles and failure
 * behavior stay here so the two launch paths cannot drift.
 */
export function createCliProgram(options: CliProgramOptions = {}): Command {
  const program = new Command()
    .name("clash")
    .description(DESCRIPTION)
    .option("--profile <profile>", "Runtime profile: dev or prod")
    .version(process.env.CLASH_DISTRIBUTION_VERSION ?? "0.1.0");

  program.hook("preAction", async (_command, actionCommand) => {
    const requested = program.opts<{ profile?: string }>().profile;
    process.env.CLASH_PROFILE = resolveClashProfile({
      ...process.env,
      ...(requested ? { CLASH_PROFILE: requested } : {}),
    });
    // Offline diagnostics must remain available when Host startup itself failed.
    if (actionCommand.name() !== "logs") await options.beforeAction?.(program);
  });

  program.addCommand(authCommand);
  program.addCommand(initCommand);
  program.addCommand(projectsCommand);
  program.addCommand(canvasCommand);
  program.addCommand(canvasesCommand);
  program.addCommand(pluginCommand);
  program.addCommand(modelsCommand);
  program.addCommand(hostCommand);
  program.addCommand(logsCommand);
  program.addCommand(generatorsCommand);
  registerProviderCommands(program);
  program.addCommand(timelineCommand);
  program.addCommand(doctorCommand);
  program.addCommand(textCommand);
  program.addCommand(projectionCommand);
  program.addCommand(assetsCommand);
  program.addCommand(auditCommand);
  program.addCommand(effectCommand);
  program.addCommand(directorCommand);
  program.addCommand(workspaceCommand);

  return program;
}

function reportFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.CLASH_DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  } else {
    console.error(message);
  }
  process.exit(1);
}

export function runCli(options: CliProgramOptions = {}): void {
  installCliTrace();
  const program = createCliProgram(options);

  process.on("unhandledRejection", reportFailure);
  process.on("uncaughtException", reportFailure);

  // Electron's Node mode keeps a Node-compatible script path in argv, so both
  // source and packaged launchers deliberately use the same parsing contract.
  void program.parseAsync(process.argv, { from: "node" }).catch(reportFailure);
}
