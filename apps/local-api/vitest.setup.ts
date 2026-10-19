import { afterEach } from "vitest";

import { closeLocalSqliteClient } from "./src/local-sqlite-connection.js";

/**
 * Suite cleanups remove their temporary data directories. The Host's SQLite
 * worker queues statements independently of the promises a test awaited, and a
 * request that reaches a directory removed moments earlier would either race
 * the remover (ENOTEMPTY) or recreate `local.sqlite` in it. Draining and
 * closing the process-wide worker before those cleanups keeps the test's
 * filesystem lifetime and the worker's connection lifetime from overlapping.
 *
 * `sequence.hooks: "list"` in `vitest.config.ts` makes this hook, which the
 * setup file registers first, run before each suite's own `afterEach`.
 */
afterEach(async () => {
  await closeLocalSqliteClient();
});
