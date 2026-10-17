/**
 * D1-shaped adapter over node:sqlite for tests that need the real SQL (Better
 * Auth's drizzle adapter, raw D1 routes) and a per-request query count.
 * Every awaited statement (`all`/`first`/`run`/`raw`) and every `batch` counts
 * as one D1 round trip, which is what costs latency in production.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface D1Counter {
  count: number;
  sql: string[];
  reset(): void;
}

type Value = string | number | bigint | null | Uint8Array;

function toSqlite(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value as Value;
}

export const WEB_DRIZZLE_MIGRATIONS = resolve(__dirname, "../../../web/drizzle");

export function createSqliteD1(migrationsDir = WEB_DRIZZLE_MIGRATIONS) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const part of sql.split("--> statement-breakpoint")) {
      if (part.trim()) db.exec(part);
    }
  }
  const counter: D1Counter = {
    count: 0,
    sql: [],
    reset() {
      this.count = 0;
      this.sql = [];
    },
  };
  const tick = (sql: string) => {
    counter.count++;
    counter.sql.push(sql.replace(/\s+/g, " ").trim().slice(0, 300));
  };

  const execute = (sql: string, args: Value[]) => {
    const statement: StatementSync = db.prepare(sql);
    const returnsRows = statement.columns().length > 0;
    if (returnsRows) {
      const results = statement.all(...args) as Record<string, unknown>[];
      return { results, meta: { changes: 0, last_row_id: 0, rows_read: results.length, rows_written: 0 } };
    }
    const info = statement.run(...args);
    return {
      results: [] as Record<string, unknown>[],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        rows_read: 0,
        rows_written: Number(info.changes),
      },
    };
  };

  const statement = (sql: string, args: Value[] = []): any => ({
    sql,
    args,
    bind: (...next: unknown[]) => statement(sql, next.map(toSqlite)),
    async all() {
      tick(sql);
      const r = execute(sql, args);
      return { success: true, results: r.results, meta: r.meta };
    },
    async run() {
      tick(sql);
      const r = execute(sql, args);
      return { success: true, results: r.results, meta: r.meta };
    },
    async first(column?: string) {
      tick(sql);
      const row = execute(sql, args).results[0] ?? null;
      return column ? (row ? (row as Record<string, unknown>)[column] ?? null : null) : row;
    },
    async raw(options?: { columnNames?: boolean }) {
      tick(sql);
      const s = db.prepare(sql);
      s.setReturnArrays(true);
      const rows = s.columns().length > 0 ? (s.all(...args) as unknown as unknown[][]) : (s.run(...args), []);
      return options?.columnNames ? [s.columns().map((c) => c.name), ...rows] : rows;
    },
  });

  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: { sql: string; args: Value[] }[]) {
      tick(`batch(${statements.length})`);
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => {
          const r = execute(s.sql, s.args);
          return { success: true, results: r.results, meta: r.meta };
        });
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      tick(sql);
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession() {
      return d1;
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite: db, counter };
}
