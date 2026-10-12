import {
  isTelemetrySecretKey,
  OTLP_PROTOCOLS,
  TELEMETRY_KEYS,
  TelemetryConfigPatchSchema,
  TelemetryKeySchema,
  type PublicTelemetryConfig,
  type TelemetryKey,
} from "@clash/shared-types";

import {
  LocalConfigError,
  type LocalConfigResource,
  type LocalConfigSnapshot,
} from "../local-config-routes.js";
import { createClashUserConfigStore } from "../user-config.js";
import type { HostTelemetry } from "./pipeline.js";
import {
  resolveTelemetryExport,
  type TelemetryEnv,
  type TelemetryExportResolution,
  type TelemetrySettings,
} from "./resolve.js";

/**
 * Telemetry Settings as a local config resource.
 *
 * Non-secret keys live in config.yaml under `telemetry.env`; header values
 * are credentials and live in credentials.json. Every committed update is
 * applied to the running pipeline.
 */
export interface TelemetryConfigResource
  extends LocalConfigResource<PublicTelemetryConfig> {
  resolve(): Promise<TelemetryExportResolution>;
  /** Push the current resolution into the pipeline (startup and updates). */
  applyToPipeline(): Promise<void>;
}

const SECTION = "telemetry";
const CREDENTIALS_KEY = "telemetryOtlpSecrets";

interface StoredSettings {
  settings: TelemetrySettings;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keep only known keys of one storage class (secret or not). */
function pickSettings(value: unknown, secret: boolean): TelemetrySettings {
  const settings: TelemetrySettings = {};
  if (!isRecord(value)) return settings;
  for (const [key, raw] of Object.entries(value)) {
    const parsed = TelemetryKeySchema.safeParse(key);
    if (!parsed.success || isTelemetrySecretKey(parsed.data) !== secret) continue;
    if (typeof raw === "string") settings[parsed.data] = raw;
  }
  return settings;
}

type Normalizer = (key: TelemetryKey, value: string) => string;

const httpUrl: Normalizer = (key, value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalConfigError(`${key} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new LocalConfigError(`${key} must use http or https`);
  return value;
};

const oneOf =
  (allowed: readonly string[]): Normalizer =>
  (key, value) => {
    const normalized = value.toLowerCase();
    if (!allowed.includes(normalized))
      throw new LocalConfigError(`${key} must be one of ${allowed.join(", ")}`);
    return normalized;
  };

const asIs: Normalizer = (_key, value) => value;

/** Per-key validation of Settings values; empty strings are always allowed. */
const NORMALIZERS: Record<TelemetryKey, Normalizer> = {
  CLASH_ENABLE_TELEMETRY: oneOf(["1", "0", "true", "false"]),
  OTEL_SDK_DISABLED: oneOf(["true", "false"]),
  OTEL_TRACES_EXPORTER: oneOf(["otlp", "none"]),
  OTEL_EXPORTER_OTLP_PROTOCOL: oneOf(OTLP_PROTOCOLS),
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: oneOf(OTLP_PROTOCOLS),
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: httpUrl,
  OTEL_EXPORTER_OTLP_HEADERS: asIs,
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: asIs,
};

function normalize(key: TelemetryKey, value: string): string {
  const trimmed = value.trim();
  return trimmed ? NORMALIZERS[key](key, trimmed) : "";
}

function parsePatch(body: Record<string, unknown>) {
  const parsed = TelemetryConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LocalConfigError(
      issue
        ? `${["settings", ...issue.path].join(".")}: ${issue.message}`
        : "Invalid telemetry settings",
    );
  }
  return Object.entries(parsed.data.settings).map(
    ([key, value]) =>
      [
        key as TelemetryKey,
        value === null || value === undefined
          ? null
          : normalize(key as TelemetryKey, value),
      ] as const,
  );
}

function applyPatch(
  current: TelemetrySettings,
  patch: ReadonlyArray<readonly [TelemetryKey, string | null]>,
  secret: boolean,
): TelemetrySettings {
  const next = { ...current };
  for (const [key, value] of patch) {
    if (isTelemetrySecretKey(key) !== secret) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function toView(
  stored: StoredSettings,
  env: TelemetryEnv,
  resolution: TelemetryExportResolution,
): PublicTelemetryConfig {
  return {
    keys: TELEMETRY_KEYS.map((key) => {
      const secret = isTelemetrySecretKey(key);
      const hasSetting = Object.prototype.hasOwnProperty.call(
        stored.settings,
        key,
      );
      const envValue = env[key]?.trim() || null;
      return {
        key,
        secret,
        setting: secret || !hasSetting ? null : (stored.settings[key] ?? ""),
        has_setting: hasSetting,
        env: secret ? null : envValue,
        has_env: envValue !== null,
        source: resolution.sources[key],
      };
    }),
    export: {
      enabled: resolution.enabled,
      reason: resolution.reason,
      endpoint: resolution.endpoint,
      protocol: resolution.protocol,
    },
  };
}

export function createTelemetryConfigResource(options: {
  dataDir: string;
  env?: TelemetryEnv;
  pipeline?: HostTelemetry;
}): TelemetryConfigResource {
  const store = createClashUserConfigStore(options.dataDir);
  const env: TelemetryEnv = options.env ?? process.env;

  async function readStored(): Promise<StoredSettings> {
    const section = await store.getSection<unknown>(SECTION);
    const credentials = await store.getCredentials();
    const record = isRecord(section) ? section : {};
    return {
      settings: {
        ...pickSettings(record.env, false),
        ...pickSettings(credentials[CREDENTIALS_KEY], true),
      },
      updatedAt:
        typeof record.updated_at === "string"
          ? record.updated_at
          : new Date(0).toISOString(),
    };
  }

  async function resolve(): Promise<TelemetryExportResolution> {
    return resolveTelemetryExport(env, (await readStored()).settings);
  }

  async function applyToPipeline(): Promise<void> {
    await options.pipeline?.applyExport(await resolve());
  }

  return {
    id: "telemetry",
    resolve,
    applyToPipeline,

    async read(): Promise<LocalConfigSnapshot<PublicTelemetryConfig>> {
      const stored = await readStored();
      return {
        view: toView(stored, env, resolveTelemetryExport(env, stored.settings)),
        updatedAt: stored.updatedAt,
      };
    },

    async update(body) {
      const patch = parsePatch(body);
      if (patch.some(([key]) => isTelemetrySecretKey(key))) {
        await store.updateCredentials((current) => {
          const secrets = applyPatch(
            pickSettings(current[CREDENTIALS_KEY], true),
            patch,
            true,
          );
          const next = { ...current };
          if (Object.keys(secrets).length > 0) next[CREDENTIALS_KEY] = secrets;
          else delete next[CREDENTIALS_KEY];
          return next;
        });
      }
      // Always rewrite the section so updated_at advances on every change,
      // secret-only updates included.
      await store.updateSection(SECTION, (current) => ({
        env: applyPatch(
          pickSettings(isRecord(current) ? current.env : undefined, false),
          patch,
          false,
        ),
        updated_at: new Date().toISOString(),
      }));
    },

    afterUpdate: applyToPipeline,
  };
}
