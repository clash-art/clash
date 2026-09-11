import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  createLogRecord,
  parseLogRecord,
  type LogLevel,
  type LogRecord,
} from "./logging.js";

export interface LocalLogEntry extends LogRecord {
  file: string;
  line: number;
  legacy?: true;
  pid?: number;
  runId?: string;
}

export interface LocalLogQuery {
  directory: string;
  level?: LogLevel;
  component?: string;
  projectId?: string;
  assetId?: string;
  event?: string;
  runId?: string;
  since?: number;
  limit?: number;
}

const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Read-only, profile-local query. No discovery, network, traces or project state. */
export async function readLocalLogs(query: LocalLogQuery) {
  const limit = Math.max(1, Math.min(1_000, query.limit ?? 50));
  let records: LocalLogEntry[] = [];
  const files: string[] = [];
  let invalidLines = 0;
  let matched = 0;
  const events = new Map<string, number>();
  const newestFirst = (a: LocalLogEntry, b: LocalLogEntry) =>
    Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.line - a.line;
  for (const folder of ["desktop", "local-api"]) {
    const directory = join(query.directory, folder);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${folder}-`) &&
        entry.name.endsWith(".jsonl"),
    )) {
      const file = join(directory, entry.name);
      const input = createReadStream(file, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let line = 0;
      try {
        files.push(file);
        for await (const text of lines) {
          line++;
          if (!text.trim()) continue;
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(text);
          } catch {
            invalidLines++;
            continue;
          }
          if (
            !raw ||
            typeof raw !== "object" ||
            typeof raw.timestamp !== "string" ||
            !Number.isFinite(Date.parse(raw.timestamp))
          ) {
            invalidLines++;
            continue;
          }
          const parsed = parseLogRecord(text);
          const level = String(raw.level).toLowerCase();
          if (!Object.hasOwn(levels, level)) {
            invalidLines++;
            continue;
          }
          const context =
            raw.context && typeof raw.context === "object"
              ? (raw.context as Record<string, unknown>)
              : {};
          const record =
            parsed ??
            createLogRecord({
              component:
                typeof raw.event === "string" &&
                raw.event.startsWith("renderer.")
                  ? "renderer"
                  : folder,
              module: "legacy",
              level: level as LogLevel,
              timestamp: raw.timestamp,
              event:
                typeof raw.event === "string" ? raw.event : `${folder}.console`,
              context: {
                ...context,
                ...(typeof raw.message === "string"
                  ? { message: raw.message }
                  : {}),
              },
            });
          if (
            levels[record.level] < levels[query.level ?? "debug"] ||
            (query.component && record.component !== query.component) ||
            (query.event && !record.event.startsWith(query.event)) ||
            (query.projectId && record.context.projectId !== query.projectId) ||
            (query.assetId && record.context.assetId !== query.assetId) ||
            (query.runId && raw.runId !== query.runId) ||
            (query.since !== undefined &&
              Date.parse(record.timestamp) < query.since)
          )
            continue;
          matched++;
          const eventKey = `${record.level} ${record.component} ${record.event}`;
          // The summary must also stay bounded when reading legacy third-party messages.
          const key =
            events.has(eventKey) || events.size < 256 ? eventKey : "other";
          events.set(key, (events.get(key) ?? 0) + 1);
          records.push({
            ...record,
            file,
            line,
            ...(parsed ? {} : { legacy: true as const }),
            ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
            ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
          });
          if (records.length > limit * 2)
            records = records.sort(newestFirst).slice(0, limit);
        }
      } catch (error) {
        // A running sink can rotate a file between inventory and open.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        lines.close();
        input.destroy();
      }
    }
  }
  const startup = join(query.directory, "desktop", "host-startup.log");
  const startupInfo = await stat(startup).catch(() => undefined);
  return {
    directory: query.directory,
    files,
    matched,
    invalidLines,
    summary: [...events]
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count),
    records: records.sort(newestFirst).slice(0, limit).reverse(),
    ...(startupInfo?.isFile()
      ? { startupLog: { file: startup, bytes: startupInfo.size } }
      : {}),
  };
}
