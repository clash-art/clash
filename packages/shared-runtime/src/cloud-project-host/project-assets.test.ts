import { createHash } from "node:crypto";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActionAssetBinding,
  projectAssetMutationReadTokenFromDoc,
  readProjectAsset,
  agentReadReceiptToken,
  markActionAssetBindingAuthority,
  unbindActionAssetBinding,
  type Resource,
} from "@clash/shared-types";
import {
  commitProjectAssetImport,
  applyProjectAssetLifecycle,
  observeProjectAsset,
  parseProjectAssetBatchIds,
  parseProjectAssetDeleteOperationId,
  projectProjectAsset,
  selectProjectAssets,
  type ProjectAssetImportCommand,
} from "./project-assets.js";

const resource = (
  id: string,
  bytes: string,
  contentType = "video/mp4",
): Resource => ({
  id,
  kind: "video",
  digest: {
    algorithm: "sha256",
    value: createHash("sha256").update(bytes).digest("hex"),
  },
  byteLength: bytes.length,
  contentType,
});

describe("cloud Project Asset document logic", () => {
  let doc: LoroDoc;
  const resources = new Map<string, Resource>();
  beforeEach(() => {
    doc = new LoroDoc();
    resources.clear();
  });
  afterEach(() => doc.free());

  const importAsset = async (
    projectAssetId: string,
    staged: Resource,
    extra: Partial<ProjectAssetImportCommand> = {},
  ) => {
    const result = await commitProjectAssetImport(
      doc,
      {
        projectId: "p",
        projectAssetId,
        resource: staged,
        name: "clip.mp4",
        metadata: { bytes: staged.byteLength, originalName: "clip.mp4" },
        createdAt: 1,
        ...extra,
      },
      { readResource: (id) => resources.get(id) ?? null },
    );
    if (result.ok && result.created) resources.set(staged.id, staged);
    return result;
  };

  it("imports once and treats a re-import of the same media as idempotent", async () => {
    const first = await importAsset("asset:a", resource("r1", "bytes"));
    expect(first).toMatchObject({
      ok: true,
      created: true,
      entry: { id: "asset:a", kind: "video", source: { kind: "owned", resourceId: "r1" } },
    });
    // Adapters may stage a new Resource row per upload; identity is the media digest.
    const again = await importAsset("asset:a", resource("r2", "bytes"));
    expect(again).toMatchObject({ ok: true, created: false, entry: { source: { resourceId: "r1" } } });
    for (const different of [
      resource("r3", "other bytes"),
      resource("r4", "bytes", "video/webm"),
    ])
      expect(await importAsset("asset:a", different)).toEqual({
        ok: false,
        status: 409,
        body: { error: "Asset ID already identifies different immutable media" },
      });
    expect(readProjectAsset(doc, "asset:a")?.source.resourceId).toBe("r1");
  });

  it("records an upload as an import unless the caller names the provenance", async () => {
    await importAsset("asset:upload", resource("r1", "upload"));
    const provenance = { kind: "render" as const, actionRunId: "run" };
    await importAsset("asset:render", resource("r2", "render"), { provenance });
    expect(readProjectAsset(doc, "asset:upload")?.provenance).toEqual({
      kind: "import",
    });
    expect(readProjectAsset(doc, "asset:render")?.provenance).toEqual(
      provenance,
    );
  });

  it("rejects duplicate content only when the client asks to", async () => {
    await importAsset("asset:a", resource("r1", "bytes"));
    const rejected = await importAsset("asset:b", resource("r2", "bytes"), {
      duplicateContent: "reject",
    });
    expect(rejected).toMatchObject({
      ok: false,
      status: 409,
      body: {
        code: "PROJECT_ASSET_DUPLICATE_CONTENT",
        projectAssetId: "asset:b",
        existingProjectAssetIds: ["asset:a"],
      },
    });
    expect(readProjectAsset(doc, "asset:b")).toBeNull();
    expect(
      await importAsset("asset:b", resource("r2", "bytes"), {
        duplicateContent: "allow",
      }),
    ).toMatchObject({ ok: true, created: true });
  });

  it("selects listed and requested entries, skipping unknown ids", async () => {
    await importAsset("asset:a", resource("r1", "a"));
    await importAsset("asset:b", resource("r2", "b"));
    expect(selectProjectAssets(doc, "p").map((entry) => entry.id)).toEqual([
      "asset:a",
      "asset:b",
    ]);
    expect(
      selectProjectAssets(doc, "p", ["asset:b", "missing"]).map((e) => e.id),
    ).toEqual(["asset:b"]);
    expect(parseProjectAssetBatchIds({ ids: ["asset:a"] })).toEqual(["asset:a"]);
    for (const invalid of [null, {}, { ids: "a" }, { ids: [""] }, { ids: [1] }])
      expect(parseProjectAssetBatchIds(invalid)).toBeNull();
    expect(
      parseProjectAssetBatchIds({ ids: Array.from({ length: 1001 }, (_, i) => `a${i}`) }),
    ).toBeNull();
  });

  it("observes an Asset with its references and mutation read token", async () => {
    await importAsset("asset:a", resource("r1", "a"));
    expect(observeProjectAsset(doc, "p", "missing")).toBeNull();
    const before = observeProjectAsset(doc, "p", "asset:a");
    expect(before).toMatchObject({ entry: { id: "asset:a" }, references: [] });
    expect(before?.version).toBe(
      projectAssetMutationReadTokenFromDoc(doc, "p", "asset:a"),
    );
    const bound = createActionAssetBinding(doc, {
      id: "binding",
      owner: { kind: "draft", actionId: "action" },
      direction: "input",
      slot: "image",
      projectAssetId: "asset:a",
    });
    expect(bound.ok).toBe(true);
    const after = observeProjectAsset(doc, "p", "asset:a");
    expect(after?.references.map((reference) => reference.id)).toEqual(["binding"]);
    expect(after?.version).not.toBe(before?.version);
  });

  it("projects ready media through the adapter URL and unavailable bytes as unavailable", async () => {
    const staged = resource("r1", "a");
    await importAsset("asset:a", staged);
    const entry = readProjectAsset(doc, "asset:a")!;
    const ports = (available: boolean) => ({
      readResource: async (_projectId: string, id: string) => resources.get(id) ?? null,
      available: async () => available,
      mediaUrl: ({ entry }: { entry: { id: string } }) =>
        `https://media.test/${encodeURIComponent(entry.id)}`,
    });
    expect(
      await projectProjectAsset(ports(true), { projectId: "p", entry }),
    ).toMatchObject({
      id: "asset:a",
      status: "ready",
      url: "https://media.test/asset%3Aa",
    });
    const unavailable = await projectProjectAsset(ports(false), {
      projectId: "p",
      entry,
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.url).toBeUndefined();
  });

  describe("trash and restore (soft delete)", () => {
    const sign = (version: string) => `sig-${version.slice(-16)}`;
    const ports = {
      verifyReceipt: (version: string, receipt: string) =>
        receipt === sign(version),
    };
    const trash = (
      expectedReadToken: string | undefined,
      deleteOperationId = "op-1",
      actorClientType = "browser",
    ) =>
      applyProjectAssetLifecycle(
        doc,
        {
          action: "trash",
          projectId: "p",
          projectAssetId: "asset:a",
          deleteOperationId,
          deletedAt: "2026-10-17T00:00:00.000Z",
          purgeAfter: "2026-11-16T00:00:00.000Z",
          observation: {
            actorClientType,
            ...(expectedReadToken ? { expectedReadToken } : {}),
          },
        },
        ports,
      );
    const restore = (expectedReadToken?: string, actorClientType = "browser") =>
      applyProjectAssetLifecycle(
        doc,
        {
          action: "restore",
          projectId: "p",
          projectAssetId: "asset:a",
          observation: {
            actorClientType,
            ...(expectedReadToken ? { expectedReadToken } : {}),
          },
        },
        ports,
      );
    const observed = () => observeProjectAsset(doc, "p", "asset:a")!.version;

    it("trashes with a tombstone, keeps the entry listed, retries idempotently, and restores", async () => {
      await importAsset("asset:a", resource("r1", "a"));
      const token = observed();
      const trashed = trash(token);
      expect(trashed).toMatchObject({
        ok: true,
        mutated: true,
        entry: {
          lifecycle: {
            state: "trashed",
            deleteOperationId: "op-1",
            deletedAt: "2026-10-17T00:00:00.000Z",
            purgeAfter: "2026-11-16T00:00:00.000Z",
          },
        },
      });
      // The list is the trash view; bytes and the Resource are untouched.
      expect(selectProjectAssets(doc, "p")).toMatchObject([
        { id: "asset:a", lifecycle: { state: "trashed" }, source: { resourceId: "r1" } },
      ]);
      // A retry of the same operation (even with the old token) is a no-op.
      expect(trash(token)).toMatchObject({ ok: true, mutated: false });
      // Another operation working from the pre-delete read is stale.
      expect(trash(token, "op-2")).toMatchObject({ ok: false, status: 409, body: { code: "STALE_READ" } });
      const restored = restore(observed());
      expect(restored).toMatchObject({ ok: true, mutated: true, entry: { lifecycle: { state: "active" } } });
      expect(readProjectAsset(doc, "asset:a")?.lifecycle).toEqual({ state: "active" });
      expect(restore(observed())).toMatchObject({ ok: true, mutated: false });
    });

    it("refuses stale reads, unknown Assets, and agents without a valid receipt", async () => {
      await importAsset("asset:a", resource("r1", "a"));
      const before = observed();
      createActionAssetBinding(doc, {
        id: "in",
        owner: { kind: "draft", actionId: "action" },
        direction: "input",
        slot: "image",
        projectAssetId: "asset:a",
      });
      expect(trash(before)).toMatchObject({ ok: false, status: 409, body: { code: "STALE_READ" } });
      expect(unbindActionAssetBinding(doc, "in").ok).toBe(true);
      expect(
        applyProjectAssetLifecycle(
          doc,
          { action: "restore", projectId: "p", projectAssetId: "missing", observation: {} },
          ports,
        ),
      ).toMatchObject({ ok: false, status: 404, body: { code: "PROJECT_ASSET_NOT_FOUND" } });
      const current = observed();
      expect(trash(current, "op-1", "agent")).toMatchObject({ ok: false, status: 409, body: { code: "READ_REQUIRED" } });
      expect(
        trash(agentReadReceiptToken({ readToken: current, receipt: "forged" }), "op-1", "agent"),
      ).toMatchObject({ ok: false, status: 409, body: { code: "INVALID_READ_PROOF" } });
      expect(
        trash(agentReadReceiptToken({ readToken: current, receipt: sign(current) }), "op-1", "agent"),
      ).toMatchObject({ ok: true, mutated: true });
    });

    it("refuses an Asset still used as an Action input, materializing legacy references first", async () => {
      await importAsset("asset:a", resource("r1", "a"));
      markActionAssetBindingAuthority(doc);
      createActionAssetBinding(doc, {
        id: "in",
        owner: { kind: "draft", actionId: "action" },
        direction: "input",
        slot: "image",
        projectAssetId: "asset:a",
      });
      expect(trash(observed())).toMatchObject({
        ok: false,
        status: 409,
        body: { code: "ASSET_IN_USE", references: [{ id: "in" }] },
      });
      expect(readProjectAsset(doc, "asset:a")?.lifecycle.state).toBe("active");
    });

    it("marks binding authority on a document that never ran the local cutover", async () => {
      await importAsset("asset:a", resource("r1", "a"));
      expect(trash(observed())).toMatchObject({ ok: true, mutated: true });
    });

    it("validates the delete operation id", () => {
      expect(parseProjectAssetDeleteOperationId({ deleteOperationId: " op " })).toBe("op");
      for (const invalid of [null, {}, { deleteOperationId: "" }, { deleteOperationId: 1 }, { deleteOperationId: "x".repeat(513) }])
        expect(parseProjectAssetDeleteOperationId(invalid)).toBeNull();
    });
  });
});
