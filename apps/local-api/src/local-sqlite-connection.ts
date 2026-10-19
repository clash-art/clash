import { AsyncLocalStorage } from "node:async_hooks";
// Module timers, not the globals: the transport's flush and close deadline must
// keep running when a caller (or a test) replaces the global timer functions.
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { Worker } from "node:worker_threads";
import { createStructuredLogger } from "@clash/shared-runtime/logging";
import {
  SQLITE_CLOSE_TIMEOUT,
  SQLITE_NESTED_SESSION,
  SQLITE_PROTOCOL_ERROR,
  SQLITE_WORKER_CLOSED,
  SQLITE_WORKER_EXITED,
  SQLITE_WORKER_OPEN_FAILED,
  SQLITE_WRITE_OUTCOME_UNKNOWN,
  type LocalSqliteBatchRequest,
  type LocalSqliteErrorPayload,
  type LocalSqliteMode,
  type LocalSqliteParam,
  type LocalSqliteRequest,
  type LocalSqliteRequestResponse,
  type LocalSqliteResponse,
  type LocalSqliteRow,
  type LocalSqliteRunResult,
  type LocalSqliteWorkerOptions,
} from "./local-sqlite-protocol.js";

export type {
  LocalSqliteParam,
  LocalSqliteRow,
  LocalSqliteRunResult,
} from "./local-sqlite-protocol.js";

const sqliteLog = createStructuredLogger({
  component: "local-api",
  module: "sqlite",
});

/**
 * Data dirs this process successfully opened. It outlives a worker (and the
 * shared client) so a request from work still winding down after shutdown
 * cannot recreate a data dir that was removed in the meantime. Workers check
 * `existsSync` before opening one.
 */
const knownDataDirs = new Set<string>();

/**
 * A coded SQLite failure. Worker-level codes (`SQLITE_WORKER_*`,
 * `SQLITE_WRITE_OUTCOME_UNKNOWN`, `SQLITE_REQUEST_TIMEOUT`, …) describe the
 * transport; `SQLITE_BUSY`/`SQLITE_CONSTRAINT`/`SQLITE_ERROR` carry SQLite's
 * own message and `sqlite.errcode`.
 */
export class LocalSqliteError extends Error {
  readonly code: string;
  readonly stage?: string;
  readonly sqlite?: { errcode: number; errstr: string };

  constructor(payload: LocalSqliteErrorPayload) {
    super(payload.message);
    this.name = "LocalSqliteError";
    this.code = payload.code;
    if (payload.stage !== undefined) this.stage = payload.stage;
    if (payload.sqlite) this.sqlite = payload.sqlite;
  }
}

export interface LocalSqliteStatement {
  run(...params: LocalSqliteParam[]): Promise<LocalSqliteRunResult>;
  get(...params: LocalSqliteParam[]): Promise<LocalSqliteRow | undefined>;
  all(...params: LocalSqliteParam[]): Promise<LocalSqliteRow[]>;
}

/** The async view of `local.sqlite` every Host store uses. */
export interface LocalSqliteDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): LocalSqliteStatement;
}

export interface LocalSqliteClientOptions {
  busyTimeoutMs?: number;
  sessionIdleMs?: number;
  /** Bounds how long a request may wait in the worker queue. */
  requestDeadlineMs?: number;
  closeDeadlineMs?: number;
}

export type LocalSqliteHealth =
  | { ok: true }
  | { ok: false; code: string; message: string; stage?: string };

interface SessionState {
  id: number;
  dataDir: string;
  generation?: number;
  started: boolean;
  done: boolean;
  inTransaction: boolean;
  broken?: LocalSqliteError;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  persisting: boolean;
  dataDir?: string;
  session?: SessionState;
}

const DEFAULT_OPTIONS = {
  busyTimeoutMs: 5_000,
  sessionIdleMs: 10_000,
  requestDeadlineMs: 30_000,
  closeDeadlineMs: 5_000,
} satisfies Required<LocalSqliteClientOptions>;

const READ_ONLY_SQL = /^\s*(?:SELECT|WITH)\b/i;
const WRITE_KEYWORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|ROLLBACK)\b[^;]*;?\s*$/i;
const COMMIT_SQL = /\b(?:COMMIT|END)\b/i;

/**
 * Whether a statement's effect could already be durable if the worker died
 * before replying. Statements inside an open transaction are not: SQLite rolls
 * back an uncommitted transaction when its connection dies.
 */
function persists(sql: string, mode: LocalSqliteMode, session?: SessionState): boolean {
  if (session?.inTransaction && !COMMIT_SQL.test(sql)) return false;
  if (TRANSACTION_CONTROL.test(sql)) return false;
  if ((mode === "get" || mode === "all") && READ_ONLY_SQL.test(sql) && !WRITE_KEYWORD.test(sql)) {
    return false;
  }
  return true;
}

function workerEntry(): { filename: string | URL; eval: boolean } {
  const here = import.meta.url;
  if (here.endsWith(".ts")) {
    // Source mode (tsx dev, vitest): Node strips the worker's erasable types;
    // this hook maps the repo's `.js` import specifiers to their `.ts` files.
    const entry = new URL("./local-sqlite-worker.ts", here).href;
    return {
      eval: true,
      filename: `
const { registerHooks } = process.getBuiltinModule("node:module");
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error && error.code === "ERR_MODULE_NOT_FOUND" && /^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) {
        return next(specifier.slice(0, -3) + ".ts", context);
      }
      throw error;
    }
  },
});
import(${JSON.stringify(entry)}).catch((error) => { setImmediate(() => { throw error; }); });
`,
    };
  }
  // The packaged Host bundle (`local-api.cjs`) ships the worker beside it.
  if (here.endsWith(".cjs")) {
    return { eval: false, filename: new URL("./host-workers/sqlite-worker.cjs", here) };
  }
  return { eval: false, filename: new URL("./local-sqlite-worker.js", here) };
}

/**
 * Main-thread client of the SQLite worker. Every Host read and write of
 * `local.sqlite` is a message; the main thread never runs SQLite.
 *
 * Failure model: a worker that exits rejects every pending request with
 * `SQLITE_WORKER_EXITED`, or `SQLITE_WRITE_OUTCOME_UNKNOWN` for a write whose
 * commit may have landed, and the next request starts a new worker. A worker
 * that cannot start, open or migrate yields `SQLITE_WORKER_OPEN_FAILED`.
 */
export class LocalSqliteWorkerClient {
  readonly #options: Required<LocalSqliteClientOptions>;
  #worker: Worker | undefined;
  #generation = 0;
  #ready = false;
  #spawnError: unknown;
  #closing: Promise<void> | undefined;
  #nextId = 1;
  #nextSession = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #outbox: LocalSqliteRequest[] = [];
  #flushScheduled = false;
  readonly #sessions = new Set<SessionState>();
  readonly #context = new AsyncLocalStorage<SessionState>();
  readonly #openFailures = new Map<string, LocalSqliteErrorPayload>();

  constructor(options: LocalSqliteClientOptions = {}) {
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Standalone statements: each one is atomic; no lease is held. */
  database(dataDir: string): LocalSqliteDatabase {
    const send = (sql: string, params: LocalSqliteParam[], mode: LocalSqliteMode) => {
      const outer = this.#context.getStore();
      if (outer && !outer.done) {
        return Promise.reject(
          new LocalSqliteError({
            code: SQLITE_NESTED_SESSION,
            message:
              "A standalone SQLite statement was issued inside a session; it would wait behind its own lease.",
          }),
        );
      }
      return this.#post(
        { type: "query", dataDir, sql, params, mode },
        { persisting: persists(sql, mode), dataDir },
      );
    };
    return databaseOf(send);
  }

  /**
   * Runs `task` with an exclusive lease: no other request runs on the worker
   * between its statements, so `BEGIN … COMMIT` inside it is atomic and
   * never interleaves with another caller. A transaction still open when the
   * task returns is rolled back and reported as `SQLITE_TRANSACTION_LEFT_OPEN`.
   */
  async session<T>(
    dataDir: string,
    task: (db: LocalSqliteDatabase) => Promise<T> | T,
  ): Promise<T> {
    const outer = this.#context.getStore();
    if (outer && !outer.done) {
      throw new LocalSqliteError({
        code: SQLITE_NESTED_SESSION,
        message: "A SQLite session was opened inside another session; it would wait behind its own lease.",
      });
    }
    const state: SessionState = {
      id: this.#nextSession++,
      dataDir,
      started: false,
      done: false,
      inTransaction: false,
    };
    this.#sessions.add(state);
    this.#updateRef();
    try {
      let result: T;
      try {
        result = await this.#context.run(state, () => task(this.#sessionDatabase(state)));
      } catch (error) {
        state.done = true;
        await this.#release(state).catch(() => undefined);
        throw error;
      }
      state.done = true;
      await this.#release(state);
      return result;
    } finally {
      this.#sessions.delete(state);
      this.#updateRef();
    }
  }

  /** Opens and migrates `dataDir` now; used by Host startup for `/health`. */
  async open(dataDir: string): Promise<void> {
    await this.#post({ type: "open", dataDir }, { persisting: false, dataDir });
  }

  health(dataDir: string): LocalSqliteHealth {
    const failure = this.#openFailures.get(dataDir);
    return failure
      ? {
          ok: false,
          code: failure.code,
          message: failure.message,
          ...(failure.stage !== undefined ? { stage: failure.stage } : {}),
        }
      : { ok: true };
  }

  /**
   * Drains the queue, checkpoints WAL and closes every connection within the
   * deadline; on timeout logs `SQLITE_CLOSE_TIMEOUT` and terminates the worker.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const id = this.#nextId++;
    const closed = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, persisting: false });
    });
    worker.ref();
    // Requests issued before shutdown run before `close` (FIFO).
    this.#flush();
    worker.postMessage({
      type: "close",
      id,
      deadlineMs: this.#options.closeDeadlineMs,
    } satisfies LocalSqliteRequest);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      closed.then(
        () => "closed" as const,
        (error: unknown) => {
          sqliteLog.warn("sqlite.close_failed", { error });
          return "closed" as const;
        },
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.#options.closeDeadlineMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      sqliteLog.error("sqlite.close_timeout", {
        code: SQLITE_CLOSE_TIMEOUT,
        deadlineMs: this.#options.closeDeadlineMs,
      });
      await worker.terminate();
    }
    await exited;
  }

  #sessionDatabase(state: SessionState): LocalSqliteDatabase {
    const send = (sql: string, params: LocalSqliteParam[], mode: LocalSqliteMode) => {
      if (state.done) {
        return Promise.reject(
          new LocalSqliteError({
            code: SQLITE_PROTOCOL_ERROR,
            message: "A SQLite statement was issued after its session ended.",
          }),
        );
      }
      if (!state.broken && state.generation !== undefined && state.generation !== this.#generation) {
        state.broken = exitedError("The SQLite worker restarted during this session.");
      }
      if (state.broken) {
        // The dead connection holds no transaction; SQLite rolled it back.
        if (mode === "exec" && /^\s*ROLLBACK\b/i.test(sql)) return Promise.resolve(undefined);
        return Promise.reject(state.broken);
      }
      const acquire = !state.started;
      state.started = true;
      return this.#post(
        {
          type: "query",
          dataDir: state.dataDir,
          sql,
          params,
          mode,
          session: state.id,
          ...(acquire ? { acquire: true } : {}),
        },
        { persisting: persists(sql, mode, state), dataDir: state.dataDir, session: state },
      );
    };
    return databaseOf(send);
  }

  async #release(state: SessionState): Promise<void> {
    if (!state.started || state.broken) return;
    if (state.generation !== this.#generation) return;
    await this.#post(
      { type: "release", session: state.id },
      { persisting: false, session: state },
    );
  }

  #post(
    message:
      | Omit<Extract<LocalSqliteRequest, { type: "query" }>, "id" | "deadlineMs">
      | Omit<Extract<LocalSqliteRequest, { type: "release" }>, "id" | "deadlineMs">
      | Omit<Extract<LocalSqliteRequest, { type: "open" }>, "id" | "deadlineMs">,
    meta: { persisting: boolean; dataDir?: string; session?: SessionState },
  ): Promise<any> {
    // A session that already holds the lease is part of the drain: `close`
    // waits behind it in the worker, so let it finish and release.
    const draining =
      meta.session !== undefined && !(message.type === "query" && message.acquire);
    if (this.#closing && !draining) {
      return Promise.reject(
        new LocalSqliteError({
          code: SQLITE_WORKER_CLOSED,
          message: "The SQLite worker is shut down.",
        }),
      );
    }
    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (error) {
      return Promise.reject(this.#openFailure(error, meta.dataDir));
    }
    if (meta.session) meta.session.generation ??= this.#generation;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const idle = this.#pending.size === 0;
      this.#pending.set(id, { resolve, reject, ...meta });
      this.#updateRef();
      this.#send(worker, idle, {
        ...message,
        id,
        deadlineMs: this.#options.requestDeadlineMs,
      } as LocalSqliteRequest);
    });
  }

  /**
   * A request to an idle worker is posted at once. Requests issued while
   * others are in flight (a list resolving hundreds of rows) are buffered and
   * posted as one `batch` per macrotask, so a wave of reads costs one round
   * trip. Order is preserved: nothing bypasses a non-empty outbox.
   */
  #send(worker: Worker, idle: boolean, request: LocalSqliteRequest): void {
    if (idle && this.#outbox.length === 0) {
      worker.postMessage(request);
      return;
    }
    this.#outbox.push(request);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    const worker = this.#worker;
    if (!worker || this.#outbox.length === 0) return;
    const requests = this.#outbox.splice(0);
    worker.postMessage(
      requests.length === 1
        ? requests[0]!
        : ({ type: "batch", requests } satisfies LocalSqliteBatchRequest),
    );
  }

  #openFailure(error: unknown, dataDir?: string): LocalSqliteError {
    const payload: LocalSqliteErrorPayload = {
      code: SQLITE_WORKER_OPEN_FAILED,
      stage: "spawn",
      message: `The SQLite worker could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    if (dataDir) this.#openFailures.set(dataDir, payload);
    return new LocalSqliteError(payload);
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const entry = workerEntry();
    const workerData: LocalSqliteWorkerOptions = {
      busyTimeoutMs: this.#options.busyTimeoutMs,
      sessionIdleMs: this.#options.sessionIdleMs,
      knownDataDirs: [...knownDataDirs],
    };
    const worker = new Worker(entry.filename, { eval: entry.eval, workerData });
    this.#generation += 1;
    const generation = this.#generation;
    if (generation > 1) {
      sqliteLog.warn("sqlite.worker_restarted", { generation });
    }
    this.#worker = worker;
    this.#ready = false;
    this.#spawnError = undefined;
    worker.unref();
    worker.on("message", (message: LocalSqliteResponse) => this.#onMessage(message));
    worker.on("error", (error) => {
      this.#spawnError = error;
    });
    worker.on("exit", (exitCode) => this.#onExit(worker, generation, exitCode));
    return worker;
  }

  #onMessage(message: LocalSqliteResponse): void {
    if (message.type === "ready") {
      this.#ready = true;
      return;
    }
    if (message.type === "batch") {
      for (const response of message.responses) this.#onResponse(response);
      return;
    }
    this.#onResponse(message);
  }

  #onResponse(message: LocalSqliteRequestResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    this.#updateRef();
    if (pending.session) pending.session.inTransaction = message.inTransaction;
    if (message.ok) {
      if (pending.dataDir) {
        knownDataDirs.add(pending.dataDir);
        this.#openFailures.delete(pending.dataDir);
      }
      pending.resolve(message.result);
      return;
    }
    if (message.error.code === SQLITE_WORKER_OPEN_FAILED && pending.dataDir) {
      this.#openFailures.set(pending.dataDir, message.error);
      sqliteLog.error("sqlite.open_failed", {
        code: message.error.code,
        stage: message.error.stage,
        errcode: message.error.sqlite?.errcode,
        message: message.error.message,
      });
    }
    pending.reject(new LocalSqliteError(message.error));
  }

  #onExit(worker: Worker, generation: number, exitCode: number): void {
    if (this.#worker !== worker) return;
    this.#worker = undefined;
    const closing = this.#closing !== undefined;
    const spawnFailed = !this.#ready && !closing;
    const spawnError = this.#spawnError;
    if (spawnFailed) {
      sqliteLog.error("sqlite.worker_spawn_failed", {
        code: SQLITE_WORKER_OPEN_FAILED,
        stage: "spawn",
        exitCode,
        error: spawnError,
      });
    } else if (!closing) {
      sqliteLog.error("sqlite.worker_exited", {
        code: SQLITE_WORKER_EXITED,
        exitCode,
        pending: this.#pending.size,
        error: spawnError,
      });
    }
    for (const session of this.#sessions) {
      if (session.generation === generation && !session.broken) {
        session.broken = exitedError("The SQLite worker exited during this session.");
      }
    }
    // Buffered requests never reached the worker: they did not run.
    const unsent = new Set(this.#outbox.splice(0).map((request) => request.id));
    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    this.#updateRef();
    for (const [id, request] of pending) {
      if (closing) {
        request.reject(
          new LocalSqliteError({
            code: SQLITE_WORKER_CLOSED,
            message: "The SQLite worker shut down before running this request.",
          }),
        );
        continue;
      }
      if (spawnFailed) {
        request.reject(this.#openFailure(spawnError ?? `exit code ${exitCode}`, request.dataDir));
        continue;
      }
      request.reject(
        request.persisting && !unsent.has(id)
          ? new LocalSqliteError({
              code: SQLITE_WRITE_OUTCOME_UNKNOWN,
              message:
                "The SQLite worker exited before acknowledging a write; it may or may not have committed. Re-read before retrying.",
            })
          : exitedError("The SQLite worker exited before answering; the request did not complete."),
      );
    }
  }

  #updateRef(): void {
    const worker = this.#worker;
    if (!worker) return;
    // A closing worker stays referenced until it exits, so `close()` settles.
    if (this.#pending.size > 0 || this.#sessions.size > 0 || this.#closing) worker.ref();
    else worker.unref();
  }

  /** Test hook: simulates a worker crash. */
  async terminateForTest(): Promise<void> {
    await this.#worker?.terminate();
  }
}

function exitedError(message: string): LocalSqliteError {
  return new LocalSqliteError({ code: SQLITE_WORKER_EXITED, message });
}

function databaseOf(
  send: (sql: string, params: LocalSqliteParam[], mode: LocalSqliteMode) => Promise<any>,
): LocalSqliteDatabase {
  return {
    exec: (sql) => send(sql, [], "exec"),
    prepare: (sql) => ({
      run: (...params) => send(sql, params, "run"),
      get: (...params) => send(sql, params, "get"),
      all: (...params) => send(sql, params, "all"),
    }),
  };
}

let sharedClient: LocalSqliteWorkerClient | undefined;

/** The Host process's SQLite worker client. */
export function localSqliteClient(): LocalSqliteWorkerClient {
  sharedClient ??= new LocalSqliteWorkerClient();
  return sharedClient;
}

/** Host shutdown: drain and close the worker. A later request starts a new one. */
export async function closeLocalSqliteClient(): Promise<void> {
  const client = sharedClient;
  sharedClient = undefined;
  await client?.close();
}

/**
 * A store's view of `<dataDir>/local.sqlite`, served by the process's SQLite
 * worker. `use` runs a task as one exclusive session; `db` issues standalone
 * statements (one message each, no lease) for single-statement hot paths.
 */
export function createLocalSqliteConnection(options: { dataDir: string }) {
  return {
    use<T>(task: (database: LocalSqliteDatabase) => Promise<T> | T): Promise<T> {
      return localSqliteClient().session(options.dataDir, task);
    },
    db: databaseOf((sql, params, mode) => {
      const db = localSqliteClient().database(options.dataDir);
      return mode === "exec" ? db.exec(sql) : db.prepare(sql)[mode](...params);
    }),
  };
}
