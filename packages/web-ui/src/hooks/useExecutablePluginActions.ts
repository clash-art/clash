import { useEffect, useRef, useState } from "react";
import {
  CustomActionDefinitionSchema,
  type CustomActionDefinition,
} from "@clash/shared-types";
import { runtimeApiUrl } from "../lib/runtimeConfig";

export async function loadExecutablePluginActions(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CustomActionDefinition[]> {
  const response = await fetchImpl(runtimeApiUrl("/api/v1/plugin-actions"), {
    credentials: "include",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Plugin action catalog request failed (${response.status}).`,
    );
  }
  const payload = (await response.json()) as { actions?: unknown };
  if (!Array.isArray(payload.actions)) {
    throw new Error("Invalid plugin action catalog: actions must be an array.");
  }
  const actions: CustomActionDefinition[] = [];
  for (const value of payload.actions) {
    const parsed = CustomActionDefinitionSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid plugin action catalog: ${parsed.error.message}`);
    }
    actions.push(parsed.data);
  }
  return actions;
}

/** Same-origin discovery for activated local plugins; failed refreshes retain
 * the last valid snapshot so a transient Bridge restart does not flicker UI. */
export function useExecutablePluginActions(
  refreshIntervalMs = 2_000,
): CustomActionDefinition[] {
  const [actions, setActions] = useState<CustomActionDefinition[]>([]);
  const snapshotRef = useRef("[]");

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await loadExecutablePluginActions(
          globalThis.fetch,
          controller.signal,
        );
        const snapshot = JSON.stringify(next);
        if (active && snapshot !== snapshotRef.current) {
          snapshotRef.current = snapshot;
          setActions(next);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        // Hosted surfaces and a restarting local Kernel may not expose
        // this endpoint. Preserve the last validated snapshot.
      }
    };
    void refresh();
    const interval = globalThis.setInterval(
      () => void refresh(),
      refreshIntervalMs,
    );
    return () => {
      active = false;
      controller?.abort();
      globalThis.clearInterval(interval);
    };
  }, [refreshIntervalMs]);

  return actions;
}
