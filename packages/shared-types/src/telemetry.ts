import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

/**
 * OpenTelemetry export settings contract shared by the local Host
 * (`GET/PATCH /api/v1/local/telemetry`) and the Settings UI.
 *
 * Settings use the same names as the environment: Clash's master switch plus
 * standard `OTEL_*` exporter variables. A key present in Settings wins over
 * the environment; an empty Settings value cancels the environment value.
 */

export const TELEMETRY_KEYS = [
  "CLASH_ENABLE_TELEMETRY",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
] as const;

export let TelemetryKeySchema = lazySchema(() => (
z.enum(TELEMETRY_KEYS)
), (real) => { TelemetryKeySchema = real; });
export type TelemetryKey = z.infer<typeof TelemetryKeySchema>;

/** Credential-bearing keys: stored with secrets and never echoed back. */
export const TELEMETRY_SECRET_KEYS: ReadonlySet<TelemetryKey> = new Set([
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
]);

export function isTelemetrySecretKey(key: TelemetryKey): boolean {
  return TELEMETRY_SECRET_KEYS.has(key);
}

/**
 * Host receiver for traces recorded by local clients (the GUI renderer).
 * Clients export OTLP/HTTP JSON here; the Host records and, when export is
 * enabled, forwards them with its own resolved endpoint and credentials.
 */
export const LOCAL_OTLP_TRACES_PATH = "/api/v1/local/otlp/v1/traces";

/** OTLP transports the Host can export with. */
export const OTLP_PROTOCOLS = ["http/protobuf", "http/json"] as const;
export let OtlpProtocolSchema = lazySchema(() => (
z.enum(OTLP_PROTOCOLS)
), (real) => { OtlpProtocolSchema = real; });
export type OtlpProtocol = z.infer<typeof OtlpProtocolSchema>;

export let TelemetryValueSourceSchema = lazySchema(() => (
z.enum(["config", "env", "default"])
), (real) => { TelemetryValueSourceSchema = real; });
export type TelemetryValueSource = z.infer<typeof TelemetryValueSourceSchema>;

export let TelemetryExportReasonSchema = lazySchema(() => (
z.enum([
  "enabled",
  "telemetry_disabled",
  "sdk_disabled",
  "exporter_none",
  "unsupported_exporter",
  "unsupported_protocol",
  "invalid_endpoint",
])
), (real) => { TelemetryExportReasonSchema = real; });
export type TelemetryExportReason = z.infer<typeof TelemetryExportReasonSchema>;

export let TelemetryKeyStateSchema = lazySchema(() => (
z.object({
  key: TelemetryKeySchema,
  secret: z.boolean(),
  /** Settings value; always null for secret keys. */
  setting: z.string().nullable(),
  has_setting: z.boolean(),
  /** Environment value; always null for secret keys. */
  env: z.string().nullable(),
  has_env: z.boolean(),
  source: TelemetryValueSourceSchema,
})
), (real) => { TelemetryKeyStateSchema = real; });
export type TelemetryKeyState = z.infer<typeof TelemetryKeyStateSchema>;

export let TelemetryExportStatusSchema = lazySchema(() => (
z.object({
  enabled: z.boolean(),
  reason: TelemetryExportReasonSchema,
  endpoint: z.string().nullable(),
  protocol: z.string().nullable(),
})
), (real) => { TelemetryExportStatusSchema = real; });
export type TelemetryExportStatus = z.infer<typeof TelemetryExportStatusSchema>;

export let PublicTelemetryConfigSchema = lazySchema(() => (
z.object({
  keys: z.array(TelemetryKeyStateSchema),
  export: TelemetryExportStatusSchema,
})
), (real) => { PublicTelemetryConfigSchema = real; });
export type PublicTelemetryConfig = z.infer<typeof PublicTelemetryConfigSchema>;

/**
 * PATCH body. A string stores the key in Settings (an empty string cancels
 * the environment value); null removes it so the environment applies again.
 * Unlisted keys are unchanged.
 */
export let TelemetryConfigPatchSchema = lazySchema(() => (
z.object({
  settings: z.partialRecord(TelemetryKeySchema, z.string().nullable()),
})
), (real) => { TelemetryConfigPatchSchema = real; });
export type TelemetryConfigPatch = z.infer<typeof TelemetryConfigPatchSchema>;
