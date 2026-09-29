// @vitest-environment jsdom
import { PluginUiProvider } from "@clash/action-sdk/ui";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StoryboardViewState,
  StoryboardViewResource,
} from "@clash/shared-types";
import {
  PluginStoryboardSurface,
  type PluginStoryboardSurfaceProps,
} from "./PluginStoryboardSurface";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const candidate: StoryboardViewResource = {
  id: "version-a",
  projectAssetId: "asset-a",
  mediaKind: "image",
  modelName: "Reference A",
};
function initialState(): StoryboardViewState {
  return {
    keyElements: [
      {
        id: "hero",
        label: "Hero",
        description: [
          { type: "text", text: "Before " },
          { type: "entity-reference", entityId: "forest" },
          { type: "text", text: " after" },
        ],
        materials: [
          {
            id: "portrait",
            label: "Portrait",
            mediaKind: "image",
            candidates: [structuredClone(candidate)],
            promptDraft: { id: "prompt", text: "A portrait" },
          },
        ],
      },
    ],
    shots: [],
    audioLayers: [],
    uncategorized: [],
  };
}
function generatedState(): StoryboardViewState {
  const state = initialState();
  state.keyElements[0].materials[0].candidates[0].generatedBy = {
    generatorId: "g",
    generatorRevisionId: "r",
    actionRunId: "run",
    outputSlot: "image",
    outputCommitId: "run:image",
  };
  return state;
}
function mount(overrides: Partial<PluginStoryboardSurfaceProps> = {}) {
  const save = vi.fn();
  function Harness() {
    const [state, setState] = useState(overrides.state ?? initialState());
    return (
      <PluginUiProvider
        components={{
          GeneratorComposer: () => null,
          GeneratorOutput: ({ onPreview, onReady, presentation }) => (
            <div>
              <button onClick={onPreview}>Pending tile</button>
              {presentation === "preview" && (
                <button
                  onClick={() =>
                    onReady({
                      ...candidate,
                      id: "result",
                      modelName: "Result",
                      generatedBy: {
                        generatorId: "g",
                        generatorRevisionId: "r",
                        actionRunId: "run",
                        outputSlot: "image",
                        outputCommitId: "run:image",
                      },
                    })
                  }
                >
                  Complete output
                </button>
              )}
            </div>
          ),
        }}
      >
        <PluginStoryboardSurface
          projectId="p"
          nodeId="v"
          label="Storyboard"
          assets={[]}
          generators={[]}
          onGenerate={vi.fn()}
          parentCanvas={{ id: "shots", name: "Shots" }}
          onOpenCanvas={vi.fn()}
          {...overrides}
          state={state}
          onSave={(next) => {
            save(next);
            setState(next);
          }}
        />
      </PluginUiProvider>
    );
  }
  const view = render(<Harness />);
  return { ...view, save };
}

describe("PluginStoryboardSurface", () => {
  it("resolves entity references to current labels while preserving their identities", () => {
    const state = initialState();
    state.keyElements.push({
      id: "forest",
      label: "Forest",
      description: [],
      materials: [],
    });
    const { save } = mount({ state });
    expect(screen.getByText("@Forest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Hero" }));
    expect(
      within(screen.getByRole("dialog")).getByText("@Forest"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Forest" }));
    fireEvent.change(screen.getByLabelText("Name for Forest"), {
      target: { value: "Rainy forest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(screen.getByText("@Rainy forest")).toBeInTheDocument();
    expect(save.mock.lastCall?.[0].keyElements[0].description).toEqual(
      state.keyElements[0].description,
    );
  });

  it.each([
    { section: "shots" as const, mediaKind: "video" as const },
    { section: "audioLayers" as const, mediaKind: "audio" as const },
  ])(
    "keeps $section attachment and details in their own section",
    ({ section, mediaKind }) => {
      const state = initialState();
      state[section] = [
        { id: "target", label: "Target", description: [], materials: [] },
      ];
      const resource: StoryboardViewResource = {
        id: "loose-target",
        projectAssetId: "target-asset",
        mediaKind,
      };
      state.uncategorized = [resource];
      const { save } = mount({
        state,
        assets: [
          {
            id: resource.projectAssetId,
            name: "Target media",
            kind: mediaKind,
            status: "ready",
            url: `https://example.test/target.${mediaKind === "video" ? "mp4" : "wav"}`,
            lifecycle: { state: "active" },
            metadata: {},
          },
        ],
      });
      const openPicker = () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Add media to Target" }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "Choose project asset" }),
        );
      };
      openPicker();
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Close",
        }),
      );
      expect(save).not.toHaveBeenCalled();
      openPicker();
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Add Target media",
        }),
      );
      const attached = save.mock.lastCall![0] as StoryboardViewState;
      expect(attached[section][0].materials).toEqual([
        expect.objectContaining({ mediaKind, candidates: [resource] }),
      ]);
      expect(attached.keyElements).toEqual(state.keyElements);
      expect(attached[section === "shots" ? "audioLayers" : "shots"]).toEqual(
        [],
      );
      expect(attached.uncategorized).toEqual([]);
      expect(
        screen.getByRole("region", { name: "Media preview" }),
      ).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Edit Target" }));
      fireEvent.change(screen.getByLabelText("Description text 1 for Target"), {
        target: { value: "Keep the subject in frame." },
      });
      fireEvent.change(screen.getByLabelText("Direction for Target"), {
        target: { value: "Start at the first shot; fade at the end." },
      });
      if (section === "shots") {
        fireEvent.change(screen.getByLabelText("Duration for Target"), {
          target: { value: "2.5" },
        });
      } else {
        expect(screen.getByText("Timing and mix direction")).toBeVisible();
        expect(screen.queryByLabelText("Duration for Target")).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Save details" }));
      const edited = save.mock.lastCall![0] as StoryboardViewState;
      expect(edited[section][0]).toEqual(
        expect.objectContaining({
          id: "target",
          description: [{ type: "text", text: "Keep the subject in frame." }],
          details: "Start at the first shot; fade at the end.",
          materials: attached[section][0].materials,
          ...(section === "shots" ? { durationSeconds: 2.5 } : {}),
        }),
      );
      save.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Edit Target" }));
      fireEvent.change(screen.getByLabelText("Name for Target"), {
        target: { value: "Discarded" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(save).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^Target/ })).toBeVisible();
    },
  );

  it.each([
    { section: "shots" as const, heading: /^Shots/ },
    { section: "audioLayers" as const, heading: /^Audio layers/ },
  ])(
    "restores $section item and section disclosure independently",
    ({ section, heading }) => {
      const state = initialState();
      state[section] = [
        { id: "target", label: "Target", description: [], materials: [] },
      ];
      const first = mount({ state });
      fireEvent.click(screen.getByRole("button", { name: "Target" }));
      fireEvent.click(screen.getByRole("button", { name: heading }));
      first.unmount();
      mount({ state });
      expect(screen.getByRole("button", { name: heading })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      fireEvent.click(screen.getByRole("button", { name: heading }));
      expect(screen.getByRole("button", { name: "Target" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.getByRole("button", { name: "Hero" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    },
  );

  it("opens the existing media panel without saving an empty material, and cancel is a no-op", async () => {
    const { save } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose project asset" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Media results" }),
      ).toBeVisible(),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close",
      }),
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText("Open preview to add media")).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
  });

  it("creates a material from the selected asset's actual kind and preserves its lineage", () => {
    const state = initialState();
    const video: StoryboardViewResource = {
      id: "loose-video",
      projectAssetId: "video-a",
      mediaKind: "video",
      generatedBy: {
        generatorId: "video-g",
        generatorRevisionId: "video-r",
        actionRunId: "video-run",
        outputCommitId: "video-run:video",
        outputSlot: "video",
      },
    };
    state.uncategorized = [video];
    const { save } = mount({
      state,
      assets: [
        {
          id: "video-a",
          name: "Forest video",
          kind: "video",
          status: "ready",
          url: "https://example.test/video.mp4",
          lifecycle: { state: "active" },
          metadata: {},
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose project asset" }),
    );
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add Forest video",
      }),
    );
    expect(save.mock.lastCall?.[0].keyElements[0].materials).toEqual([
      initialState().keyElements[0].materials[0],
      expect.objectContaining({ mediaKind: "video", candidates: [video] }),
    ]);
    expect(save.mock.lastCall?.[0].uncategorized).toEqual([]);
    expect(screen.getByRole("region", { name: "Media preview" })).toBeVisible();
  });

  it("keeps a new generation local until submission and attaches its pending output once", async () => {
    let callbacks!: Parameters<
      NonNullable<PluginStoryboardSurfaceProps["onCompose"]>
    >[1];
    const { save } = mount({
      generators: [
        {
          label: "Image generator",
          actionId: "generate",
          outputSlot: "image",
          mediaKind: "image",
          definition: {} as never,
        },
      ],
      onCompose: async (_request, nextCallbacks) => {
        callbacks = nextCallbacks;
        return <div>Shared composer</div>;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Generate media" })),
    );
    expect(save).not.toHaveBeenCalled();
    act(() => callbacks.onClose());
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Generate media" })),
    );
    const output = {
      generatorId: "g",
      generatorRevisionId: "r",
      actionRunId: "run",
      outputSlot: "image",
      mediaKind: "image" as const,
    };
    act(() => {
      callbacks.onPending(output);
      callbacks.onPending(output);
    });
    expect(save.mock.lastCall?.[0].keyElements[0].materials).toEqual([
      initialState().keyElements[0].materials[0],
      expect.objectContaining({ candidates: [], pendingOutputs: [output] }),
    ]);
    expect(
      screen.getByRole("region", { name: "Pending media preview" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Complete output" }));
    expect(save.mock.lastCall?.[0].keyElements[0].materials.at(-1)).toEqual(
      expect.objectContaining({
        candidates: [expect.objectContaining({ id: "result" })],
        pendingOutputs: [],
      }),
    );
  });

  it("does not display legacy blank slots or orphan preview actions", () => {
    const state = initialState();
    state.keyElements[0].materials.push({
      id: "blank",
      label: "Video",
      mediaKind: "video",
      candidates: [],
    });
    const { save } = mount({ state });
    expect(screen.queryByRole("group", { name: "Video media" })).toBeNull();
    expect(screen.queryByText("Your storyboard, shot by shot")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the original preview when cancelling Add media and does not offer generation without a provider", () => {
    const { save } = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    const preview = screen.getByRole("region", { name: "Media preview" });
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    expect(screen.queryByRole("button", { name: "Generate media" })).toBeNull();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close",
      }),
    );
    expect(screen.getByRole("region", { name: "Media preview" })).toBe(preview);
    expect(save).not.toHaveBeenCalled();
  });

  it("imports through the shared media panel and keeps upload failures local without saving a slot", async () => {
    const onUpload = vi
      .fn()
      .mockRejectedValueOnce(new Error("Import failed"))
      .mockResolvedValueOnce({ id: "upload", kind: "audio" });
    const { save } = mount({ onUpload });
    fireEvent.click(screen.getByRole("button", { name: "Add media to Hero" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose project asset" }),
    );
    const file = new File(["audio"], "voice.wav", { type: "audio/wav" });
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Upload media"), {
        target: { files: [file] },
      }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("alert"),
    ).toHaveTextContent("Import failed");
    expect(save).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Upload media"), {
        target: { files: [file] },
      }),
    );
    expect(save.mock.lastCall?.[0].keyElements[0].materials.at(-1)).toEqual(
      expect.objectContaining({
        mediaKind: "audio",
        candidates: [
          expect.objectContaining({
            projectAssetId: "upload",
            mediaKind: "audio",
          }),
        ],
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates to its owning Canvas while preview close stays inside Storyboard", () => {
    const onOpenCanvas = vi.fn();
    mount({ onOpenCanvas });
    expect(
      screen.queryByRole("button", { name: "Close Storyboard" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onOpenCanvas).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Media preview" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open parent Canvas Shots" }),
    );
    expect(onOpenCanvas).toHaveBeenCalledWith("shots");
  });

  it("restores disclosure choices without keeping generation forms in the list", () => {
    const first = mount();
    expect(
      screen.queryByRole("button", { name: "Edit prompt for Portrait" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hero" }));
    fireEvent.click(screen.getByRole("button", { name: /Key elements/ }));
    first.unmount();
    mount();
    expect(
      screen.getByRole("button", { name: /Key elements/ }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /Key elements/ }));
    expect(screen.getByRole("button", { name: "Hero" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the current preview mounted while Prompt opens its composer below", async () => {
    let close!: () => void;
    mount({
      state: generatedState(),
      onCompose: async (_request, callbacks) => {
        close = callbacks.onClose;
        return <div>Edit composer</div>;
      },
      generators: [
        {
          label: "Image generator",
          actionId: "generate",
          outputSlot: "image",
          mediaKind: "image",
          definition: {} as never,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Generated image" }),
    );
    const preview = screen.getByRole("region", { name: "Media preview" });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Prompt" })),
    );
    expect(screen.getByRole("region", { name: "Media preview" })).toBe(preview);
    expect(
      within(preview).getByRole("region", { name: "Generator composer" }),
    ).toHaveTextContent("Edit composer");
    act(() => close());
    expect(screen.getByRole("region", { name: "Media preview" })).toBe(preview);
    expect(
      screen.queryByRole("region", { name: "Generator composer" }),
    ).toBeNull();
  });

  it("opens the shared composer from Preview and keeps failures local", async () => {
    const onCompose = vi
      .fn()
      .mockRejectedValue(new Error("Generator unavailable"));
    mount({
      onCompose,
      generators: [
        {
          label: "Image generator",
          actionId: "generate",
          outputSlot: "image",
          mediaKind: "image",
          definition: {} as never,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New version" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Generate media" })),
    );
    expect(onCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "new",
        material: expect.objectContaining({ id: "portrait" }),
      }),
      expect.anything(),
    );
    expect(
      within(screen.getByRole("region", { name: "Media preview" })).getByRole(
        "alert",
      ),
    ).toHaveTextContent("Generator unavailable");
    expect(
      within(screen.getByRole("group", { name: "Portrait media" })).queryByRole(
        "textbox",
      ),
    ).toBeNull();
  });

  it("lets legacy entries without labels save details without renaming their identity", () => {
    const state = initialState();
    delete state.keyElements[0]!.label;
    const { save } = mount({ state });
    fireEvent.click(screen.getByRole("button", { name: "Edit hero" }));
    fireEvent.change(screen.getByLabelText("Description text 1 for hero"), {
      target: { value: "Updated " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(save.mock.lastCall?.[0].keyElements[0]).toEqual(
      expect.objectContaining({
        id: "hero",
        description: [
          { type: "text", text: "Updated " },
          { type: "entity-reference", entityId: "forest" },
          { type: "text", text: " after" },
        ],
      }),
    );
  });

  it("keeps removed entries' media as loose resources, including generation lineage", () => {
    const state = initialState();
    const lineage = {
      generatorId: "g",
      generatorRevisionId: "g:r1",
      actionRunId: "run",
      outputCommitId: "commit",
    };
    state.keyElements[0]!.materials[0]!.candidates[0]!.generatedBy = lineage;
    const { save } = mount({ state });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Hero from storyboard" }),
    );
    expect(save.mock.lastCall?.[0].uncategorized).toEqual([
      expect.objectContaining({
        projectAssetId: "asset-a",
        generatedBy: lineage,
      }),
    ]);
  });

  it("creates a named item only after confirmation, without replacing existing entries", () => {
    const { save } = mount();
    fireEvent.click(screen.getByRole("button", { name: /^Add key element/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Forest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add key element" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Forest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(save.mock.lastCall?.[0].keyElements).toEqual([
      expect.objectContaining({ id: "hero", label: "Hero" }),
      expect.objectContaining({ label: "Forest" }),
    ]);
  });

  it("edits display names and individual text spans without changing IDs or reference order", () => {
    const { save } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit Hero" }));
    fireEvent.change(screen.getByLabelText("Name for Hero"), {
      target: { value: "Lead" },
    });
    fireEvent.change(screen.getByLabelText("Description text 1 for Hero"), {
      target: { value: "Beside " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(save.mock.lastCall?.[0].keyElements[0]).toEqual(
      expect.objectContaining({
        id: "hero",
        label: "Lead",
        description: [
          { type: "text", text: "Beside " },
          { type: "entity-reference", entityId: "forest" },
          { type: "text", text: " after" },
        ],
      }),
    );
  });

  it("previews a version without adopting it, then explicitly adopts the version", () => {
    const { save } = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    expect(
      screen.getByRole("region", { name: "Media preview" }),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this version" }));
    expect(
      save.mock.lastCall?.[0].keyElements[0].materials[0].selectedCandidateId,
    ).toBe(candidate.id);
  });

  it("attaches an existing asset and removes its loose entry without changing asset facts", () => {
    const state = initialState();
    state.uncategorized = [
      { id: "loose", projectAssetId: "asset-b", mediaKind: "image" },
    ];
    const { save } = mount({
      state,
      assets: [
        {
          id: "asset-b",
          name: "Forest plate",
          url: "https://example.test/forest.png",
          kind: "image",
          status: "ready",
          lifecycle: { state: "active" },
          metadata: {},
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New version" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose project asset" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add Forest plate",
      }),
    );
    expect(
      save.mock.lastCall?.[0].keyElements[0].materials[0].candidates,
    ).toEqual([
      candidate,
      expect.objectContaining({ projectAssetId: "asset-b" }),
    ]);
    expect(save.mock.lastCall?.[0].uncategorized).toEqual([]);
  });

  it("appends a generation result to the latest state, preserving edits made while it runs", async () => {
    let finish!: (resource: StoryboardViewResource) => void;
    const onCompose: NonNullable<
      PluginStoryboardSurfaceProps["onCompose"]
    > = async (_request, callbacks) => {
      finish = callbacks.onResult;
      return <div>Shared composer</div>;
    };
    const { save } = mount({
      onCompose,
      generators: [
        {
          label: "Image generator",
          actionId: "generate",
          outputSlot: "image",
          mediaKind: "image",
          definition: {
            pluginId: "test",
            definitionId: "image",
          } as PluginStoryboardSurfaceProps["generators"][number]["definition"],
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New version" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Generate media" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Hero" }));
    fireEvent.change(screen.getByLabelText("Name for Hero"), {
      target: { value: "Changed during generation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await act(async () =>
      finish({
        id: "generated",
        projectAssetId: "new-asset",
        mediaKind: "image",
      }),
    );
    expect(save.mock.lastCall?.[0].keyElements[0]).toEqual(
      expect.objectContaining({
        label: "Changed during generation",
        materials: [
          expect.objectContaining({
            candidates: [
              candidate,
              expect.objectContaining({ id: "generated" }),
            ],
          }),
        ],
      }),
    );
  });
});

it("previews acknowledged regeneration, supports reopening pending, and follows completion", async () => {
  const state = initialState();
  state.keyElements[0]!.materials[0]!.candidates[0]!.generatedBy = {
    generatorId: "g",
    generatorRevisionId: "r",
    actionRunId: "old",
    outputSlot: "image",
    outputCommitId: "old:image",
  };
  const { save } = mount({
    state,
    generators: [
      {
        label: "Image generator",
        actionId: "generate",
        outputSlot: "image",
        mediaKind: "image",
        definition: {} as never,
      },
    ],
    onCompose: async (_request, callbacks) => {
      callbacks.onPending({
        generatorId: "g",
        generatorRevisionId: "r",
        actionRunId: "run",
        outputSlot: "image",
        mediaKind: "image",
      });
      return null;
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview Generated image" }),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" })),
  );
  expect(
    screen.getByRole("region", { name: "Pending media preview" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview Generated image" }),
  );
  expect(
    screen.queryByRole("region", { name: "Pending media preview" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pending tile" }));
  fireEvent.click(screen.getByRole("button", { name: "Complete output" }));
  expect(
    screen.getByRole("region", { name: "Media preview" }),
  ).toHaveTextContent("Result");
  expect(
    save.mock.lastCall?.[0].keyElements[0].materials[0].pendingOutputs,
  ).toEqual([]);
});

it("opens composer preparation immediately and ignores a late composer after closing", async () => {
  let resolve!: (value: import("react").ReactNode) => void;
  mount({
    state: generatedState(),
    generators: [
      {
        label: "Image generator",
        actionId: "generate",
        outputSlot: "image",
        mediaKind: "image",
        definition: {} as never,
      },
    ],
    onCompose: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview Generated image" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
  expect(
    screen.getByRole("status", { name: "Preparing composer" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close composer" }));
  await act(async () => resolve(<div>Late composer</div>));
  expect(screen.queryByText("Late composer")).toBeNull();
});

it.each(["assigned", "uncategorized"])(
  "references %s media in chat without a generator or a View mutation",
  (location) => {
    const onReference = vi.fn();
    const onCompose = vi.fn();
    const state = initialState();
    if (location === "uncategorized") {
      state.keyElements = [];
      state.uncategorized = [candidate];
    }
    const { save } = mount({ state, onReference, onCompose });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Reference A" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    expect(onReference).toHaveBeenCalledWith(candidate);
    expect(onCompose).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Generator composer" }),
    ).toBeNull();
  },
);
