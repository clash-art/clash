// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextDocumentNode } from "./TextDocumentNode";
import TextNode from "./TextNode";
import { TextNodeEditorProvider } from "../TextNodeEditorContext";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

vi.mock("@xyflow/react", () => ({
  Handle: ({ type }: { type: string }) => <div data-testid={`${type}-handle`} />,
  Position: { Left: "left", Right: "right" },
}));
vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => ({ projectId: "project" }),
}));
vi.mock("../../hooks/useTextDocumentRevision", () => ({
  useTextDocumentRevision: () => ({ body: "Saved Document body" }),
}));
vi.mock("../../hooks/useRevisionHistory", () => ({
  useRevisionHistory: () => ({ count: 0, revisions: [] }),
}));
vi.mock("./SourceHandleMenu", () => ({ default: () => null }));
vi.mock("./RevisionHistoryBadge", () => ({ RevisionHistoryBadge: () => null }));

it("retains the existing editor for historical plain Canvas text", () => {
  const onOpenNode = vi.fn();
  render(<TextNodeEditorProvider onOpenNode={onOpenNode}><TextNode {...{ id: "old-text", data: { content: "Old classroom notes" } } as any} /></TextNodeEditorProvider>);
  expect(screen.getByText("Old classroom notes")).toBeTruthy();
  fireEvent.doubleClick(screen.getByTestId("text-node-drag-surface"));
  expect(onOpenNode).toHaveBeenCalledWith("old-text");
});

it("reads typed analysis output from its pinned Document instead of a text shadow", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: {
    id: "observed", documentAssetId: "analysis", documentKind: "media.analysis.description", schemaVersion: 1, mutability: "immutable",
    body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "action-run", actionRunId: "analyze" }, sourceRefs: [],
  }, body: { result: { text: "Folding a shirt carefully" }, modelId: "test-model" } })));
  render(<TextDocumentNode {...({ id: "analysis-output", data: { label: "Video analysis", documentKind: "media.analysis.description", status: "completed", documentRevision: { kind: "document", documentAssetId: "analysis", revisionId: "observed" }, content: "Do not show this shadow" } } as any)} />);
  expect(await screen.findByText("Folding a shirt carefully")).toBeTruthy();
  expect(screen.queryByText("Do not show this shadow")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read analysis" }));
  expect(within(screen.getByRole("dialog", { name: "Video analysis" })).queryByRole("textbox")).toBeNull();
});

it("routes pending and failed Canvas outputs to the typed reader without inventing text or loading a missing Document", () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const props = { id: "analysis-output", data: { documentKind: "media.analysis.tags", status: "generating", actionRunId: "analysis-run" } };
  const { rerender } = render(<TextNode {...props as any} />);
  expect(screen.getByRole("status").textContent).toContain("Analyzing");
  rerender(<TextNode {...{ ...props, data: { ...props.data, status: "failed" } } as any} />);
  expect(screen.getByRole("alert").textContent).toContain("failed");
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByText("Hello World")).toBeNull();
});

it("opens the exact saved body in a reader without displaying a legacy content shadow", () => {
  render(
    <TextDocumentNode
      {...({
        id: "result",
        data: {
          label: "Generated script",
          content: "Stale Canvas text",
          documentRevision: {
            kind: "document",
            documentAssetId: "script",
            revisionId: "pinned",
          },
        },
      } as any)}
    />,
  );
  expect(screen.getByTestId("source-handle")).toBeTruthy();
  expect(screen.queryByText("Stale Canvas text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read text" }));
  const dialog = screen.getByRole("dialog", { name: "Generated script" });
  expect(within(dialog).getByText("Saved Document body")).toBeTruthy();
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
