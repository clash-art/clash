import { LoroDoc } from "loro-crdt";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createProjectGenerator,
  generatorDefinitionFromExecutablePluginRegistration,
  ExecutablePluginGeneratorDocumentSchema,
  CustomActionDefinitionSchema,
  MODEL_CARDS,
  type GeneratorRevision,
  type ModelCatalogEntry,
  type ModelUpstreamRoute,
} from "@clash/shared-types";

import PromptActionNode, {
  normalizeActionAspectRatioOptions,
  planKeyframeInsertion,
} from "./ActionBadge";
import { CanvasTransientUiProvider } from "../CanvasTransientUiContext";
import { CustomActionsProvider } from "../CustomActionsContext";
import agentTextGenerator from "../../../../../plugins/agent-text/generators/text.json";
import agentTextCard from "../../../../../plugins/agent-text/cards/agent-text.json";

const reactFlowMock = vi.hoisted(() => {
  const nodeConnections: any[] = [];
  return {
    addEdges: vi.fn(),
    addSelectedNodes: vi.fn(),
    getEdges: vi.fn(() => []),
    getNode: vi.fn((_id: string): any => undefined),
    getNodes: vi.fn((): any[] => []),
    nodeConnections,
    setEdges: vi.fn(),
    setNodes: vi.fn(),
  };
});

const spawnAssetMock = vi.hoisted(() => ({
  adoptDraft: vi.fn(),
  latestInput: null as any,
  spawnDraft: vi.fn(),
  spawnPending: vi.fn(),
}));

const layoutMock = vi.hoisted(() => ({
  addNodeWithAutoLayout: vi.fn(),
  addNodeWithLayout: vi.fn(),
}));

const projectContextMock = vi.hoisted(() => ({
  enabledModelCatalog: null as ModelCatalogEntry[] | null,
}));

const refPickerAssetMock = vi.hoisted(() => ({
  asset: undefined as
    | {
        id: string;
        kind: "video";
        status: "ready";
        url: string;
        thumbnailUrl?: string;
        metadata: Record<string, never>;
        lifecycle: { state: "active" };
      }
    | undefined,
}));

vi.mock("@xyflow/react", () => ({
  Handle: ({ type, position, ...props }: any) => (
    <div data-testid={`handle-${type}-${position}`} {...props} />
  ),
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
    Bottom: "bottom",
  },
  NodeToolbar: ({ children, isVisible }: any) =>
    isVisible ? <div data-testid="node-toolbar">{children}</div> : null,
  useNodeConnections: () => reactFlowMock.nodeConnections,
  useStoreApi: () => ({ getState: () => reactFlowMock }),
  useReactFlow: () => ({
    addEdges: reactFlowMock.addEdges,
    getEdges: reactFlowMock.getEdges,
    getNode: reactFlowMock.getNode,
    getNodes: reactFlowMock.getNodes,
    setEdges: reactFlowMock.setEdges,
    setNodes: reactFlowMock.setNodes,
  }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => true,
  Reorder: {
    Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Item: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => (
      <button {...props}>{children}</button>
    ),
  },
}));

const configureModelsMock = vi.hoisted(() => vi.fn());
vi.mock("../ProjectContext", async () => {
  const { MODEL_CARDS } = await import("@clash/shared-types");
  return {
    useProject: () => ({
      projectId: "project-1",
      configureModels: configureModelsMock,
      modelCatalogReady: true,
      enabledModelCatalog:
        projectContextMock.enabledModelCatalog ??
        MODEL_CARDS.map((model) => ({
          model,
          tier: "available",
          selectedRoute: {},
        })),
    }),
  };
});

const nativeLoroMock = vi.hoisted(() => ({ value: null as any }));
vi.mock("../LoroSyncContext", () => ({
  useOptionalLoroSyncContext: () => nativeLoroMock.value,
}));

vi.mock("../PresenceAwarenessContext", () => ({
  usePeersSelectingNode: () => [],
}));

vi.mock("../ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
}));

vi.mock("../MilkdownEditor", () => ({
  default: ({ content }: { content?: string }) => (
    <div data-testid="editor">{content}</div>
  ),
}));

vi.mock("../ProjectedMedia", () => ({
  ProjectedImage: ({ src, alt }: { src?: string; alt?: string }) => (
    <img src={src} alt={alt ?? ""} />
  ),
}));

vi.mock("@clash/web-ui/lib/hooks/useAsset", () => ({
  getAsset: vi.fn(),
  useAsset: () => refPickerAssetMock.asset,
}));

vi.mock("@clash/web-ui/hooks/useRuntimes", () => ({
  RUNTIME_OFFLINE_LABEL: "Offline",
  RUNTIME_OFFLINE_TOOLTIP: "Runtime offline",
  isCustomActionRuntimeOnline: () => true,
  useRuntimes: () => ({ loading: false, runtimes: [] }),
}));

vi.mock("@clash/web-ui/lib/layout", () => ({
  useLayoutManager: () => layoutMock,
}));

vi.mock("./useSpawnPendingAsset", () => ({
  useSpawnPendingAsset: (input: any) => {
    spawnAssetMock.latestInput = input;
    return {
      adoptDraft: spawnAssetMock.adoptDraft,
      canSpawn: true,
      disabledReason: null,
      outputKind: "audio",
      spawnDraft: spawnAssetMock.spawnDraft,
      spawnPending: spawnAssetMock.spawnPending,
    };
  },
}));

vi.mock("./ActionBadgePipelineMenu", () => ({
  default: () => null,
}));

vi.mock("./AttributionLine", () => ({
  default: () => null,
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

describe("ActionBadge canvas subscriptions", () => {
  it("removes presentation aliases before Action passes ratio options to its picker", () => {
    expect(
      normalizeActionAspectRatioOptions({
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        required: false,
        options: [
          { label: "Landscape (16:9)", value: "16:9" },
          { label: "Ultrawide (21:9)", value: "21:9" },
        ],
      }),
    ).toEqual([
      { label: "16:9", value: "16:9" },
      { label: "21:9", value: "21:9" },
    ]);
  });

  it("redistributes untouched timing but preserves custom timing when adding a keyframe", () => {
    expect(planKeyframeInsertion([0, 60, 120], 120, false)).toEqual({
      insertionIndex: 2,
      frameIndices: [0, 40, 80, 120],
    });
    expect(planKeyframeInsertion([0, 24, 120], 120, true)).toEqual({
      insertionIndex: 2,
      frameIndices: [0, 24, 72, 120],
    });
    // Equal gaps choose the later slot so insertion still feels append-like.
    expect(planKeyframeInsertion([0, 60, 120], 120, true)).toEqual({
      insertionIndex: 2,
      frameIndices: [0, 60, 90, 120],
    });
  });

  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    nativeLoroMock.value = null;
    cleanup();
    Element.prototype.scrollIntoView = vi.fn();
    reactFlowMock.nodeConnections.splice(0);
    reactFlowMock.getEdges.mockReset();
    reactFlowMock.getEdges.mockReturnValue([]);
    reactFlowMock.getNode.mockReset();
    reactFlowMock.getNode.mockReturnValue(undefined);
    reactFlowMock.getNodes.mockReset();
    reactFlowMock.getNodes.mockReturnValue([]);
    reactFlowMock.addEdges.mockReset();
    reactFlowMock.addSelectedNodes.mockReset();
    reactFlowMock.setNodes.mockReset();
    spawnAssetMock.adoptDraft.mockReset();
    spawnAssetMock.latestInput = null;
    spawnAssetMock.adoptDraft.mockResolvedValue({ id: "draft-1" });
    spawnAssetMock.spawnDraft.mockReset();
    spawnAssetMock.spawnPending.mockReset();
    spawnAssetMock.spawnPending.mockResolvedValue({ id: "new-output" });
    layoutMock.addNodeWithAutoLayout.mockReset();
    layoutMock.addNodeWithAutoLayout.mockImplementation((node: any) => ({
      ...node,
      position: { x: 320, y: 0 },
    }));
    layoutMock.addNodeWithLayout.mockReset();
    projectContextMock.enabledModelCatalog = null;
    refPickerAssetMock.asset = undefined;
  });

  it("disables a parameter only when every configured provider excludes it", () => {
    const seedAudio = MODEL_CARDS.find((model) => model.id === "seed-audio-1")!;
    const hiloRoute = {
      modelCode: seedAudio.id,
      kind: seedAudio.kind,
      providerId: "hilo-hub",
      upstreamId: "hilo-hub",
      upstreamModel: "seed-audio-1.0",
      apiShape: "hilo-hub",
      priority: 1,
      excludedParameterIds: ["voice_id"],
      executorBinding: {
        pluginId: "hilo.hub-media",
        version: "1.0.0",
        exportId: "hilo-hub-execute",
        schemaHash: `sha256:${"a".repeat(64)}`,
      },
    } satisfies ModelUpstreamRoute;
    const officialRoute = {
      ...hiloRoute,
      providerId: "volcengine-speech",
      upstreamId: "volcengine-speech",
      apiShape: "volcengine-speech",
      excludedParameterIds: undefined,
      executorBinding: {
        pluginId: "clash.volcengine",
        version: "1.0.0",
        exportId: "volcengine-speech-execute",
        schemaHash: `sha256:${"b".repeat(64)}`,
      },
    } satisfies ModelUpstreamRoute;
    const catalogEntry = (
      routes: ModelUpstreamRoute[],
      unavailableParameterIds: string[],
    ): ModelCatalogEntry => ({
      model: seedAudio,
      tier: "available",
      routes,
      selectedRoute: routes[0] ?? null,
      candidateProviders: routes.flatMap((route) =>
        route.providerId ? [route.providerId] : [],
      ),
      unavailableParameterIds,
      missingCredentials: [],
      missingOAuth: [],
    });
    const renderEditor = () =>
      render(
        <CanvasTransientUiProvider>
          <PromptActionNode
            {...baseNodeProps}
            id="seed-audio-action"
            type="action-badge"
            data={{
              actionType: "audio-gen",
              content: "A calm narrator",
              label: "Generate audio",
              modelId: seedAudio.id,
            }}
          />
        </CanvasTransientUiProvider>,
      );
    const openParameters = () => {
      fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
      fireEvent.click(screen.getByRole("button", { name: "Parameters" }));
    };

    projectContextMock.enabledModelCatalog = [
      catalogEntry([hiloRoute], ["voice_id"]),
    ];
    const first = renderEditor();
    openParameters();
    expect(screen.getByRole("button", { name: /Voice ID/i })).toBeDisabled();

    first.unmount();
    projectContextMock.enabledModelCatalog = [
      catalogEntry([hiloRoute, officialRoute], []),
    ];
    renderEditor();
    openParameters();
    const voiceIdControl = screen.getByRole("button", { name: /Voice ID/i });
    expect(voiceIdControl).toBeEnabled();
    fireEvent.click(voiceIdControl);
    fireEvent.change(screen.getByRole("textbox", { name: "Voice ID" }), {
      target: { value: "speaker-123" },
    });
    expect(spawnAssetMock.latestInput.pluginBinding).toMatchObject({
      pluginId: "clash.volcengine",
      exportId: "volcengine-speech-execute",
    });
  });

  it("offers Settings for an unconfigured draft without inventing a model or showing an error", () => {
    projectContextMock.enabledModelCatalog = [];
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps}
      id="empty-model" type="action-badge" data={{ actionType: "image-gen", content: "" }}
    /></CanvasTransientUiProvider>);
    expect(screen.queryByText(/No connected provider or executable route/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configure models in Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure models in Settings" }));
    expect(configureModelsMock).toHaveBeenCalled();
  });

  it("blocks an existing model node when no provider route is available", () => {
    projectContextMock.enabledModelCatalog = [];
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps}
      id="unavailable-model" type="action-badge"
      data={{ actionType: "image-gen", modelId: "unconnected-model", content: "A landscape" }}
    /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(screen.getByRole("button", { name: "Run action" })).toBeDisabled();
    expect(screen.getByText("No available model selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parameters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Batch count" })).not.toBeInTheDocument();
  });

  it("mounts from node-scoped connections without subscribing to every edge", () => {
    const { getByText } = render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "image-gen",
            content: "Generate a variant",
            label: "Generate",
            modelId: "nano-banana-2",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    expect(getByText("Generate")).not.toBeNull();
  });

  it.each([false, true])("configuring a badge selects it without replacing an existing selection (selected=%s)", (selected) => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          selected={selected}
          id="action-1"
          type="action-badge"
          data={{ actionType: "text-gen", content: "Write a brief", modelId: "gpt-5.4" }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));

    expect(screen.getByTestId("node-toolbar")).toBeTruthy();
    if (selected) {
      expect(reactFlowMock.addSelectedNodes).not.toHaveBeenCalled();
    } else {
      expect(reactFlowMock.addSelectedNodes).toHaveBeenCalledWith(["action-1"]);
    }
  });

  it("selects a copied badge when its configuration opens automatically", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-copy"
          type="action-badge"
          data={{ actionType: "text-gen", content: "Write a brief", modelId: "gpt-5.4", openPanel: true }}
        />
      </CanvasTransientUiProvider>,
    );
    expect(screen.getByTestId("node-toolbar")).toBeTruthy();
    expect(reactFlowMock.addSelectedNodes).toHaveBeenCalledWith(["action-copy"]);
  });

  it("keeps configuration open on repeated clicks and closes it when the node loses selection", () => {
    const node = (selected: boolean) => (
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          selected={selected}
          id="action-1"
          type="action-badge"
          data={{ actionType: "text-gen", content: "Write a brief", modelId: "gpt-5.4" }}
        />
      </CanvasTransientUiProvider>
    );
    const { rerender } = render(node(true));
    const configure = screen.getByRole("button", { name: "Configure action" });
    fireEvent.click(configure);
    fireEvent.click(configure);
    expect(screen.getByTestId("node-toolbar")).toBeTruthy();
    rerender(node(false));
    expect(screen.queryByTestId("node-toolbar")).toBeNull();
  });

  it("keeps the selected capsule fill uniform while the configure half is hovered", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          selected
          id="action-1"
          type="action-badge"
          data={{
            actionType: "text-gen",
            content: "Write a brief",
            label: "Agent Brief",
            modelId: "gpt-5.4",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Configure action" }).className,
    ).toContain("hover:bg-transparent");
  });

  it("renders direct-only Lyrics while connected Text references remain Prompt references", () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "lyrics-text-music-action",
      source: "lyrics-text",
      target: "music-action",
    });
    const lyricsNode = {
      id: "lyrics-text",
      type: "text",
      data: { label: "Chorus draft", content: "Stay until morning" },
    };
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === lyricsNode.id ? lyricsNode : undefined,
    );
    reactFlowMock.getNodes.mockReturnValue([lyricsNode]);

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="music-action"
          type="action-badge"
          data={{
            actionType: "audio-gen",
            content: "Dreamy synth pop",
            label: "Night song",
            lyrics: "[Verse]\nNeon rain",
            modelId: "minimax-music-3",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));

    const lyricsInput = screen.getByRole("textbox", { name: "Lyrics" });
    expect((lyricsInput as HTMLTextAreaElement).value).toBe(
      "[Verse]\nNeon rain",
    );
    expect(
      screen.queryByRole("button", { name: "Add lyrics reference" }),
    ).toBeNull();
    expect(spawnAssetMock.latestInput.lyrics).toBe("[Verse]\nNeon rain");
    expect(spawnAssetMock.latestInput.refNodeIds).toEqual(["lyrics-text"]);
    expect(spawnAssetMock.latestInput.lyricsRefNodeIds).toBeUndefined();

    fireEvent.change(lyricsInput, { target: { value: "[Chorus]\nStay" } });
    expect(spawnAssetMock.latestInput.lyrics).toBe("[Chorus]\nStay");
  });

  it("does not render a Lyrics input for non-music models", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="video-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "A quiet street",
            label: "Generate video",
            modelId: "minimax-h3",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(screen.queryByRole("textbox", { name: "Lyrics" })).toBeNull();
  });

  it("presents FLUX 3 keyframes as an independent model card", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Connect these moments",
            label: "FLUX 3",
            modelId: "flux-3-video-keyframes",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(
      screen.queryByRole("combobox", { name: "FLUX 3 Video workflow" }),
    ).toBeNull();
    const strip = screen.getByTestId("frame-reference-strip");
    expect(strip.getAttribute("data-frame-layout")).toBe("scroll");
    expect(
      screen.getByRole("button", { name: "Pick Start keyframe" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pick End keyframe" }),
    ).toBeTruthy();
    expect(strip.textContent).toContain("Start");
    expect(strip.textContent).toContain("End");
    expect(strip.textContent).toContain("0s");
    expect(strip.textContent).toContain("5s");
    expect(screen.queryByText(/0\/10 keyframes/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add reference from canvas" }),
    ).toBeNull();
    expect(screen.queryByTestId("keyframe-timeline-track")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    expect(screen.getByRole("option", { name: "FLUX 3 Video" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "FLUX 3 Video (Keyframes)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "FLUX 3 Video (Continue)" }),
    ).toBeTruthy();
  });

  it("uses the shared frame strip for fixed start/end slots", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="start-end-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Move between these frames",
            label: "Start and end",
            modelId: "minimax-h3-startend",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const strip = screen.getByTestId("frame-reference-strip");
    expect(strip.getAttribute("data-frame-layout")).toBe("fixed");
    expect(
      screen.getByRole("button", { name: "Pick Start frame" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pick End frame" })).toBeTruthy();
  });

  it("gives FLUX 3 continuation a single semantic Source video slot", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-continue-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Keep the shot moving",
            label: "Continue",
            modelId: "flux-3-video-continue",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(
      screen.queryByRole("combobox", { name: "FLUX 3 Video workflow" }),
    ).toBeNull();
    expect(screen.getByText("Source video")).toBeTruthy();
    expect(screen.getByText("MP4 · up to 15s · 50 MB")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose source video" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add reference from canvas" }),
    ).toBeNull();
  });

  it("never sends a source-video playback URL through the reference-picker image decoder", () => {
    const sourceVideo = {
      id: "source-video",
      type: "video",
      data: { assetId: "source-video-asset", label: "Opening clip" },
    };
    reactFlowMock.getNodes.mockReturnValue([sourceVideo]);
    refPickerAssetMock.asset = {
      id: "source-video-asset",
      kind: "video",
      status: "ready",
      url: "https://media.clash.test/source-video.mp4",
      metadata: {},
      lifecycle: { state: "active" },
    };

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-continue-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Keep the shot moving",
            label: "Continue",
            modelId: "flux-3-video-continue",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose source video" }));

    expect(
      document.querySelector(
        'img[src="https://media.clash.test/source-video.mp4"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector("video")?.getAttribute("src"),
    ).toBe("https://media.clash.test/source-video.mp4");
  });

  it("lets Seedance continuation collect videos up to the card's declared limit", () => {
    const sourceVideo = {
      id: "seedance-source-1",
      type: "video",
      data: { label: "Opening clip" },
    };
    reactFlowMock.nodeConnections.push({
      edgeId: "seedance-source-1-seedance-extend-action",
      source: sourceVideo.id,
      target: "seedance-extend-action",
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === sourceVideo.id ? sourceVideo : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="seedance-extend-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Bridge these source clips",
            label: "Extend",
            modelId: "seedance-2-extend",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(screen.getByText("Source videos")).toBeTruthy();
    expect(screen.getByText("1–3 videos · up to 15s total")).toBeTruthy();
    expect(screen.getByText("Opening clip")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add source video" }),
    ).toBeTruthy();
  });

  it("labels and evenly times the first and last FLUX 3 keyframes", () => {
    const keyframes = Array.from({ length: 2 }, (_, index) => ({
      id: `frame-${index + 1}`,
      type: "image",
      data: { label: `Frame ${index + 1}` },
    }));
    reactFlowMock.nodeConnections.push(
      ...keyframes.map((frame) => ({
        edgeId: `${frame.id}-flux-action`,
        source: frame.id,
        target: "flux-action",
      })),
    );
    reactFlowMock.getNode.mockImplementation((id: string) =>
      keyframes.find((frame) => frame.id === id),
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Connect these moments",
            label: "FLUX 3",
            modelId: "flux-3-video-keyframes",
            referenceImageOrder: keyframes.map((frame) => frame.id),
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const editor = screen.getByRole("list", { name: "FLUX 3 keyframes" });
    const strip = screen.getByTestId("frame-reference-strip");
    expect(strip.getAttribute("data-frame-layout")).toBe("scroll");
    expect(strip.className).not.toMatch(
      /rounded-xl|border-warm-border|bg-warm-surface|shadow-sm/,
    );
    expect(editor.textContent).toContain("Start");
    expect(editor.textContent).toContain("End");
    expect(editor.textContent).toContain("0s");
    expect(editor.textContent).toContain("5s");
    expect(screen.queryByText(/2\/10 keyframes/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add middle keyframe" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("keyframe-timeline-track")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit keyframe timing" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Edit keyframe timing" }),
    ).toBeTruthy();
    expect(screen.getByTestId("keyframe-timeline-track")).toBeTruthy();
  });

  it("edits an intermediate FLUX 3 keyframe at exact 24 fps positions in the timing dialog", async () => {
    const keyframes = Array.from({ length: 3 }, (_, index) => ({
      id: `timed-frame-${index + 1}`,
      type: "image",
      data: { label: `Timed frame ${index + 1}` },
    }));
    reactFlowMock.nodeConnections.push(
      ...keyframes.map((frame) => ({
        edgeId: `${frame.id}-timed-action`,
        source: frame.id,
        target: "timed-action",
      })),
    );
    reactFlowMock.getNode.mockImplementation((id: string) =>
      keyframes.find((frame) => frame.id === id),
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="timed-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Hit the exact beat",
            label: "Timed FLUX 3",
            modelId: "flux-3-video-keyframes",
            modelParams: {
              duration: 5,
              keyframe_frame_indices: "[0,48,120]",
              keyframe_timing_customized: true,
            },
            referenceImageOrder: keyframes.map((frame) => frame.id),
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit keyframe timing" }),
    );
    const timingDialog = screen.getByRole("dialog", {
      name: "Edit keyframe timing",
    });
    const timeSlots = timingDialog.querySelectorAll(
      '[data-testid="keyframe-time-slot"]',
    );
    expect(timeSlots).toHaveLength(3);
    for (const slot of timeSlots) {
      expect(slot.className).toContain("flex");
      expect(slot.className).toContain("h-4");
      expect(slot.className).toContain("w-10");
      expect(slot.className).toContain("items-center");
      expect(slot.className).toContain("justify-center");
      expect(slot.className).toContain("leading-none");
    }
    const track = screen.getByTestId("keyframe-timeline-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 480,
      bottom: 100,
      width: 480,
      height: 100,
      toJSON: () => ({}),
    });
    const markerContent = screen
      .getAllByLabelText("Frame 2 at 2s")
      .find((element) => element.closest('[role="dialog"]')) as HTMLElement;
    const marker = markerContent.parentElement as HTMLElement;
    marker.setPointerCapture = vi.fn();
    fireEvent.pointerDown(marker, { pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(marker, { pointerId: 7, clientX: 196 });
    fireEvent.pointerUp(marker, { pointerId: 7, clientX: 196 });

    await waitFor(() => {
      const dragged = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const [nextNode] = update([{ id: "timed-action", data: {} }]);
        return (
          nextNode?.data?.modelParams?.keyframe_frame_indices === "[0,72,120]"
        );
      });
      expect(dragged).toBe(true);
    });

    const timeInput = screen.getByRole("spinbutton", {
      name: "Frame 2 time in seconds",
    }) as HTMLInputElement;
    expect(timeInput.value).toBe("2.00");
    fireEvent.change(timeInput, { target: { value: "3" } });
    fireEvent.blur(timeInput);

    await waitFor(() => {
      const persisted = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const [nextNode] = update([{ id: "timed-action", data: {} }]);
        return (
          nextNode?.data?.modelParams?.keyframe_frame_indices ===
            "[0,72,120]" &&
          nextNode?.data?.modelParams?.keyframe_timing_customized === true
        );
      });
      expect(persisted).toBe(true);
    });
  });

  it("stops offering keyframes at the model card limit", () => {
    const keyframes = Array.from({ length: 10 }, (_, index) => ({
      id: `frame-${index + 1}`,
      type: "image",
      data: { label: `Frame ${index + 1}` },
    }));
    reactFlowMock.nodeConnections.push(
      ...keyframes.map((frame) => ({
        edgeId: `${frame.id}-flux-action`,
        source: frame.id,
        target: "flux-action",
      })),
    );
    reactFlowMock.getNode.mockImplementation((id: string) =>
      keyframes.find((frame) => frame.id === id),
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Connect every beat",
            label: "FLUX 3",
            modelId: "flux-3-video-keyframes",
            referenceImageOrder: keyframes.map((frame) => frame.id),
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const editor = screen.getByRole("list", { name: "FLUX 3 keyframes" });
    expect(editor.className).toContain("min-w-max");
    const strip = screen.getByTestId("frame-reference-strip");
    const scrollViewport = screen.getByTestId("frame-reference-scroll");
    const timingButton = screen.getByRole("button", {
      name: "Edit keyframe timing",
    });
    expect(scrollViewport.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("w-[18rem]");
    expect(strip.className).toContain("max-w-[min(18rem,calc(100vw-3rem))]");
    expect(strip.className).toContain("min-w-0");
    expect(strip.className).toContain("flex-none");
    expect(strip.style.width).toBe("18rem");
    expect(strip.style.maxWidth).toBe("calc(100vw - 3rem)");
    expect(strip.style.minWidth).toBe("0px");
    expect(scrollViewport.contains(timingButton)).toBe(false);
    expect(strip.contains(timingButton)).toBe(true);
    expect(strip.querySelectorAll(".clash-node-ref-index")).toHaveLength(0);
    expect(screen.queryByText(/10\/10 keyframes/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add middle keyframe" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit keyframe timing" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit keyframe timing" });
    expect(dialog.querySelectorAll(".clash-node-ref-index")).toHaveLength(0);
  });

  it("switches between independent FLUX 3 model cards through the model picker", async () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="flux-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "A moving portrait",
            label: "FLUX 3",
            modelId: "flux-3-video",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(
      screen.getByRole("option", { name: "FLUX 3 Video (Continue)" }),
    );

    await waitFor(() => {
      const persisted = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const [nextNode] = update([{ id: "flux-action", data: {} }]);
        return nextNode?.data?.modelId === "flux-3-video-continue";
      });
      expect(persisted).toBe(true);
    });
  });

  it("resolves connected source nodes by id without scanning the whole node array", () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "image-1-action-1",
      source: "image-1",
      sourceHandle: null,
      target: "action-1",
      targetHandle: null,
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "image-1"
        ? {
            id: "image-1",
            type: "image",
            data: {
              naturalHeight: 180,
              naturalWidth: 320,
            },
          }
        : undefined,
    );
    reactFlowMock.getNodes.mockImplementation(() => {
      throw new Error(
        "ActionBadge should use getNode(id), not scan getNodes()",
      );
    });

    const { getByText } = render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "image-gen",
            content: "Generate a variant",
            label: "Generate",
            modelId: "nano-banana-2",
            referenceImageOrder: ["image-1"],
          }}
        />
      </CanvasTransientUiProvider>,
    );

    expect(getByText("Generate")).not.toBeNull();
    expect(reactFlowMock.getNode).toHaveBeenCalledWith("image-1");
  });

  it("offers only audio-compatible video models for an attached audio reference", () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "audio-1-action-1",
      source: "audio-1",
      sourceHandle: null,
      target: "action-1",
      targetHandle: null,
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "audio-1"
        ? {
            id: "audio-1",
            type: "audio",
            data: { assetId: "audio-asset-1", status: "completed" },
          }
        : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Animate to this audio",
            label: "Video Prompt",
            modelId: "seedance-2-ref",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));

    const modelSelect = screen.getByRole("combobox", { name: "Model" });
    expect(modelSelect.hasAttribute("disabled")).toBe(false);
    expect(modelSelect.textContent).toContain("Seedance 2.0 (全能参考)");
    fireEvent.click(modelSelect);
    expect(
      screen.getByRole("option", { name: "Seedance 2.5 (全能参考)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Seedance 2.0 Fast (全能参考)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Seedance 2.0 Mini (全能参考)" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Kling Avatar" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Sora 2" })).toBeNull();
    expect(
      screen.queryByRole("option", { name: "Seedance 2.0 (Start/End)" }),
    ).toBeNull();
    expect(
      screen.queryByRole("option", { name: "MiniMax H3 (全能参考)" }),
    ).toBeNull();
  });

  it("selects a form Custom Action from the Image Gen model picker", async () => {
    const action = CustomActionDefinitionSchema.parse({
      id: "codex-imagegen",
      name: "Codex ImageGen",
      outputType: "image",
      presentation: { type: "form" },
      parameters: [
        {
          id: "aspect_ratio",
          label: "Aspect Ratio",
          type: "select",
          options: [{ label: "Square", value: "1:1" }],
          defaultValue: "1:1",
        },
      ],
    });

    render(
      <CanvasTransientUiProvider>
        <CustomActionsProvider actions={[action]}>
          <PromptActionNode
            {...baseNodeProps}
            id="action-1"
            type="action-badge"
            data={{
              actionType: "image-gen",
              content: "Draw a quiet forest",
              label: "Image Prompt",
              modelId: "nano-banana-2",
            }}
          />
        </CustomActionsProvider>
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: "Codex ImageGen" }));

    await waitFor(() =>
      expect(spawnAssetMock.latestInput).toMatchObject({
        actionType: "custom:codex-imagegen",
        isCustom: true,
        customActionParams: { aspect_ratio: "1:1" },
        customDef: { id: "codex-imagegen" },
      }),
    );
  });

  it("opens the aspect-ratio secondary panel directly from its toolbar chip", async () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="ratio-action"
          type="action-badge"
          data={{
            actionType: "image-gen",
            content: "A vertical studio portrait",
            label: "Image Prompt",
            modelId: "nano-banana-2",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Aspect Ratio: 16:9" }));

    expect(screen.getByLabelText("Model aspect ratio")).toBeTruthy();
    expect(screen.getByText("Aspect ratio")).toBeTruthy();
    expect(screen.queryByText("Choose a preset or drag the frame")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));

    await waitFor(() =>
      expect(spawnAssetMock.latestInput.modelParams).toMatchObject({
        aspect_ratio: "9:16",
      }),
    );
  });

  it("shows only the ratio on a custom action's aspect-ratio toolbar chip", () => {
    const action = CustomActionDefinitionSchema.parse({
      id: "custom-ultrawide-image",
      name: "Custom Ultrawide Image",
      outputType: "image",
      presentation: { type: "form" },
      parameters: [
        {
          id: "aspect_ratio",
          label: "Aspect Ratio",
          type: "select",
          options: [
            { label: "Landscape (16:9)", value: "16:9" },
            { label: "Ultrawide (21:9)", value: "21:9" },
          ],
          defaultValue: "16:9",
        },
      ],
    });

    render(
      <CanvasTransientUiProvider>
        <CustomActionsProvider actions={[action]}>
          <PromptActionNode
            {...baseNodeProps}
            id="custom-ratio-action"
            type="action-badge"
            data={{
              actionType: "custom:custom-ultrawide-image",
              customActionId: "custom-ultrawide-image",
              customActionParams: { aspect_ratio: "21:9" },
              content: "A cat",
              label: "Image Prompt",
            }}
          />
        </CustomActionsProvider>
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));

    expect(screen.getByRole("button", { name: "Aspect Ratio: 21:9" })).toBeTruthy();
    expect(screen.queryByText("Ultrawide (21:9)")).toBeNull();
  });

  it("requires an explicit update before running a Custom Action with a newer definition", async () => {
    const previousBinding = {
      pluginId: "clash.codex-imagegen",
      version: "0.1.0",
      exportId: "generate-image",
      schemaHash: `sha256:${"a".repeat(64)}` as const,
    };
    const currentBinding = {
      ...previousBinding,
      version: "0.1.1",
      schemaHash: `sha256:${"b".repeat(64)}` as const,
    };
    const action = CustomActionDefinitionSchema.parse({
      id: "codex-imagegen",
      name: "Codex ImageGen",
      outputType: "image",
      presentation: { type: "form" },
      parameters: [],
      runtime: "local",
      version: currentBinding.version,
      pluginBinding: currentBinding,
    });

    render(
      <CanvasTransientUiProvider>
        <CustomActionsProvider actions={[action]}>
          <PromptActionNode
            {...baseNodeProps}
            id="stale-action"
            type="action-badge"
            data={{
              actionType: "custom:codex-imagegen",
              customActionId: "codex-imagegen",
              content: "A cat",
              label: "Codex ImageGen",
              pluginBinding: previousBinding,
            }}
          />
        </CustomActionsProvider>
      </CanvasTransientUiProvider>,
    );

    expect(screen.getByText("Action definition updated")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Action definition updated. Update before running.",
      }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Update action" }));

    await waitFor(() => {
      const persisted = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const [nextNode] = update([
          {
            id: "stale-action",
            type: "action-badge",
            data: { pluginBinding: previousBinding },
          },
        ]);
        return nextNode?.data?.pluginBinding?.schemaHash ===
          currentBinding.schemaHash;
      });
      expect(persisted).toBe(true);
    });
  });

  it("copies a checkpointed Custom Action onto its current executable definition", async () => {
    const previousBinding = {
      pluginId: "clash.codex-imagegen",
      version: "0.1.0",
      exportId: "generate-image",
      schemaHash: `sha256:${"a".repeat(64)}` as const,
    };
    const currentBinding = {
      ...previousBinding,
      version: "0.1.1",
      schemaHash: `sha256:${"b".repeat(64)}` as const,
    };
    const action = CustomActionDefinitionSchema.parse({
      id: "codex-imagegen",
      name: "Codex ImageGen",
      outputType: "image",
      presentation: { type: "form" },
      parameters: [],
      runtime: "local",
      version: currentBinding.version,
      pluginBinding: currentBinding,
    });
    reactFlowMock.getEdges.mockImplementation(
      () =>
        [
          { id: "stale-output", source: "stale-action", target: "output-1" },
        ] as any,
    );
    reactFlowMock.getNode.mockImplementation((nodeId: string) =>
      nodeId === "stale-action"
        ? { id: nodeId, position: { x: 10, y: 20 } }
        : nodeId === "output-1"
          ? { id: nodeId, type: "image", data: { status: "failed" } }
          : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <CustomActionsProvider actions={[action]}>
          <PromptActionNode
            {...baseNodeProps}
            id="stale-action"
            type="action-badge"
            data={{
              actionType: "custom:codex-imagegen",
              customActionId: "codex-imagegen",
              customActionParams: { aspect_ratio: "1:1" },
              content: "A cat",
              hasRun: true,
              label: "Codex ImageGen",
              pluginBinding: previousBinding,
            }}
          />
        </CustomActionsProvider>
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy to update" }));

    await waitFor(() => {
      const copied = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const nextNodes = update([
          {
            id: "stale-action",
            type: "action-badge",
            position: { x: 10, y: 20 },
            data: { pluginBinding: previousBinding },
          },
        ]);
        const copy = nextNodes.find((node: any) => node.id !== "stale-action");
        return (
          copy?.data?.customActionId === "codex-imagegen" &&
          copy?.data?.customActionParams?.aspect_ratio === "1:1" &&
          copy?.data?.pluginBinding?.schemaHash === currentBinding.schemaHash
        );
      });
      expect(copied).toBe(true);
    });
  });

  it("shrinks the aspect-ratio popover while Auto hides the numeric editor", async () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="adaptive-ratio-action"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Animate this reference",
            label: "Video Prompt",
            modelId: "minimax-h3",
            modelParams: {
              aspect_ratio: "adaptive",
              duration: 5,
              resolution: "2K",
            },
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Aspect Ratio: Auto" }));

    const popover = document.querySelector<HTMLElement>(
      '[data-aspect-ratio-popover]',
    );
    expect(popover).toHaveAttribute("data-aspect-ratio-popover", "automatic");
    expect(popover).toHaveStyle({ width: "22rem" });
    expect(screen.queryByLabelText("Aspect ratio preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "16:9" }));

    await waitFor(() => {
      expect(popover).toHaveAttribute("data-aspect-ratio-popover", "editable");
      expect(popover).toHaveStyle({ width: "32.5rem" });
    });
  });

  it("keeps exactly one action configuration panel open", () => {
    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "image-gen",
            content: "First prompt",
            label: "First",
            modelId: "nano-banana-2",
          }}
        />
        <PromptActionNode
          {...baseNodeProps}
          id="action-2"
          type="action-badge"
          data={{
            actionType: "image-gen",
            content: "Second prompt",
            label: "Second",
            modelId: "nano-banana-2",
          }}
        />
      </CanvasTransientUiProvider>,
    );
    const triggers = screen.getAllByRole("button", {
      name: "Configure action",
    });

    fireEvent.click(triggers[0]);
    expect(
      document.querySelectorAll("[data-action-config-panel]"),
    ).toHaveLength(1);
    expect(
      document.querySelector("[data-action-config-panel='action-1']"),
    ).not.toBeNull();

    fireEvent.click(triggers[1]);
    expect(
      document.querySelectorAll("[data-action-config-panel]"),
    ).toHaveLength(1);
    expect(
      document.querySelector("[data-action-config-panel='action-2']"),
    ).not.toBeNull();
  });

  it.each(["placed", "unplaced", "timing"])("edits native keyframes in one revision request (%s)", async (mode) => {
    const placed = mode === "placed";
    const doc = new LoroDoc();
    const nodes = ["start", "middle", "end"].map(id => ({ id, type: "image", data: { assetId: id, src: `https://example.test/${id}.png` } }));
    reactFlowMock.getNodes.mockReturnValue(placed ? nodes : mode === "timing" ? [] : nodes.filter(node => node.id !== "middle"));
    reactFlowMock.getNode.mockImplementation(id => nodes.find(node => node.id === id));
    const refs = nodes.map(node => ({ slot: "image", itemKey: node.id, target: { kind: "media" as const, projectAssetId: node.id } }));
    const revision: GeneratorRevision = { id: "before", generatorId: "native", definitionRef: {
      pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` },
      state: { modelId: "flux-3-video-keyframes", prompt: "Animate", params: { duration: 5, keyframe_frame_indices: "[0,24,120]", keyframe_timing_customized: true },
        contentParts: [{ type: "text", text: "Animate" }, ...refs.map(ref => ({ type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "" }))] }, persistentInputRefs: refs };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge" data={{ generatorId: "native", label: "Keyframes" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    if (mode === "timing") {
      fireEvent.click(screen.getByRole("button", { name: "Edit keyframe timing" }));
      const input = screen.getByRole("spinbutton", { name: "Frame 2 time in seconds" });
      fireEvent.change(input, { target: { value: "2" } });
      fireEvent.blur(input);
    } else {
    fireEvent.click(screen.getByRole("button", { name: "Remove frame 2 keyframe" }));
    }
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const input = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(input.state.params.keyframe_frame_indices).toBe(mode === "timing" ? "[0,48,120]" : "[0,120]");
    expect(input.state.params.keyframe_timing_customized).toBe(true);
    expect(input.persistentInputRefs.map((ref: any) => ref.target.projectAssetId).sort()).toEqual(mode === "timing" ? ["end", "middle", "start"] : ["end", "start"]);
    expect(input.state.contentParts.filter((part: any) => part.type === "input").map((part: any) => part.itemKey)).toEqual(mode === "timing" ? ["start", "middle", "end"] : ["start", "end"]);
    expect(nativeLoroMock.value.updateNode).not.toHaveBeenCalled();
    cleanup();
    doc.free();
  });

  it("removes an unplaced input by identity while retaining another reference to the same Asset", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const refs = ["opening", "closing"].map((itemKey) => ({ slot: "video", itemKey, target: { kind: "media" as const, projectAssetId: "shared-asset" } }));
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "openingclosing", contentParts: refs.map((ref) => ({ type: "input", slot: ref.slot, itemKey: ref.itemKey, label: ref.itemKey })), params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: refs };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", label: "Unplaced references" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(screen.getByRole("list", { name: "Media references" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove Media reference" })[0]!);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls.find((call) => call[1]?.body)![1]!.body as string);
    expect(input.persistentInputRefs).toEqual([refs[1]]);
    expect(input.state.prompt).toBe("closing");
    expect(input.state.contentParts).toEqual([revision.state.contentParts[1]]);
  });

  it("waits for ordered text edits before Run without replacing them with the old flat prompt", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "Before", contentParts: [{ type: "text", text: "Before" }], params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    let release!: () => void;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      if (request.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge" data={{ generatorId: "native", label: "Ordered prompt" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt text 1" }), { target: { value: "After" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Run action" }).at(-1)!);
    await waitFor(() => expect(request.mock.calls.some((call) => call[1]?.body)).toBe(true));
    expect(spawnAssetMock.spawnPending).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(spawnAssetMock.spawnPending).toHaveBeenCalled());
    for (const [, init] of request.mock.calls.filter((call) => call[1]?.body)) {
      const input = JSON.parse(init!.body as string);
      expect(input.state.prompt).toBe("After");
      expect(input.state.contentParts).toEqual([{ type: "text", text: "After" }]);
    }
  });

  it("renders a native end-only reference in the End slot", () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3-startend", prompt: "Move", params: {} },
      persistentInputRefs: [{ slot: "endFrame", target: { kind: "media" as const, projectAssetId: "end-image" } }] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    const source = { id: "reference", type: "image", data: { assetId: "end-image", label: "End image" } };
    reactFlowMock.getNodes.mockReturnValue([source]);
    reactFlowMock.getNode.mockImplementation((id: string) => id === source.id ? source : undefined);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", label: "End only" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    expect(screen.getByRole("button", { name: "Pick Start frame" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear End frame" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear Start frame" })).toBeNull();
  });

  it.each([{ kind: "image", attached: false }, { kind: "image", attached: true }, { kind: "text", attached: false }, { kind: "document", attached: false }] as const)("saves a picked $kind reference (attached=$attached) through the native revision", async ({ kind, attached }) => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision: import("@clash/shared-types").GeneratorRevision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "Native prompt", params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" }, ...(attached ? { contentParts: [{ type: "text", text: "Native prompt" }, { type: "input", slot: "image", itemKey: "existing", label: "" }] } : {}) }, persistentInputRefs: attached ? [{ slot: "image", itemKey: "existing", target: { kind: "media" as const, projectAssetId: "image-asset" } }] : [] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    const documentRevision = { kind: "document" as const, documentAssetId: "script", revisionId: "saved-script" };
    const source = { id: "reference", type: kind === "document" ? "text" : kind, data: { assetId: "image-asset", label: "Reference image", content: "Snapshot text", ...(kind === "document" ? { documentRevision } : {}) } };
    reactFlowMock.getNodes.mockReturnValue([source]);
    reactFlowMock.getNode.mockImplementation((id: string) => id === source.id ? source : undefined);
    nativeLoroMock.value = { doc, updateNode: vi.fn(), addEdge: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/documents/")) return Response.json({
        revision: { id: documentRevision.revisionId, documentAssetId: documentRevision.documentAssetId,
          documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
          body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" },
          producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] },
        body: "The saved script body",
      });
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId },
        revision: { ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId,
          state: input.state, persistentInputRefs: input.persistentInputRefs } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", label: "Native draft" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Add reference from canvas" }));
    if (attached) {
      expect(screen.queryByRole("button", { name: "Reference image" })).toBeNull();
      expect(request).not.toHaveBeenCalled();
      return;
    }
    fireEvent.click(screen.getByRole("button", { name: "Reference image" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls.find((call) => call[1]?.body)![1]!.body as string);
    if (kind === "image") {
      expect(input.persistentInputRefs).toEqual([{ slot: "image", itemKey: expect.any(String), target: { kind: "media", projectAssetId: "image-asset" } }]);
      expect(input.canvasInputConnections).toEqual([{ canvasId: "main", sourceNodeId: "reference", targetNodeId: "placement", asset: { kind: "media" as const, projectAssetId: "image-asset" } }]);
    } else if (kind === "document") {
      expect(input.persistentInputRefs).toEqual([{ slot: "text", itemKey: expect.any(String), target: documentRevision }]);
      expect(input.canvasInputConnections).toEqual([{ canvasId: "main", sourceNodeId: "reference", targetNodeId: "placement", asset: documentRevision }]);
      expect(input.state.prompt).not.toContain("Snapshot text");
      await screen.findByText("The saved script body");
      expect(request.mock.calls.some(([path]) => path.endsWith("/documents/script/revisions/saved-script"))).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Add reference from canvas" }));
      expect(screen.queryByRole("button", { name: "Reference image" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Add reference from canvas" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove Reference image text reference" }));
      await waitFor(() => {
        const last = request.mock.calls.filter(call => call[1]?.body).at(-1)!;
        const removed = JSON.parse(last[1]!.body as string);
        expect(removed.persistentInputRefs).toEqual([]);
        expect(removed.state.contentParts.some((part: any) => part.type === "input")).toBe(false);
      });
    } else {
      expect(input.persistentInputRefs).toEqual([]);
      expect(input.state.prompt).toBe("Native prompt\n\nSnapshot text");
      expect(input.state.contentParts).toEqual([{ type: "text", text: "Native prompt" }, { type: "text", text: "\n\nSnapshot text" }]);
    }
    expect(reactFlowMock.addEdges).not.toHaveBeenCalled();
    expect(nativeLoroMock.value.addEdge).not.toHaveBeenCalled();
  });

  it.each([true, false])("offers exact Document inputs only for mapped Action ports (mapped=%s)", async (mapped) => {
    const doc = new LoroDoc();
    const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.agent-text", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`, document: ExecutablePluginGeneratorDocumentSchema.parse(agentTextGenerator) });
    const definitionRef = { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash };
    const card = { ...agentTextCard.spec, generator: { ...agentTextCard.spec.generator, inputSlots: mapped ? agentTextCard.spec.generator.inputSlots : {} } };
    const action = CustomActionDefinitionSchema.parse({ ...card, pluginBinding: { pluginId: definitionRef.pluginId, version: definitionRef.version, schemaHash: definitionRef.schemaHash, exportId: card.functionExportId } });
    const revision: GeneratorRevision = { id: "before", generatorId: "agent-draft", definitionRef, state: { prompt: "Rewrite the source", modelId: "chosen-agent-model", systemPrompt: "Keep the meaning." }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: revision.generatorId, headRevisionId: revision.id }, revision });
    if (!created.ok) throw new Error(created.error.message);
    const asset = { kind: "document" as const, documentAssetId: "script", revisionId: "saved" };
    const source = { id: "source", type: "text", data: { label: "Source document", documentRevision: asset, content: "Stale Canvas text" } };
    reactFlowMock.getNode.mockImplementation(id => id === source.id ? source : undefined);
    reactFlowMock.getNodes.mockReturnValue([source, { id: "draft-text", type: "text", data: { label: "Draft text", content: "Ordinary authored text" } }]);
    nativeLoroMock.value = { doc, updateNode: vi.fn(), addEdge: vi.fn() };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("/generator-definitions/")) return Response.json({ definition });
      if (path.includes("/documents/")) return Response.json({ revision: { id: asset.revisionId, documentAssetId: asset.documentAssetId, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
        body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] }, body: "The saved source text" });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: { ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><CustomActionsProvider actions={[action]}><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: revision.generatorId, actionCardId: card.id, label: card.name }} /></CustomActionsProvider></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Add reference from canvas" }));
    if (!mapped) {
      expect(screen.queryByRole("button", { name: "Source document" })).toBeNull();
      expect(screen.getByRole("button", { name: "Draft text" })).toBeTruthy();
      expect(request).not.toHaveBeenCalled();
      return;
    }
    fireEvent.click(screen.getByRole("button", { name: "Source document" }));
    await screen.findByText("The saved source text");
    const added = JSON.parse(request.mock.calls.find(call => call[1]?.body)![1]!.body as string);
    expect(added.state).toEqual(revision.state);
    expect(added.persistentInputRefs.map((ref: any) => ref.target)).toEqual([asset]);
    expect(added.canvasInputConnections).toEqual([{ canvasId: "main", sourceNodeId: source.id, targetNodeId: "placement", asset }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Text text reference" }));
    await waitFor(() => {
      const removed = JSON.parse(request.mock.calls.filter(call => call[1]?.body).at(-1)![1]!.body as string);
      expect(removed.persistentInputRefs).toEqual([]);
      expect(removed.state).toEqual(revision.state);
    });
    expect(nativeLoroMock.value.updateNode).not.toHaveBeenCalled();
    expect(nativeLoroMock.value.addEdge).not.toHaveBeenCalled();
  });

  it("edits optional Agent Text settings even when the draft has no parameter values yet", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.agent-text", definitionId: "text", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const card = agentTextCard.spec;
    const action = CustomActionDefinitionSchema.parse({ ...card, pluginBinding: { pluginId: definitionRef.pluginId, version: definitionRef.version, schemaHash: definitionRef.schemaHash, exportId: card.functionExportId } });
    const revision: GeneratorRevision = { id: "before", generatorId: "agent-draft", definitionRef, state: { prompt: "Write a scene" }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: revision.generatorId, headRevisionId: revision.id }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><CustomActionsProvider actions={[action]}><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: revision.generatorId, actionCardId: card.id, label: card.name }} /></CustomActionsProvider></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Parameters" }));
    expect(screen.queryByText("undefined")).toBeNull();
    for (const [label, key, value] of [["Agent", "agentId", "chosen-harness"], ["Agent model", "modelId", "chosen-agent-model"], ["Instructions", "systemPrompt", "Be concise."]]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}\\s*Default$`) }));
      fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
      await waitFor(() => expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string).state[key]).toBe(value));
    }
    fireEvent.click(screen.getByRole("button", { name: /^Agent\s*chosen-harness$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agent" }), { target: { value: "" } });
    await waitFor(() => expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string).state).toEqual({ prompt: "Write a scene", agentId: "", modelId: "chosen-agent-model", systemPrompt: "Be concise." }));
    expect(nativeLoroMock.value.updateNode).not.toHaveBeenCalled();
  });

  it("removes an unplaced native Action reference while preserving its plugin-owned state", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "test.paint", definitionId: "paint", version: "1.0.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const action = CustomActionDefinitionSchema.parse({ id: "paint", name: "Paint", presentation: { type: "form" }, outputType: "image",
      input: { inputMode: { images: { max: 5 } }, promptModalities: ["text", "image"] }, parameters: [],
      pluginBinding: { pluginId: definitionRef.pluginId, version: definitionRef.version, schemaHash: definitionRef.schemaHash, exportId: "paint" },
      generator: { definitionId: "paint", actionId: "generate", inputSlots: { image: "image" } } });
    const revision: GeneratorRevision = { id: "before", generatorId: "native", definitionRef,
      state: { prompt: "Paint", modelId: "flux-3-video-keyframes", contentParts: [{ type: "input", slot: "image", itemKey: "ref", label: "Plugin-owned label" }] },
      persistentInputRefs: [{ slot: "image", itemKey: "ref", target: { kind: "media", projectAssetId: "reference" } }] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: revision.id }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><CustomActionsProvider actions={[action]}><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", actionCardId: action.id, label: "Paint" }} /></CustomActionsProvider></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Media reference" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(input.state).toEqual(revision.state);
    expect(input.persistentInputRefs).toEqual([]);
    expect(nativeLoroMock.value.updateNode).not.toHaveBeenCalled();
  });

  it("copies a native checkpoint through Host creation without a legacy Canvas clone", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "Native prompt", params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    doc.getMap("nodes").set("placement", { type: "action-badge", canvasId: "main", data: { generatorId: "native" } });
    const addNode = vi.fn();
    nativeLoroMock.value = { doc, updateNode: vi.fn(), addNode };
    reactFlowMock.getEdges.mockImplementation(() => [{ id: "output-edge", source: "placement", target: "output" }] as any);
    reactFlowMock.getNode.mockImplementation((nodeId: string) => nodeId === "output"
      ? { id: "output", type: "video", data: { status: "ready", assetId: "output-asset" } } : undefined);
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { id: input.generatorId, headRevisionId: input.generatorRevisionId, definitionRef },
        revision: { ...revision, id: input.generatorRevisionId, generatorId: input.generatorId, state: input.state, forkedFrom: input.forkedFrom } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", hasRun: true, label: "Native checkpoint" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("button", { name: "Create an independent Generator copy" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls.find((call) => call[1]?.body)![1]!.body as string);
    expect(input.forkedFrom).toEqual({ generatorId: "native", generatorRevisionId: "before" });
    expect(input.state).toEqual(revision.state);
    expect(addNode).not.toHaveBeenCalled();
    expect(spawnAssetMock.spawnPending).not.toHaveBeenCalled();
  });

  it.each(["media", "document"])("converts a plain editor mention into immutable inputs before Run (%s)", async (kind) => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "Before", params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const target = kind === "media" ? { kind: "media", projectAssetId: "subject-asset" }
      : { kind: "document", documentAssetId: "script", revisionId: "saved-script" };
    const slot = kind === "media" ? "image" : "text";
    reactFlowMock.getNode.mockImplementation((id: string) => id === "subject" ? { id, type: kind === "media" ? "image" : "text", data: kind === "media" ? { assetId: "subject-asset" } : { documentRevision: target } } : undefined);
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/documents/")) return Response.json({
        revision: { id: "saved-script", documentAssetId: "script", documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
          body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" },
          producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] }, body: "Saved script",
      });
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
      } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge" data={{ generatorId: "native", label: "Mention" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const prompt = screen.getByLabelText("Prompt");
    prompt.textContent = "Use @[subject](node:subject)";
    fireEvent.input(prompt);
    fireEvent.click(screen.getAllByRole("button", { name: "Run action" }).at(-1)!);
    await waitFor(() => expect(spawnAssetMock.spawnPending).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls.find((call) => call[1]?.body)![1]!.body as string);
    expect(input.state.prompt).toBe("Use subject");
    expect(input.persistentInputRefs).toEqual([{ slot, itemKey: expect.any(String), target }]);
    expect(input.state.contentParts).toEqual([{ type: "text", text: "Use " }, { type: "input", slot, itemKey: input.persistentInputRefs[0].itemKey, label: "subject" }]);
    expect(spawnAssetMock.spawnPending).toHaveBeenCalledWith(expect.objectContaining({ generatorRevision: {
      generatorId: "native", generatorRevisionId: input.generatorRevisionId,
    } }));
    expect(reactFlowMock.addEdges).not.toHaveBeenCalled();
  });

  it("saves native Lyrics independently and pins the latest edit when Run follows immediately", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "audio", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "song", definitionRef, state: { modelId: "minimax-music-3", prompt: "Gentle piano", lyrics: "Morning light", params: {} }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: "song", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (_path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      const input = JSON.parse(init!.body as string);
      return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: { ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs } });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge" data={{ generatorId: "song", label: "Song" }} /></CanvasTransientUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const lyrics = screen.getByRole("textbox", { name: "Lyrics" });
    expect((lyrics as HTMLTextAreaElement).value).toBe("Morning light");
    fireEvent.change(lyrics, { target: { value: "Evening glow" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Run action" }).at(-1)!);
    await waitFor(() => expect(spawnAssetMock.spawnPending).toHaveBeenCalled());
    const input = JSON.parse(request.mock.calls.filter((call) => call[1]?.body).at(-1)![1]!.body as string);
    expect(input.state).toMatchObject({ prompt: "Gentle piano", lyrics: "Evening glow" });
    expect(spawnAssetMock.spawnPending).toHaveBeenCalledWith(expect.objectContaining({ generatorRevision: { generatorId: "song", generatorRevisionId: input.generatorRevisionId } }));
    for (const [, patch] of nativeLoroMock.value.updateNode.mock.calls) expect(patch.data).not.toHaveProperty("lyrics");
  });

  it("waits for the native draft save before pinning the Run revision", async () => {
    const doc = new LoroDoc();
    const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const revision = { id: "before", generatorId: "native", definitionRef,
      state: { modelId: "minimax-h3", prompt: "Native prompt", params: { resolution: "768P", duration: 5, aspect_ratio: "16:9" } }, persistentInputRefs: [] };
    const created = createProjectGenerator(doc, { head: { id: "native", headRevisionId: "before" }, revision });
    if (!created.ok) throw new Error(created.error.message);
    nativeLoroMock.value = { doc, updateNode: vi.fn() };
    let release!: (value: Response) => void;
    const request = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.includes("/generator-definitions/")) return Response.json({ definition: definitionRef });
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    vi.stubGlobal("fetch", request);
    render(<CanvasTransientUiProvider><PromptActionNode {...baseNodeProps} id="placement" type="action-badge"
      data={{ generatorId: "native", content: "Stale Canvas prompt", label: "Native draft" }} /></CanvasTransientUiProvider>);
    expect(spawnAssetMock.latestInput.content).toBe(revision.state.prompt);
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    const prompt = screen.getByLabelText("Prompt");
    prompt.textContent = "Edited immediately before Run";
    fireEvent.input(prompt);
    fireEvent.click(screen.getAllByRole("button", { name: "Run action" }).at(-1)!);
    await waitFor(() => expect(request.mock.calls.some((call) => call[1]?.body)).toBe(true));
    expect(spawnAssetMock.spawnPending).not.toHaveBeenCalled();
    const input = JSON.parse((request.mock.calls.find((call) => call[1]?.body) as unknown as [string, RequestInit])[1].body as string);
    expect(input.state.prompt).toBe("Edited immediately before Run");
    await act(async () => {
      release(Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
        ...revision, id: input.generatorRevisionId, parentRevisionId: "before", state: input.state,
      } }));
    });
    await waitFor(() => expect(spawnAssetMock.spawnPending).toHaveBeenCalledWith(expect.objectContaining({
      generatorRevision: { generatorId: "native", generatorRevisionId: input.generatorRevisionId },
    })));
  });

  it("Run creates a fresh pending output instead of adopting a downstream draft", async () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "action-1-draft-1",
      source: "action-1",
      sourceHandle: null,
      target: "draft-1",
      targetHandle: null,
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "draft-1"
        ? { id: "draft-1", type: "audio", data: { status: "draft" } }
        : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "audio-gen",
            content: "Read this line",
            label: "Audio Prompt",
            modelId: "gemini-3.1-flash-tts",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));

    await waitFor(() =>
      expect(spawnAssetMock.spawnPending).toHaveBeenCalledTimes(1),
    );
    expect(spawnAssetMock.adoptDraft).not.toHaveBeenCalled();
  });

  it("surfaces Model Card media constraints before spawning generation", async () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "image-oversize-action-1",
      source: "image-oversize",
      target: "action-1",
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "image-oversize"
        ? {
            id,
            type: "image",
            data: {
              assetId: "asset-oversize",
              naturalWidth: 1024,
              naturalHeight: 1024,
              metadata: { bytes: 31 * 1024 * 1024, contentType: "image/png" },
            },
          }
        : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Animate this frame",
            label: "Animate",
            modelId: "minimax-h3-startend",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));

    expect((await screen.findByText(/30 MB/)).textContent).toContain("30 MB");
    expect(spawnAssetMock.spawnPending).not.toHaveBeenCalled();
  });

  it("shows a media compatibility error as soon as the model changes", async () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "video-long-action-1",
      source: "video-long",
      target: "action-1",
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "video-long"
        ? {
            id,
            type: "video",
            data: {
              assetId: "asset-long",
              naturalWidth: 1280,
              naturalHeight: 720,
              metadata: { durationMs: 20_000, contentType: "video/mp4" },
            },
          }
        : undefined,
    );

    const { rerender } = render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Restyle this clip",
            label: "Restyle",
            modelId: "seedance-2.5-ref",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    expect(screen.queryByText(/at most 15 seconds/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(
      screen.getByRole("option", { name: "MiniMax H3 (全能参考)" }),
    );

    await waitFor(() => {
      const persisted = reactFlowMock.setNodes.mock.calls.some(([update]) => {
        if (typeof update !== "function") return false;
        const [nextNode] = update([{ id: "action-1", data: {} }]);
        return nextNode?.data?.modelId === "minimax-h3";
      });
      expect(persisted).toBe(true);
    });
    rerender(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Restyle this clip",
            label: "Restyle",
            modelId: "minimax-h3",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    expect(await screen.findByText(/at most 15 seconds/i)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Run action" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(reactFlowMock.setEdges).not.toHaveBeenCalled();
  });

  it("shows a conditional media error as soon as edit mode is enabled", async () => {
    reactFlowMock.nodeConnections.push({
      edgeId: "video-short-action-1",
      source: "video-short",
      target: "action-1",
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "video-short"
        ? {
            id,
            type: "video",
            data: {
              assetId: "asset-short",
              naturalWidth: 640,
              naturalHeight: 640,
              metadata: { durationMs: 3_999, contentType: "video/mp4" },
            },
          }
        : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Edit this clip",
            label: "Edit",
            modelId: "seedance-2.5-ref",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure action" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Parameters" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Edit referenced video.*Off/i }),
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Edit referenced video" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "On" }));

    expect(await screen.findByText(/at least 4 seconds/i)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Run action" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(reactFlowMock.setEdges).not.toHaveBeenCalled();
  });

  it("turns Director Shot packets into one visual Shot Group and one generation per Shot", async () => {
    const packet = (shotId: string, assetId: string) => ({
      schemaVersion: 1 as const,
      stageId: "stage-1",
      stageRevisionId: "stage-revision-7",
      exportedAt: "2026-07-24T10:00:00.000Z",
      aspectRatio: "16:9" as const,
      durationSeconds: 4,
      fps: 30,
      scope: { kind: "shot" as const, selectedShotIds: [shotId] },
      cameraIds: [`camera-${shotId}`],
      referenceVideo: {
        assetId,
        mimeType: "video/webm",
      },
      referenceStills: [],
      shotSpec: {
        shots: [
          {
            id: shotId,
            name: shotId === "shot-a" ? "Lead walk" : "Reverse follow",
            cameraId: `camera-${shotId}`,
            startTime: 0,
            sequenceStartTime: shotId === "shot-a" ? 0 : 4,
            durationSeconds: 4,
            aspectRatio: "16:9" as const,
            transition: "cut" as const,
          },
        ],
      },
    });
    const firstPacket = packet("shot-a", "director-shot-a-video");
    const secondPacket = packet("shot-b", "director-shot-b-video");

    reactFlowMock.nodeConnections.push({
      edgeId: "stage-1-action-1",
      source: "stage-1",
      sourceHandle: null,
      target: "action-1",
      targetHandle: null,
    });
    reactFlowMock.getNode.mockImplementation((id: string) =>
      id === "stage-1"
        ? {
            id: "stage-1",
            type: "director-stage",
            data: {
              directorShotReferencePackets: [firstPacket, secondPacket],
              outputVideoAssetId: "director-sequence-preview",
            },
          }
        : undefined,
    );

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Preserve the blocking and cinematic camera language",
            label: "Generate selected shots",
            modelId: "seedance-2-ref",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));

    await waitFor(() =>
      expect(spawnAssetMock.spawnPending).toHaveBeenCalledTimes(2),
    );
    expect(layoutMock.addNodeWithAutoLayout).toHaveBeenCalledTimes(1);
    const groupNode = layoutMock.addNodeWithAutoLayout.mock.calls[0][0];
    expect(groupNode).toMatchObject({
      type: "group",
      data: {
        label: "Director shots · 2",
        sourceDirectorStageId: "stage-1",
        sourceDirectorStageRevisionId: "stage-revision-7",
        selectedDirectorShotIds: ["shot-a", "shot-b"],
      },
    });
    expect(spawnAssetMock.spawnPending).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        directorReferencePacket: firstPacket,
        directorShotGroupId: groupNode.id,
        groupIndex: 0,
        labelOverride: "Lead walk",
        parentGroupId: groupNode.id,
        sourceDirectorStageId: "stage-1",
        sourceDirectorStageRevisionId: "stage-revision-7",
        sourceDirectorStageShotId: "shot-a",
      }),
    );
    expect(spawnAssetMock.spawnPending).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        directorReferencePacket: secondPacket,
        directorShotGroupId: groupNode.id,
        groupIndex: 1,
        labelOverride: "Reverse follow",
        parentGroupId: groupNode.id,
        sourceDirectorStageId: "stage-1",
        sourceDirectorStageRevisionId: "stage-revision-7",
        sourceDirectorStageShotId: "shot-b",
      }),
    );
  });

  it("consumes selected Director Shots from referenced video output nodes", async () => {
    const packet = (shotId: string, assetId: string) => ({
      schemaVersion: 1 as const,
      stageId: "stage-1",
      stageRevisionId: "stage-revision-8",
      exportedAt: "2026-07-24T10:00:00.000Z",
      aspectRatio: "16:9" as const,
      durationSeconds: 4,
      fps: 30,
      scope: { kind: "shot" as const, selectedShotIds: [shotId] },
      cameraIds: [`camera-${shotId}`],
      referenceVideo: { assetId, mimeType: "video/webm" },
      referenceStills: [],
      shotSpec: {
        shots: [
          {
            id: shotId,
            name: shotId === "shot-a" ? "Lead walk" : "Reverse follow",
            cameraId: `camera-${shotId}`,
            startTime: 0,
            sequenceStartTime: shotId === "shot-a" ? 0 : 4,
            durationSeconds: 4,
            aspectRatio: "16:9" as const,
            transition: "cut" as const,
          },
        ],
      },
    });
    const firstPacket = packet("shot-a", "director-shot-a-video");
    const secondPacket = packet("shot-b", "director-shot-b-video");

    reactFlowMock.nodeConnections.push(
      {
        edgeId: "output-a-action-1",
        source: "output-a",
        sourceHandle: null,
        target: "action-1",
        targetHandle: null,
      },
      {
        edgeId: "output-b-action-1",
        source: "output-b",
        sourceHandle: null,
        target: "action-1",
        targetHandle: null,
      },
    );
    reactFlowMock.getNode.mockImplementation((id: string) => {
      if (id === "output-a") {
        return {
          id,
          type: "video",
          data: {
            assetId: firstPacket.referenceVideo.assetId,
            directorReferencePacket: firstPacket,
          },
        };
      }
      if (id === "output-b") {
        return {
          id,
          type: "video",
          data: {
            assetId: secondPacket.referenceVideo.assetId,
            directorReferencePacket: secondPacket,
          },
        };
      }
      return undefined;
    });

    render(
      <CanvasTransientUiProvider>
        <PromptActionNode
          {...baseNodeProps}
          id="action-1"
          type="action-badge"
          data={{
            actionType: "video-gen",
            content: "Preserve each rendered Director shot",
            label: "Generate selected shots",
            modelId: "seedance-2-ref",
          }}
        />
      </CanvasTransientUiProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));

    await waitFor(() =>
      expect(spawnAssetMock.spawnPending).toHaveBeenCalledTimes(2),
    );
    expect(spawnAssetMock.spawnPending).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        directorReferencePacket: firstPacket,
        sourceDirectorStageId: "stage-1",
        sourceDirectorStageRevisionId: "stage-revision-8",
        sourceDirectorStageShotId: "shot-a",
      }),
    );
    expect(spawnAssetMock.spawnPending).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        directorReferencePacket: secondPacket,
        sourceDirectorStageId: "stage-1",
        sourceDirectorStageRevisionId: "stage-revision-8",
        sourceDirectorStageShotId: "shot-b",
      }),
    );
  });
});
