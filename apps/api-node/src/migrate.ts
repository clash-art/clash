import { databaseUrl } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { migrateTaskQueue } from "./task-runtime.ts";
import {
  runMigrations,
  type MigrationReport,
  type RunMigrationsOptions,
} from "./migrations.ts";
/**
 * The one migrate path (decision 12: Postgres only): application schema under
 * the advisory lock, then BullMQ's queue schema. A plan touches neither.
 * Startup never calls this; run it once per rollout (`gateway migrate`).
 */
export async function migrate(
  env: Record<string, string | undefined> = process.env,
  options: Omit<RunMigrationsOptions, "migrations"> = {},
): Promise<MigrationReport> {
  const database = openPostgres({ connectionString: databaseUrl(env), max: 1 });
  try {
    const report = await runMigrations(database.db, options);
    if (!options.plan) await migrateTaskQueue(databaseUrl(env));
    return report;
  } finally {
    await database.close();
  }
}
