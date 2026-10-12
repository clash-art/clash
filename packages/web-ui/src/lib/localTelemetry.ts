import {
  PublicTelemetryConfigSchema,
  type PublicTelemetryConfig,
  type TelemetryConfigPatch,
  type TelemetryKey,
  type TelemetryKeyState,
} from "@clash/shared-types";

import { runtimeApiUrl } from "./runtimeConfig";

/** Client for the Host's `/api/v1/local/telemetry` Settings resource. */

async function parseResponse(response: Response): Promise<PublicTelemetryConfig> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return PublicTelemetryConfigSchema.parse(body);
}

export async function fetchLocalTelemetryConfig(): Promise<PublicTelemetryConfig> {
  return parseResponse(
    await fetch(runtimeApiUrl("/api/v1/local/telemetry"), {
      credentials: "include",
    }),
  );
}

export async function saveLocalTelemetryConfig(
  settings: TelemetryConfigPatch["settings"],
): Promise<PublicTelemetryConfig> {
  return parseResponse(
    await fetch(runtimeApiUrl("/api/v1/local/telemetry"), {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings } satisfies TelemetryConfigPatch),
    }),
  );
}

export function telemetryKeyState(
  config: PublicTelemetryConfig,
  key: TelemetryKey,
): TelemetryKeyState | undefined {
  return config.keys.find((entry) => entry.key === key);
}
