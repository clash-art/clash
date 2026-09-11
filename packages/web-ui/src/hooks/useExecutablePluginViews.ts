import { useEffect, useRef, useState } from "react";
import {
  ExecutablePluginViewDocumentSchema,
  ExecutablePluginViewReferenceSchema,
  type ExecutablePluginViewReference,
  type StoryboardViewState,
} from "@clash/shared-types";

import { runtimeApiUrl } from "../lib/runtimeConfig";

export interface ExecutablePluginViewDefinition extends ExecutablePluginViewReference {
  name: string;
  description?: string;
  presentation: { type: "storyboard" };
  initialState: StoryboardViewState;
}

export async function loadExecutablePluginViews(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<ExecutablePluginViewDefinition[]> {
  const response = await fetchImpl(runtimeApiUrl("/api/v1/plugin-views"), {
    credentials: "include",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Plugin View catalog request failed (${response.status}).`);
  }
  const payload = (await response.json()) as { views?: unknown };
  if (!Array.isArray(payload.views)) {
    throw new Error("Invalid plugin View catalog: views must be an array.");
  }
  return payload.views.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid plugin View catalog entry.");
    }
    const raw = value as Record<string, unknown>;
    const reference = ExecutablePluginViewReferenceSchema.parse({
      pluginId: raw.pluginId,
      definitionId: raw.definitionId,
      version: raw.version,
      schemaHash: raw.schemaHash,
    });
    const document = ExecutablePluginViewDocumentSchema.parse({
      apiVersion: "clash.view/v1",
      kind: "view",
      spec: {
        definitionId: raw.definitionId,
        name: raw.name,
        ...(raw.description === undefined
          ? {}
          : { description: raw.description }),
        presentation: raw.presentation,
        initialState: raw.initialState,
      },
    });
    return { ...reference, ...document.spec };
  });
}

/** Retains the last valid activated View catalog while the local bridge restarts. */
export function useExecutablePluginViews(
  refreshIntervalMs = 2_000,
): ExecutablePluginViewDefinition[] {
  const [views, setViews] = useState<ExecutablePluginViewDefinition[]>([]);
  const snapshotRef = useRef("[]");
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await loadExecutablePluginViews(
          globalThis.fetch,
          controller.signal,
        );
        const snapshot = JSON.stringify(next);
        if (active && snapshot !== snapshotRef.current) {
          snapshotRef.current = snapshot;
          setViews(next);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
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
  return views;
}
