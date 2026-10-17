import { createHash } from "node:crypto";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActionAssetBinding,
  projectAssetMutationReadTokenFromDoc,
  readProjectAsset,
  type Resource,
} from "@clash/shared-types";
import {
  commitProjectAssetImport,
  observeProjectAsset,
  parseProjectAssetBatchIds,
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
});
