// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextDocumentReadSurface } from "./TextDocumentReadSurface";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps pending and failed native output read-only and reads only the committed revision", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      revision: {
        id: "observed",
        documentAssetId: "analysis",
        documentKind: "media.analysis.description",
        schemaVersion: 1,
        mutability: "immutable",
        body: {
          digest: `sha256:${"a".repeat(64)}`,
          byteLength: 1,
          contentType: "application/json",
        },
        producer: { kind: "action-run", actionRunId: "analyze" },
        sourceRefs: [],
      },
      body: { result: { text: "Fold the left sleeve" }, modelId: "test-model" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const onClose = vi.fn();
  const props = {
    projectId: "project",
    label: "Video analysis",
    documentKind: "media.analysis.description",
    reference: undefined,
    status: "generating",
    onClose,
  };
  const { rerender } = render(<TextDocumentReadSurface {...props} />);
  expect(screen.getByRole("status").textContent).toContain("Analyzing");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  rerender(<TextDocumentReadSurface {...props} status="failed" />);
  expect(screen.getByRole("alert").textContent).toContain("failed");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  rerender(
    <TextDocumentReadSurface
      {...props}
      status="completed"
      reference={{
        kind: "document",
        documentAssetId: "analysis",
        revisionId: "observed",
      }}
    />,
  );
  expect(await screen.findByText("Fold the left sleeve")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("/documents/analysis/revisions/observed"),
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to Canvas" }));
  expect(onClose).toHaveBeenCalledOnce();
});
