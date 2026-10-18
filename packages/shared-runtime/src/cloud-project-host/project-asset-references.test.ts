import { describe, expect, it } from "vitest";
import type { ProjectAssetEntry, Resource } from "@clash/shared-types";

import {
  createProjectAssetReferenceResolver,
  resolveTimelineMediaReferences,
  type ProjectAssetReferencePorts,
} from "./project-asset-references.js";

const resource = { id: "res-1", kind: "video", contentType: "video/mp4" } as Resource;

function entry(id: string, state: "active" | "trashed" = "active") {
  return {
    id,
    kind: "video",
    source: { resourceId: resource.id },
    lifecycle: { state },
    metadata: { width: 64, height: 48 },
  } as unknown as ProjectAssetEntry;
}

function resolver(
  entries: Record<string, ProjectAssetEntry>,
  committed: Partial<ProjectAssetReferencePorts> = {},
) {
  const signed: string[] = [];
  const references = createProjectAssetReferenceResolver({
    readAsset: async ({ assetId }) => entries[assetId],
    readCommittedResource: async () => resource,
    async sign({ target }) {
      signed.push(target.assetId);
      return {
        url: `https://media.test/${target.projectId}/${target.assetId}?sig=x`,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
    ...committed,
  });
  return { references, signed };
}

describe("ProjectAssetReferenceResolver", () => {
  it("signs only an active Asset whose Resource is committed", async () => {
    const { references, signed } = resolver({
      clip: entry("clip"),
      binned: entry("binned", "trashed"),
    });
    await expect(references.resolve({ projectId: "p", assetId: "clip" })).resolves.toMatchObject({
      ok: true,
      reference: {
        assetId: "clip",
        kind: "video",
        url: "https://media.test/p/clip?sig=x",
        contentType: resource.contentType,
        width: 64,
        height: 48,
      },
    });
    await expect(references.resolve({ projectId: "p", assetId: "gone" })).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
    await expect(references.resolve({ projectId: "p", assetId: "binned" })).resolves.toEqual({
      ok: false,
      reason: "trashed",
    });
    expect(signed).toEqual(["clip"]);
  });

  it("never signs an Asset whose bytes are not committed", async () => {
    const { references, signed } = resolver(
      { clip: entry("clip") },
      { readCommittedResource: async () => null },
    );
    await expect(references.resolve({ projectId: "p", assetId: "clip" })).resolves.toEqual({
      ok: false,
      reason: "uncommitted",
    });
    expect(signed).toEqual([]);
  });
});

describe("resolveTimelineMediaReferences", () => {
  const timeline = (items: Array<Record<string, unknown>>) => ({
    fps: 30,
    tracks: [
      { id: "media", items },
      { id: "titles", items: [{ id: "title", type: "text", text: "Hi" }] },
    ],
  });
  const assetIdOf = (item: Record<string, unknown>) =>
    typeof item.assetId === "string" ? item.assetId : undefined;

  it("gives each media item its Asset's signed src and leaves other items alone", async () => {
    const { references } = resolver({ clip: entry("clip") });
    const input = timeline([{ id: "clip", type: "video", assetId: "clip", src: "stale" }]);
    const resolved = await resolveTimelineMediaReferences(input, {
      projectId: "p",
      references,
      assetIdOf,
      decorate: (_item, reference) => ({ naturalWidth: reference.width }),
    });
    expect(resolved).toEqual({
      fps: 30,
      tracks: [
        {
          id: "media",
          items: [
            {
              id: "clip",
              type: "video",
              assetId: "clip",
              src: "https://media.test/p/clip?sig=x",
              naturalWidth: 64,
            },
          ],
        },
        input.tracks[1],
      ],
    });
  });

  it("fails reference_unavailable, naming the item and Asset, instead of rendering a clip without src", async () => {
    const { references } = resolver({ binned: entry("binned", "trashed") });
    const failure = await resolveTimelineMediaReferences(
      timeline([{ id: "clip", type: "video", assetId: "binned" }]),
      { projectId: "p", references, assetIdOf },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      failure: { code: "reference_unavailable", retryable: false },
    });
    expect((failure as Error).message).toContain("media:clip");
    expect((failure as Error).message).toContain("binned");
  });

  it("fails a media item with neither an Asset nor an absolute src, and keeps an absolute one", async () => {
    const { references } = resolver({});
    await expect(
      resolveTimelineMediaReferences(timeline([{ id: "clip", type: "audio" }]), {
        projectId: "p",
        references,
        assetIdOf,
      }),
    ).rejects.toMatchObject({ failure: { code: "invalid_request" } });
    const external = timeline([
      { id: "clip", type: "image", src: "https://cdn.example.com/still.png" },
    ]);
    await expect(
      resolveTimelineMediaReferences(external, { projectId: "p", references, assetIdOf }),
    ).resolves.toEqual(external);
  });
});
