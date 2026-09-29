import { pathToFileURL } from "node:url";
import { databaseUrl } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { migrateTaskQueue } from "./task-runtime.ts";
import { migrateDatabase } from "./migrations.ts";
export async function migrate(
  env: Record<string, string | undefined> = process.env,
) {
  const database = openPostgres({ connectionString: databaseUrl(env) });
  try {
    await migrateDatabase(database.db);
    await migrateTaskQueue(databaseUrl(env));
  } finally {
    await database.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await migrate()
    .then(() => console.log("Cloud database migrations applied"))
    .catch(() => {
      console.error("Cloud database migration failed");
      process.exitCode = 1;
    });
}
