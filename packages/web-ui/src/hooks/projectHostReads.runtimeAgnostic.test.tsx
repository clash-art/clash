// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeProjectAssetProjection } from "../lib/liveProjectAssets";
import { setRuntimeConfigOverride } from "../lib/runtimeConfig";
import { useExecutablePluginActions } from "./useExecutablePluginActions";
import { useExecutablePluginViews } from "./useExecutablePluginViews";
import { useHostTimelines } from "./useHostTimelines";

// Issue #94 / #98: hosted Web used to be gated out of every Project Host read
// with a UI-level runtime-mode check, which masked the missing cloud adapter.
// The UI must issue the same Project Host reads on every runtime and leave
// backend differences to the adapter; failures must back off, not flood.
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

const PROJECT_HOST_READS = [
  "/api/v1/projects/project-1/assets",
  "/api/v1/plugin-actions",
  "/api/v1/plugin-views",
  "/api/v1/projects/project-1/host-command",
];

describe("Project Host reads are runtime-agnostic", () => {
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

  it.each(["hosted", "local", "desktop"] as const)(
    "issues the same Project Host reads on the %s runtime",
    async (mode) => {
      setRuntimeConfigOverride({ mode });
      stop = await mountProjectPageHostReaders();
      const paths = new Set(requestedPaths(fetchMock));
      for (const path of PROJECT_HOST_READS) expect(paths).toContain(path);
    },
  );

  it("backs off failing Asset projection reads instead of flooding", async () => {
    setRuntimeConfigOverride({ mode: "hosted" });
    stop = await mountProjectPageHostReaders();
    const assetReads = requestedPaths(fetchMock).filter(
      (path) => path === "/api/v1/projects/project-1/assets",
    );
    expect(assetReads.length).toBeGreaterThan(0);
    expect(assetReads.length).toBeLessThanOrEqual(6);
  });
});
