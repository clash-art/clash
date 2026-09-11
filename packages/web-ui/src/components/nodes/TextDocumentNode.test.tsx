// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TextDocumentNode } from "./TextDocumentNode";

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
