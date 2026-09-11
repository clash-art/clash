// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDirectorCodeSources } from "./useDirectorCodeSources";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const component = (revisionId: string) => [
  {
    id: "prop",
    name: "Prop",
    source: {
      kind: "document" as const,
      documentAssetId: "source",
      revisionId,
    },
  },
];
const response = (id: string, body: string) =>
  Response.json({
    revision: {
      id,
      documentAssetId: "source",
      documentKind: "text.plain",
      schemaVersion: 1,
    },
    body,
  });

it("gates the viewport while loading and discards a response from the previously selected revision", async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.endsWith("/old")
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : response("new", "export default () => <group />"),
    ),
  );
  const { result, rerender } = renderHook(
    ({ revision }) => useDirectorCodeSources("project", component(revision)),
    { initialProps: { revision: "old" } },
  );
  expect(result.current.ready).toBe(false);
  rerender({ revision: "new" });
  await waitFor(() => expect(result.current.ready).toBe(true));
  const selected = result.current.sources;
  await act(async () =>
    resolveOld(response("old", "export default () => <mesh />")),
  );
  expect(result.current.sources).toBe(selected);
});

it("keeps an incorrect Document response out of the viewport", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response("different", "export default () => <group />")),
  );
  const { result } = renderHook(() =>
    useDirectorCodeSources("project", component("pinned")),
  );
  await waitFor(() => expect(result.current.error).toMatch(/exact/));
  expect(result.current.ready).toBe(false);
  expect(result.current.sources).toBeUndefined();
});
