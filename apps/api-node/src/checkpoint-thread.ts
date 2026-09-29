import { parentPort, workerData } from "node:worker_threads";
import { buildProjectCheckpoint } from "./checkpoint.ts";
import { openPostgres } from "./postgres.ts";
const db = openPostgres({ connectionString: workerData.connectionString });
try {
  const covered = await buildProjectCheckpoint(db.db, workerData.projectId);
  if (covered === null || covered < workerData.cursor)
    throw Error("Checkpoint does not cover requested offset");
  parentPort!.postMessage(covered);
} finally {
  await db.close();
}
