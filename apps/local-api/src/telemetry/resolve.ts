import {
  OTLP_PROTOCOLS,
  TELEMETRY_KEYS,
  type OtlpProtocol,
  type TelemetryExportReason,
  type TelemetryKey,
  type TelemetryValueSource,
} from "@clash/shared-types";

/**
 * Pure resolution of OTLP trace export from the environment plus Settings.
 *
 * Follows Claude Code's model: nothing is exported unless the master switch
 * `CLASH_ENABLE_TELEMETRY` is on, the remaining knobs are the standard
 * `OTEL_*` exporter variables, and a key present in Settings wins over the
 * same environment variable (an empty Settings value cancels it).
 */

export type TelemetrySettings = Partial<Record<TelemetryKey, string>>;
export type TelemetryEnv = Readonly<Partial<Record<string, string>>>;

export type TelemetryExportResolution =
  | {
      enabled: true;
      reason: "enabled";
      endpoint: string;
      protocol: OtlpProtocol;
      headers: Record<string, string>;
      sources: Record<TelemetryKey, TelemetryValueSource>;
    }
  | {
      enabled: false;
      reason: Exclude<TelemetryExportReason, "enabled">;
      endpoint: string | null;
      protocol: string | null;
      headers: Record<string, never>;
      sources: Record<TelemetryKey, TelemetryValueSource>;
    };

// OTLP exporter defaults from the OpenTelemetry specification
// (specification/protocol/exporter.md): OTLP/HTTP listens on localhost:4318,
// the generic endpoint gets the per-signal path appended, a signal-specific
// endpoint is used as-is, and the default protocol is http/protobuf.
const DEFAULT_OTLP_HTTP_ENDPOINT = "http://localhost:4318";
const TRACES_SIGNAL_PATH = "v1/traces";
const DEFAULT_OTLP_PROTOCOL: OtlpProtocol = "http/protobuf";

function isOtlpProtocol(value: string): value is OtlpProtocol {
  return (OTLP_PROTOCOLS as readonly string[]).includes(value);
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS`: comma-separated `key=value` pairs with
 * percent-encoded values. Malformed entries are skipped.
 */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw?.split(",") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      // Invalid percent-encoding: skip the entry rather than send garbage.
    }
  }
  return headers;
}

/** Effective value and origin of every key: Settings first, then env. */
export function resolveTelemetryValues(
  env: TelemetryEnv,
  settings: TelemetrySettings,
): {
  values: Partial<Record<TelemetryKey, string>>;
  sources: Record<TelemetryKey, TelemetryValueSource>;
} {
  const values: Partial<Record<TelemetryKey, string>> = {};
  const sources = {} as Record<TelemetryKey, TelemetryValueSource>;
  for (const key of TELEMETRY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      const value = settings[key]?.trim();
      if (value) values[key] = value;
      sources[key] = "config";
      continue;
    }
    const value = env[key]?.trim();
    if (value) values[key] = value;
    sources[key] = value ? "env" : "default";
  }
  return { values, sources };
}

export function resolveTelemetryExport(
  env: TelemetryEnv,
  settings: TelemetrySettings,
): TelemetryExportResolution {
  const { values, sources } = resolveTelemetryValues(env, settings);
  const off = (
    reason: Exclude<TelemetryExportReason, "enabled">,
    detail: { endpoint?: string; protocol?: string } = {},
  ): TelemetryExportResolution => ({
    enabled: false,
    reason,
    endpoint: detail.endpoint ?? null,
    protocol: detail.protocol ?? null,
    headers: {},
    sources,
  });

  if (!isTruthyFlag(values.CLASH_ENABLE_TELEMETRY))
    return off("telemetry_disabled");
  if (values.OTEL_SDK_DISABLED?.toLowerCase() === "true")
    return off("sdk_disabled");

  const exporters = (values.OTEL_TRACES_EXPORTER ?? "otlp")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (exporters.every((name) => name === "none")) return off("exporter_none");
  if (!exporters.includes("otlp")) return off("unsupported_exporter");

  const protocol =
    values.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
    values.OTEL_EXPORTER_OTLP_PROTOCOL ??
    DEFAULT_OTLP_PROTOCOL;
  if (!isOtlpProtocol(protocol))
    return off("unsupported_protocol", { protocol });

  const endpoint =
    values.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    `${(values.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_HTTP_ENDPOINT).replace(/\/+$/, "")}/${TRACES_SIGNAL_PATH}`;
  if (!isHttpUrl(endpoint))
    return off("invalid_endpoint", { endpoint, protocol });

  return {
    enabled: true,
    reason: "enabled",
    endpoint,
    protocol,
    // Signal-specific headers override generic ones per key, matching the
    // official OTLP exporters' environment handling.
    headers: {
      ...parseOtlpHeaders(values.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(values.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    },
    sources,
  };
}
