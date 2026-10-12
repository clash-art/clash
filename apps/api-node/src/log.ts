import { createServerLogger } from "@clash/shared-telemetry/log";

/** Structured JSON-line logger for api-node (stdout + OTel Logs bridge). */
export const apiNodeLog = createServerLogger({ component: "api-node" });

/**
 * Loggable facts about a failure without its message. PostgreSQL and
 * connection errors may echo connection strings, so api-node logs only the
 * error class and driver code (e.g. a SQLSTATE).
 */
export function errorFacts(error: unknown): {
  error_name: string;
  error_code?: string;
} {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number"
    ? { error_name: name, error_code: String(code) }
    : { error_name: name };
}
