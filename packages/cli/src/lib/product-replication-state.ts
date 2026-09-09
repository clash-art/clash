import { nodeRequire } from "./node-require.js";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parse } from "yaml";

const require = createRequire(process.execPath);

interface SqliteDatabase {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => SqliteDatabase;
}

export interface ProductReplicationStateOptions {
  localApiDataDir: string;
  env?: Record<string, string | undefined>;
}

export function readProductReplicationState(
  options: ProductReplicationStateOptions,
): Record<string, unknown> {
  const fallback = syncStateFromEnv(options.env ?? {});
  if (fallback.mode === "cloud-sync") return fallback;
  const configPath = join(options.localApiDataDir, "..", "config.yaml");
  if (existsSync(configPath)) {
    try {
      const root = parse(readFileSync(configPath, "utf8")) as unknown;
      if (!isRecord(root)) return { mode: "unknown" };
      return syncStateFromStoredConfig(root.sync);
    } catch {
      return { mode: "unknown" };
    }
  }

  // Read the retired SQLite row only until local-api performs the one-way
  // import. Once config.yaml exists it is the sole source of truth.
  const sqlitePath = join(options.localApiDataDir, "local.sqlite");
  if (!existsSync(sqlitePath)) return fallback;

  let db: SqliteDatabase | undefined;
  try {
    const { DatabaseSync } = nodeRequire()("node:sqlite") as SqliteModule;
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const row = db
      .prepare("SELECT value_json FROM local_config WHERE key = ?")
      .get("local-sync-config");
    if (!row || typeof row.value_json !== "string") return fallback;
    return syncStateFromStoredConfig(JSON.parse(row.value_json));
  } catch (error) {
    if (isMissingLocalConfigTable(error)) return fallback;
    return { mode: "unknown" };
  } finally {
    db?.close();
  }
}

function syncStateFromEnv(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const remoteUrl = env.CLASH_REMOTE_LORO_URL?.trim();
  return remoteUrl
    ? { mode: "cloud-sync", capabilities: emptyCapabilities() }
    : { mode: "local-only", capabilities: emptyCapabilities() };
}

function syncStateFromStoredConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { mode: "unknown" };
  if (value.mode === "local-only") {
    return { mode: "local-only", capabilities: emptyCapabilities() };
  }
  const remote = isRecord(value.remote_loro) ? value.remote_loro : {};
  const remoteUrl = nonEmptyString(remote.url)
    ? remote.url
    : nonEmptyString(value.remoteLoroUrl)
      ? value.remoteLoroUrl
      : null;
  if (value.mode !== "cloud-sync" || !remoteUrl) {
    return { mode: "unknown" };
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  return {
    mode: "cloud-sync",
    capabilities: {
      canvas: capabilities.canvas === true,
      asset_metadata: capabilities.asset_metadata === true,
      revision_content: capabilities.revision_content === true,
      project_metadata: capabilities.project_metadata === true,
    },
  };
}

function emptyCapabilities(): Record<string, boolean> {
  return {
    canvas: false,
    asset_metadata: false,
    revision_content: false,
    project_metadata: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isMissingLocalConfigTable(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no such table:\s*local_config/i.test(error.message)
  );
}
