import { metrics, type Histogram } from "@opentelemetry/api";
import { createServerLogger } from "@clash/shared-telemetry/log";
import { sanitizeLogValue } from "@clash/shared-runtime/logging";

/** Structured JSON-line logger for render-server (stdout + OTel Logs bridge). */
export const renderLog = createServerLogger({ component: "render-server" });

/**
 * Source URLs are short-lived signed capabilities; log only origin and path,
 * never the query string that carries the signature.
 */
export function sourceTag(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.origin}${url.pathname}`.slice(0, 120);
  } catch {
    return "invalid-url";
  }
}

/**
 * Error text safe to return to callers. ffmpeg and Remotion echo source URLs,
 * and api-cf's asset URLs are signed capabilities (`?exp=&sig=`) that grant
 * download until expiry; callers also copy this text into their own errors.
 * Uses the shared log sanitizer: URL query, fragment and userinfo removed,
 * bearer and API tokens redacted.
 */
export function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(sanitizeLogValue(message));
}

export type RenderOperation = "render" | "thumbnail" | "probe_audio";

// Created on first use, not at import: the metrics API has no proxy
// provider, so an instrument taken before the bootstrap registers its
// MeterProvider would stay a no-op for the life of the process.
let operationDuration: Histogram | undefined;
function durationHistogram(): Histogram {
  return (operationDuration ??= metrics
    .getMeter("@clash/render-server")
    .createHistogram("clash.render.duration", {
      description: "render-server operation wall time, by operation and outcome.",
      unit: "s",
    }));
}

/** Time one operation and record its duration with a success/failure outcome. */
export async function measured<T>(
  operation: RenderOperation,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await work();
    outcome = "success";
    return result;
  } finally {
    durationHistogram().record((performance.now() - started) / 1000, {
      "clash.render.operation": operation,
      "clash.render.outcome": outcome,
    });
  }
}
