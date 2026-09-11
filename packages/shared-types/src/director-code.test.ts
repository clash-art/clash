import { describe, expect, it } from "vitest";
import { directorCodeDocumentBody } from "./director-code.js";

describe("Director source readback", () => {
  it("keeps source identity pinned instead of accepting the latest Document body", () => {
    const source = {
      kind: "document" as const,
      documentAssetId: "source",
      revisionId: "selected",
    };
    const body = "export default () => <group />";
    const revision = {
      documentAssetId: source.documentAssetId,
      id: source.revisionId,
      documentKind: "text.plain",
      schemaVersion: 1,
    };
    expect(directorCodeDocumentBody(source, { revision, body })).toBe(body);
    expect(() =>
      directorCodeDocumentBody(source, {
        revision: { ...revision, id: "new-head" },
        body,
      }),
    ).toThrow();
    expect(() =>
      directorCodeDocumentBody(source, { revision, body: { text: body } }),
    ).toThrow();
  });
});
