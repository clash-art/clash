import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  SQLITE_BUSY,
  SQLITE_CONSTRAINT,
  SQLITE_DATABASE_REMOVED,
  SQLITE_ERROR,
  SQLITE_LOCKED,
  SQLITE_PROTOCOL_ERROR,
  SQLITE_REQUEST_TIMEOUT,
  SQLITE_SESSION_TIMEOUT,
  SQLITE_TRANSACTION_LEFT_OPEN,
  SQLITE_WORKER_CLOSED,
  SQLITE_WORKER_OPEN_FAILED,
  type LocalSqliteBatchRequest,
  type LocalSqliteErrorPayload,
  type LocalSqliteQueryRequest,
  type LocalSqliteRequest,
  type LocalSqliteRequestResponse,
  type LocalSqliteResponse,
  type LocalSqliteWorkerOptions,
} from "./local-sqlite-protocol.js";
import { LOCAL_SQLITE_SCHEMA_STAGES } from "./local-sqlite-schema.js";

/**
 * The Host's only owner of `local.sqlite` connections.
 *
 * Requests arrive in FIFO order and each runs synchronously to completion. A
 * session (an exclusive lease) lets one caller run several statements --
 * including `BEGIN … COMMIT` -- with nothing else interleaved: while a lease is
 * held, other requests wait in `queue`. The main thread therefore never blocks
 * on SQLite, including `busy_timeout` waits.
 */

const port = parentPort;
if (!port) throw new Error("local-sqlite-worker must run in a worker thread.");

const options = workerData as LocalSqliteWorkerOptions;

/** Data dirs this process opened before this worker started. */
const knownDataDirs = new Set(options.knownDataDirs ?? []);

const STATEMENT_CACHE_LIMIT = 256;

interface Connection {
  db: DatabaseSync;
  path: string;
  dev: number;
  ino: number;
  statements: Map<string, StatementSync>;
}

class WorkerFailure extends Error {
  readonly payload: LocalSqliteErrorPayload;

  constructor(payload: LocalSqliteErrorPayload) {
    super(payload.message);
    this.payload = payload;
  }
}

type QueuedRequest = LocalSqliteRequest & { deadlineAt: number };

const connections = new Map<string, Connection>();
const queue: QueuedRequest[] = [];
const expiredSessions = new Set<number>();
let lease:
  | { session: number; dataDirs: Set<string>; timer: ReturnType<typeof setTimeout> }
  | undefined;
let closing = false;

function sqliteFailure(error: unknown, stage?: string): LocalSqliteErrorPayload {
  if (error instanceof WorkerFailure) return error.payload;
  const candidate = error as {
    code?: unknown;
    errcode?: unknown;
    errstr?: unknown;
    message?: unknown;
  };
  const message =
    error instanceof Error ? error.message : String(error ?? "SQLite failure");
  if (candidate?.code === "ERR_SQLITE_ERROR" && typeof candidate.errcode === "number") {
    const primary = candidate.errcode & 0xff;
    return {
      code:
        stage !== undefined
          ? SQLITE_WORKER_OPEN_FAILED
          : primary === 5
            ? SQLITE_BUSY
            : primary === 6
              ? SQLITE_LOCKED
              : primary === 19
                ? SQLITE_CONSTRAINT
                : SQLITE_ERROR,
      message,
      ...(stage !== undefined ? { stage } : {}),
      sqlite: {
        errcode: candidate.errcode,
        errstr: typeof candidate.errstr === "string" ? candidate.errstr : "",
      },
    };
  }
  return {
    code: stage !== undefined ? SQLITE_WORKER_OPEN_FAILED : SQLITE_ERROR,
    message,
    ...(stage !== undefined ? { stage } : {}),
  };
}

function openConnection(dataDir: string): Connection {
  const path = join(dataDir, "local.sqlite");
  let stage = "open";
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path);
    stage = "pragma";
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))};
      PRAGMA foreign_keys = ON;
    `);
    for (const [name, apply] of LOCAL_SQLITE_SCHEMA_STAGES) {
      stage = `schema:${name}`;
      apply(db);
    }
    stage = "open";
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort, as before: Windows and foreign owners cannot chmod.
    }
    const info = statSync(path);
    return { db, path, dev: info.dev, ino: info.ino, statements: new Map() };
  } catch (error) {
    if (db?.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The connection is discarded below.
      }
    }
    db?.close();
    throw new WorkerFailure(sqliteFailure(error, stage));
  }
}

/**
 * The open connection for `dataDir`. Outside a lease, the file identity is
 * checked first. A database file replaced in a directory that still exists is
 * reopened and migrated, exactly as each store's per-call open used to do. A
 * removed directory is not: recreating it would resurrect a data dir whose
 * owner is shutting down (or a test's temp HOME being removed) and leave files
 * behind the remover already walked. That request fails with a coded error.
 */
function connectionFor(dataDir: string, checkIdentity: boolean): Connection {
  const current = connections.get(dataDir);
  if (current && !checkIdentity) return current;
  if (current) {
    let same = false;
    let removedDirectory = false;
    try {
      const info = statSync(current.path);
      same = info.dev === current.dev && info.ino === current.ino;
    } catch {
      removedDirectory = !existsSync(dataDir);
    }
    if (same) return current;
    if (removedDirectory) {
      throw new WorkerFailure({
        code: SQLITE_DATABASE_REMOVED,
        message: `The SQLite data directory ${dataDir} was removed while its database was open; the Host did not recreate it.`,
      });
    }
    connections.delete(dataDir);
    current.statements.clear();
    try {
      current.db.close();
    } catch {
      // The replaced file's handle is released either way.
    }
  }
  if (knownDataDirs.has(dataDir) && !existsSync(dataDir)) {
    throw new WorkerFailure({
      code: SQLITE_DATABASE_REMOVED,
      message: `The SQLite data directory ${dataDir} was removed after this process opened it; the Host did not recreate it.`,
    });
  }
  const opened = openConnection(dataDir);
  connections.set(dataDir, opened);
  return opened;
}

function statement(connection: Connection, sql: string): StatementSync {
  const cached = connection.statements.get(sql);
  if (cached) {
    // Refresh recency for the bounded cache.
    connection.statements.delete(sql);
    connection.statements.set(sql, cached);
    return cached;
  }
  const prepared = connection.db.prepare(sql);
  connection.statements.set(sql, prepared);
  if (connection.statements.size > STATEMENT_CACHE_LIMIT) {
    const oldest = connection.statements.keys().next().value;
    if (oldest !== undefined) connection.statements.delete(oldest);
  }
  return prepared;
}

function runQuery(connection: Connection, request: LocalSqliteQueryRequest): unknown {
  switch (request.mode) {
    case "exec":
      connection.db.exec(request.sql);
      return undefined;
    case "run": {
      const result = statement(connection, request.sql).run(...request.params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    }
    case "get":
      return statement(connection, request.sql).get(...request.params);
    case "all":
      return statement(connection, request.sql).all(...request.params);
    default:
      throw new WorkerFailure({
        code: SQLITE_PROTOCOL_ERROR,
        message: `Unknown SQLite request mode ${String(request.mode)}.`,
      });
  }
}

function anyInTransaction(dataDirs: Iterable<string>): boolean {
  for (const dataDir of dataDirs) {
    if (connections.get(dataDir)?.db.isTransaction) return true;
  }
  return false;
}

/** Rolls back whatever a lease or standalone request left open. */
function rollbackOpen(dataDirs: Iterable<string>): boolean {
  let rolledBack = false;
  for (const dataDir of dataDirs) {
    const connection = connections.get(dataDir);
    if (!connection?.db.isTransaction) continue;
    rolledBack = true;
    try {
      connection.db.exec("ROLLBACK");
    } catch {
      // A failed ROLLBACK leaves SQLite to roll back when the handle closes.
    }
  }
  return rolledBack;
}

// Replies produced while handling one inbound message (or timer) go back as
// one message, mirroring the client's request batching.
const outgoing: LocalSqliteRequestResponse[] = [];

function reply(message: LocalSqliteRequestResponse): void {
  outgoing.push(message);
}

function flushReplies(): void {
  if (outgoing.length === 0) return;
  const responses = outgoing.splice(0);
  port!.postMessage(
    (responses.length === 1
      ? responses[0]!
      : { type: "batch", responses }) satisfies LocalSqliteResponse,
  );
}

function fail(id: number, error: LocalSqliteErrorPayload, inTransaction = false): void {
  reply({ type: "response", id, ok: false, error, inTransaction });
}

function armLeaseTimer(session: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (lease?.session !== session) return;
    const dataDirs = lease.dataDirs;
    lease = undefined;
    rollbackOpen(dataDirs);
    expiredSessions.add(session);
    pump();
    flushReplies();
  }, options.sessionIdleMs);
}

function touchLease(dataDir?: string): void {
  if (!lease) return;
  clearTimeout(lease.timer);
  if (dataDir) lease.dataDirs.add(dataDir);
  lease.timer = armLeaseTimer(lease.session);
}

function execute(request: QueuedRequest): void {
  if (Date.now() > request.deadlineAt) {
    fail(request.id, {
      code: SQLITE_REQUEST_TIMEOUT,
      message: "The SQLite request waited past its deadline and was not run.",
    });
    return;
  }
  switch (request.type) {
    case "query": {
      const leased = request.session !== undefined;
      if (leased && request.acquire) {
        lease = {
          session: request.session!,
          dataDirs: new Set(),
          timer: armLeaseTimer(request.session!),
        };
      }
      let connection: Connection | undefined;
      try {
        connection = connectionFor(request.dataDir, !leased || request.acquire === true);
        if (leased) touchLease(request.dataDir);
        const result = runQuery(connection, request);
        if (!leased && connection.db.isTransaction) {
          connection.db.exec("ROLLBACK");
          fail(request.id, {
            code: SQLITE_TRANSACTION_LEFT_OPEN,
            message:
              "A standalone SQLite statement opened a transaction; it was rolled back. Use a session.",
          });
          return;
        }
        reply({
          type: "response",
          id: request.id,
          ok: true,
          result,
          inTransaction: connection.db.isTransaction,
        });
      } catch (error) {
        if (!leased && connection?.db.isTransaction) rollbackOpen([request.dataDir]);
        fail(request.id, sqliteFailure(error), connection?.db.isTransaction ?? false);
      }
      return;
    }
    case "release": {
      const held = lease;
      lease = undefined;
      if (held) clearTimeout(held.timer);
      if (held && rollbackOpen(held.dataDirs)) {
        fail(request.id, {
          code: SQLITE_TRANSACTION_LEFT_OPEN,
          message:
            "A SQLite session ended with an open transaction; it was rolled back.",
        });
        return;
      }
      reply({ type: "response", id: request.id, ok: true, result: undefined, inTransaction: false });
      return;
    }
    case "open": {
      try {
        connectionFor(request.dataDir, true);
        reply({ type: "response", id: request.id, ok: true, result: undefined, inTransaction: false });
      } catch (error) {
        fail(request.id, sqliteFailure(error));
      }
      return;
    }
    case "close": {
      closing = true;
      const failures: string[] = [];
      for (const [dataDir, connection] of connections) {
        try {
          if (connection.db.isTransaction) connection.db.exec("ROLLBACK");
          connection.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          failures.push(`${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
        }
        connection.statements.clear();
        try {
          connection.db.close();
        } catch (error) {
          failures.push(`${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      connections.clear();
      if (failures.length > 0) {
        fail(request.id, {
          code: SQLITE_ERROR,
          message: `SQLite close failed: ${failures.join("; ")}`,
        });
      } else {
        reply({ type: "response", id: request.id, ok: true, result: undefined, inTransaction: false });
      }
      // Everything queued before `close` has run; nothing after it will.
      pump();
      flushReplies();
      port!.close();
      return;
    }
    default:
      fail((request as { id: number }).id, {
        code: SQLITE_PROTOCOL_ERROR,
        message: `Unknown SQLite request type ${String((request as { type?: unknown }).type)}.`,
      });
  }
}

function sessionOf(request: LocalSqliteRequest): number | undefined {
  return request.type === "query" || request.type === "release"
    ? request.session
    : undefined;
}

/**
 * Runs every request that may run now, oldest first: anything when no lease
 * is held (a session's first statement takes the lease), and only the
 * lease's own requests while one is held.
 */
function pump(): void {
  for (;;) {
    if (closing) {
      while (queue.length > 0) {
        fail(queue.shift()!.id, {
          code: SQLITE_WORKER_CLOSED,
          message: "The SQLite worker is closed.",
        });
      }
      return;
    }
    const now = Date.now();
    for (let index = 0; index < queue.length; index += 1) {
      const waiting = queue[index]!;
      if (now > waiting.deadlineAt && sessionOf(waiting) !== lease?.session) {
        queue.splice(index, 1);
        index -= 1;
        fail(waiting.id, {
          code: SQLITE_REQUEST_TIMEOUT,
          message: "The SQLite request waited past its deadline and was not run.",
        });
      }
    }
    let index = -1;
    if (lease) {
      index = queue.findIndex((request) => sessionOf(request) === lease!.session);
    } else if (queue.length > 0) {
      index = 0;
    }
    if (index < 0) return;
    const [request] = queue.splice(index, 1);
    const session = sessionOf(request!);
    if (
      !lease &&
      session !== undefined &&
      !(request!.type === "query" && request!.acquire)
    ) {
      const expired = expiredSessions.delete(session);
      fail(request!.id, {
        code: expired ? SQLITE_SESSION_TIMEOUT : SQLITE_PROTOCOL_ERROR,
        message: expired
          ? "The SQLite session was idle too long; its open transaction was rolled back."
          : `SQLite session ${session} does not hold the lease.`,
      });
      continue;
    }
    execute(request!);
  }
}

port.on("message", (message: LocalSqliteRequest | LocalSqliteBatchRequest) => {
  const receivedAt = Date.now();
  for (const request of message.type === "batch" ? message.requests : [message]) {
    queue.push({ ...request, deadlineAt: receivedAt + request.deadlineMs });
  }
  pump();
  flushReplies();
});

port.postMessage({ type: "ready" } satisfies LocalSqliteResponse);
