import { describe, expect, it } from "vitest";
import type { TextAppliedRevision } from "@clash/shared-types";
import {
  indexTextRevision,
  listTextRevisionHistory,
  readTextRevisionContent,
  textRevisionContentHash,
  textRevisionLimit,
  type TextRevisionPorts,
} from "./text-revisions.js";

function memoryPorts(owned = new Set(["p1", "p2"])) {
  const rows = new Map<string, TextAppliedRevision>();
  const blobs = new Map<string, string>();
  const ports: TextRevisionPorts = {
    canAccessProject: async (id) => owned.has(id),
    store: {
      get: async (p, r) => rows.get(`${p}/${r}`) ?? null,
      put: async (rev) => void rows.set(`${rev.projectId}/${rev.revisionId}`, rev),
      list: async ({ projectId, nodeId, limit }) =>
        [...rows.values()]
          .filter((r) => r.projectId === projectId && (!nodeId || r.nodeId === nodeId))
          .sort((a, b) =>
            a.createdAt === b.createdAt
              ? b.revisionId.localeCompare(a.revisionId)
              : b.createdAt.localeCompare(a.createdAt),
          )
          .slice(0, limit),
    },
    blobs: {
      read: async (p, h) => blobs.get(`${p}/${h}`) ?? null,
      has: async (p, h) => blobs.has(`${p}/${h}`),
      write: async (p, h, c) => void blobs.set(`${p}/${h}`, c),
    },
  };
  return { ports, rows, blobs };
}

function revision(content: string, over: Partial<TextAppliedRevision> = {}): TextAppliedRevision {
  const hash = textRevisionContentHash(content);
  return {
    schemaVersion: 1,
    kind: "clash.text.revision",
    textId: "text-1",
    revisionId: "rev-1",
    projectId: "p1",
    nodeId: "node-1",
    createdAt: "2026-10-17T00:00:00.000Z",
    contentHash: hash,
    hashAlgorithm: "sha256-64",
    sourceFilePath: "notes/a.md",
    sourceFileHash: hash,
    ...over,
  } as TextAppliedRevision;
}

describe("text revisions (shared module)", () => {
  it("indexes, lists newest first with a content descriptor, and reads verified content", async () => {
    const { ports } = memoryPorts();
    const r1 = revision("# one\n");
    const r2 = revision("# two\n", { revisionId: "rev-2", parentRevisionId: "rev-1", createdAt: "2026-10-17T00:01:00.000Z" });
    expect((await indexTextRevision({ revision: r1, content: "# one\n" }, ports)).status).toBe(200);
    const second = await indexTextRevision({ revision: r2, content: "# two\n" }, ports);
    expect(second.status).toBe(200);
    expect((second.body as any).content).toMatchObject({ stored: true, url: "/api/v1/projects/p1/text-revisions/rev-2/content" });
    const listed = await listTextRevisionHistory({ projectId: "p1", nodeId: "node-1" }, ports);
    expect((listed.body as any).revisions.map((r: any) => r.revisionId)).toEqual(["rev-2", "rev-1"]);
    expect((listed.body as any).revisions[0].content.stored).toBe(true);
    const read = await readTextRevisionContent({ projectId: "p1", revisionId: "rev-1" }, ports);
    expect(read).toMatchObject({ status: 200, content: "# one\n" });
  });

  it("is idempotent for identical input and 409s on different metadata or content", async () => {
    const { ports } = memoryPorts();
    const r1 = revision("a");
    await indexTextRevision({ revision: r1, content: "a" }, ports);
    expect((await indexTextRevision({ revision: r1, content: "a" }, ports)).status).toBe(200);
    expect((await indexTextRevision({ revision: { ...r1, textId: "other" } }, ports)).status).toBe(409);
  });

  it("rejects invalid revisions, hash mismatches and unsafe paths with 400", async () => {
    const { ports } = memoryPorts();
    expect((await indexTextRevision({ revision: { nope: 1 } }, ports)).status).toBe(400);
    expect((await indexTextRevision({ revision: revision("a"), content: "b" }, ports)).status).toBe(400);
    expect((await indexTextRevision({ revision: revision("a", { sourceFilePath: "../x.md" }) }, ports)).status).toBe(400);
    expect((await indexTextRevision({ revision: revision("a", { sourceFileHash: "0".repeat(16) }) }, ports)).status).toBe(400);
  });

  it("hides other Projects: 404 for foreign projects, no cross-project blob reads", async () => {
    const { ports } = memoryPorts();
    await indexTextRevision({ revision: revision("secret"), content: "secret" }, ports);
    expect((await indexTextRevision({ revision: revision("x", { projectId: "foreign" }) }, ports)).status).toBe(404);
    expect((await listTextRevisionHistory({ projectId: "foreign" }, ports)).status).toBe(404);
    // A metadata-only revision in p2 naming p1's hash must not expose p1's body.
    await indexTextRevision({ revision: revision("secret", { projectId: "p2" }) }, ports);
    expect((await readTextRevisionContent({ projectId: "p2", revisionId: "rev-1" }, ports)).status).toBe(404);
    expect((await readTextRevisionContent({ projectId: "p1", revisionId: "missing" }, ports)).status).toBe(404);
  });

  it("409s on a corrupted blob and clamps the list limit", async () => {
    const { ports, blobs } = memoryPorts();
    const r1 = revision("a");
    await indexTextRevision({ revision: r1, content: "a" }, ports);
    blobs.set(`p1/${r1.contentHash}`, "tampered");
    expect((await readTextRevisionContent({ projectId: "p1", revisionId: "rev-1" }, ports)).status).toBe(409);
    expect([textRevisionLimit(undefined), textRevisionLimit(0), textRevisionLimit(999), textRevisionLimit(7.9)]).toEqual([50, 1, 200, 7]);
  });
});

describe("text revisions: concurrent index", () => {
  it("409s when a concurrent writer inserted different metadata first", async () => {
    const { ports, rows } = memoryPorts();
    const r1 = revision("a");
    const racing: TextRevisionPorts = {
      ...ports,
      store: {
        ...ports.store,
        get: async (p, r) => {
          const value = await ports.store.get(p, r);
          return value;
        },
        put: async (rev) => {
          // The other writer lands between our read and our insert-if-absent.
          if (!rows.has(`${rev.projectId}/${rev.revisionId}`))
            rows.set(`${rev.projectId}/${rev.revisionId}`, { ...rev, textId: "winner" });
        },
      },
    };
    expect((await indexTextRevision({ revision: r1 }, racing)).status).toBe(409);
  });
});
