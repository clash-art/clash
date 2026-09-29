// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  advanceProjectGeneratorHead,
  createProjectAsset,
  createProjectGenerator,
  ensureActionRunRequest,
  ensureOutputCommit,
  resolveOutputCommitAssetType,
  type GeneratorRevision,
} from "@clash/shared-types";
import { EditableProjectAssetSurface } from "./AssetWorkspace";
import { mediaContentResult } from "./content.test-fixtures";

const assetProjection = vi.hoisted(() => ({
  current: {
    id: "image-1",
    kind: "image",
    url: "https://media.clash.test/assets/image-1",
    metadata: {},
    lifecycle: { state: "active" },
    status: "ready",
    provenance: {
      kind: "generation",
      model: "nano-banana-2",
      prompt: "A paper city at sunrise",
    },
  } as any,
}));

vi.mock("../../lib/hooks/useAsset", () => ({
  useAsset: () => assetProjection.current,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assetProjection.current = {
    id: "image-1",
    kind: "image",
    url: "https://media.clash.test/assets/image-1",
    metadata: {},
    lifecycle: { state: "active" },
    status: "ready",
    provenance: {
      kind: "generation",
      model: "nano-banana-2",
      prompt: "A paper city at sunrise",
    },
  };
});

describe("EditableProjectAssetSurface", () => {
  it("does not present a truncated empty evidence projection as a complete provenance result", async () => {
    assetProjection.current = { ...assetProjection.current, provenance: undefined };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [], truncated: true, matchMode: "literal-text", countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 0 } })));
    render(<EditableProjectAssetSurface asset={assetProjection.current} projectId="project-1" onApplied={vi.fn()} />);
    expect(await screen.findByText("Some evidence is omitted from this view.")).toBeTruthy();
    expect(screen.queryByText(/No provenance has been recorded/)).toBeNull();
  });
  it("shows recorded external work with its exact command, source links, and timed observations", async () => {
    assetProjection.current = { ...assetProjection.current, kind: "video", provenance: undefined };
    const sourceRefs = [
      { slot: "source", target: { kind: "media", projectAssetId: "original-video" } },
      { slot: "output", target: { kind: "media", projectAssetId: "image-1" } },
    ] as const;
    const producer = { kind: "actor", actor: { kind: "agent" } } as const;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/content")) return Response.json(mediaContentResult("image-1", [
        { field: "content", attachmentId: "trace-link", document: { kind: "document", documentAssetId: "crop-record", revisionId: "recorded" }, documentKind: "media.operation-trace", producer, sourceRefs: [...sourceRefs], text: "Crop original" },
        { field: "content", attachmentId: "analysis-link", document: { kind: "document", documentAssetId: "notes", revisionId: "observed" }, documentKind: "media.observation", producer, sourceRefs: [], text: "Folding a shirt", location: { asset: { kind: "media", projectAssetId: "image-1" }, startMs: 2000, endMs: 8000 } },
      ]));
      return Response.json({ revision: { id: "recorded", documentAssetId: "crop-record", documentKind: "media.operation-trace", schemaVersion: 1, mutability: "immutable", body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer, sourceRefs }, body: { title: "Crop original", detail: "ffmpeg -i original.mp4 -ss 2 -t 6 result.mp4" } });
    }));
    const onOpenAsset = vi.fn();
    render(<EditableProjectAssetSurface asset={assetProjection.current} projectId="project-1" projectAssets={[{ id: "original-video", name: "Original video", kind: "video", metadata: {}, lifecycle: { state: "active" }, status: "ready" }]} onOpenAsset={onOpenAsset} onApplied={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Crop original" }));
    expect(await screen.findByText("ffmpeg -i original.mp4 -ss 2 -t 6 result.mp4")).toBeTruthy();
    expect(screen.queryByText(/No provenance has been recorded/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open source Original video" }));
    expect(onOpenAsset).toHaveBeenCalledWith("original-video");
    expect(screen.getByText("Folding a shirt")).toBeTruthy();
    expect(screen.getByText("00:02–00:08")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview 00:02–00:08" }));
    const video = screen.getByLabelText("image-1") as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(2);
    expect(screen.queryByRole("button", { name: /execute|run command/i })).toBeNull();
  });
  function nativeRender(publishedAssetId = "render-1") {
    const doc = new LoroDoc();
    const definitionRef = {
      pluginId: "clash.remotion",
      definitionId: "timeline",
      version: "0.1.0",
      schemaHash: `sha256:${"a".repeat(64)}`,
    };
    const revision: GeneratorRevision = {
      id: "rendered-revision",
      generatorId: "trailer",
      definitionRef,
      state: {},
      persistentInputRefs: [
        {
          slot: "media",
          itemKey: "clip-1",
          target: { kind: "media", projectAssetId: "source-1" },
        },
      ],
    };
    expect(
      createProjectGenerator(doc, {
        head: { id: "trailer", headRevisionId: revision.id },
        revision,
      }).ok,
    ).toBe(true);
    for (const id of ["source-1", "overlay-1", publishedAssetId]) {
      expect(
        createProjectAsset(doc, {
          id,
          kind: "video",
          source: { kind: "owned", resourceId: `resource:${id}` },
          metadata: {},
          lifecycle: { state: "active" },
        }).ok,
      ).toBe(true);
    }
    expect(
      ensureActionRunRequest(doc, {
        actionRunId: "render-run",
        generatorRevision: {
          generatorId: "trailer",
          generatorRevisionId: revision.id,
        },
        actionId: "render",
        executor: {
          pluginId: definitionRef.pluginId,
          version: definitionRef.version,
          schemaHash: definitionRef.schemaHash,
          exportId: "render-timeline",
        },
        invocationFingerprint: `sha256:${"b".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [
          {
            slot: "overlay",
            target: { kind: "media", projectAssetId: "overlay-1" },
          },
        ],
        outputContract: [
          {
            slot: "render:output",
            assetType: { kind: "media", mediaKind: "video" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      ensureOutputCommit(
        doc,
        {
          actionRunId: "render-run",
          outputSlot: "render:output",
          asset: { kind: "media", projectAssetId: publishedAssetId },
        },
        resolveOutputCommitAssetType,
      ).ok,
    ).toBe(true);
    expect(
      advanceProjectGeneratorHead(doc, {
        generatorId: revision.generatorId,
        expectedHeadRevisionId: revision.id,
        editPolicy: "advance-head",
        revision: {
          ...revision,
          id: "later-revision",
          parentRevisionId: revision.id,
          persistentInputRefs: [],
        },
      }).ok,
    ).toBe(true);
    assetProjection.current = {
      id: "render-1",
      kind: "video",
      metadata: {},
      lifecycle: { state: "active" },
      status: "ready",
      provenance: { kind: "generation", actionRunId: "render-run" },
    };
    return doc;
  }

  it("shows native render provenance and exact frozen inputs after the Timeline head advances", () => {
    const doc = nativeRender();
    const onOpenTimeline = vi.fn();
    const onOpenAsset = vi.fn();
    render(
      <EditableProjectAssetSurface
        asset={assetProjection.current}
        projectId="project-1"
        relationDoc={doc}
        timelines={[
          {
            id: "trailer",
            name: "Trailer",
            owner: { kind: "project" },
            revisionId: "later-revision",
            state: {},
          },
        ]}
        projectAssets={["source-1", "overlay-1"].map((id) => ({
          id,
          name: `${id}.mp4`,
          kind: "video",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        }))}
        onOpenTimeline={onOpenTimeline}
        onOpenAsset={onOpenAsset}
        onApplied={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No provenance has been recorded/)).toBeNull();
    expect(screen.getByText("clash.remotion")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open origin Timeline Trailer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open source asset source-1.mp4" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open source asset overlay-1.mp4" }),
    );
    expect(onOpenTimeline).toHaveBeenCalledWith("trailer");
    expect(onOpenAsset.mock.calls).toEqual([["source-1"], ["overlay-1"]]);
  });

  it.each(["unavailable", "another-output"])(
    "does not invent or deny recorded provenance when its Run is %s",
    (caseName) => {
      const doc = nativeRender("another-output");
      render(
        <EditableProjectAssetSurface
          asset={assetProjection.current}
          projectId="project-1"
          relationDoc={caseName === "unavailable" ? new LoroDoc() : doc}
          onApplied={vi.fn()}
        />,
      );
      expect(screen.queryByText(/No provenance has been recorded/)).toBeNull();
      expect(screen.queryByText("clash.remotion")).toBeNull();
      expect(screen.queryByRole("button", { name: /Open origin/ })).toBeNull();
    },
  );

  it("is the cohesive asset preview/edit entry point outside ProjectEditor", () => {
    render(
      <EditableProjectAssetSurface
        asset={{
          id: "image-1",
          kind: "image",
          url: "https://media.clash.test/assets/image-1",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        }}
        projectId="project-1"
        onApplied={vi.fn()}
      />,
    );

    expect(screen.getByRole("main", { name: "image-1 preview" })).toBeTruthy();
  });

  it("does not offer a manual project cover control", () => {
    render(
      <EditableProjectAssetSurface
        asset={{
          id: "image-1",
          kind: "image",
          url: "https://media.clash.test/assets/image-1",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        }}
        projectId="project-1"
        onApplied={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Use as project cover" }),
    ).toBeNull();
  });

  it("renders a docked provenance rail with navigable Canvas, Timeline, source, and prompt relations", () => {
    const onOpenCanvas = vi.fn();
    const onOpenTimeline = vi.fn();
    const onOpenAsset = vi.fn();
    render(
      <EditableProjectAssetSurface
        asset={{
          id: "image-1",
          kind: "image",
          url: "https://media.clash.test/assets/image-1",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        }}
        projectId="project-1"
        projectAssets={[
          {
            id: "source-1",
            name: "source.png",
            kind: "image",
            url: "https://media.clash.test/assets/source-1",
            metadata: {},
            lifecycle: { state: "active" },
            status: "ready",
          },
        ]}
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[
          {
            id: "trailer",
            name: "Trailer",
            owner: { kind: "project" },
            revisionId: "revision-1",
            state: {
              tracks: [{ items: [{ id: "shot-1", assetId: "image-1" }] }],
            },
          },
        ]}
        relationNodes={[
          {
            id: "generator",
            canvasId: "main",
            type: "action-badge",
            data: {
              prompt: "A paper city at sunrise",
              referenceImageAssetIds: ["source-1"],
            },
          },
          {
            id: "output",
            canvasId: "main",
            type: "image",
            data: { assetId: "image-1" },
          },
        ]}
        relationEdges={[
          { canvasId: "main", source: "generator", target: "output" },
        ]}
        relationBindings={[
          {
            id: "generation-output",
            owner: {
              kind: "run",
              actionId: "node:generator",
              actionRevisionId: "revision-1",
              actionRunId: "run-1",
            },
            direction: "output",
            slot: "output",
            projectAssetId: "image-1",
          },
          {
            id: "generation-input",
            owner: {
              kind: "run",
              actionId: "node:generator",
              actionRevisionId: "revision-1",
              actionRunId: "run-1",
            },
            direction: "input",
            slot: "reference:0",
            projectAssetId: "source-1",
            role: "reference",
          },
          {
            id: "timeline-input",
            owner: { kind: "draft", actionId: "timeline:trailer" },
            direction: "input",
            slot: "timeline:item:shot-1",
            projectAssetId: "image-1",
          },
        ]}
        onOpenCanvas={onOpenCanvas}
        onOpenTimeline={onOpenTimeline}
        onOpenAsset={onOpenAsset}
        onApplied={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "Asset relations" }),
    ).toBeTruthy();
    expect(screen.getByText("A paper city at sunrise")).toBeTruthy();
    expect(screen.getByText("nano-banana-2")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open origin Canvas Main" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Timeline Trailer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open source asset source.png" }),
    );

    expect(onOpenCanvas).toHaveBeenCalledWith("main", "output");
    expect(onOpenTimeline).toHaveBeenCalledWith("trailer");
    expect(onOpenAsset).toHaveBeenCalledWith("source-1");
  });

  it("uses a fresh Host projection for preview and disables byte-dependent actions while unavailable", () => {
    assetProjection.current = {
      id: "image-1",
      kind: "image",
      metadata: { originalName: "remote.png" },
      lifecycle: { state: "active" },
      status: "downloading",
      progress: 0.3,
    };

    render(
      <EditableProjectAssetSurface
        asset={{
          id: "image-1",
          kind: "image",
          url: "https://stale.example/remote.png",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        }}
        projectId="project-1"
        onApplied={vi.fn()}
      />,
    );

    expect(screen.getByText("Downloading 30%")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "remote.png" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use as project cover" }),
    ).toBeNull();
  });
});
