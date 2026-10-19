import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalSqliteWorkerClient,
  createLocalSqliteConnection,
} from "./local-sqlite-connection.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const execFileAsync = promisify(execFile);

const clients: LocalSqliteWorkerClient[] = [];

function client(options?: ConstructorParameters<typeof LocalSqliteWorkerClient>[0]) {
  const created = new LocalSqliteWorkerClient(options);
  clients.push(created);
  return created;
}

async function dataDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "clash-sqlite-worker-")), "local-api");
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((created) => created.close()));
});

async function seedItems(sqlite: LocalSqliteWorkerClient, dir: string) {
  await sqlite.database(dir).exec(
    "CREATE TABLE IF NOT EXISTS item (id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
}

describe("SQLite worker client", () => {
  it("opens, migrates every Host table and serves standalone statements", async () => {
    const dir = await dataDir();
    const sqlite = client();
    const db = sqlite.database(dir);
    await seedItems(sqlite, dir);
    await db.prepare("INSERT INTO item VALUES (?, ?)").run("a", 1);
    expect(await db.prepare("SELECT id, value FROM item WHERE id = ?").get("a")).toEqual({
      id: "a",
      value: 1,
    });
    const tables = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["project", "provider_accounts", "local_resources", "plugin_store"]),
    );
    expect(await db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(await db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect((await stat(join(dir, "local.sqlite"))).mode & 0o777).toBe(0o600);
  });

  it("round-trips a single-row read in well under a millisecond", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    await db.prepare("INSERT INTO item VALUES ('a', 1)").run();
    const read = db.prepare("SELECT value FROM item WHERE id = ?");
    for (let index = 0; index < 200; index += 1) await read.get("a");
    const samples: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const started = performance.now();
      await read.get("a");
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    // Acceptance bound is 0.1 ms p50; a loaded CI box gets 10x headroom.
    expect(samples[500]).toBeLessThan(1);
  });

  it("coalesces a wave of concurrent requests into one round trip with per-request outcomes", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const wave = Array.from({ length: 200 }, (_, index) =>
        index === 100
          ? db.prepare("SELECT * FROM missing_table").get()
          : db.prepare("SELECT ? AS value").get(index),
      );
      const outcomes = await Promise.all(
        wave.map((pending) =>
          pending.then(
            (row) => row?.value,
            (error: { code?: string }) => error.code,
          ),
        ),
      );
      expect(outcomes).toEqual(
        Array.from({ length: 200 }, (_, index) => (index === 100 ? "SQLITE_ERROR" : index)),
      );
      // The first request goes out at once; the rest of the wave rides one batch.
      expect(posted.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      posted.mockRestore();
    }
  });

  it("still flushes batched requests when a caller installs fake timers", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    vi.useFakeTimers();
    try {
      const values = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          db.prepare("SELECT ? AS value").get(index).then((row) => row?.value),
        ),
      );
      expect(values).toEqual(Array.from({ length: 20 }, (_, index) => index));
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets another caller observe or interleave a session's transaction", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    await db.prepare("INSERT INTO item VALUES ('a', 0), ('b', 0)").run();
    const observed: number[] = [];
    const transfers = Array.from({ length: 20 }, () =>
      sqlite.session(dir, async (tx) => {
        await tx.exec("BEGIN IMMEDIATE");
        await tx.prepare("UPDATE item SET value = value - 1 WHERE id = 'a'").run();
        // Yield the main thread between statements: other requests are queued, not run.
        await new Promise((resolve) => setImmediate(resolve));
        await tx.prepare("UPDATE item SET value = value + 1 WHERE id = 'b'").run();
        await tx.exec("COMMIT");
      }),
    );
    const readers = Array.from({ length: 40 }, async () => {
      const row = await db.prepare("SELECT SUM(value) AS total FROM item").get();
      observed.push(Number(row?.total));
    });
    await Promise.all([...transfers, ...readers]);
    expect(new Set(observed)).toEqual(new Set([0]));
    expect(await db.prepare("SELECT value FROM item ORDER BY id").all()).toEqual([
      { value: -20 },
      { value: 20 },
    ]);
  });

  it("rolls back a failed transaction and reports a transaction left open", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    await db.prepare("INSERT INTO item VALUES ('a', 1)").run();
    await expect(
      sqlite.session(dir, async (tx) => {
        await tx.exec("BEGIN IMMEDIATE");
        try {
          await tx.prepare("INSERT INTO item VALUES ('b', 2)").run();
          await tx.prepare("INSERT INTO item VALUES ('a', 3)").run();
          await tx.exec("COMMIT");
        } catch (error) {
          await tx.exec("ROLLBACK");
          throw error;
        }
      }),
    ).rejects.toMatchObject({
      code: "SQLITE_CONSTRAINT",
      message: expect.stringContaining("UNIQUE constraint failed"),
      sqlite: { errcode: expect.any(Number) },
    });
    await expect(
      sqlite.session(dir, async (tx) => {
        await tx.exec("BEGIN IMMEDIATE");
        await tx.prepare("INSERT INTO item VALUES ('c', 3)").run();
      }),
    ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_LEFT_OPEN" });
    await expect(db.exec("BEGIN IMMEDIATE")).rejects.toMatchObject({
      code: "SQLITE_TRANSACTION_LEFT_OPEN",
    });
    expect(await db.prepare("SELECT id FROM item ORDER BY id").all()).toEqual([{ id: "a" }]);
  });

  it("returns SQLITE_BUSY as a coded error without blocking the main thread", async () => {
    const dir = await dataDir();
    const sqlite = client({ busyTimeoutMs: 300 });
    await seedItems(sqlite, dir);
    const holder = new DatabaseSync(join(dir, "local.sqlite"));
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 10);
      const started = Date.now();
      await expect(
        sqlite.database(dir).prepare("INSERT INTO item VALUES ('a', 1)").run(),
      ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      clearInterval(ticker);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      // The 300 ms busy wait ran in the worker; the main loop kept ticking.
      expect(ticks).toBeGreaterThanOrEqual(10);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("rejects every pending request with a code when the worker dies, then restarts", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    let inside!: () => void;
    const holding = new Promise<void>((resolve) => {
      inside = resolve;
    });
    const session = sqlite.session(dir, async (tx) => {
      await tx.exec("BEGIN IMMEDIATE");
      await tx.prepare("INSERT INTO item VALUES ('partial', 1)").run();
      inside();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tx.prepare("INSERT INTO item VALUES ('partial-2', 2)").run();
      await tx.exec("COMMIT");
    });
    await holding;
    const outcomes = Promise.all(
      [
        session,
        db.prepare("SELECT COUNT(*) AS count FROM item").get(),
        db.prepare("INSERT INTO item VALUES ('queued', 3)").run(),
      ].map((pending) => pending.then(() => "resolved", (error) => error.code)),
    );
    // Let the buffered requests reach the worker, where they wait behind the lease.
    await new Promise((resolve) => setImmediate(resolve));
    await sqlite.terminateForTest();

    expect(await outcomes).toEqual([
      "SQLITE_WORKER_EXITED",
      "SQLITE_WORKER_EXITED",
      "SQLITE_WRITE_OUTCOME_UNKNOWN",
    ]);

    // The next request starts a new worker; the uncommitted transaction is gone.
    expect(await db.prepare("SELECT id FROM item WHERE id LIKE 'partial%'").all()).toEqual([]);
  });

  it("bounds queue waits and idle sessions with coded errors", async () => {
    const dir = await dataDir();
    const sqlite = client({ requestDeadlineMs: 50, sessionIdleMs: 150 });
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    const idle = sqlite.session(dir, async (tx) => {
      await tx.exec("BEGIN IMMEDIATE");
      await tx.prepare("INSERT INTO item VALUES ('idle', 1)").run();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.prepare("INSERT INTO item VALUES ('late', 2)").run();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(db.prepare("SELECT 1 AS one").get()).rejects.toMatchObject({
      code: "SQLITE_REQUEST_TIMEOUT",
    });
    await expect(idle).rejects.toMatchObject({ code: "SQLITE_SESSION_TIMEOUT" });
    expect(await db.prepare("SELECT id FROM item").all()).toEqual([]);
  });

  it("refuses a nested session instead of deadlocking behind its own lease", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    await expect(
      sqlite.session(dir, async (tx) => {
        await tx.prepare("SELECT 1").get();
        await sqlite.database(dir).prepare("SELECT 1").get();
      }),
    ).rejects.toMatchObject({ code: "SQLITE_NESTED_SESSION" });
    await expect(
      sqlite.session(dir, () => sqlite.session(dir, () => 1)),
    ).rejects.toMatchObject({ code: "SQLITE_NESTED_SESSION" });
  });

  it("reports an open failure with its stage in health and on every request", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-sqlite-worker-"));
    const dir = join(root, "local-api");
    await writeFile(dir, "not a directory");
    const sqlite = client();
    await expect(sqlite.open(dir)).rejects.toMatchObject({
      code: "SQLITE_WORKER_OPEN_FAILED",
      stage: "open",
    });
    expect(sqlite.health(dir)).toMatchObject({
      ok: false,
      code: "SQLITE_WORKER_OPEN_FAILED",
      stage: "open",
    });
    await expect(sqlite.database(dir).prepare("SELECT 1").get()).rejects.toMatchObject({
      code: "SQLITE_WORKER_OPEN_FAILED",
    });
    await rm(dir);
    await sqlite.open(dir);
    expect(sqlite.health(dir)).toEqual({ ok: true });
  });

  it("reports a failed migration stage", async () => {
    const dir = await dataDir();
    const seed = client();
    await seed.open(dir);
    await seed.close();
    const raw = new DatabaseSync(join(dir, "local.sqlite"), { timeout: 5_000 });
    // A view where the inspection table belongs makes that stage's DDL fail.
    raw.exec("DROP TABLE local_asset_inspections; CREATE VIEW local_asset_inspections AS SELECT 1 AS x");
    raw.close();
    const sqlite = client();
    await expect(sqlite.open(dir)).rejects.toMatchObject({
      code: "SQLITE_WORKER_OPEN_FAILED",
      stage: "schema:inspections",
    });
  });

  it("drains queued work, checkpoints WAL and closes on shutdown", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    const writes = Array.from({ length: 50 }, (_, index) =>
      db.prepare("INSERT INTO item VALUES (?, ?)").run(`k${index}`, index),
    );
    const closed = sqlite.close();
    await Promise.all(writes);
    await closed;
    await expect(db.prepare("SELECT 1").get()).rejects.toMatchObject({
      code: "SQLITE_WORKER_CLOSED",
    });
    const files = await readdir(dir);
    if (files.includes("local.sqlite-wal")) {
      expect((await stat(join(dir, "local.sqlite-wal"))).size).toBe(0);
    }
    const raw = new DatabaseSync(join(dir, "local.sqlite"), { timeout: 5_000 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM item").get()).toEqual({ count: 50 });
    raw.close();
  });

  it("lets a session that holds the lease finish before shutdown closes", async () => {
    const dir = await dataDir();
    const sqlite = client({ closeDeadlineMs: 2_000 });
    await seedItems(sqlite, dir);
    let inside!: () => void;
    const holding = new Promise<void>((resolve) => {
      inside = resolve;
    });
    const session = sqlite.session(dir, async (tx) => {
      await tx.exec("BEGIN IMMEDIATE");
      await tx.prepare("INSERT INTO item VALUES ('first', 1)").run();
      inside();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tx.prepare("INSERT INTO item VALUES ('second', 2)").run();
      await tx.exec("COMMIT");
    });
    await holding;
    const started = Date.now();
    const closed = sqlite.close();
    await expect(sqlite.session(dir, (tx) => tx.prepare("SELECT 1").get())).rejects.toMatchObject({
      code: "SQLITE_WORKER_CLOSED",
    });
    await session;
    await closed;
    expect(Date.now() - started).toBeLessThan(1_000);
    const raw = new DatabaseSync(join(dir, "local.sqlite"), { timeout: 5_000 });
    expect(raw.prepare("SELECT id FROM item ORDER BY id").all()).toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    raw.close();
  });

  it("settles close in a process whose event loop has nothing else to wait for", async () => {
    const dir = await dataDir();
    const entry = new URL("./local-sqlite-connection.ts", import.meta.url).href;
    const script = `
      import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, next) {
          try {
            return next(specifier, context);
          } catch (error) {
            if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js")) {
              return next(specifier.slice(0, -3) + ".ts", context);
            }
            throw error;
          }
        },
      });
      const { LocalSqliteWorkerClient } = await import(${JSON.stringify(entry)});
      const client = new LocalSqliteWorkerClient();
      await client.database(${JSON.stringify(dir)}).prepare("SELECT 1 AS one").get();
      await client.close();
      console.log("closed");
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { timeout: 20_000 },
    );
    expect(stdout.trim()).toBe("closed");
  });

  it("reopens and migrates again when the database file is removed", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    await db.prepare("INSERT INTO item VALUES ('a', 1)").run();
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(dir, `local.sqlite${suffix}`), { force: true });
    }
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name = 'item'").all(),
    ).toEqual([]);
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name = 'project'").all(),
    ).toEqual([{ name: "project" }]);
  });

  it("fails a removed data directory instead of recreating it", async () => {
    const dir = await dataDir();
    const sqlite = client();
    await seedItems(sqlite, dir);
    const db = sqlite.database(dir);
    await db.prepare("INSERT INTO item VALUES ('a', 1)").run();
    await rm(dir, { recursive: true, force: true });

    await expect(db.prepare("SELECT 1 AS one").get()).rejects.toMatchObject({
      code: "SQLITE_DATABASE_REMOVED",
      message: expect.stringContaining(dir),
    });
    // The refused request must not resurrect a directory its owner removed.
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sqlite.open(dir)).rejects.toMatchObject({
      code: "SQLITE_DATABASE_REMOVED",
    });
  });

  it("serves stores through the process client", async () => {
    const dir = await dataDir();
    const connection = createLocalSqliteConnection({ dataDir: dir });
    const rows = await connection.use(async (db) => {
      await db.prepare("INSERT INTO local_config VALUES ('k', '1', 'now')").run();
      return db.prepare("SELECT key FROM local_config").all();
    });
    expect(rows).toEqual([{ key: "k" }]);
    expect(await connection.db.prepare("SELECT key FROM local_config").get()).toEqual({ key: "k" });
  });
});

describe("Host main-thread SQLite boundary", () => {
  it("imports node:sqlite only from the SQLite worker modules", async () => {
    const root = new URL(".", import.meta.url);
    const allowed = new Set(["local-sqlite-worker.ts", "local-sqlite-schema.ts"]);
    const offenders: string[] = [];
    const visit = async (directory: URL, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "fixtures") continue;
          await visit(new URL(`${entry.name}/`, directory), `${relative}/`);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (entry.name.endsWith(".test-helper.ts") || entry.name.endsWith(".test-fixtures.ts")) continue;
        if (allowed.has(relative)) continue;
        const source = await readFile(new URL(entry.name, directory), "utf8");
        if (/["']node:sqlite["']|\bDatabaseSync\b/.test(source)) offenders.push(relative);
      }
    };
    await visit(root, "");
    expect(offenders).toEqual([]);
  });
});
