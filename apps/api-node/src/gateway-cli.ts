/**
 * Gateway-node operator CLI (#377). One-shot commands, never run on startup:
 *
 *   gateway migrate [--plan] [--allow-contract] [--lock-timeout-ms <ms>]
 *   gateway seed
 *
 * `migrate` is the one Postgres migrate path (decision 12): advisory-locked,
 * one transaction, expand/contract-gated; `--plan` reports without writing.
 * `seed` publishes the Flash-only DeepSeek staging catalog on a migrated
 * database. Each prints one JSON report line on stdout and exits 0, or prints
 * `CODE: message` on stderr and exits non-zero. Staging/test databases only;
 * see apps/docs/guide/gateway-node-rollout.md.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { migrate } from "./migrate.ts";
import { MigrationError, type MigrationReport } from "./migrations.ts";
import { GatewaySeedError, seedGateway } from "./gateway-seed.ts";
import { errorFacts } from "./log.ts";
import { databaseUrl } from "./config.ts";

export const GATEWAY_MIGRATE_DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export interface GatewayCliDeps {
  env: Record<string, string | undefined>;
  migrate(options: {
    plan: boolean;
    allowContract: boolean;
    lockTimeoutMs: number;
  }): Promise<MigrationReport>;
  seed(): Promise<{ models: number; prices: number }>;
  stdout(line: string): void;
  stderr(line: string): void;
}

const USAGE =
  "usage: gateway migrate [--plan] [--allow-contract] [--lock-timeout-ms <ms>] | gateway seed";

class GatewayCliUsageError extends Error {
  readonly code = "GATEWAY_CLI_USAGE";
}
class GatewayCliConfigError extends Error {
  readonly code = "GATEWAY_CLI_CONFIG";
}

/** config.ts messages name the variable, never its value. */
function requireDatabaseUrl(env: Record<string, string | undefined>): void {
  try {
    databaseUrl(env);
  } catch (error) {
    throw new GatewayCliConfigError(
      error instanceof Error ? error.message : "DATABASE_URL is invalid",
    );
  }
}

function parseMigrateArgs(args: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        plan: { type: "boolean", default: false },
        "allow-contract": { type: "boolean", default: false },
        "lock-timeout-ms": { type: "string" },
      },
    }));
  } catch (error) {
    throw new GatewayCliUsageError(
      error instanceof Error ? error.message : USAGE,
    );
  }
  const raw = values["lock-timeout-ms"];
  const lockTimeoutMs =
    raw === undefined ? GATEWAY_MIGRATE_DEFAULT_LOCK_TIMEOUT_MS : Number(raw);
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1)
    throw new GatewayCliUsageError(
      "--lock-timeout-ms must be a positive integer",
    );
  return {
    plan: values.plan,
    allowContract: values["allow-contract"],
    lockTimeoutMs,
  };
}

/** Coded stderr line; uncoded failures report only error class/driver code. */
function failure(error: unknown, fallback: string): string {
  if (
    error instanceof MigrationError ||
    error instanceof GatewaySeedError ||
    error instanceof GatewayCliUsageError ||
    error instanceof GatewayCliConfigError
  )
    return `${error.code}: ${error.message}`;
  return `${fallback}: ${JSON.stringify(errorFacts(error))}`;
}

export async function runGatewayCli(
  argv: readonly string[],
  deps: GatewayCliDeps,
): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "migrate") {
      const options = parseMigrateArgs(args);
      requireDatabaseUrl(deps.env);
      const report = await deps.migrate(options);
      deps.stdout(
        JSON.stringify({
          command: options.plan ? "plan" : "migrate",
          ...report,
        }),
      );
      return 0;
    }
    if (command === "seed") {
      if (args.length) throw new GatewayCliUsageError(USAGE);
      requireDatabaseUrl(deps.env);
      const result = await deps.seed();
      deps.stdout(
        JSON.stringify({ command: "seed", deepseek: "flash-only", ...result }),
      );
      return 0;
    }
    throw new GatewayCliUsageError(USAGE);
  } catch (error) {
    if (error instanceof GatewayCliUsageError) {
      deps.stderr(failure(error, "GATEWAY_CLI_USAGE"));
      return 2;
    }
    deps.stderr(
      failure(
        error,
        command === "seed" ? "GATEWAY_SEED_FAILED" : "GATEWAY_MIGRATE_FAILED",
      ),
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runGatewayCli(process.argv.slice(2), {
    env: process.env,
    migrate: (options) => migrate(process.env, options),
    seed: () => seedGateway(process.env),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}
