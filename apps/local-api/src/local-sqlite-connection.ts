import { chmod, mkdir, stat } from "node:fs/promises";

interface ClosableDatabase {
  close(): void;
}

/**
 * A store's long-lived connection to `local.sqlite`.
 *
 * Stores used to open the database, re-run their schema DDL, run one query and
 * close it again for every call. Closing the last WAL connection checkpoints
 * and fsyncs, so one Dashboard project listing paid that cost thousands of
 * times. The connection is now opened and prepared once per store and reused; `DatabaseSync` work is synchronous, so a
 * task never interleaves with another task on the same connection.
 *
 * The file identity is checked before every task: if the database was removed
 * or replaced, the next task reopens it and runs `prepare` again, exactly as the
 * per-call open did.
 */
export function createLocalSqliteConnection<Database extends ClosableDatabase>(options: {
  dataDir: string;
  path: string;
  open: (path: string) => Database;
  prepare?: (database: Database) => void;
}) {
  let current:
    | Promise<{ database: Database; dev: number; ino: number }>
    | undefined;

  async function connect() {
    await mkdir(options.dataDir, { recursive: true });
    const database = options.open(options.path);
    try {
      options.prepare?.(database);
      await chmod(options.path, 0o600).catch(() => undefined);
      const info = await stat(options.path);
      return { database, dev: info.dev, ino: info.ino };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async function connection(): Promise<Database> {
    const pending = current;
    if (pending) {
      const opened = await pending.catch(() => undefined);
      if (opened) {
        const info = await stat(options.path).catch(() => undefined);
        if (info && info.dev === opened.dev && info.ino === opened.ino)
          return opened.database;
      }
      // Another caller already replaced a stale or failed connection.
      if (current !== pending) return connection();
      current = undefined;
      opened?.database.close();
    }
    const next = connect();
    current = next;
    try {
      return (await next).database;
    } catch (error) {
      if (current === next) current = undefined;
      throw error;
    }
  }

  return {
    async use<T>(task: (database: Database) => T): Promise<T> {
      return task(await connection());
    },
    async close(): Promise<void> {
      const opened = await current?.catch(() => undefined);
      current = undefined;
      opened?.database.close();
    },
  };
}
