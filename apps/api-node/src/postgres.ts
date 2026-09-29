import { Pool, type PoolConfig } from "pg";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
export interface ReservedConnection extends PostgresQueryPort {
  release(destroy?: boolean): void;
}
export interface ConnectionPool extends PostgresQueryPort {
  connect(): Promise<ReservedConnection>;
}
export type SqlConnection = PostgresQueryPort & {
  exec(sql: string): Promise<unknown>;
};

/** Transaction statements always use one checked-out client. */
export function createPostgresDatabase(pool: ConnectionPool) {
  return {
    query: <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) => pool.query<Row>(sql, parameters),
    async transaction<T>(
      work: (connection: SqlConnection) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query("BEGIN");
        const value = await work({
          query: client.query.bind(client),
          exec: (sql) => client.query(sql),
        });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
        throw error;
      } finally {
        client.release(destroy);
      }
    },
  };
}
export function openPostgres(config: PoolConfig) {
  const pool = new Pool({
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    ...config,
  });
  // An idle socket error must not crash the process or disclose connection credentials.
  pool.on("error", () => console.error("PostgreSQL idle connection failed"));
  return { pool, db: createPostgresDatabase(pool), close: () => pool.end() };
}
