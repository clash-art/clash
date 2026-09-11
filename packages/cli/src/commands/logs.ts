import { Command, InvalidArgumentError, Option } from "commander";
import { join } from "node:path";
import {
  readLocalLogs,
  type LocalLogQuery,
} from "@clash/shared-runtime/log-reader";
import {
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
} from "@clash/shared-runtime/local-paths";

function duration(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match)
    throw new InvalidArgumentError("Use a duration such as 30m, 2h or 1d.");
  return (
    Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!
  );
}

export async function runLogs(
  options: Omit<LocalLogQuery, "directory"> & {
    json?: boolean;
    directory?: string;
    stdout?: (line: string) => void;
  },
) {
  const output = options.stdout ?? console.log;
  const result = await readLocalLogs({
    ...options,
    directory:
      options.directory ??
      join(clashHomeForLocalDataDir(defaultLocalApiDataDir()), "logs"),
  });
  if (options.json) {
    output(JSON.stringify(result, null, 2));
    return result;
  }
  output(`Logs: ${result.directory}`);
  output(
    `${result.matched} matching records; showing ${result.records.length}; ${result.invalidLines} incomplete/invalid lines`,
  );
  for (const item of result.summary.slice(0, 10))
    output(`${item.count} × ${item.event}`);
  for (const record of result.records) {
    output(
      `${record.timestamp} ${record.level.toUpperCase()} ${record.component}/${record.module} ${record.event}`,
    );
    output(`  ${JSON.stringify(record.context)}`);
    output(
      `  ${record.file}:${record.line}${record.runId ? ` run=${record.runId}` : ""}${record.legacy ? " (legacy)" : ""}`,
    );
  }
  if (result.startupLog) output(`Startup fallback: ${result.startupLog.file}`);
  return result;
}

export const logsCommand = new Command("logs")
  .description(
    "Query this profile's local desktop, renderer and Host diagnostics without starting the Host",
  )
  .addOption(
    new Option("--level <level>", "Minimum severity")
      .choices(["debug", "info", "warn", "error"])
      .default("warn"),
  )
  .option(
    "--since <duration>",
    "Recent time window (30m, 2h, 1d)",
    duration,
    86_400_000,
  )
  .addOption(
    new Option("--component <name>", "Process/surface").choices([
      "desktop",
      "renderer",
      "local-api",
    ]),
  )
  .option("--project <id>", "Filter project identity")
  .option("--asset <id>", "Filter asset identity")
  .option(
    "--event <prefix>",
    "Filter named event prefix, e.g. sync. or plugin.",
  )
  .option("--run <id>", "Filter one process run")
  .option(
    "--limit <count>",
    "Maximum returned records (1–1000)",
    (value) => {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 1_000)
        throw new InvalidArgumentError(
          "Limit must be an integer from 1 to 1000.",
        );
      return count;
    },
    50,
  )
  .option("--json", "Output records, event counts and file locations as JSON")
  .action(async (options) => {
    await runLogs({
      ...options,
      projectId: options.project,
      assetId: options.asset,
      runId: options.run,
      since: Date.now() - options.since,
    });
  });
