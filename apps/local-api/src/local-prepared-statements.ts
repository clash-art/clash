/**
 * Prepared statements are bound to one open `node:sqlite` connection. Stores
 * already keep that connection alive through `createLocalSqliteConnection`, so
 * re-preparing the same SELECT on every Asset resolve was pure repeat work.
 * The WeakMap follows connection replacement: a new database object gets a new
 * statement cache, and closed databases are collectible.
 */
const caches = new WeakMap<object, Map<string, unknown>>();

export function preparedStatement<Statement>(
  database: object,
  sql: string,
  prepare: (sql: string) => Statement,
): Statement {
  let cache = caches.get(database);
  if (!cache) {
    cache = new Map();
    caches.set(database, cache);
  }
  const existing = cache.get(sql);
  if (existing !== undefined) return existing as Statement;
  const statement = prepare(sql);
  cache.set(sql, statement);
  return statement;
}
