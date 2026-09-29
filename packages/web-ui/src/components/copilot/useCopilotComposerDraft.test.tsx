// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeCopilotAssetComposerValue } from "./projectAssetReferences";
import {
  useCopilotComposerDraft,
  type CopilotAssetReferenceRequest,
} from "./useCopilotComposerDraft";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const reference: CopilotAssetReferenceRequest = {
  id: "request",
  projectId: "p",
  threadId: "thread",
  asset: { projectAssetId: "asset/portrait", kind: "image", label: "Portrait" },
};

it("appends to the unsent draft once across strict effects and persists through remount", () => {
  const onConsumed = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ requests }) =>
      useCopilotComposerDraft({
        projectId: "p",
        threadId: "thread",
        requests,
        onConsumed,
      }),
    {
      initialProps: { requests: [] as CopilotAssetReferenceRequest[] },
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    },
  );
  act(() => result.current.setInput("Please compare"));
  rerender({ requests: [reference] });
  expect(result.current.input).toContain("Please compare");
  const normalized = normalizeCopilotAssetComposerValue(result.current.input, [
    {
      id: reference.asset.projectAssetId,
      type: "image",
      kind: "asset",
      label: "Portrait",
    },
  ]);
  expect(normalized.assets).toEqual([reference.asset]);
  expect(result.current.input.match(/project-asset:/g)).toHaveLength(1);
  expect(onConsumed).toHaveBeenCalledExactlyOnceWith(["request"]);
  unmount();
  const restored = renderHook(() =>
    useCopilotComposerDraft({ projectId: "p", threadId: "thread" }),
  );
  expect(restored.result.current.input.trim()).toBe(normalized.text);
});

it("queues references for their own project and thread, preserving the other draft", () => {
  const onConsumed = vi.fn();
  const { result, rerender } = renderHook(
    ({ projectId, threadId }) =>
      useCopilotComposerDraft({
        projectId,
        threadId,
        requests: [reference],
        onConsumed,
      }),
    { initialProps: { projectId: "other", threadId: "thread" } },
  );
  act(() => result.current.setInput("Other project draft"));
  expect(onConsumed).not.toHaveBeenCalled();
  rerender({ projectId: "p", threadId: "other-thread" });
  expect(result.current.input).toBe("");
  expect(onConsumed).not.toHaveBeenCalled();
  rerender({ projectId: "p", threadId: "thread" });
  expect(result.current.input).toContain("project-asset:asset%2Fportrait");
  rerender({ projectId: "other", threadId: "thread" });
  expect(result.current.input).toBe("Other project draft");
});
