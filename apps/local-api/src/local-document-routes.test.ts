import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import { closeLocalSqliteClient } from "./local-sqlite-connection.js";
import {
  createProjectAsset,
  readDocumentAssetRevision,
} from "@clash/shared-types";

import { createLocalApiApp } from "./app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await closeLocalSqliteClient();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clash-document-routes-"));
  temporaryDirectories.push(directory);
  return directory;
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

function documentAuthority(doc: LoroDoc) {
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

describe("Local Typed Document routes", () => {
  it("creates, reads, and CAS-advances declared Documents with Host-derived actor provenance", async () => {
    const doc = new LoroDoc();
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      userId: "local-user",
      documentProjectAuthority: documentAuthority(doc),
    } as Parameters<typeof createLocalApiApp>[0]);
    const collection = "/api/v1/projects/project-1/documents";
    const createBody = {
      documentAssetId: "description-1",
      revisionId: "description-1:r1",
      documentKind: "media.description",
      schemaVersion: 1,
      body: description("A lighthouse at dusk."),
      sourceRefs: [],
    };

    const spoofedProducer = await app.request(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody,
        producer: { kind: "migration", source: "spoofed" },
      }),
    });
    expect(spoofedProducer.status).toBe(400);

    const created = await app.request(collection, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clash-client-type": "agent",
      },
      body: JSON.stringify(createBody),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      asset: { id: "description-1", headRevisionId: "description-1:r1" },
      revision: {
        id: "description-1:r1",
        producer: { kind: "actor", actor: { kind: "agent" } },
      },
      body: { text: "A lighthouse at dusk." },
    });

    const listed = await app.request(collection);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      documents: Array<Record<string, unknown>>;
    };
    expect(listedBody.documents).toEqual([
      expect.objectContaining({
        id: "description-1",
        headRevisionId: "description-1:r1",
        documentKind: "media.description",
      }),
    ]);
    expect(listedBody.documents[0]).not.toHaveProperty("body");

    const history = await app.request(`${collection}/description-1/revisions`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      revisions: Array<Record<string, unknown>>;
    };
    expect(historyBody.revisions).toEqual([
      expect.objectContaining({
        id: "description-1:r1",
        documentAssetId: "description-1",
        body: expect.objectContaining({
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          contentType: "application/json",
        }),
      }),
    ]);
    expect(JSON.stringify(historyBody)).not.toContain("A lighthouse at dusk.");

    const read = await app.request(`${collection}/description-1`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      revision: { id: "description-1:r1" },
      body: { text: "A lighthouse at dusk." },
    });
    const oldRevision = await app.request(
      `${collection}/description-1/revisions/description-1%3Ar1`,
    );
    expect(oldRevision.status).toBe(200);
    await expect(oldRevision.json()).resolves.toMatchObject({
      revision: { id: "description-1:r1" },
      body: { text: "A lighthouse at dusk." },
    });

    const advanced = await app.request(
      `${collection}/description-1/revisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedHeadRevisionId: "description-1:r1",
          revisionId: "description-1:r2",
          body: description("A red lighthouse at blue hour."),
          sourceRefs: [],
        }),
      },
    );
    expect(advanced.status, await advanced.clone().text()).toBe(201);
    await expect(advanced.json()).resolves.toMatchObject({
      asset: { headRevisionId: "description-1:r2" },
      revision: {
        id: "description-1:r2",
        parentRevisionId: "description-1:r1",
        producer: {
          kind: "actor",
          actor: { kind: "user", id: "local-user" },
        },
      },
    });
    expect(
      readDocumentAssetRevision(doc, {
        documentAssetId: "description-1",
        revisionId: "description-1:r1",
      }),
    ).not.toBeNull();
  });

  it("creates and CAS-advances a typed attachment to an exact Document revision", async () => {
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "image-1",
        kind: "image",
        source: { kind: "owned", resourceId: "resource:image-1" },
        lifecycle: { state: "active" },
        metadata: { width: 1, height: 1, contentType: "image/png" },
      }),
    ).toMatchObject({ ok: true });
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      documentProjectAuthority: documentAuthority(doc),
    } as Parameters<typeof createLocalApiApp>[0]);
    const documents = "/api/v1/projects/project-1/documents";
    const attachments = "/api/v1/projects/project-1/document-attachments";
    expect(
      (
        await app.request(documents, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            documentAssetId: "description-1",
            revisionId: "description-1:r1",
            documentKind: "media.description",
            schemaVersion: 1,
            body: description("First description."),
            sourceRefs: [],
          }),
        })
      ).status,
    ).toBe(201);
    const attached = await app.request(attachments, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "image-description",
        target: { kind: "project-asset", projectAssetId: "image-1" },
        slot: "description",
        document: {
          kind: "document",
          documentAssetId: "description-1",
          revisionId: "description-1:r1",
        },
      }),
    });
    expect(attached.status, await attached.clone().text()).toBe(201);

    expect(
      (
        await app.request(`${documents}/description-1/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedHeadRevisionId: "description-1:r1",
            revisionId: "description-1:r2",
            body: description("Second description."),
            sourceRefs: [],
          }),
        })
      ).status,
    ).toBe(201);
    const advanced = await app.request(
      `${attachments}/image-description/revisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevisionId: "description-1:r1",
          document: {
            kind: "document",
            documentAssetId: "description-1",
            revisionId: "description-1:r2",
          },
        }),
      },
    );
    expect(advanced.status, await advanced.clone().text()).toBe(200);
    await expect(advanced.json()).resolves.toMatchObject({
      attachment: {
        id: "image-description",
        document: { revisionId: "description-1:r2" },
      },
    });
  });
});
