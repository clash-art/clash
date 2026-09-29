// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { ProjectProvider } from "../ProjectContext";
import ImageNode from "./ImageNode";
import VideoNode from "./VideoNode";

const reactFlowMock = vi.hoisted(() => ({
  setNodes: vi.fn(),
  getEdges: vi.fn(() => [] as Array<{source: string; target: string}>),
  asset: undefined as {metadata: {width: number; height: number}} | undefined,
}));

vi.mock("@xyflow/react", () => ({
  Handle: ({ type, position, ...props }: any) => (
    <div data-testid={`handle-${type}-${position}`} {...props} />
  ),
  Position: {
    Left: "left",
    Right: "right",
  },
  useReactFlow: () => ({
    setNodes: reactFlowMock.setNodes,
    getEdges: reactFlowMock.getEdges,
  }),
}));

vi.mock("./SourceHandleMenu", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="source-handle-menu" data-node-id={nodeId} />
  ),
}));

vi.mock("./DraftPlaceholder", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="draft-placeholder" data-node-id={nodeId} />
  ),
}));

vi.mock("../MediaViewerContext", () => ({
  useMediaViewer: () => ({
    openViewer: vi.fn(),
  }),
}));

vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => null,
}));

vi.mock("../PresenceAwarenessContext", () => ({
  usePeersSelectingNode: () => [],
}));

vi.mock("./PeerSelectionRing", () => ({
  default: () => null,
}));

vi.mock("./AttributionLine", () => ({
  default: () => null,
}));

vi.mock("@clash/web-ui/lib/hooks/useAsset", () => ({
  useAsset: () => reactFlowMock.asset,
  invalidateAsset: vi.fn(),
}));

vi.mock("@clash/web-ui/lib/runtimeConfig", () => ({
  runtimeApiUrl: (path: string) => path,
}));

const baseNodeProps = {
  selected: false,
  dragging: false,
  draggable: true,
  selectable: true,
  deletable: true,
  zIndex: 1,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

describe("media node sizing", () => {
  beforeEach(() => {
    reactFlowMock.setNodes.mockReset();
    reactFlowMock.getEdges.mockReturnValue([]);
    reactFlowMock.asset = undefined;
  });

  it.each([ImageNode, VideoNode])("does not rewrite the geometry of a referenced media node", (MediaNode) => {
    reactFlowMock.getEdges.mockReturnValue([{source: "reference", target: "generator"}]);
    reactFlowMock.asset = {metadata: {width: 1024, height: 512}};
    render(
      <ProjectProvider projectId="project-test" initialModelCatalog={[]}>
        <MediaNode {...baseNodeProps} id="reference" type="image" width={400} height={400}
          data={{assetId: "asset", status: "completed", customActionParams: {aspect_ratio: "2:1"}}} />
      </ProjectProvider>,
    );
    expect(reactFlowMock.setNodes).not.toHaveBeenCalled();
  });

  it("repairs an existing custom image node from its saved aspect-ratio parameter", async () => {
    render(
      <ProjectProvider projectId="project-test" initialModelCatalog={[]}>
        <ImageNode
          {...baseNodeProps}
          id="legacy-custom-image"
          type="image"
          width={400}
          height={400}
          data={{
            actionType: "custom:codex-imagegen",
            customActionParams: { aspect_ratio: "21:9" },
            label: "A cat",
            status: "pending",
          }}
        />
      </ProjectProvider>,
    );

    await waitFor(() => expect(reactFlowMock.setNodes).toHaveBeenCalled());
    const update = reactFlowMock.setNodes.mock.calls[0][0];
    const [repaired] = update([
      {
        id: "legacy-custom-image",
        data: {},
        width: 400,
        height: 400,
        style: { width: 400, height: 400 },
      },
    ]);

    expect(repaired.data.aspectRatio).toBe("21:9");
    expect(repaired.width / repaired.height).toBeCloseTo(21 / 9, 2);
  });

  it("renders image nodes from node props width and height without subscribing to all nodes", () => {
    const { container } = render(
      <ProjectProvider projectId="project-test" initialModelCatalog={[]}>
        <ImageNode
          {...baseNodeProps}
          id="image-1"
          type="image"
          width={260}
          height={190}
          data={{
            label: "Preview image",
            status: "completed",
            previewUrl:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          }}
        />
      </ProjectProvider>,
    );

    const card = container.querySelector(
      ".bg-warm-surface",
    ) as HTMLElement | null;
    expect(card?.style.width).toBe("260px");
    expect(card?.style.height).toBe("190px");
  });

  it("renders video nodes from node props width and height without subscribing to all nodes", () => {
    const { container } = render(
      <ProjectProvider projectId="project-test" initialModelCatalog={[]}>
        <VideoNode
          {...baseNodeProps}
          id="video-1"
          type="video"
          width={320}
          height={180}
          data={{
            label: "Preview video",
            status: "completed",
            previewUrl: "data:video/mp4;base64,",
          }}
        />
      </ProjectProvider>,
    );

    const card = container.querySelector(
      ".bg-warm-surface",
    ) as HTMLElement | null;
    expect(card?.style.width).toBe("320px");
    expect(card?.style.height).toBe("180px");
  });
});
