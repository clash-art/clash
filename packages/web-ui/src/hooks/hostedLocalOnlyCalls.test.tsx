// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeProjectAssetProjection } from "../lib/liveProjectAssets";
import { setRuntimeConfigOverride } from "../lib/runtimeConfig";
import { useExecutablePluginActions } from "./useExecutablePluginActions";
import { useExecutablePluginViews } from "./useExecutablePluginViews";
import { useHostTimelines } from "./useHostTimelines";

// Issue #94: hosted Web answers every Host-only contract with 404. The project
// page polled and retried them anyway, so it never reached network idle.
const notFound = () =>
  Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));

function requestedPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    ([input]) => new URL(String(input), "http://clash.test").pathname,
  );
}

async function mountProjectPageHostReaders(): Promise<() => void> {
  const doc = new LoroDoc();
  const stopAssets = subscribeProjectAssetProjection({
    doc,
    projectId: "project-1",
    onProjection: () => {},
  });
  renderHook(() => {
    useExecutablePluginActions(2_000, "project-1");
    useExecutablePluginViews(2_000, "project-1");
    useHostTimelines({ projectId: "project-1", doc, connected: true });
  });
  // Long enough for several catalog polls and Asset projection retries.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  return stopAssets;
}

describe("Host-only project reads on hosted Web", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(notFound);
    vi.stubGlobal("fetch", fetchMock);
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    cleanup();
    setRuntimeConfigOverride(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("issues and retries none of them without a local Host", async () => {
    setRuntimeConfigOverride({ mode: "hosted" });
    stop = await mountProjectPageHostReaders();
    expect(requestedPaths(fetchMock)).toEqual([]);
  });

  it("still reads every one of them from a local Host", async () => {
    setRuntimeConfigOverride({ mode: "local" });
    stop = await mountProjectPageHostReaders();
    const paths = new Set(requestedPaths(fetchMock));
    expect(paths).toContain("/api/v1/projects/project-1/assets");
    expect(paths).toContain("/api/v1/plugin-actions");
    expect(paths).toContain("/api/v1/plugin-views");
    expect(paths).toContain("/api/v1/projects/project-1/host-command");
  });
});
