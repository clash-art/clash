// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEMETRY_KEYS,
  isTelemetrySecretKey,
  type PublicTelemetryConfig,
  type TelemetryKey,
} from "@clash/shared-types";

import { AppFeedbackProvider } from "./AppFeedback";
import { TelemetrySection } from "./SettingsTelemetrySection";

function config(
  overrides: Partial<Record<TelemetryKey, { setting?: string; env?: string }>> = {},
  exportStatus: PublicTelemetryConfig["export"] = {
    enabled: false,
    reason: "telemetry_disabled",
    endpoint: null,
    protocol: null,
  },
): PublicTelemetryConfig {
  return {
    keys: TELEMETRY_KEYS.map((key) => {
      const entry = overrides[key] ?? {};
      const secret = isTelemetrySecretKey(key);
      return {
        key,
        secret,
        setting: secret ? null : (entry.setting ?? null),
        has_setting: entry.setting !== undefined,
        env: secret ? null : (entry.env ?? null),
        has_env: entry.env !== undefined,
        source:
          entry.setting !== undefined
            ? "config"
            : entry.env !== undefined
              ? "env"
              : "default",
      };
    }),
    export: exportStatus,
  };
}

function mockFetch(initial: PublicTelemetryConfig, saved: PublicTelemetryConfig) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method === "PATCH" ? saved : initial), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection() {
  render(
    <AppFeedbackProvider>
      <TelemetrySection />
    </AppFeedbackProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TelemetrySection", () => {
  it("sends only the changed keys when saving", async () => {
    const fetchMock = mockFetch(
      config(),
      config(
        {
          CLASH_ENABLE_TELEMETRY: { setting: "1" },
          OTEL_EXPORTER_OTLP_ENDPOINT: { setting: "http://collector:4318" },
        },
        {
          enabled: true,
          reason: "enabled",
          endpoint: "http://collector:4318/v1/traces",
          protocol: "http/protobuf",
        },
      ),
    );
    renderSection();

    fireEvent.click(await screen.findByRole("switch", { name: "Export traces" }));
    fireEvent.change(screen.getByLabelText("OTLP endpoint"), {
      target: { value: "http://collector:4318" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Exporting traces to http:\/\/collector:4318\/v1\/traces/),
      ).toBeTruthy(),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      settings: {
        CLASH_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      },
    });
  });

  it("removes a Settings value to fall back to the environment", async () => {
    const fetchMock = mockFetch(
      config({
        OTEL_EXPORTER_OTLP_ENDPOINT: {
          setting: "http://settings:4318",
          env: "http://env:4318",
        },
      }),
      config({ OTEL_EXPORTER_OTLP_ENDPOINT: { env: "http://env:4318" } }),
    );
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "Use environment value" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
      ).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      settings: { OTEL_EXPORTER_OTLP_ENDPOINT: null },
    });
  });
});
