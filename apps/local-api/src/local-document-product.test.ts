import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  readDocumentAttachment,
  readDocumentAssetRevision,
  readProjectDocumentAsset,
} from "@clash/shared-types";

import { createLocalDocumentProductService } from "./local-document-product.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clash-document-product-"));
  temporaryDirectories.push(directory);
  return directory;
}

function authority(doc: LoroDoc) {
  return {
    inspect: async <T>(
      _projectId: string,
      read: (candidate: LoroDoc) => T | Promise<T>,
    ) => read(doc),
    mutate: async <T>(
      _projectId: string,
      mutation: (
        candidate: LoroDoc,
        checkpoint: () => Promise<void>,
      ) => T | Promise<T>,
    ) => mutation(doc, async () => undefined),
  };
}

function description(text: string) {
  return {
    schemaVersion: 1 as const,
    kind: "media.description" as const,
    text,
    sourceHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

describe("Local Typed Document product service", () => {
  it("creates, reads, and CAS-advances a versioned Document without mutating old revisions", async () => {
    const doc = new LoroDoc();
    const service = createLocalDocumentProductService({
      dataDir: await dataDir(),
      authority: authority(doc),
      producer: { kind: "actor", actor: { kind: "agent", id: "codex" } },
    });

    const created = await service.create("project-1", {
      documentAssetId: "description-1",
      revisionId: "description-1:r1",
      documentKind: "media.description",
      schemaVersion: 1,
      body: description("A lighthouse at dusk."),
      sourceRefs: [],
    });
    expect(created).toMatchObject({
      changed: true,
      asset: {
        id: "description-1",
        headRevisionId: "description-1:r1",
        mutability: "versioned",
      },
      revision: {
        producer: { kind: "actor", actor: { kind: "agent", id: "codex" } },
        body: { contentType: "application/json" },
      },
    });
    await expect(
      service.read("project-1", "description-1"),
    ).resolves.toMatchObject({
      revision: { id: "description-1:r1" },
      body: { text: "A lighthouse at dusk." },
    });

    const advanced = await service.advance("project-1", {
      documentAssetId: "description-1",
      expectedHeadRevisionId: "description-1:r1",
      revisionId: "description-1:r2",
      body: description("A red lighthouse at blue hour."),
      sourceRefs: [],
    });
    expect(advanced).toMatchObject({
      changed: true,
      asset: { headRevisionId: "description-1:r2" },
      revision: {
        id: "description-1:r2",
        parentRevisionId: "description-1:r1",
      },
    });
    expect(
      readDocumentAssetRevision(doc, {
        documentAssetId: "description-1",
        revisionId: "description-1:r1",
      }),
    ).not.toBeNull();
    await expect(
      service.readRevision("project-1", {
        documentAssetId: "description-1",
        revisionId: "description-1:r1",
      }),
    ).resolves.toMatchObject({ body: { text: "A lighthouse at dusk." } });
    await expect(service.list("project-1")).resolves.toMatchObject([
      { id: "description-1", headRevisionId: "description-1:r2" },
    ]);
    await expect(
      service.listRevisions("project-1", "description-1"),
    ).resolves.toMatchObject([
      { id: "description-1:r1" },
      { id: "description-1:r2" },
    ]);
  });

  it("validates the declared body schema and leaves no authority fact on failure", async () => {
    const doc = new LoroDoc();
    const service = createLocalDocumentProductService({
      dataDir: await dataDir(),
      authority: authority(doc),
      producer: { kind: "actor", actor: { kind: "user", id: "user-1" } },
    });

    await expect(
      service.create("project-1", {
        documentAssetId: "bad-description",
        revisionId: "bad-description:r1",
        documentKind: "media.description",
        schemaVersion: 1,
        body: { text: "missing identity fields" },
        sourceRefs: [],
      }),
    ).rejects.toThrow(/schemaVersion|kind|sourceHash/i);
    expect(readProjectDocumentAsset(doc, "bad-description")).toBeNull();
  });

  it("rejects a dangling exact source reference before creating Document authority", async () => {
    const doc = new LoroDoc();
    const service = createLocalDocumentProductService({
      dataDir: await dataDir(),
      authority: authority(doc),
      producer: { kind: "actor", actor: { kind: "agent" } },
    });

    await expect(
      service.create("project-1", {
        documentAssetId: "description-with-source",
        revisionId: "description-with-source:r1",
        documentKind: "media.description",
        schemaVersion: 1,
        body: description("A missing image."),
        sourceRefs: [
          {
            slot: "source",
            target: { kind: "media", projectAssetId: "missing-image" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_NOT_FOUND" });
    expect(readProjectDocumentAsset(doc, "description-with-source")).toBeNull();
  });

  it("rejects stale edits without inserting an orphan revision", async () => {
    const doc = new LoroDoc();
    const service = createLocalDocumentProductService({
      dataDir: await dataDir(),
      authority: authority(doc),
      producer: { kind: "actor", actor: { kind: "user" } },
    });
    await service.create("project-1", {
      documentAssetId: "description-1",
      revisionId: "description-1:r1",
      documentKind: "media.description",
      schemaVersion: 1,
      body: description("First."),
      sourceRefs: [],
    });

    await expect(
      service.advance("project-1", {
        documentAssetId: "description-1",
        expectedHeadRevisionId: "stale",
        revisionId: "description-1:orphan",
        body: description("Stale edit."),
        sourceRefs: [],
      }),
    ).rejects.toMatchObject({ code: "STALE_DOCUMENT_HEAD" });
    expect(
      readDocumentAssetRevision(doc, {
        documentAssetId: "description-1",
        revisionId: "description-1:orphan",
      }),
    ).toBeNull();
  });

  it("creates an attachment only through the same target and kind policy authority", async () => {
    const doc = new LoroDoc();
    createProjectAsset(doc, {
      id: "image-1",
      kind: "image",
      source: { kind: "owned", resourceId: "resource-image-1" },
      lifecycle: { state: "active" },
      metadata: { width: 1, height: 1, contentType: "image/png" },
    });
    const service = createLocalDocumentProductService({
      dataDir: await dataDir(),
      authority: authority(doc),
      producer: { kind: "actor", actor: { kind: "agent" } },
    });
    await service.create("project-1", {
      documentAssetId: "description-1",
      revisionId: "description-1:r1",
      documentKind: "media.description",
      schemaVersion: 1,
      body: description("An image."),
      sourceRefs: [],
    });

    await expect(
      service.attach("project-1", {
        id: "image-description",
        target: { kind: "project-asset", projectAssetId: "image-1" },
        slot: "description",
        document: {
          kind: "document",
          documentAssetId: "description-1",
          revisionId: "description-1:r1",
        },
      }),
    ).resolves.toMatchObject({ changed: true });
    expect(readDocumentAttachment(doc, "image-description")).toMatchObject({
      target: { projectAssetId: "image-1" },
      document: { revisionId: "description-1:r1" },
    });
  });
});

it("copies an exact Document revision with fork lineage and leaves source history intact", async () => {
  const doc = new LoroDoc();
  const service = createLocalDocumentProductService({
    dataDir: await dataDir(),
    authority: authority(doc),
    producer: { kind: "actor", actor: { kind: "user", id: "editor" } },
  });
  const created = await service.create("project", {
    documentAssetId: "source",
    revisionId: "source-r1",
    documentKind: "media.description",
    schemaVersion: 1,
    body: description("Original"),
    sourceRefs: [],
  });
  await service.advance("project", {
    documentAssetId: "source",
    expectedHeadRevisionId: created.revision.id,
    revisionId: "source-r2",
    body: description("Later head"),
    sourceRefs: [],
  });
  const copied = await service.copy("project", {
    sourceDocumentAssetId: "source",
    sourceRevisionId: "source-r1",
    documentAssetId: "copy",
    revisionId: "copy-r1",
    body: description("Independent edit"),
  });
  expect(copied.revision).toMatchObject({
    forkedFrom: {
      kind: "document",
      documentAssetId: "source",
      revisionId: "source-r1",
    },
    producer: { kind: "actor", actor: { id: "editor" } },
    sourceRefs: [],
  });
  expect((await service.read("project", "source"))!.body).toMatchObject({
    text: "Later head",
  });
  expect(
    (await service.readRevision("project", {
      documentAssetId: "source",
      revisionId: "source-r1",
    }))!.body,
  ).toMatchObject({ text: "Original" });
  expect((await service.read("project", "copy"))!.body).toMatchObject({
    text: "Independent edit",
  });
  doc.free();
});
