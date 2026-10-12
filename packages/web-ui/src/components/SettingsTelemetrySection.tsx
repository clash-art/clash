import { useCallback, useEffect, useState } from "react";
import { Pulse } from "@phosphor-icons/react";

import type {
  PublicTelemetryConfig,
  TelemetryConfigPatch,
  TelemetryExportReason,
  TelemetryKey,
} from "@clash/shared-types";
import {
  fetchLocalTelemetryConfig,
  saveLocalTelemetryConfig,
  telemetryKeyState,
} from "@clash/web-ui/lib/localTelemetry";
import { useAppFeedback } from "./AppFeedback";
import {
  SettingsActions,
  SettingsFieldGroup,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSectionLayout,
} from "./SettingsPrimitives";
import { Button } from "./ui/button";
import { InlineAlert } from "./ui/feedback";
import { Input } from "./ui/input";
import { SelectMenu, type SelectOption } from "./ui/select";
import { Switch } from "./ui/switch";

type TelemetryPatch = TelemetryConfigPatch["settings"];

const DEFAULT_PROTOCOL = "__default__";

const PROTOCOL_OPTIONS: SelectOption<string>[] = [
  {
    value: DEFAULT_PROTOCOL,
    label: "Default",
    description: "Environment value, otherwise http/protobuf",
  },
  { value: "http/protobuf", label: "http/protobuf" },
  { value: "http/json", label: "http/json" },
];

const REASON_TEXT: Record<TelemetryExportReason, string> = {
  enabled: "Exporting traces.",
  telemetry_disabled: "Export is off. Traces stay in local logs only.",
  sdk_disabled: "OTEL_SDK_DISABLED is set, so export is off.",
  exporter_none: "OTEL_TRACES_EXPORTER is none, so export is off.",
  unsupported_exporter:
    "OTEL_TRACES_EXPORTER names an exporter Clash does not provide; only otlp is supported.",
  unsupported_protocol:
    "The OTLP protocol is not supported; use http/protobuf or http/json.",
  invalid_endpoint: "The OTLP endpoint is not a valid http(s) URL.",
};

function isOn(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

interface Draft {
  enabled: boolean;
  endpoint: string;
  protocol: string;
  headers: string;
  removeHeaders: boolean;
}

function draftFrom(config: PublicTelemetryConfig): Draft {
  const enable = telemetryKeyState(config, "CLASH_ENABLE_TELEMETRY");
  const endpoint = telemetryKeyState(config, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const protocol = telemetryKeyState(config, "OTEL_EXPORTER_OTLP_PROTOCOL");
  return {
    enabled: isOn(enable?.has_setting ? enable.setting : enable?.env),
    endpoint: endpoint?.has_setting ? (endpoint.setting ?? "") : "",
    protocol: protocol?.has_setting && protocol.setting
      ? protocol.setting
      : DEFAULT_PROTOCOL,
    headers: "",
    removeHeaders: false,
  };
}

function patchFrom(config: PublicTelemetryConfig, draft: Draft): TelemetryPatch {
  const initial = draftFrom(config);
  const patch: TelemetryPatch = {};
  if (draft.enabled !== initial.enabled)
    patch.CLASH_ENABLE_TELEMETRY = draft.enabled ? "1" : "0";
  if (draft.endpoint.trim() !== initial.endpoint)
    patch.OTEL_EXPORTER_OTLP_ENDPOINT = draft.endpoint.trim() || null;
  if (draft.protocol !== initial.protocol)
    patch.OTEL_EXPORTER_OTLP_PROTOCOL =
      draft.protocol === DEFAULT_PROTOCOL ? null : draft.protocol;
  if (draft.removeHeaders) patch.OTEL_EXPORTER_OTLP_HEADERS = null;
  else if (draft.headers.trim())
    patch.OTEL_EXPORTER_OTLP_HEADERS = draft.headers.trim();
  return patch;
}

function SourceNote({
  config,
  keyName,
  onUseEnvironment,
}: {
  config: PublicTelemetryConfig;
  keyName: TelemetryKey;
  onUseEnvironment?: () => void;
}) {
  const state = telemetryKeyState(config, keyName);
  if (!state) return null;
  const text =
    state.source === "config"
      ? state.has_env
        ? "Set in Settings; overrides the environment variable."
        : "Set in Settings."
      : state.source === "env"
        ? `From environment variable ${keyName}.`
        : "Not set.";
  return (
    <p className="mt-1 flex items-center gap-2 text-xs leading-4 text-muted-foreground">
      <span>{text}</span>
      {state.source === "config" && state.has_env && onUseEnvironment ? (
        <Button size="sm" onClick={onUseEnvironment}>
          Use environment value
        </Button>
      ) : null}
    </p>
  );
}

/**
 * OpenTelemetry trace export. Every control maps to one standard key that
 * the Host resolves in `apps/local-api/src/local-telemetry.ts`; a value set
 * here wins over the same environment variable.
 */
export function TelemetrySection() {
  const feedback = useAppFeedback();
  const [config, setConfig] = useState<PublicTelemetryConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: PublicTelemetryConfig) => {
    setConfig(next);
    setDraft(draftFrom(next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchLocalTelemetryConfig()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const save = useCallback(
    async (patch: TelemetryPatch) => {
      if (Object.keys(patch).length === 0) return;
      setSaving(true);
      try {
        apply(await saveLocalTelemetryConfig(patch));
        feedback.notify({ variant: "success", title: "Telemetry settings saved" });
      } catch (error) {
        feedback.notify({
          variant: "error",
          title: "Could not save telemetry settings",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setSaving(false);
      }
    },
    [apply, feedback],
  );

  if (loadError) {
    return (
      <SettingsSectionLayout aria-labelledby="telemetry-heading">
        <SettingsSectionHeader
          title="Telemetry"
          titleId="telemetry-heading"
          icon={<Pulse className="size-4" weight="bold" />}
        />
        <InlineAlert tone="error" title={loadError} />
      </SettingsSectionLayout>
    );
  }
  if (!config || !draft) {
    return (
      <SettingsSectionLayout
        aria-labelledby="telemetry-heading"
        aria-busy="true"
      >
        <SettingsSectionHeader
          title="Telemetry"
          titleId="telemetry-heading"
          icon={<Pulse className="size-4" weight="bold" />}
        />
      </SettingsSectionLayout>
    );
  }

  const endpointState = telemetryKeyState(config, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const headersState = telemetryKeyState(config, "OTEL_EXPORTER_OTLP_HEADERS");
  const patch = patchFrom(config, draft);
  const dirty = Object.keys(patch).length > 0;
  const update = (change: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));

  return (
    <SettingsSectionLayout aria-labelledby="telemetry-heading">
      <SettingsSectionHeader
        title="Telemetry"
        titleId="telemetry-heading"
        description="Send OpenTelemetry traces of agent sessions, turns and tool calls to your own collector. Spans carry IDs, counts and durations only, never prompts, tool arguments or outputs."
        icon={<Pulse className="size-4" weight="bold" />}
        action={
          <Switch
            aria-label="Export traces"
            checked={draft.enabled}
            disabled={saving}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />

      <SettingsPanel className="space-y-4 p-4">
        <SettingsFieldGroup
          label="OTLP endpoint"
          description="Base URL of the collector; /v1/traces is appended."
        >
          <Input
            aria-label="OTLP endpoint"
            value={draft.endpoint}
            placeholder={endpointState?.env ?? "http://localhost:4318"}
            onChange={(event) => update({ endpoint: event.target.value })}
          />
          <SourceNote
            config={config}
            keyName="OTEL_EXPORTER_OTLP_ENDPOINT"
            onUseEnvironment={() =>
              void save({ OTEL_EXPORTER_OTLP_ENDPOINT: null })
            }
          />
        </SettingsFieldGroup>

        <SettingsFieldGroup label="Protocol">
          <SelectMenu
            value={draft.protocol}
            options={PROTOCOL_OPTIONS}
            onValueChange={(protocol) => update({ protocol })}
            ariaLabel="OTLP protocol"
            variant="field"
            menuWidth="trigger"
          />
          <SourceNote config={config} keyName="OTEL_EXPORTER_OTLP_PROTOCOL" />
        </SettingsFieldGroup>

        <SettingsFieldGroup
          label="Headers"
          description="Comma-separated key=value pairs, for example Authorization=Bearer%20token. Stored with your credentials and never shown again."
        >
          <Input
            aria-label="OTLP headers"
            type="password"
            autoComplete="off"
            value={draft.headers}
            placeholder={
              draft.removeHeaders
                ? "Will be removed"
                : headersState?.has_setting
                  ? "Configured in Settings"
                  : headersState?.has_env
                    ? "From environment variable"
                    : "Not set"
            }
            onChange={(event) =>
              update({ headers: event.target.value, removeHeaders: false })
            }
          />
          {headersState?.has_setting && !draft.removeHeaders ? (
            <SettingsActions className="justify-start pt-1">
              <Button
                size="sm"
               
                onClick={() => update({ headers: "", removeHeaders: true })}
              >
                Remove saved headers
              </Button>
            </SettingsActions>
          ) : null}
        </SettingsFieldGroup>
      </SettingsPanel>

      <InlineAlert
        tone={
          config.export.enabled
            ? "success"
            : config.export.reason === "telemetry_disabled"
              ? "info"
              : "warning"
        }
        title={
          config.export.enabled && config.export.endpoint
            ? `Exporting traces to ${config.export.endpoint} (${config.export.protocol}).`
            : REASON_TEXT[config.export.reason]
        }
      />

      <SettingsActions>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save(patch)}
        >
          Save
        </Button>
      </SettingsActions>
    </SettingsSectionLayout>
  );
}
