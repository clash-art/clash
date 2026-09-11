import { describe, expect, it } from "vitest";
import {
  canonicalizeTimelineItemScopeRefs,
  selectTimelineMediaInputs,
} from "./timelineMediaInputs";

describe("selectTimelineMediaInputs", () => {
  const lifecycle = { state: "active" as const };
  const assets = [
    {
      id: "asset-connected",
      name: "Opening frame",
      url: "https://media.clash.test/assets/connected",
      kind: "image" as const,
      lifecycle,
      metadata: {},
      status: "ready" as const,
    },
    {
      id: "asset-unconnected",
      url: "https://media.clash.test/assets/unconnected",
      kind: "image" as const,
      lifecycle,
      metadata: {},
      status: "ready" as const,
    },
    {
      id: "asset-used",
      url: "https://media.clash.test/assets/used",
      kind: "video" as const,
      lifecycle,
      metadata: {},
      status: "ready" as const,
    },
  ];
  const nodes = [
    {
      id: "source-connected",
      canvasId: "main",
      type: "image",
      data: { assetId: "asset-connected", label: "Opening frame" },
    },
    {
      id: "source-unconnected",
      canvasId: "main",
      type: "image",
      data: { assetId: "asset-unconnected", label: "Not wired" },
    },
    {
      id: "source-used",
      canvasId: "main",
      type: "video",
      data: { assetId: "asset-used" },
    },
  ];

  it("admits wired sources and already-used clips, but not the whole Project asset pool", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-1",
        name: "Cut",
        owner: {
          kind: "canvas-action",
          canvasId: "main",
          actionNodeId: "timeline-action",
        },
        revisionId: "rev",
        state: {
          tracks: [
            {
              items: [
                {
                  id: "clip-used",
                  sourceNodeId: "source-used",
                  assetId: "asset-used",
                  type: "video",
                },
              ],
            },
          ],
        },
      },
      assets,
      nodes,
      edges: [
        {
          canvasId: "main",
          source: "source-connected",
          target: "timeline-action",
        },
      ],
    });

    expect(result.map((asset) => asset.sourceNodeId)).toEqual([
      "source-connected",
      "source-used",
    ]);
    expect(result[0]).toMatchObject({
      displayName: "Opening frame",
      projectAssetId: "asset-connected",
    });
    expect(
      result.some((asset) => asset.sourceNodeId === "source-unconnected"),
    ).toBe(false);
    expect(result.map((asset) => asset.displayName)).not.toContain(
      "projects/private/connected.png",
    );
  });

  it("does not expose Project assets to a standalone empty Timeline", () => {
    expect(
      selectTimelineMediaInputs({
        timeline: {
          id: "timeline-2",
          name: "Empty",
          owner: { kind: "project" },
          revisionId: "rev",
          state: { tracks: [] },
        },
        assets,
          nodes,
        edges: [],
      }),
    ).toEqual([]);
  });

  it("uses media identities from the native Timeline projection", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-authority",
        name: "Authority",
        owner: { kind: "project" },
        revisionId: "rev",
        state: {
          tracks: [
            {
              id: "track-1",
              items: [
                {
                  id: "clip-1",
                  sourceNodeId: "source-used",
                  assetId: "asset-used",
                  type: "video",
                },
              ],
            },
          ],
        },
      },
      assets,
      nodes,
      edges: [],
    });

    expect(result).toEqual([
      expect.objectContaining({
        sourceNodeId: "source-used",
        projectAssetId: "asset-used",
        type: "video",
      }),
    ]);
  });

  it("reads native Timeline media without Canvas nodes or draft bindings", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-standalone",
        name: "Standalone",
        owner: { kind: "project" },
        revisionId: "rev",
        state: {
          tracks: [
            {
              id: "video",
              items: [
                { id: "clip-used", assetId: "asset-used", type: "video" },
              ],
            },
          ],
        },
      },
      assets,
      nodes,
      edges: [],
    });
    expect(result).toEqual([
      expect.objectContaining({
        sourceNodeId: "timeline-asset:asset-used",
        projectAssetId: "asset-used",
        type: "video",
      }),
    ]);
  });

  it("uses the playable storage source instead of a video cover preview", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-video",
        name: "Video",
        owner: { kind: "project" },
        revisionId: "rev",
        state: {
          tracks: [
            {
              id: "video",
              items: [
                { id: "clip-video", assetId: "asset-video", type: "video" },
              ],
            },
          ],
        },
      },
      assets: [
        {
          id: "asset-video",
          name: "Talking head",
          url: "https://media.clash.test/assets/asset-video",
          thumbnailUrl: "https://media.clash.test/thumbnails/asset-video",
          kind: "video",
          lifecycle,
          metadata: {},
          status: "ready",
        },
      ],
      nodes: [],
      edges: [],
    });

    expect(result[0]?.src).toBe("https://media.clash.test/assets/asset-video");
  });

  it("keeps one canonical Timeline reference when a sidebar drop points at the same Project asset", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-standalone-dropped",
        name: "Standalone drop",
        owner: { kind: "project" },
        revisionId: "rev",
        state: {
          tracks: [
            {
              id: "track-1",
              name: "Video",
              items: [
                {
                  id: "clip-1",
                  sourceNodeId: "asset-used-project-ref",
                  assetId: "asset-used",
                  type: "video",
                  from: 48,
                  durationInFrames: 90,
                },
              ],
            },
          ],
        },
      },
      assets,
      nodes,
      edges: [],
    });

    expect(result).toEqual([
      expect.objectContaining({
        sourceNodeId: "asset-used-project-ref",
        projectAssetId: "asset-used",
      }),
    ]);
  });

  it("prefers the connected Canvas placement over the Project sidebar identity for the same asset", () => {
    const result = selectTimelineMediaInputs({
      timeline: {
        id: "timeline-canvas-dropped",
        name: "Canvas drop",
        owner: {
          kind: "canvas-action",
          canvasId: "main",
          actionNodeId: "timeline-action",
        },
        revisionId: "rev",
        state: {
          tracks: [
            {
              id: "track-1",
              name: "Image",
              items: [
                {
                  id: "clip-1",
                  sourceNodeId: "asset-connected-project-ref",
                  assetId: "asset-connected",
                  type: "image",
                  from: 73,
                  durationInFrames: 90,
                },
              ],
            },
          ],
        },
      },
      assets,
      nodes,
      edges: [
        {
          canvasId: "main",
          source: "source-connected",
          target: "timeline-action",
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        sourceNodeId: "source-connected",
        projectAssetId: "asset-connected",
      }),
    ]);
  });

  it("rewrites only the scope identity and preserves the native cursor frame", () => {
    const tracks = [
      {
        id: "track-1",
        name: "Image",
        items: [
          {
            id: "clip-1",
            sourceNodeId: "asset-connected-project-ref",
            assetId: "asset-connected",
            type: "image" as const,
            from: 73,
            durationInFrames: 90,
          },
        ],
      },
    ];

    expect(
      canonicalizeTimelineItemScopeRefs(tracks, [
        {
          sourceNodeId: "source-connected",
          projectAssetId: "asset-connected",
          type: "image",
          src: "/connected.png",
        },
      ]),
    ).toEqual([
      {
        ...tracks[0],
        items: [
          {
            ...tracks[0].items[0],
            sourceNodeId: "source-connected",
            from: 73,
          },
        ],
      },
    ]);
  });
});
