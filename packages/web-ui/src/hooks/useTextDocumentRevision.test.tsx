// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useTextDocumentRevision } from "./useTextDocumentRevision";

const reference = {
  kind: "document" as const,
  documentAssetId: "script",
  revisionId: "old",
};
function response(id: string, body: string) {
  return Response.json({
    revision: {
      id,
      documentAssetId: "script",
      documentKind: "text.plain",
      schemaVersion: 1,
      mutability: "versioned",
      body: {
        digest: `sha256:${"a".repeat(64)}`,
        byteLength: 1,
        contentType: "application/json",
      },
      producer: { kind: "actor", actor: { kind: "user" } },
      sourceRefs: [],
    },
    body,
  });
}

it("keeps old responses from replacing a newly selected Document revision", async () => {
  let finishOld!: (value: Response) => void;
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    return path.endsWith("/old")
      ? new Promise<Response>((resolve) => {
          finishOld = resolve;
        })
      : response("new", "New script");
  };
  const { result, rerender } = renderHook(
    ({ revisionId }) =>
      useTextDocumentRevision("project", { ...reference, revisionId }, request),
    { initialProps: { revisionId: "old" } },
  );
  rerender({ revisionId: "new" });
  await waitFor(() => expect(result.current.body).toBe("New script"));
  await act(async () => {
    finishOld(response("old", "Old script"));
  });
  expect(result.current.body).toBe("New script");
  expect(paths).toEqual([
    "/api/v1/projects/project/documents/script/revisions/old",
    "/api/v1/projects/project/documents/script/revisions/new",
  ]);
});

it("rejects a body returned for a different revision instead of displaying it", async () => {
  const request = async () => response("wrong", "Do not display");
  const { result } = renderHook(() =>
    useTextDocumentRevision("project", reference, request),
  );
  await waitFor(() => expect(result.current.error).toMatch(/revision/i));
  expect(result.current.body).toBeUndefined();
});
