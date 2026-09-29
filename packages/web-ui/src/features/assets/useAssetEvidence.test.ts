// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAssetEvidence } from "./useAssetEvidence";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("preserves Host truncation and clears it when the active query changes or closes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      return Response.json({
        items: [],
        truncated: query === "shirt",
        countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 0 },
        matchMode: "literal-text",
      });
    }),
  );
  const { result, rerender } = renderHook(
    ({ query, enabled }) =>
      useAssetEvidence({ projectId: "project-1", query, enabled }),
    { initialProps: { query: "shirt", enabled: true } },
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.truncated).toBe(true);
  rerender({ query: "left sleeve", enabled: true });
  expect(result.current.loading).toBe(true);
  expect(result.current.truncated).toBe(false);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.truncated).toBe(false);
  rerender({ query: "shirt", enabled: true });
  await waitFor(() => expect(result.current.truncated).toBe(true));
  rerender({ query: "shirt", enabled: false });
  expect(result.current.truncated).toBe(false);
});
