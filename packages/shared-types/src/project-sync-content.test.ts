import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createProjectAsset } from "./project-assets.js";
import {
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
  readDocumentAssetRevision,
  advanceProjectDocumentAssetHead,
} from "./project-document-assets.js";
import { projectSyncContent } from "./project-sync-content.js";

it("enumerates immutable media and historical Document byte references from Project authority", () => {
  const doc = new LoroDoc();
  try {
    expect(
      createProjectAsset(doc, {
        id: "media",
        kind: "image",
        source: { kind: "owned", resourceId: "immutable-resource" },
        lifecycle: { state: "active" },
        metadata: {},
      }).ok,
    ).toBe(true);
    markDocumentAssetAuthority(doc);
    const body = {
      digest: `sha256:${"a".repeat(64)}`,
      byteLength: 10,
      contentType: "application/json" as const,
    };
    expect(
      createProjectDocumentAsset(doc, {
        id: "revision",
        documentAssetId: "document",
        documentKind: "media.transcript",
        schemaVersion: 1,
        mutability: "versioned",
        body,
        producer: { kind: "actor", actor: { kind: "user", id: "owner" } },
        sourceRefs: [],
      }).ok,
    ).toBe(true);
    const original = readDocumentAssetRevision(doc, {
      documentAssetId: "document",
      revisionId: "revision",
    })!;
    const nextBody = { ...body, digest: `sha256:${"b".repeat(64)}` };
    expect(
      advanceProjectDocumentAssetHead(doc, {
        documentAssetId: "document",
        expectedHeadRevisionId: "revision",
        revision: {
          ...original,
          id: "next-revision",
          parentRevisionId: "revision",
          body: nextBody,
        },
      }).ok,
    ).toBe(true);
    expect(projectSyncContent(doc).documents).toContainEqual(nextBody);
    expect(projectSyncContent(doc).resources).toContainEqual({
      resourceId: "immutable-resource",
      kind: "image",
    });
    expect(projectSyncContent(doc).documents).toContainEqual(body);
  } finally {
    doc.free();
  }
});

it("rejects conflicting media kinds for one immutable Resource identity", () => {
  const doc = new LoroDoc();
  try {
    for (const kind of ["image", "video"] as const)
      createProjectAsset(doc, {
        id: kind,
        kind,
        source: { kind: "owned", resourceId: "same-resource" },
        lifecycle: { state: "active" },
        metadata: {},
      });
    expect(() => projectSyncContent(doc)).toThrow(/conflicting/i);
  } finally {
    doc.free();
  }
});
