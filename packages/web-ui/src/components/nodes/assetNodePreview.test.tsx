// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AudioNode from "./AudioNode";
import ImageNode from "./ImageNode";
import VideoNode from "./VideoNode";

const openAssetPreview = vi.fn();
const assetProjection = vi.hoisted(() => ({
  enabled: true,
  status: "ready" as
    "uploading" | "ready" | "downloading" | "unavailable" | "failed",
}));
const loroConnection = vi.hoisted(() => ({ connected: true }));

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  useReactFlow: () => ({ setNodes: vi.fn() }),
}));

vi.mock("./SourceHandleMenu", () => ({ default: () => null }));
vi.mock("./DraftPlaceholder", () => ({ default: () => null }));
vi.mock("./AttributionLine", () => ({ default: () => null }));
vi.mock("./PeerSelectionRing", () => ({ default: () => null }));
vi.mock("../PresenceAwarenessContext", () => ({
  usePeersSelectingNode: () => [],
}));
vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => loroConnection,
}));
vi.mock("../MediaViewerContext", () => ({
  useMediaViewer: () => ({
    openViewer: vi.fn(),
    openAssetPreview,
  }),
}));
vi.mock("../ProjectContext", () => ({
  useProject: () => ({ projectId: "project-1" }),
}));
vi.mock("@clash/web-ui/lib/hooks/useAsset", () => ({
  useAsset: (_projectId: string, assetId?: string) =>
    assetProjection.enabled && assetId
      ? {
          id: assetId,
          kind: assetId.includes("audio")
            ? "audio"
            : assetId.includes("video")
              ? "video"
              : "image",
          status: assetProjection.status,
          metadata: {},
          url: `https://media.clash.test/${assetId}`,
        }
      : undefined,
  invalidateAsset: vi.fn(),
}));
vi.mock("@clash/web-ui/lib/runtimeConfig", () => ({
  runtimeApiUrl: (path: string) => path,
}));
vi.mock("./NodeModalDialog", () => ({
  NodeModalDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Audio Player" /> : null,
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

afterEach(() => {
  cleanup();
  openAssetPreview.mockClear();
  assetProjection.enabled = true;
  assetProjection.status = "ready";
  loroConnection.connected = true;
});

describe("asset node preview navigation", () => {
  it.each([
    ["image", ImageNode],
    ["video", VideoNode],
    ["audio", AudioNode],
  ] as const)(
    "explains that a pending %s node is waiting for the Project Host while Loro is disconnected",
    (kind, Component) => {
      loroConnection.connected = false;

      const { unmount } = render(
        <Component
          {...baseNodeProps}
          id={`${kind}-pending-node`}
          type={kind}
          width={320}
          height={180}
          data={{
            label: `Pending ${kind}`,
            status: "pending",
          }}
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "Waiting for connection",
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Starts automatically after reconnection",
      );
      expect(screen.queryByText(/Generating/i)).toBeNull();
      unmount();
    },
  );

  it.each([
    ["image", ImageNode, "Generating image asset", "Building image"],
    ["video", VideoNode, "Generating video asset", "Building video"],
  ] as const)(
    "announces active %s generation as an asset-building status",
    (kind, Component, accessibleName, visibleLabel) => {
      render(
        <Component
          {...baseNodeProps}
          id={`${kind}-generating-node`}
          type={kind}
          width={320}
          height={180}
          data={{
            label: `Generating ${kind}`,
            status: "pending",
          }}
        />,
      );

      expect(
        screen.getByRole("status", { name: accessibleName }),
      ).toHaveTextContent(visibleLabel);
    },
  );

  it.each([
    ["image", ImageNode, "Generating image asset"],
    ["video", VideoNode, "Generating video asset"],
  ] as const)(
    "renders dedicated %s generation motion without shared artwork",
    (kind, Component, accessibleName) => {
      render(
        <Component
          {...baseNodeProps}
          id={`${kind}-reference-generation-node`}
          type={kind}
          width={320}
          height={180}
          data={{
            label: `Generating ${kind}`,
            status: "pending",
          }}
        />,
      );

      const status = screen.getByRole("status", { name: accessibleName });
      expect(status.querySelector('[data-ui="brand-asset"]')).toBeNull();
      expect(
        status.querySelector('[data-slot="clash-agent-avatar"]'),
      ).toHaveAttribute("data-status", "working");
      expect(
        status.querySelectorAll(`[data-generation-asset="${kind}"]`),
      ).toHaveLength(3);
    },
  );

  it.each([
    ["image", ImageNode],
    ["video", VideoNode],
    ["audio", AudioNode],
  ] as const)(
    "shows a failed %s node's message with its failure code",
    (kind, Component) => {
      const { unmount } = render(
        <Component
          {...baseNodeProps}
          id={`${kind}-failed-node`}
          type={kind}
          width={320}
          height={180}
          data={{
            label: `Failed ${kind}`,
            status: "failed",
            error: "Run exceeded its deadline",
            errorCode: "deadline_exceeded",
          }}
        />,
      );

      expect(
        screen.getByText("Run exceeded its deadline [deadline_exceeded]"),
      ).toBeInTheDocument();
      unmount();
    },
  );

  it.each([
    ["image", ImageNode],
    ["video", VideoNode],
  ] as const)(
    "never renders an empty failure on a %s node",
    (kind, Component) => {
      const { unmount } = render(
        <Component
          {...baseNodeProps}
          id={`${kind}-failed-empty-node`}
          type={kind}
          width={320}
          height={180}
          data={{ label: `Failed ${kind}`, status: "failed" }}
        />,
      );

      expect(
        screen.getByText(
          "Generation failed without an error message [unknown_failure]",
        ),
      ).toBeInTheDocument();
      unmount();
    },
  );

  it("shows only the message when a failed node has no code", () => {
    render(
      <VideoNode
        {...baseNodeProps}
        id="video-failed-uncoded-node"
        type="video"
        width={320}
        height={180}
        data={{
          label: "Failed video",
          status: "failed",
          error: "Provider rejected the prompt",
        }}
      />,
    );

    expect(screen.getByText("Provider rejected the prompt")).toBeInTheDocument();
    expect(screen.queryByText(/\[\]/)).toBeNull();
  });

  it("keeps a single click on an audio node from opening the enlarged player", () => {
    const { container } = render(
      <AudioNode
        {...baseNodeProps}
        id="audio-node"
        type="audio"
        data={{
          assetId: "audio-asset",
          label: "Narration",
          status: "completed",
        }}
      />,
    );

    fireEvent.click(container.querySelector(".cursor-pointer")!);

    expect(screen.queryByRole("dialog", { name: "Audio Player" })).toBeNull();
  });

  it.each([
    ["image", ImageNode, "image-asset"],
    ["video", VideoNode, "video-asset"],
    ["audio", AudioNode, "audio-asset"],
  ] as const)(
    "opens the shared project preview from the %s node button",
    (_kind, Component, assetId) => {
      const { unmount } = render(
        <Component
          {...baseNodeProps}
          id={`${assetId}-node`}
          type={_kind}
          width={320}
          height={180}
          data={{
            assetId,
            label: `${_kind} material`,
            status: "completed",
            previewUrl: `data:${_kind}/mock;base64,`,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Preview asset" }));

      expect(openAssetPreview).toHaveBeenCalledWith(assetId);
      unmount();
      openAssetPreview.mockClear();
    },
  );

  it.each([
    ["image", ImageNode, "data:image/png;base64,stale"],
    ["video", VideoNode, "blob:https://clash.test/stale-video"],
  ] as const)(
    "does not render a completed %s node from its persisted preview URL",
    (kind, Component, stalePreviewUrl) => {
      assetProjection.enabled = false;
      const { container } = render(
        <Component
          {...baseNodeProps}
          id={`${kind}-unresolved-node`}
          type={kind}
          width={320}
          height={180}
          data={{
            assetId: `${kind}-unresolved-asset`,
            label: `Unresolved ${kind}`,
            status: "completed",
            previewUrl: stalePreviewUrl,
          }}
        />,
      );

      const mediaSources = Array.from(
        container.querySelectorAll("img, video"),
        (element) => element.getAttribute("src"),
      );
      expect(mediaSources).not.toContain(stalePreviewUrl);
    },
  );

  it("does not decode or seek video bytes while their Host projection is downloading", () => {
    assetProjection.status = "downloading";
    const { container } = render(
      <VideoNode
        {...baseNodeProps}
        id="video-downloading-node"
        type="video"
        width={320}
        height={180}
        data={{
          assetId: "video-downloading-asset",
          label: "Downloading video",
          status: "completed",
        }}
      />,
    );

    expect(container.querySelector("video")).toBeNull();
  });

  it("keeps the ephemeral local upload preview without extracting or seeking a poster", () => {
    assetProjection.enabled = false;
    const { container } = render(
      <VideoNode
        {...baseNodeProps}
        id="video-uploading-node"
        type="video"
        width={320}
        height={180}
        data={{
          assetId: "video-uploading-asset",
          label: "Uploading video",
          status: "uploading",
          previewUrl: "blob:https://clash.test/upload-preview",
        }}
      />,
    );

    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(
      "blob:https://clash.test/upload-preview",
    );
    Object.defineProperty(video!, "duration", {
      configurable: true,
      value: 12,
    });
    fireEvent.loadedMetadata(video!);
    expect(video!.currentTime).toBe(0);
  });
});
