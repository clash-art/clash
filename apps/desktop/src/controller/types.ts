import type { LogRecord, LogLevel } from "@clash/shared-runtime/logging";
export interface DesktopControllerLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  record?(record: LogRecord): void;
  event?(
    level: LogLevel,
    event: string,
    context?: Record<string, unknown>,
  ): void;
}
