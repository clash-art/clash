/**
 * Message protocol between the Host main thread and the SQLite worker
 * (`local-sqlite-worker.ts`). The worker is the only owner of `local.sqlite`
 * connections in the Host process; the main thread never imports `node:sqlite`.
 *
 * Erasable TypeScript only: the worker loads this file directly in source mode.
 */

export type LocalSqliteParam = string | number | bigint | null | Uint8Array;

export type LocalSqliteRow = Record<string, unknown>;

export interface LocalSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export type LocalSqliteMode = "run" | "get" | "all" | "exec";

export interface LocalSqliteWorkerOptions {
  /** `PRAGMA busy_timeout` for every connection. */
  busyTimeoutMs: number;
  /** A session with no statement for this long is rolled back and expired. */
  sessionIdleMs: number;
  /**
   * Data dirs this process opened successfully before this worker started. A
   * known dir that no longer exists must not be recreated implicitly.
   */
  knownDataDirs?: string[];
}

/**
 * One statement. `session` binds it to an exclusive lease: while a lease is
 * held, no other request runs on the worker. `acquire` marks a session's first
 * statement. `deadlineMs` bounds how long the request may wait in the worker
 * queue, measured from when the worker receives it.
 */
export interface LocalSqliteQueryRequest {
  type: "query";
  id: number;
  dataDir: string;
  sql: string;
  params: LocalSqliteParam[];
  mode: LocalSqliteMode;
  session?: number;
  acquire?: boolean;
  deadlineMs: number;
}

export interface LocalSqliteReleaseRequest {
  type: "release";
  id: number;
  session: number;
  deadlineMs: number;
}

/** Opens and migrates a data dir eagerly (Host startup and `/health`). */
export interface LocalSqliteOpenRequest {
  type: "open";
  id: number;
  dataDir: string;
  deadlineMs: number;
}

/** Drains the queue, checkpoints WAL and closes every connection. */
export interface LocalSqliteCloseRequest {
  type: "close";
  id: number;
  deadlineMs: number;
}

export type LocalSqliteRequest =
  | LocalSqliteQueryRequest
  | LocalSqliteReleaseRequest
  | LocalSqliteOpenRequest
  | LocalSqliteCloseRequest;

/**
 * Requests the main thread issued while earlier ones were in flight, posted as
 * one message. The worker queues them in order, exactly as if each had been
 * posted alone, and answers with one `batch` response. Batching changes only
 * the transport: each request keeps its own id, lease and outcome.
 */
export interface LocalSqliteBatchRequest {
  type: "batch";
  requests: LocalSqliteRequest[];
}

export interface LocalSqliteErrorPayload {
  code: string;
  message: string;
  stage?: string;
  sqlite?: { errcode: number; errstr: string };
}

export type LocalSqliteRequestResponse =
  | { type: "response"; id: number; ok: true; result: unknown; inTransaction: boolean }
  | {
      type: "response";
      id: number;
      ok: false;
      error: LocalSqliteErrorPayload;
      inTransaction: boolean;
    };

export type LocalSqliteResponse =
  | { type: "ready" }
  | LocalSqliteRequestResponse
  | { type: "batch"; responses: LocalSqliteRequestResponse[] };

export const SQLITE_WORKER_OPEN_FAILED = "SQLITE_WORKER_OPEN_FAILED";
export const SQLITE_WORKER_EXITED = "SQLITE_WORKER_EXITED";
export const SQLITE_WORKER_CLOSED = "SQLITE_WORKER_CLOSED";
export const SQLITE_WRITE_OUTCOME_UNKNOWN = "SQLITE_WRITE_OUTCOME_UNKNOWN";
export const SQLITE_REQUEST_TIMEOUT = "SQLITE_REQUEST_TIMEOUT";
export const SQLITE_SESSION_TIMEOUT = "SQLITE_SESSION_TIMEOUT";
export const SQLITE_TRANSACTION_LEFT_OPEN = "SQLITE_TRANSACTION_LEFT_OPEN";
export const SQLITE_NESTED_SESSION = "SQLITE_NESTED_SESSION";
export const SQLITE_PROTOCOL_ERROR = "SQLITE_PROTOCOL_ERROR";
export const SQLITE_DATABASE_REMOVED = "SQLITE_DATABASE_REMOVED";
export const SQLITE_CLOSE_TIMEOUT = "SQLITE_CLOSE_TIMEOUT";
export const SQLITE_BUSY = "SQLITE_BUSY";
export const SQLITE_LOCKED = "SQLITE_LOCKED";
export const SQLITE_CONSTRAINT = "SQLITE_CONSTRAINT";
export const SQLITE_ERROR = "SQLITE_ERROR";
